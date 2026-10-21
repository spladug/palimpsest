import { describe, expect, it } from 'vitest';
import { cutFrontage } from '../src/sim/plots';
import { shapeArea, type Shape } from '../src/sim/polygon';
import { createWorld } from '../src/sim/world';
import { medievalEngland } from '../src/plugins/medieval-england';

const field: Shape = [[{ x: -50, y: -200 }, { x: 450, y: -200 }, { x: 450, y: 200 }, { x: -50, y: 200 }]];

describe('cutFrontage', () => {
  it('cuts plots of the requested width that tile the frontage', () => {
    const plots = cutFrontage([{ x: 0, y: 0 }, { x: 400, y: 0 }], 1, {
      offset: () => 6,
      depth: 60,
      width: () => 15,
      land: [field],
      street: 'High Street',
    });
    // 26 full plots, then the 10 m left over at the end of the street.
    expect(plots.length).toBe(27);
    for (const p of plots.slice(0, -1)) expect(shapeArea(p.shape)).toBeCloseTo(15 * 60, -1);
    expect(shapeArea(plots[26].shape)).toBeCloseTo(10 * 60, -1);
    // All on the +y side (left of an eastward street, with y pointing down the screen).
    for (const p of plots) expect(p.frontage.inward.y).toBeGreaterThan(0.99);
  });

  it('follows the grain of old strips when it is close to square', () => {
    const grain = Math.PI / 2 + 0.3; // strips at ~17° off square
    const plots = cutFrontage([{ x: 0, y: 0 }, { x: 400, y: 0 }], 1, {
      offset: () => 6,
      depth: 60,
      width: () => 15,
      land: [field],
      grain: () => grain,
      street: 'High Street',
    });
    const dir = plots[5].frontage.inward;
    expect(Math.abs(Math.atan2(dir.y, dir.x) - grain)).toBeLessThan(0.01);
  });
});

describe('borough', () => {
  it('plants burgage plots held freely by burgesses, cut from the strips', () => {
    const w = createWorld('town-test', medievalEngland);
    w.clock.advance(w, 1300);
    const cad = w.cadastre;
    const burgages = [...cad.parcels.values()].filter((p) => p.kind === 'burgage');
    expect(burgages.length).toBeGreaterThan(10);
    const taken = burgages.find((p) => p.takenUp !== undefined)!;
    const burgess = taken.rights.withdrawal!;
    // Burgage tenure: the burgess, not the lord, may sell and divide.
    expect(taken.rights.alienation).toBe(burgess);
    expect(taken.rights.subdivide).toBe(burgess);
    expect([...cad.buildings.values()].some((b) => b.parcelId === taken.id)).toBe(true);
    // The strips the plots replaced are recorded in the history.
    expect(cad.history.some((e) => e.note.includes('burgage') && e.parents.length > 0)).toBe(true);
    expect([...cad.parcels.values()].some((p) => p.kind === 'market')).toBe(true);
  }, 120_000);
});
