// Physical plausibility checks: things that should never happen on the ground,
// whatever the history. Each check returns violations with a position, so they
// can be counted in batch runs and highlighted on the map.

import { dist, projectOnPolyline, undirectedBearing, type Vec2 } from './geom';
import { bounds, difference, distanceToBoundary, intersection, pointInShape, ringCentroid, shapeArea, thickness, type Bounds, type Shape } from './polygon';
import { frameRect, plotFrame } from './plots';
import { wayWidth, type GraphEdge } from './graph';
import { GROUNDS_KINDS, SOLID_KINDS, TOWN_PLOT_KINDS } from './cadastre';
import type { World } from './world';

export type ViolationKind =
  | 'parcel overlap'
  | 'sliver parcel'
  | 'building overlap'
  | 'building off its parcel'
  | 'building on a way'
  | 'building in the river'
  | 'plot on a way'
  | 'plot without access'
  | 'malformed plot'
  | 'wedge building'
  | 'narrow building'
  | 'skewed front'
  | 'ways cross without a junction'
  | 'way crosses itself'
  | 'way crosses the river away from a ford';

export const VIOLATION_KINDS: readonly ViolationKind[] = [
  'parcel overlap',
  'sliver parcel',
  'building overlap',
  'building off its parcel',
  'building on a way',
  'building in the river',
  'plot on a way',
  'plot without access',
  'malformed plot',
  'wedge building',
  'narrow building',
  'skewed front',
  'ways cross without a junction',
  'way crosses itself',
  'way crosses the river away from a ford',
];

export interface Violation {
  kind: ViolationKind;
  at: Vec2;
  /** Parcel, building or edge ids involved. */
  ids: number[];
  /** Overlap area (m²), angle (degrees) or width (m), as fits the check. */
  size: number;
  note: string;
}

const TOWN_PLOTS = TOWN_PLOT_KINDS;
const SOLID = SOLID_KINDS;

/** Areas below these are rounding, not real overlaps. */
const OVERLAP_TOLERANCE = { parcel: 2, building: 0.5, plotOnWay: 2, buildingOnWay: 0.5 };
/** How far a plot's front may sit from the centreline of a way before it has no access (a road's half-width, a verge and a margin). */
const ACCESS_REACH = 8;
/** Depth of ground behind a plot's front that it should fill. */
const FRONT_BAND = 3;
/** Fords are points; a way crossing within this distance of one uses it. */
const FORD_REACH = 60;

const overlaps = (a: Bounds, b: Bounds) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const areaOf = (shapes: Shape[]) => shapes.reduce((s, x) => s + shapeArea(x), 0);
const centre = (s: Shape) => ringCentroid(s[0]);

/** All pairs of items whose bounds overlap, by a sweep along x. */
function boundPairs<T>(items: T[], bb: (t: T) => Bounds): [T, T][] {
  const sorted = items.map((t) => ({ t, b: bb(t) })).sort((p, q) => p.b.minX - q.b.minX);
  const out: [T, T][] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].b.minX < sorted[i].b.maxX; j++) {
      if (overlaps(sorted[i].b, sorted[j].b)) out.push([sorted[i].t, sorted[j].t]);
    }
  }
  return out;
}

/** Pairs across two lists whose bounds overlap. */
function crossPairs<A, B>(as: A[], ab: (a: A) => Bounds, bs: B[], bb: (b: B) => Bounds): [A, B][] {
  const sa = as.map((t) => ({ t, b: ab(t) })).sort((p, q) => p.b.minX - q.b.minX);
  const sb = bs.map((t) => ({ t, b: bb(t) })).sort((p, q) => p.b.minX - q.b.minX);
  const out: [A, B][] = [];
  let start = 0;
  for (const a of sa) {
    while (start < sb.length && sb[start].b.maxX < a.b.minX - 50) start++;
    for (let j = start; j < sb.length && sb[j].b.minX < a.b.maxX; j++) {
      if (overlaps(a.b, sb[j].b)) out.push([a.t, sb[j].t]);
    }
  }
  return out;
}

function grow(b: Bounds, r: number): Bounds {
  return { minX: b.minX - r, minY: b.minY - r, maxX: b.maxX + r, maxY: b.maxY + r };
}

/** Area of a shape lying on a way's carriageway, by sampling a grid of the given step. */
function areaNear(shape: Shape, sb: Bounds, way: { pts: readonly Vec2[]; half: number; b: Bounds }, step: number): number {
  const x0 = Math.max(sb.minX, way.b.minX);
  const x1 = Math.min(sb.maxX, way.b.maxX);
  const y0 = Math.max(sb.minY, way.b.minY);
  const y1 = Math.min(sb.maxY, way.b.maxY);
  let n = 0;
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      const p = { x, y };
      if (projectOnPolyline(p, way.pts).dist < way.half && pointInShape(p, shape)) n++;
    }
  }
  return n * step * step;
}

/** The point where segments pq and rs cross strictly inside both, if they do. */
function crossing(p: Vec2, q: Vec2, r: Vec2, s: Vec2): Vec2 | null {
  const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
  const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
}

function polylineCrossing(a: readonly Vec2[], b: readonly Vec2[]): Vec2 | null {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const x = crossing(a[i - 1], a[i], b[j - 1], b[j]);
      if (x) return x;
    }
  }
  return null;
}

/** Smallest interior angle of a ring, in degrees (convex corners only). */
function sharpestCorner(ring: readonly Vec2[]): number {
  const n = ring.length;
  const ccw = ringSignedArea(ring) > 0;
  let min = 180;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n];
    const b = ring[i];
    const c = ring[(i + 1) % n];
    const ux = a.x - b.x;
    const uy = a.y - b.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 0.3 || lv < 0.3) continue;
    const cross = vx * uy - vy * ux;
    if (ccw ? cross < 0 : cross > 0) continue; // reflex corner
    const ang = (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) * 180) / Math.PI;
    min = Math.min(min, ang);
  }
  return min;
}

function ringSignedArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  return a / 2;
}

/** Width of a footprint across its ridge: area over ridge length, for a roughly rectangular range. */
function spanAcross(footprint: Shape, ridge: [Vec2, Vec2]): number {
  const len = dist(ridge[0], ridge[1]);
  return len > 0 ? shapeArea(footprint) / len : 0;
}

/** Angle between two undirected bearings, folded to 0..45: 0 is parallel or square. */
function offSquare(a: number, b: number): number {
  const d = Math.abs(a - b) % 90;
  return Math.min(d, 90 - d);
}

export interface CheckOptions {
  /** Only these checks. */
  only?: ReadonlySet<ViolationKind>;
}

export function checkWorld(world: World, opts: CheckOptions = {}): Violation[] {
  const want = (k: ViolationKind) => !opts.only || opts.only.has(k);
  const out: Violation[] = [];
  const cad = world.cadastre;
  const parcels = [...cad.parcels.values()].filter((p) => p.retired === null);
  const buildings = [...cad.buildings.values()];
  const edges = [...world.graph.edges.values()];
  const buildingBounds = new Map(buildings.map((b) => [b.id, bounds(b.footprint)]));

  if (want('parcel overlap')) {
    for (const [a, b] of boundPairs(parcels, (p) => p.bounds)) {
      const x = areaOf(intersection(a.shape, b.shape));
      if (x > OVERLAP_TOLERANCE.parcel) {
        out.push({ kind: 'parcel overlap', at: centre(a.shape), ids: [a.id, b.id], size: x, note: `${a.kind} and ${b.kind}` });
      }
    }
  }
  if (want('sliver parcel')) {
    for (const p of parcels) {
      const t = thickness(p.shape);
      if (t < 1.5) out.push({ kind: 'sliver parcel', at: centre(p.shape), ids: [p.id], size: t, note: p.kind });
    }
  }

  if (want('building overlap')) {
    for (const [a, b] of boundPairs(buildings, (b) => buildingBounds.get(b.id)!)) {
      const x = areaOf(intersection(a.footprint, b.footprint));
      if (x > OVERLAP_TOLERANCE.building) {
        out.push({ kind: 'building overlap', at: centre(a.footprint), ids: [a.id, b.id], size: x, note: `${a.use} (${a.built}) and ${b.use} (${b.built})` });
      }
    }
  }
  if (want('building off its parcel')) {
    for (const b of buildings) {
      const p = b.parcelId !== null ? cad.parcels.get(b.parcelId) : undefined;
      if (!p || p.retired !== null) {
        out.push({ kind: 'building off its parcel', at: centre(b.footprint), ids: [b.id], size: shapeArea(b.footprint), note: p ? 'parcel retired' : 'no parcel' });
        continue;
      }
      const outside = areaOf(difference(b.footprint, p.shape));
      if (outside > OVERLAP_TOLERANCE.building) {
        out.push({ kind: 'building off its parcel', at: centre(b.footprint), ids: [b.id, p.id], size: outside, note: `${b.use} on ${p.kind}` });
      }
    }
  }
  if (want('wedge building') || want('narrow building')) {
    for (const b of buildings) {
      if (b.use === 'church') continue;
      const corner = sharpestCorner(b.footprint[0]);
      if (want('wedge building') && corner < 45) {
        out.push({ kind: 'wedge building', at: centre(b.footprint), ids: [b.id], size: corner, note: b.use });
      }
      const span = spanAcross(b.footprint, b.ridge);
      // A privy or a lean-to is meant to be small; only buildings big enough to live or work in count.
      if (want('narrow building') && span < 2.5 && shapeArea(b.footprint) >= 12) {
        out.push({ kind: 'narrow building', at: centre(b.footprint), ids: [b.id], size: span, note: b.use });
      }
    }
  }
  if (want('skewed front')) {
    for (const b of buildings) {
      if (b.back || b.parcelId === null) continue;
      const p = cad.parcels.get(b.parcelId);
      if (!p?.frontage || !TOWN_PLOTS.has(p.kind)) continue;
      const off = offSquare(undirectedBearing(b.ridge[0], b.ridge[1]), undirectedBearing(p.frontage.a, p.frontage.b));
      if (off > 15) out.push({ kind: 'skewed front', at: centre(b.footprint), ids: [b.id, p.id], size: off, note: b.use });
    }
  }

  // Ways: the carriageway as drawn on the map, measured by distance from the centreline
  // (buffer polygons of tightly bending ways cross themselves, which clipping can't take).
  const ways = edges.map((e) => ({ e, pts: e.pts, half: wayWidth(e) / 2, b: grow(bounds([e.pts]), wayWidth(e) / 2) }));
  if (want('building on a way')) {
    for (const [w, b] of crossPairs(ways, (w) => w.b, buildings, (b) => buildingBounds.get(b.id)!)) {
      const x = areaNear(b.footprint, buildingBounds.get(b.id)!, w, 0.4);
      if (x > OVERLAP_TOLERANCE.buildingOnWay) {
        out.push({ kind: 'building on a way', at: centre(b.footprint), ids: [b.id, w.e.id], size: x, note: `${b.use} (${b.built}) on ${w.e.cls} (${w.e.created})` });
      }
    }
  }
  if (want('plot on a way')) {
    const solid = parcels.filter((p) => SOLID.has(p.kind));
    for (const [w, p] of crossPairs(ways, (w) => w.b, solid, (p) => p.bounds)) {
      // A way may lead in through the gate of an institution's grounds to the place within.
      if (GROUNDS_KINDS.has(p.kind) && [w.e.a, w.e.b].some((n) => pointInShape(world.graph.nodes.get(n)!.pos, p.shape))) continue;
      const x = areaNear(p.shape, p.bounds, w, 0.8);
      if (x > OVERLAP_TOLERANCE.plotOnWay) {
        out.push({ kind: 'plot on a way', at: centre(p.shape), ids: [p.id, w.e.id], size: x, note: `${p.kind} (${p.created}) on ${w.e.cls} (${w.e.created})` });
      }
    }
  }
  if (want('plot without access')) {
    // Plots round a market place open onto it.
    const markets = parcels.filter((p) => p.kind === 'market');
    for (const p of parcels) {
      if (!TOWN_PLOTS.has(p.kind) || !p.frontage) continue;
      const f = p.frontage;
      const fronts = [f.a, f.b, { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }];
      if (markets.some((q) => fronts.some((m) => pointInShape(m, q.shape) || distanceToBoundary(m, q.shape) < 2))) continue;
      const gap = Math.min(...fronts.map((m) => world.graph.nearestEdge(m, 40)?.proj.dist ?? 40));
      if (gap > ACCESS_REACH) out.push({ kind: 'plot without access', at: fronts[2], ids: [p.id], size: gap, note: `${p.kind} on ${f.street}` });
    }
  }
  if (want('malformed plot')) {
    // A plot should fill the strip of ground just behind its front: its front is its edge on the street.
    for (const p of parcels) {
      if (!TOWN_PLOTS.has(p.kind) || !p.frontage) continue;
      const fr = plotFrame(p.shape, p.frontage);
      const band = frameRect(fr, 0, fr.width, 0, FRONT_BAND);
      const fill = areaOf(intersection(band, p.shape)) / Math.max(1e-9, fr.width * FRONT_BAND);
      if (fill < 0.6) out.push({ kind: 'malformed plot', at: centre(band), ids: [p.id], size: fill, note: `${p.kind} (${p.created})` });
    }
  }

  if (want('ways cross without a junction')) {
    for (const [a, b] of boundPairs(edges, (e) => bounds([e.pts]))) {
      const x = polylineCrossing(a.pts, b.pts);
      if (x) out.push({ kind: 'ways cross without a junction', at: x, ids: [a.id, b.id], size: 0, note: `${a.cls} (${a.created}) and ${b.cls} (${b.created})` });
    }
  }
  if (want('way crosses itself')) {
    for (const e of edges) {
      const x = selfCrossing(e);
      if (x) out.push({ kind: 'way crosses itself', at: x, ids: [e.id], size: 0, note: e.cls });
    }
  }

  const rivers = world.terrain.rivers;
  if (want('building in the river')) {
    for (const r of rivers) {
      const water = { pts: r.centreline, half: r.width / 2, b: grow(bounds([r.centreline]), r.width / 2) };
      for (const b of buildings) {
        const bb = buildingBounds.get(b.id)!;
        if (b.use === 'mill' || !overlaps(water.b, bb)) continue;
        const x = areaNear(b.footprint, bb, water, 0.4);
        if (x > OVERLAP_TOLERANCE.building) out.push({ kind: 'building in the river', at: centre(b.footprint), ids: [b.id], size: x, note: b.use });
      }
    }
  }
  if (want('way crosses the river away from a ford')) {
    const fords = world.terrain.fords;
    for (const r of rivers) {
      for (const e of edges) {
        for (let i = 1; i < e.pts.length; i++) {
          for (let j = 1; j < r.centreline.length; j++) {
            const x = crossing(e.pts[i - 1], e.pts[i], r.centreline[j - 1], r.centreline[j]);
            if (!x) continue;
            const near = Math.min(...fords.map((f) => dist(f, x)));
            if (near > FORD_REACH) out.push({ kind: 'way crosses the river away from a ford', at: x, ids: [e.id], size: near, note: `${e.cls} (${e.created})` });
          }
        }
      }
    }
  }
  return out;
}

function selfCrossing(e: GraphEdge): Vec2 | null {
  const p = e.pts;
  for (let i = 1; i < p.length; i++) {
    for (let j = i + 2; j < p.length; j++) {
      if (i === 1 && j === p.length - 1 && dist(p[0], p[p.length - 1]) < 1e-6) continue;
      const x = crossing(p[i - 1], p[i], p[j - 1], p[j]);
      if (x) return x;
    }
  }
  return null;
}

/** Counts by kind, with every kind present. */
export function tally(violations: readonly Violation[]): Record<ViolationKind, number> {
  const t = Object.fromEntries(VIOLATION_KINDS.map((k) => [k, 0])) as Record<ViolationKind, number>;
  for (const v of violations) t[v.kind]++;
  return t;
}
