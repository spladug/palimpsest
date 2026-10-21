import { describe, expect, it } from 'vitest';
import { cutStrips } from '../src/sim/fields';
import { shapeArea, type Shape } from '../src/sim/polygon';
import { Rng } from '../src/sim/rng';
import { createWorld } from '../src/sim/world';
import { medievalEngland } from '../src/plugins/medieval-england';

const rules = medievalEngland.technology.fields;

describe('cutStrips', () => {
  it('tiles a furlong exactly with curved strips', () => {
    const furlong: Shape = [[{ x: 0, y: 0 }, { x: 200, y: 10 }, { x: 190, y: 180 }, { x: -10, y: 170 }]];
    const strips = cutStrips(furlong, 0.1, new Rng('strips'), { ...rules, minStripArea: 0 });
    const total = strips.reduce((s, p) => s + shapeArea(p), 0);
    expect(total).toBeCloseTo(shapeArea(furlong), 0);
    // Strips about 13 m wide across a ~175 m furlong.
    expect(strips.length).toBeGreaterThan(8);
    expect(strips.length).toBeLessThan(25);
  });
});

describe('open fields', () => {
  it('reorganises the township and gives households scattered strips with non-nested rights', () => {
    const w = createWorld('fields-test', medievalEngland);
    w.clock.advance(w, 1100);
    const cad = w.cadastre;
    expect(w.township).not.toBeNull();
    expect(cad.furlongs.size).toBeGreaterThan(10);
    const village = w.places.find((p) => p.kind === 'village')!;
    expect(village.mass).toBeGreaterThanOrEqual(4);

    const strips = [...cad.parcels.values()].filter((p) => p.kind === 'strip');
    const household = [...cad.holders.values()].find((h) => h.kind === 'household' && h.placeId === village.id)!;
    const theirs = strips.filter((p) => p.rights.withdrawal === household.id);
    // Sun-division scatters a holding across many furlongs.
    expect(new Set(theirs.map((p) => p.furlongId)).size).toBeGreaterThan(5);
    // The crop is the household's, but the township manages the field and the lord alone may grant it.
    const r = theirs[0].rights;
    expect(r.management).toBe(cad.community);
    expect(r.alienation).toBe(cad.lord);
    expect(r.build).toBeUndefined();
    // Furlongs are blocks along their strips: most of each outline runs with or across them.
    const squareness = [...cad.furlongs.values()].map((f) => {
      let along = 0;
      let total = 0;
      const ring = f.shape[0];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const off = Math.abs(Math.sin(2 * (Math.atan2(b.y - a.y, b.x - a.x) - f.orientation)));
        if (off < Math.sin((2 * 10 * Math.PI) / 180)) along += len;
        total += len;
      }
      return along / total;
    });
    squareness.sort((a, b) => a - b);
    expect(squareness[squareness.length >> 1]).toBeGreaterThan(0.6);
    // Their old closes were thrown into the fields, leaving ghost boundaries.
    expect(cad.ghosts.length).toBeGreaterThan(0);
  }, 60_000);
});
