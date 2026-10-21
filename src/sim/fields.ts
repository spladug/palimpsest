// Rural land division: closes around farmsteads, and the open-field layout of
// a township (furlongs of strips, meadow, common pasture). The geometry is
// generic; field-system parameters come from the technology plugin and rights
// from the tenure plugin.

import { Delaunay } from 'd3-delaunay';
import type { Vec2 } from './geom';
import {
  bufferPolyline,
  differenceMany,
  distanceToBoundary,
  intersection,
  pointInShape,
  radialPolygon,
  rectangle,
  ringCentroid,
  shapeArea,
  thickness,
  union,
  type Bounds,
  type Shape,
} from './polygon';
import type { Rng } from './rng';
import type { EdgeClass } from './graph';
import type { World } from './world';
import type { Parcel } from './cadastre';
import type { FieldRules } from '../plugins/types';

const WAY_HALF_WIDTH: Record<EdgeClass, number> = { path: 2, track: 3, lane: 4, road: 5 };

/** A wobbly outline: radius varies smoothly with angle. */
export function wobblyOutline(rng: Rng, centre: Vec2, radius: number, wobble = 0.2): Shape {
  const phases = [rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3)];
  return radialPolygon(centre, (a) =>
    radius * (1 + wobble * (0.9 * Math.sin(2 * a + phases[0]) + 0.6 * Math.sin(3 * a + phases[1]) + 0.35 * Math.sin(5 * a + phases[2]))),
  );
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Corridors occupied by ways, rivers and existing parcels near an area. */
function obstacles(world: World, area: Bounds, includeParcels: (p: Parcel) => boolean): Shape[] {
  const out: Shape[] = [];
  for (const e of world.graph.edges.values()) {
    const b = edgeBounds(e.pts);
    if (overlaps(b, area)) out.push(bufferPolyline(e.pts, WAY_HALF_WIDTH[e.cls]));
  }
  for (const r of world.terrain.rivers) out.push(bufferPolyline(r.centreline, r.width / 2 + 4));
  for (const p of world.cadastre.parcels.values()) {
    if (includeParcels(p) && overlaps(p.bounds, area)) out.push(p.shape);
  }
  return out.filter((s) => s.length && s[0].length >= 3);
}

function edgeBounds(pts: readonly Vec2[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

function mapRect(world: World, inset = 2): Shape {
  const h = world.terrain.height;
  return rectangle({ minX: inset, minY: inset, maxX: h.worldWidth - inset, maxY: h.worldHeight - inset });
}

/** Dart-throwing Poisson-disc sample of points inside a shape. */
function poissonPoints(rng: Rng, shape: Shape, spacing: number, b: Bounds): Vec2[] {
  const pts: Vec2[] = [];
  const area = (b.maxX - b.minX) * (b.maxY - b.minY);
  const attempts = Math.ceil((area / (spacing * spacing)) * 30);
  for (let k = 0; k < attempts; k++) {
    const p = { x: rng.range(b.minX, b.maxX), y: rng.range(b.minY, b.maxY) };
    if (!pointInShape(p, shape)) continue;
    if (pts.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < spacing * spacing)) continue;
    pts.push(p);
  }
  return pts;
}

function voronoiCells(seeds: Vec2[], b: Bounds): Shape[] {
  if (seeds.length === 0) return [];
  if (seeds.length === 1) return [rectangle(b)];
  const delaunay = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number]));
  const vor = delaunay.voronoi([b.minX - 1, b.minY - 1, b.maxX + 1, b.maxY + 1]);
  return seeds.map((_, i) => {
    const poly = vor.cellPolygon(i);
    if (!poly) return [];
    const ring = poly.map(([x, y]) => ({ x, y }));
    ring.pop();
    return [ring];
  });
}

/** Closes: a farmstead's small hedged fields, split from the land around it. */
export function layOutCloses(world: World, centre: Vec2, holder: number, rng: Rng): Parcel[] {
  const rules = world.plugins.technology.fields;
  const radius = rules.closeRadius * rng.range(0.8, 1.2);
  const outline = intersection(wobblyOutline(rng, centre, radius, 0.25), mapRect(world))[0];
  if (!outline) return [];
  const b = edgeBounds(outline[0]);
  const free = differenceMany(outline, obstacles(world, b, (p) => p.retired === null));
  const seeds = [centre, ...poissonPoints(rng, outline, rules.closeSpacing, b)];
  const cells = voronoiCells(seeds, b);
  const tenure = world.plugins.tenure;
  const out: Parcel[] = [];
  for (const cell of cells) {
    if (!cell.length) continue;
    for (const freePart of free) {
      for (const part of intersection(cell, freePart)) {
        if (shapeArea(part) < 600) continue;
        const { regime, rights } = tenure.rights('close', holder, world.cadastre);
        out.push(world.cadastre.addParcel('close', part, regime, rights, world.clock.now));
      }
    }
  }
  world.cadastre.record({
    year: Math.round(world.clock.now),
    kind: 'create',
    parents: [],
    children: out.map((p) => p.id),
    note: `Closes laid out around the farmstead of ${world.cadastre.holderName(holder)}`,
  });
  return out;
}

/** Mean wetness, slope vector and height over a shape, by grid sampling. */
function sampleTerrain(world: World, shape: Shape, step = 15) {
  const t = world.terrain;
  const b = edgeBounds(shape[0]);
  let n = 0;
  let wet = 0;
  let gx = 0;
  let gy = 0;
  let steep = 0;
  const e = 10;
  for (let y = b.minY + step / 2; y < b.maxY; y += step) {
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      const p = { x, y };
      if (!pointInShape(p, shape)) continue;
      n++;
      wet += t.wetness.sample(p);
      const dx = (t.height.sample({ x: x + e, y }) - t.height.sample({ x: x - e, y })) / (2 * e);
      const dy = (t.height.sample({ x, y: y + e }) - t.height.sample({ x, y: y - e })) / (2 * e);
      gx += dx;
      gy += dy;
      steep += Math.hypot(dx, dy);
    }
  }
  if (!n) return null;
  return { wet: wet / n, gx: gx / n, gy: gy / n, slope: steep / n };
}

/**
 * Cut a furlong into strips running along `theta`, each with the reverse-S
 * curve of ox ploughing (Eyre 1955). Neighbouring strips share their curved
 * edges, so the furlong is tiled exactly.
 */
export function cutStrips(shape: Shape, theta: number, rng: Rng, rules: FieldRules): Shape[] {
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const p of shape[0]) {
    const u = p.x * ux + p.y * uy;
    const v = -p.x * uy + p.y * ux;
    umin = Math.min(umin, u);
    umax = Math.max(umax, u);
    vmin = Math.min(vmin, v);
    vmax = Math.max(vmax, v);
  }
  const L = umax - umin;
  const A = Math.min(rules.aratralMax, rules.aratralCurve * L);
  const offset = (u: number) => A * Math.sin((2 * Math.PI * (u - umin)) / L);
  const toWorld = (u: number, v: number): Vec2 => ({ x: u * ux - v * uy, y: u * uy + v * ux });
  const N = 14;
  const out: Shape[] = [];
  let v = vmin - A - 1;
  while (v < vmax + A + 1) {
    const w = Math.max(rules.stripWidth.min, Math.min(rules.stripWidth.max, rules.stripWidth.mean + rules.stripWidth.sd * rng.normal()));
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    for (let k = 0; k <= N; k++) {
      const u = umin - 2 + ((L + 4) * k) / N;
      left.push(toWorld(u, v + offset(u)));
      right.push(toWorld(u, v + w + offset(u)));
    }
    const band: Shape = [[...left, ...right.reverse()]];
    for (const part of intersection(band, shape)) if (shapeArea(part) > rules.minStripArea) out.push(part);
    v += w;
  }
  return out;
}

/** A piece of the township to be laid out, and the way strips would run on it. */
interface Block {
  shape: Shape;
  theta: number;
}

/**
 * Divide land into furlongs. Each is grown from a seed as a block about a
 * ploughing length along its strips, which run downslope so the furrows
 * drain. A block stops where the land changes (wet ground, steep ground, a
 * turn in the slope) or where it meets a way, the river or a furlong already
 * laid out, so its ends are headlands square to the strips. On the flat,
 * a furlong often lies across its neighbour. What is left between blocks
 * becomes meadow, common or odd-shaped gores.
 */
function furlongBlocks(world: World, land: Shape[], rng: Rng, rules: FieldRules): Block[] {
  const t = world.terrain;
  const grad = (p: Vec2, e: number): Vec2 => ({
    x: (t.height.sample({ x: p.x + e, y: p.y }) - t.height.sample({ x: p.x - e, y: p.y })) / (2 * e),
    y: (t.height.sample({ x: p.x, y: p.y + e }) - t.height.sample({ x: p.x, y: p.y - e })) / (2 * e),
  });
  // The lie of the land over a neighbourhood, not the tilt of each hummock.
  const slopeNear = (p: Vec2, r = rules.furlongLie): Vec2 => {
    let x = 0;
    let y = 0;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const g = grad({ x: p.x + (i * r) / 2, y: p.y + (j * r) / 2 }, r / 2);
        x += g.x / 25;
        y += g.y / 25;
      }
    }
    return { x, y };
  };
  const ploughable = (p: Vec2, theta: number): boolean => {
    if (t.wetness.sample(p) >= rules.meadowWetness) return false;
    const g = slopeNear(p);
    const m = Math.hypot(g.x, g.y);
    if (m >= rules.wasteSlope) return false;
    // Where the slope turns away, furrows along the old line would no longer drain.
    const turned = Math.abs(Math.cos(Math.atan2(g.y, g.x) - theta)) < Math.cos(rules.furlongTurn);
    return !(m > 2 * rules.drainageSlope && turned);
  };

  let remaining = land;
  const open = (p: Vec2) => remaining.some((s) => pointInShape(p, s));
  /** How far ploughing can run from a point in a direction, up to `max`. */
  const reach = (p: Vec2, d: Vec2, max: number, theta: number): number => {
    const step = 8;
    for (let s = step; s <= max; s += step) {
      const q = { x: p.x + d.x * s, y: p.y + d.y * s };
      // Run on into a neighbour, a way or the river: the block is trimmed to it exactly.
      if (!open(q)) return s;
      if (!ploughable(q, theta)) return s - step;
    }
    return max;
  };
  /** An interval of about `want` within [-back, ahead], centred on 0 where there is room. */
  const fit = (back: number, ahead: number, want: number): [number, number] => {
    const len = Math.min(want, back + ahead);
    if (ahead < len / 2) return [ahead - len, ahead];
    if (back < len / 2) return [-back, len - back];
    return [-len / 2, len / 2];
  };

  const blocks: (Block & { seed: Vec2 })[] = [];
  const nearest = (p: Vec2) => {
    let best: (typeof blocks)[number] | null = null;
    for (const b of blocks) if (!best || dist2(b.seed, p) < dist2(best.seed, p)) best = b;
    return best;
  };
  /** Strip direction at a seed: downslope, but laid out with or across the furlong next to it where that is close. */
  const direction = (seed: Vec2, next: { theta: number } | null): number => {
    const g = slopeNear(seed);
    if (Math.hypot(g.x, g.y) <= rules.drainageSlope) {
      return next ? next.theta + (rng.chance(rules.crossFurlong) ? Math.PI / 2 : 0) : rng.range(0, Math.PI);
    }
    const theta = Math.atan2(g.y, g.x);
    if (!next) return theta;
    const quarter = Math.round((theta - next.theta) / (Math.PI / 2));
    return Math.abs(theta - next.theta - quarter * (Math.PI / 2)) < rules.furlongSnap ? next.theta + quarter * (Math.PI / 2) : theta;
  };
  /** Lay out a furlong from a seed, returning seeds for the land beyond each of its sides. */
  const grow = (seed: Vec2, next: { theta: number } | null): Vec2[] => {
    if (!open(seed)) return [];
    const theta = direction(seed, next);
    if (!ploughable(seed, theta)) return [];
    const u = { x: Math.cos(theta), y: Math.sin(theta) };
    const v = { x: -u.y, y: u.x };
    const length = rng.range(rules.furlongLength.min, rules.furlongLength.max);
    const [u0, u1] = fit(reach(seed, { x: -u.x, y: -u.y }, length, theta), reach(seed, u, length, theta), length);
    if (u1 - u0 < rules.furlongLength.min / 2) return [];
    const breadth = rng.range(rules.furlongBreadth.min, rules.furlongBreadth.max);
    const [v0, v1] = fit(reach(seed, { x: -v.x, y: -v.y }, breadth, theta), reach(seed, v, breadth, theta), breadth);
    if (v1 - v0 < rules.furlongBreadth.min / 2) return [];
    const at = (a: number, b: number) => ({ x: seed.x + u.x * a + v.x * b, y: seed.y + u.y * a + v.y * b });
    const rect = (a0: number, a1: number, b0: number, b1: number): Shape => [[at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]];
    const free = remaining.flatMap((s) => intersection(rect(u0, u1, v0, v1), s));
    const square = squareUp(free, at, u0, u1, v0, v1, rules);
    if (!square) return [];
    const [a0, a1, b0, b1] = square;
    const taken = free
      .flatMap((s) => intersection(s, rect(a0, a1, b0, b1)))
      .filter((s) => shapeArea(s) >= rules.minFurlongArea && thickness(s) >= rules.minGoreWidth);
    if (!taken.length) return [];
    for (const shape of taken) blocks.push({ shape, theta, seed });
    remaining = remaining.flatMap((s) => differenceMany(s, taken));
    const am = (a0 + a1) / 2;
    const bm = (b0 + b1) / 2;
    return [at(a1 + 10, bm), at(a0 - 10, bm), at(am, b1 + 10), at(am, b0 - 10)];
  };

  // Furlongs spread out from each other, so neighbours share headlands and sides.
  // Fresh seeds start new runs where the spread cannot reach; closer ones fill the gaps.
  for (const spacing of [rules.furlongSpacing, rules.furlongSpacing * 0.6]) {
    const seeds = remaining.flatMap((s) => poissonPoints(rng, s, spacing, edgeBounds(s[0])));
    for (const start of seeds) {
      const queue: { seed: Vec2; next: { theta: number } | null }[] = [{ seed: start, next: nearest(start) }];
      while (queue.length) {
        const { seed, next } = queue.shift()!;
        const before = blocks.length;
        const beyond = grow(seed, next);
        if (blocks.length > before) for (const p of beyond) queue.push({ seed: p, next: blocks[before] });
      }
    }
  }

  // The leftovers: gores between furlongs take their own slope or their neighbour's line.
  // Any too big for one furlong are divided along and across that line.
  const out: Block[] = blocks.map(({ shape, theta }) => ({ shape, theta }));
  const L = (rules.furlongLength.min + rules.furlongLength.max) / 2;
  const B = (rules.furlongBreadth.min + rules.furlongBreadth.max) / 2;
  for (const shape of remaining) {
    // Slivers too narrow to plough are left as grass balks.
    if (shapeArea(shape) < rules.minFurlongArea || thickness(shape) < rules.minGoreWidth) continue;
    const c = ringCentroid(shape[0]);
    const g = slopeNear(c);
    const theta = Math.hypot(g.x, g.y) > rules.drainageSlope ? Math.atan2(g.y, g.x) : (nearest(c)?.theta ?? rng.range(0, Math.PI));
    const parts = shapeArea(shape) > 1.5 * L * B ? divide(shape, theta, L, B) : [shape];
    for (const part of parts) {
      if (shapeArea(part) >= rules.minFurlongArea && thickness(part) >= rules.minGoreWidth) out.push({ shape: part, theta });
    }
  }
  return out;
}

/**
 * The largest rectangle, in a furlong's own frame, that its free land fills
 * row by row: each row runs along a strip. A neighbour or way cutting across
 * the strips at a slant is squared off, so the furlong keeps headlands at
 * right angles to its strips; the wedge beyond is left for a gore. Rows may
 * fall short of the rectangle by a little, so a slight slant is kept.
 * Returns [u0, u1, v0, v1], or null if nothing worth a furlong fits.
 */
function squareUp(
  free: Shape[],
  at: (a: number, b: number) => Vec2,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  rules: FieldRules,
): [number, number, number, number] | null {
  const step = 4;
  const slack = rules.headlandSlack;
  // The longest open run along each row.
  const rows: { v: number; from: number; to: number }[] = [];
  for (let v = v0 + step / 2; v < v1; v += step) {
    let best = { from: 0, to: -1 };
    let start: number | null = null;
    for (let a = u0; a <= u1 + 1e-6; a += step) {
      const inside = free.some((s) => pointInShape(at(a, v), s));
      if (inside && start === null) start = a;
      if ((!inside || a + step > u1 + 1e-6) && start !== null) {
        const end = inside ? a : a - step;
        if (end - start > best.to - best.from) best = { from: start, to: end };
        start = null;
      }
    }
    rows.push({ v, from: best.from - slack, to: best.to + slack });
  }
  let result: [number, number, number, number] | null = null;
  let bestArea = 0;
  for (let i = 0; i < rows.length; i++) {
    let from = -Infinity;
    let to = Infinity;
    for (let j = i; j < rows.length; j++) {
      from = Math.max(from, rows[j].from);
      to = Math.min(to, rows[j].to);
      const len = to - from;
      if (len < rules.furlongLength.min / 2) break;
      const area = len * (j - i + 1) * step;
      if (area > bestArea) {
        bestArea = area;
        result = [Math.max(u0, from), Math.min(u1, to), rows[i].v - step / 2, rows[j].v + step / 2];
      }
    }
  }
  return result && bestArea >= rules.minFurlongArea ? result : null;
}

/** Cut a shape by a grid of `along` × `across` cells lying along `theta`. */
function divide(shape: Shape, theta: number, along: number, across: number): Shape[] {
  const u = { x: Math.cos(theta), y: Math.sin(theta) };
  const v = { x: -u.y, y: u.x };
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of shape[0]) {
    const a = p.x * u.x + p.y * u.y;
    const b = p.x * v.x + p.y * v.y;
    u0 = Math.min(u0, a);
    u1 = Math.max(u1, a);
    v0 = Math.min(v0, b);
    v1 = Math.max(v1, b);
  }
  // Spread the cells evenly rather than leave a sliver at one end.
  const nu = Math.max(1, Math.round((u1 - u0) / along));
  const nv = Math.max(1, Math.round((v1 - v0) / across));
  const du = (u1 - u0) / nu;
  const dv = (v1 - v0) / nv;
  const at = (a: number, b: number) => ({ x: u.x * a + v.x * b, y: u.y * a + v.y * b });
  const out: Shape[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = u0 + i * du;
      const b = v0 + j * dv;
      const cell: Shape = [[at(a, b), at(a + du, b), at(a + du, b + dv), at(a, b + dv)]];
      out.push(...intersection(cell, shape));
    }
  }
  return out;
}

function dist2(a: Vec2, b: Vec2): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

export interface OpenFieldLayout {
  township: Shape;
  /** Ground left around the village centre for house plots. */
  villageCore: Shape;
  furlongs: number;
  strips: number;
  meadows: number;
  commons: number;
  /** One access point per furlong, on its edge nearest the village. */
  gates: { pos: Vec2; furlongId: number; area: number }[];
}

const FURLONG_NAMES = [
  'Long Furlong', 'Short Butts', 'Broad Lands', 'Stony Lands', 'Fox Holes', 'Hanging Lands', 'Gore Furlong',
  'Middle Furlong', 'Ox Close Furlong', 'Long Lands', 'Cross Furlong', 'Thorn Furlong', 'Sandy Lands',
  'Red Lands', 'Picked Furlong', 'Crabtree Furlong', 'Hollow Furlong', 'Windmill Furlong', 'Wheatlands',
  'Ryelands', 'Peaslands', 'Bean Furlong', 'Flaxlands', 'Linches', 'Wandlands', 'Shortlands', 'Headlands',
  'Ash Furlong', 'Elder Stubs', 'Gallows Furlong', 'Hare Furlong', 'Lark Furlong', 'Moor Furlong',
  'Pease Furlong', 'Rush Furlong', 'Twelve Acres', 'Nine Lands', 'Six Lands', 'Butts', 'Dole Furlong',
];

/**
 * Reorganise a township's land into open fields around a village centre.
 * `households` share the strips by sun-division: strips are handed out in a
 * fixed rotation, so each holding is scattered across every furlong.
 */
export function layOutOpenFields(
  world: World,
  township: Shape,
  centre: Vec2,
  households: number[],
  rng: Rng,
): OpenFieldLayout {
  const rules = world.plugins.technology.fields;
  const tenure = world.plugins.tenure;
  const cad = world.cadastre;
  const year = Math.round(world.clock.now);
  const tb = edgeBounds(township[0]);
  const villageCore = wobblyOutline(rng, centre, rules.villageCoreRadius, 0.15);
  const blocked = union(...obstacles(world, tb, (p) => p.retired === null), villageCore);
  const free = differenceMany(township, blocked);

  const blocks = furlongBlocks(world, free, rng, rules);
  const rotation = rng.range(0, Math.PI * 2);
  const fieldOf = (p: Vec2) => {
    const a = (((Math.atan2(p.y - centre.y, p.x - centre.x) - rotation) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return Math.min(2, Math.floor(a / ((2 * Math.PI) / 3)));
  };
  cad.greatFields = [0, 1, 2].map((i) => {
    const mid = rotation + (i + 0.5) * ((2 * Math.PI) / 3);
    return { name: `${compass(mid)} Field` };
  });

  const layout: OpenFieldLayout = { township, villageCore, furlongs: 0, strips: 0, meadows: 0, commons: 0, gates: [] };
  const names = [...FURLONG_NAMES];
  const used = new Set<string>();
  const community = cad.community!;
  const lord = cad.lord!;
  const church = [...cad.holders.values()].find((h) => h.kind === 'church')?.id ?? null;
  let turn = 0;

  for (const block of blocks) {
    const part = block.shape;
    const area = shapeArea(part);
    const s = sampleTerrain(world, part);
    if (!s) continue;
    if (s.wet >= rules.meadowWetness) {
      const { regime, rights } = tenure.rights('meadow', community, cad);
      cad.addParcel('meadow', part, regime, rights, year);
      layout.meadows++;
      continue;
    }
    if (s.slope >= rules.wasteSlope) {
      const { regime, rights } = tenure.rights('common', community, cad);
      cad.addParcel('common', part, regime, rights, year);
      layout.commons++;
      continue;
    }
    const theta = block.theta;
    const c = ringCentroid(part[0]);
    const name = names.length ? names.splice(rng.int(0, names.length), 1)[0] : qualifiedName(rng, used);
    used.add(name);
    const furlong = cad.addFurlong(name, part, theta, fieldOf(c));
    layout.furlongs++;

    const strips = cutStrips(part, theta, rng, rules);
    // Some furlongs hold a block of the lord's demesne.
    const demesne = rng.chance(rules.demesneShare)
      ? { from: rng.int(0, strips.length), len: Math.ceil(strips.length * rng.range(0.3, 0.6)) }
      : null;
    strips.forEach((shape, i) => {
      let holder: number;
      if (demesne && i >= demesne.from && i < demesne.from + demesne.len) {
        holder = lord;
      } else if (church !== null && (turn + 1) % rules.glebeEvery === 0) {
        holder = church;
        turn++;
      } else {
        holder = households[turn++ % households.length];
      }
      const { regime, rights } = tenure.rights('strip', holder, cad);
      cad.addParcel('strip', shape, regime, rights, year, furlong.id);
      layout.strips++;
    });
    // Each furlong starts the rotation somewhere new.
    turn += rng.int(0, households.length);

    let gate = part[0][0];
    for (const p of part[0]) if (Math.hypot(p.x - centre.x, p.y - centre.y) < Math.hypot(gate.x - centre.x, gate.y - centre.y)) gate = p;
    layout.gates.push({ pos: gate, furlongId: furlong.id, area });
  }
  return layout;
}

/** Once the plain names are used up: Upper Long Furlong, Nether Butts, and so on. */
function qualifiedName(rng: Rng, used: Set<string>): string {
  for (let k = 0; k < 50; k++) {
    const name = `${rng.pick(['Upper', 'Nether', 'Little', 'Great', 'Over', 'Far'])} ${rng.pick(FURLONG_NAMES)}`;
    if (!used.has(name)) return name;
  }
  return `Furlong ${used.size + 1}`;
}

/** The bounds of a township: a wobbly area around its centre, within the map. */
export function townshipOutline(world: World, centre: Vec2, radius: number, rng: Rng): Shape {
  return intersection(wobblyOutline(rng, centre, radius, 0.18), mapRect(world, 4))[0];
}

function compass(angle: number): string {
  // Screen y points south.
  const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return ['East', 'South', 'West', 'North'][Math.round(a / (Math.PI / 2)) % 4];
}

/** Closes of the given holders whose centre lies inside the township. */
export function closesWithin(world: World, township: Shape, holders: Set<number>): number[] {
  const out: number[] = [];
  for (const p of world.cadastre.parcels.values()) {
    if (p.kind !== 'close' || p.rights.withdrawal === undefined || !holders.has(p.rights.withdrawal)) continue;
    const c = ringCentroid(p.shape[0]);
    if (pointInShape(c, township)) out.push(p.id);
  }
  return out;
}

/** Walking speed multipliers from land use: crops are not trampled, headlands are walked. */
export function rasteriseLandUse(world: World): void {
  const rules = world.plugins.technology.fields;
  const lf = world.landFactor;
  lf.data.fill(1);
  const cs = lf.cellSize;
  const paint = (shape: Shape, factor: (p: Vec2) => number) => {
    const b = edgeBounds(shape[0]);
    const i0 = Math.max(0, Math.floor(b.minX / cs));
    const i1 = Math.min(lf.width - 1, Math.floor(b.maxX / cs));
    const j0 = Math.max(0, Math.floor(b.minY / cs));
    const j1 = Math.min(lf.height - 1, Math.floor(b.maxY / cs));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const p = lf.cellCentre(i, j);
        if (pointInShape(p, shape)) lf.set(i, j, Math.min(lf.get(i, j), factor(p)));
      }
    }
  };
  for (const f of world.cadastre.furlongs.values()) {
    paint(f.shape, (p) => (distanceToBoundary(p, f.shape) < rules.headland ? 1 : rules.cropFactor));
  }
  for (const p of world.cadastre.parcels.values()) {
    if (p.kind === 'close') paint(p.shape, (q) => (distanceToBoundary(q, p.shape) < rules.headland ? 0.9 : rules.closeFactor));
    else if (p.kind === 'meadow') paint(p.shape, () => rules.meadowFactor);
    // House plots are private: people go round by the street or the back lane.
    else if (p.kind !== 'strip' && p.kind !== 'common' && p.kind !== 'market') paint(p.shape, () => rules.plotFactor);
  }
  // Nobody walks through a house: buildings are all but impassable.
  for (const b of world.cadastre.buildings.values()) paint(b.footprint, () => 0.04);
}
