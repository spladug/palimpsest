import { describe, expect, it } from 'vitest';
import { Clock } from '../src/sim/clock';
import { StreetGraph } from '../src/sim/graph';
import { DEFAULT_INSERT, insertRoute } from '../src/sim/insert';
import { Pathfinder, tobler, type CostField } from '../src/sim/pathfind';
import { Raster } from '../src/sim/raster';
import { Rng } from '../src/sim/rng';
import { createWorld } from '../src/sim/world';
import { medievalEngland } from '../src/plugins/medieval-england';
import type { Vec2 } from '../src/sim/geom';

const opts = { ...DEFAULT_INSERT, year: 900 };
const line = (a: Vec2, b: Vec2, n = 20): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));

describe('Rng', () => {
  it('is reproducible from a seed', () => {
    const a = new Rng('seed');
    const b = new Rng('seed');
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });
});

describe('Clock', () => {
  it('runs processes and events in time order', () => {
    const seen: string[] = [];
    const clock = new Clock<null>(900);
    clock.addProcess({ name: 'p', interval: 2, run: (_, now) => seen.push(`p${now}`) }, 901);
    clock.schedule({ time: 902, name: 'e', fire: () => seen.push('e902') });
    clock.advance(null, 905);
    expect(seen).toEqual(['p901', 'e902', 'p903', 'p905']);
  });
});

describe('insertRoute', () => {
  it('adds a new way, then reuses it for a similar route', () => {
    const g = new StreetGraph();
    const a = g.addNode({ x: 0, y: 0 }, 1).id;
    const b = g.addNode({ x: 300, y: 0 }, 2).id;
    insertRoute(g, line({ x: 0, y: 0 }, { x: 300, y: 0 }), 10, a, b, opts);
    expect(g.edges.size).toBe(1);
    // A route a few metres to one side follows the same way.
    const wobbly = line({ x: 0, y: 0 }, { x: 300, y: 0 }).map((p, i) => ({ x: p.x, y: i % 2 ? 6 : -4 }));
    wobbly[0] = { x: 0, y: 0 };
    wobbly[wobbly.length - 1] = { x: 300, y: 0 };
    insertRoute(g, wobbly, 5, a, b, opts);
    expect(g.edges.size).toBe(1);
    expect([...g.edges.values()][0].yearUse).toBe(15);
  });

  it('makes a crossroads where two routes cross', () => {
    const g = new StreetGraph();
    const ids = [
      g.addNode({ x: 0, y: 150 }, 1).id,
      g.addNode({ x: 300, y: 150 }, 2).id,
      g.addNode({ x: 150, y: 0 }, 3).id,
      g.addNode({ x: 150, y: 300 }, 4).id,
    ];
    insertRoute(g, line({ x: 0, y: 150 }, { x: 300, y: 150 }), 1, ids[0], ids[1], opts);
    insertRoute(g, line({ x: 150, y: 0 }, { x: 150, y: 300 }), 1, ids[2], ids[3], opts);
    const crossings = [...g.nodes.values()].filter((n) => g.degree(n.id) === 4);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].pos.x).toBeCloseTo(150, -1);
    expect(crossings[0].pos.y).toBeCloseTo(150, -1);
    expect(g.edges.size).toBe(4);
  });

  it('branches off an existing way at a T-junction', () => {
    const g = new StreetGraph();
    const a = g.addNode({ x: 0, y: 0 }, 1).id;
    const b = g.addNode({ x: 400, y: 0 }, 2).id;
    const c = g.addNode({ x: 300, y: 200 }, 3).id;
    insertRoute(g, line({ x: 0, y: 0 }, { x: 400, y: 0 }), 1, a, b, opts);
    const route = [...line({ x: 0, y: 0 }, { x: 200, y: 0 }, 10), ...line({ x: 200, y: 0 }, { x: 300, y: 200 }, 10).slice(1)];
    insertRoute(g, route, 1, a, c, opts);
    const tees = [...g.nodes.values()].filter((n) => g.degree(n.id) === 3);
    expect(tees).toHaveLength(1);
    expect(tees[0].pos.x).toBeGreaterThan(170);
    expect(tees[0].pos.x).toBeLessThan(230);
    expect(g.edges.size).toBe(3);
  });
});

describe('Pathfinder', () => {
  it('crosses water only at a ford', () => {
    const n = 40;
    const field: CostField = {
      height: new Raster(n, n, 10),
      speedFactor: new Raster(n, n, 10, 1),
      water: new Raster(n, n, 10),
      crossable: new Raster(n, n, 10),
      fordFactor: 0.5,
      speed: tobler,
      maxFactor: 1,
    };
    for (let j = 0; j < n; j++) {
      field.water.set(20, j, 1);
      field.water.set(21, j, 1);
    }
    field.crossable.set(20, 35, 1);
    field.crossable.set(21, 35, 1);
    const r = new Pathfinder(n, n).route(field, { x: 50, y: 50 }, { x: 350, y: 50 })!;
    expect(r).not.toBeNull();
    const crossing = r.points.find((p) => p.x > 200 && p.x < 220)!;
    expect(crossing.y).toBeGreaterThan(330);
  });
});

describe('World', () => {
  it('is deterministic for a seed', () => {
    const run = () => {
      const w = createWorld('test-seed', medievalEngland);
      w.clock.advance(w, 920);
      return { edges: w.graph.edges.size, places: w.places.length, len: Math.round(w.graph.totalLength()) };
    };
    expect(run()).toEqual(run());
  }, 60_000);
});
