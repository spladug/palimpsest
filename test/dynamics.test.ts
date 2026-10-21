import { beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { medievalEngland } from '../src/plugins/medieval-england';
import { townHouseholds } from '../src/sim/dynamics';
import { nextBackBuilding, splitLengthwise } from '../src/sim/plots';
import { intersection, shapeArea, type Shape } from '../src/sim/polygon';
import { dist } from '../src/sim/geom';
import type { Frontage } from '../src/sim/cadastre';

const plot: Shape = [[{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 60 }, { x: 0, y: 60 }]];
const front: Frontage = { a: { x: 0, y: 0 }, b: { x: 15, y: 0 }, inward: { x: 0, y: 1 }, street: 'High Street' };

describe('plot operations', () => {
  it('splits a plot lengthwise into two halves with their own frontages', () => {
    const halves = splitLengthwise(plot, front)!;
    expect(halves).toHaveLength(2);
    expect(shapeArea(halves[0].shape) + shapeArea(halves[1].shape)).toBeCloseTo(900, 0);
    expect(dist(halves[0].frontage.b, halves[1].frontage.a)).toBeLessThan(1e-9);
    expect(dist(halves[0].frontage.a, halves[0].frontage.b)).toBeCloseTo(7.5, 5);
  });

  it('fills back land from the street backwards until it is full', () => {
    const built: Shape[] = [[[{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 10 }, { x: 0, y: 10 }]]];
    // Each side fills from the front backwards.
    const depth = { left: 0, right: 0 };
    for (let k = 0; k < 50; k++) {
      const b = nextBackBuilding(plot, front, built, { width: 5, depth: 7 }, 0);
      if (!b) break;
      const xs = b.footprint[0].map((p) => p.x);
      const ys = b.footprint[0].map((p) => p.y);
      const side = Math.max(...xs) <= 7.5 ? 'left' : 'right';
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(depth[side] - 1e-9);
      expect(Math.max(...ys)).toBeLessThanOrEqual(60);
      depth[side] = Math.max(...ys);
      built.push(b.footprint);
    }
    // Ranges down both sides of a 60 m plot, then no more room.
    expect(built.length).toBeGreaterThan(6);
    expect(nextBackBuilding(plot, front, built, { width: 5, depth: 7 }, 0)).toBeNull();
  });
});

describe('a town over the centuries', () => {
  let w: World;
  const at: Record<number, { households: number; plots: number; back: number }> = {};

  beforeAll(() => {
    w = createWorld('dynamics-test', medievalEngland);
    for (const year of [1300, 1347, 1352, 1900]) {
      w.clock.advance(w, year);
      let plots = 0;
      let back = 0;
      for (const p of w.cadastre.parcels.values()) {
        if (p.kind !== 'burgage' && p.kind !== 'plot') continue;
        plots++;
        if (w.cadastre.buildingsOn(p.id).some((b) => b.back)) back++;
      }
      at[year] = { households: townHouseholds(w), plots, back };
    }
  }, 300_000);

  it('grows beyond its first plan along the roads out', () => {
    const planted = w.cadastre.history.find((e) => e.note.startsWith('Open-field strips taken for burgage plots'))!;
    expect(at[1300].plots).toBeGreaterThan(planted.children.length);
    expect(w.log.some((e) => e.year < 1348 && e.text.startsWith('The town spreads along'))).toBe(true);
  });

  it('loses many households to the Black Death', () => {
    expect(at[1352].households).toBeLessThan(at[1347].households * 0.8);
  });

  it('fills the back land of its plots while it prospers', () => {
    expect(at[1300].back).toBeGreaterThan(5);
  });

  it('passes plots to heirs, and splits and merges them, recording each change', () => {
    const kinds = new Set(w.cadastre.history.map((e) => e.kind));
    for (const k of ['inherit', 'split', 'merge', 'sale'] as const) expect(kinds.has(k)).toBe(true);
    const split = w.cadastre.history.find((e) => e.kind === 'split')!;
    expect(split.children.length).toBe(2);
  });

  it('is enclosed, and the closes are held freehold', () => {
    expect(w.enclosed).not.toBeNull();
    const parcels = [...w.cadastre.parcels.values()];
    expect(parcels.some((p) => p.kind === 'strip')).toBe(false);
    const enclosed = parcels.filter((p) => p.kind === 'close' && p.created === w.enclosed);
    expect(enclosed.length).toBeGreaterThan(20);
    for (const p of enclosed) expect(p.rights.alienation).toBe(p.rights.withdrawal);
  });

  it('grows to an industrial town of terraced streets laid out field by field', () => {
    expect(at[1900].households).toBeGreaterThan(600);
    expect(w.log.some((e) => /sells a field to .*, who lays out/.test(e.text))).toBe(true);
    expect([...w.cadastre.buildings.values()].filter((b) => b.use === 'terrace').length).toBeGreaterThan(100);
  });

  it('never lets two parcels claim the same ground', () => {
    const ps = [...w.cadastre.parcels.values()];
    const clashes: string[] = [];
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i].bounds;
        const b = ps[j].bounds;
        if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
        const area = intersection(ps[i].shape, ps[j].shape).reduce((s, x) => s + shapeArea(x), 0);
        if (area > 5) clashes.push(`${ps[i].kind} ${ps[i].id} / ${ps[j].kind} ${ps[j].id}: ${area.toFixed(0)} m²`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('keeps institutions on the old edge while growth jumps past them (a fringe belt)', () => {
    const market = w.places.find((p) => p.kind === 'market')!;
    const parcels = [...w.cadastre.parcels.values()];
    const old = parcels.filter((p) => p.kind === 'precinct' && p.created < 1700);
    expect(old.length).toBeGreaterThan(0);
    const centre = (p: (typeof parcels)[number]) => {
      const b = p.bounds;
      return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    };
    const farthest = Math.max(...old.map((p) => dist(centre(p), market.pos)));
    const later = parcels.filter((p) => p.kind === 'plot' && p.created > 1800 && dist(centre(p), market.pos) > farthest);
    expect(later.length).toBeGreaterThan(0);
  });
});

describe('inheritance customs', () => {
  it('divides plots among heirs where inheritance is partible', () => {
    const partible = { ...medievalEngland, tenure: { ...medievalEngland.tenure, inheritance: 'partible' as const } };
    const w = createWorld('partible-test', partible);
    w.clock.advance(w, 1340);
    expect(w.cadastre.history.some((e) => e.kind === 'split' && e.note.includes('between heirs'))).toBe(true);
  }, 200_000);

  it('runs the same way twice from the same seed', () => {
    const a = createWorld('same-seed', medievalEngland);
    const b = createWorld('same-seed', medievalEngland);
    a.clock.advance(a, 1280);
    b.clock.advance(b, 1280);
    expect(townHouseholds(a)).toBe(townHouseholds(b));
    expect(a.cadastre.parcels.size).toBe(b.cadastre.parcels.size);
    expect(a.log.map((e) => e.text)).toEqual(b.log.map((e) => e.text));
  }, 200_000);
});
