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

  const seeds = poissonPoints(rng, township, rules.furlongSpacing, tb);
  const cells = voronoiCells(seeds, tb);
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

  for (const cell of cells) {
    if (!cell.length) continue;
    for (const freePart of free) {
      for (const part of intersection(cell, freePart)) {
        const area = shapeArea(part);
        if (area < rules.minFurlongArea) continue;
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
        // Strips run downslope so the furrows drain; on the flat, any way.
        const theta = Math.hypot(s.gx, s.gy) > rules.drainageSlope ? Math.atan2(s.gy, s.gx) : rng.range(0, Math.PI);
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
    }
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
