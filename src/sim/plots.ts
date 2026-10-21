// Cutting plots along a street frontage, and placing buildings on them.
//
// Plots are cut by lines running back from the street. Where the land behind
// was ploughed in strips running roughly the same way, the cut lines follow
// the strips, so plot boundaries inherit the field pattern (Slater; Ward 1962).

import { dist, polylineLength, resample, type Vec2 } from './geom';
import { intersection, pointInShape, shapeArea, type Shape } from './polygon';
import type { Frontage } from './cadastre';
import type { World } from './world';

export interface CutPlot {
  shape: Shape;
  frontage: Frontage;
  /** Distance along the street of the plot's frontage midpoint. */
  along: number;
}

export interface FrontageOptions {
  /** Distance from the street centreline to the plot fronts, as a function of distance along. */
  offset: (along: number) => number;
  depth: number;
  /** Width of the next plot. */
  width: () => number;
  /** Land plots may occupy. */
  land: Shape[];
  /** Preferred direction back from the street at a point, if the old field pattern suggests one. */
  grain?: (p: Vec2) => number | null;
  /** Largest angle (radians) by which a plot side may follow the grain rather than run square to the street. */
  maxSkew?: number;
  from?: number;
  to?: number;
  minArea?: number;
  street: string;
}

interface Station {
  along: number;
  front: Vec2;
  dir: Vec2;
  normal: Vec2;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Cut plots on one side (+1 left, -1 right) of a street centreline. */
export function cutFrontage(street: readonly Vec2[], side: 1 | -1, opts: FrontageOptions): CutPlot[] {
  const pts = resample(street, 2);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(total, opts.to ?? total);
  const maxSkew = opts.maxSkew ?? (35 * Math.PI) / 180;

  const at = (s: number): { p: Vec2; t: Vec2 } => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    const p = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
    // Tangent smoothed over a few metres, so kinks don't fan the plot lines.
    const a = pointAt(Math.max(0, s - 8));
    const b = pointAt(Math.min(total, s + 8));
    const len = dist(a, b) || 1;
    return { p, t: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
  };
  function pointAt(s: number): Vec2 {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
  }

  const station = (s: number): Station => {
    const { p, t } = at(s);
    const n = { x: -t.y * side, y: t.x * side };
    const off = opts.offset(s);
    const front = { x: p.x + n.x * off, y: p.y + n.y * off };
    let dir = n;
    const g = opts.grain?.({ x: front.x + n.x * 15, y: front.y + n.y * 15 });
    if (g !== null && g !== undefined) {
      let v = { x: Math.cos(g), y: Math.sin(g) };
      if (v.x * n.x + v.y * n.y < 0) v = { x: -v.x, y: -v.y };
      if (Math.acos(Math.min(1, v.x * n.x + v.y * n.y)) <= maxSkew) dir = v;
    }
    return { along: s, front, dir, normal: n };
  };

  /** Points on the front line strictly between two stations, if they run in order along the chord. */
  const frontBetween = (p: Station, q: Station): Vec2[] => {
    const cx = q.front.x - p.front.x;
    const cy = q.front.y - p.front.y;
    const c2 = cx * cx + cy * cy;
    const pts: Vec2[] = [];
    let last = 0;
    for (let t = p.along + 2; t < q.along - 1; t += 2) {
      const { p: c, t: tan } = at(t);
      const off = opts.offset(t);
      const f = { x: c.x - tan.y * side * off, y: c.y + tan.x * side * off };
      const k = ((f.x - p.front.x) * cx + (f.y - p.front.y) * cy) / c2;
      // On the inside of a tight bend the offset line loops back on itself: keep the chord there.
      if (k <= last || k >= 1) return [];
      last = k;
      pts.push(f);
    }
    return pts;
  };

  const out: CutPlot[] = [];
  let prev = station(from);
  let s = from;
  while (s < to - 3) {
    const w = opts.width();
    const next = station(Math.min(to, s + w));
    s = next.along;
    const back = (st: Station, d: Vec2) => ({ x: st.front.x + d.x * opts.depth, y: st.front.y + d.y * opts.depth });
    let backA = back(prev, prev.dir);
    let backB = back(next, next.dir);
    // If the two side lines cross (sharp bend, changing grain), square them to the street.
    if (segmentsCross(prev.front, backA, next.front, backB)) {
      backA = back(prev, prev.normal);
      backB = back(next, next.normal);
    }
    // The front follows the street round a bend rather than cutting the corner on a chord.
    const quad: Shape = [[prev.front, ...frontBetween(prev, next), next.front, backB, backA]];
    const mid = { x: (prev.front.x + next.front.x) / 2, y: (prev.front.y + next.front.y) / 2 };
    const inward = { x: (prev.dir.x + next.dir.x) / 2, y: (prev.dir.y + next.dir.y) / 2 };
    const probe = { x: mid.x + inward.x * 3, y: mid.y + inward.y * 3 };
    let best: Shape | null = null;
    for (const land of opts.land) {
      for (const part of intersection(quad, land)) {
        if (pointInShape(probe, part) && (!best || shapeArea(part) > shapeArea(best))) best = part;
      }
    }
    // A plot's front is the stretch where it actually reaches the street: where land beside
    // it was not to be had, it is narrower than the cut. Too little of a front, and it is no plot.
    const front = best && frontRun(best, prev.front, next.front, inward);
    if (best && front && dist(front.a, front.b) >= MIN_FRONT && shapeArea(best) >= (opts.minArea ?? 150)) {
      out.push({
        shape: best,
        frontage: { a: front.a, b: front.b, inward, street: opts.street },
        along: (prev.along + next.along) / 2,
      });
    }
    prev = next;
  }
  return out;
}

/** The narrowest front a plot can have and still be built on. */
const MIN_FRONT = 4;
/** The narrowest house worth building (a one-room cottage is about this wide). */
const MIN_HOUSE_WIDTH = 3.6;

/**
 * The longest stretch of a front line (a to b) along which the plot lies just
 * behind it, and fills the ground for a few metres back.
 */
function frontRun(plot: Shape, a: Vec2, b: Vec2, inward: Vec2): { a: Vec2; b: Vec2 } | null {
  const len = dist(a, b);
  const il = Math.hypot(inward.x, inward.y) || 1;
  const n = { x: inward.x / il, y: inward.y / il };
  const at = (t: number, back: number) => ({ x: a.x + (b.x - a.x) * t + n.x * back, y: a.y + (b.y - a.y) * t + n.y * back });
  const steps = Math.max(2, Math.ceil(len / 0.5));
  let best: [number, number] | null = null;
  let start = -1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ok = i < steps && [0.6, 2, 3.5].every((d) => pointInShape(at(t, d), plot));
    if (ok && start < 0) start = t;
    if (!ok && start >= 0) {
      const end = (i - 1) / steps;
      if (!best || end - start > best[1] - best[0]) best = [start, end];
      start = -1;
    }
  }
  if (!best) return null;
  // Snap to the cut ends when the run reaches within a step of them.
  const t0 = best[0] <= 1.5 / steps ? 0 : best[0];
  const t1 = best[1] >= 1 - 1.5 / steps ? 1 : best[1];
  return { a: at(t0, 0), b: at(t1, 0) };
}

export interface BuildingSpec {
  /** 'full' fills the frontage (terraced town houses); otherwise a width in metres. */
  width: number | 'full';
  depth: number;
  /** Gap left between the street and the building front. */
  setback: number;
  /** Gap left at each side for a detached house. */
  sideGap?: number;
}

/** A rectangular footprint at the front of a plot, clipped to the plot. */
export function frontBuilding(plot: Shape, f: Frontage, spec: BuildingSpec): { footprint: Shape; ridge: [Vec2, Vec2] } | null {
  const along = { x: f.b.x - f.a.x, y: f.b.y - f.a.y };
  const fw = Math.hypot(along.x, along.y);
  if (fw < 3) return null;
  const u = { x: along.x / fw, y: along.y / fw };
  // Use the normal to the frontage (not the skewed plot side), so houses face the street.
  let n = { x: -u.y, y: u.x };
  if (n.x * f.inward.x + n.y * f.inward.y < 0) n = { x: -n.x, y: -n.y };
  const gap = spec.width === 'full' ? 0.3 : Math.max(spec.sideGap ?? 1.5, (fw - spec.width) / 2);
  const w = fw - 2 * gap;
  // Too narrow for a house: the plot stays a yard or garden.
  if (w < MIN_HOUSE_WIDTH) return null;
  const a = { x: f.a.x + u.x * gap + n.x * spec.setback, y: f.a.y + u.y * gap + n.y * spec.setback };
  const corner = (du: number, dn: number) => ({ x: a.x + u.x * du + n.x * dn, y: a.y + u.y * du + n.y * dn });
  // Where the plot narrows behind the front, build shallower rather than squeeze the house into a wedge.
  for (const depth of [spec.depth, spec.depth * 0.8, spec.depth * 0.6]) {
    const rect: Shape = [[corner(0, 0), corner(w, 0), corner(w, depth), corner(0, depth)]];
    const clipped = intersection(rect, plot);
    if (!clipped.length) continue;
    const footprint = clipped.reduce((x, y) => (shapeArea(y) > shapeArea(x) ? y : x));
    if (shapeArea(footprint) < Math.max(12, 0.9 * w * depth)) continue;
    // The ridge runs along the longer side.
    const ridge: [Vec2, Vec2] =
      w >= depth ? [corner(0, depth / 2), corner(w, depth / 2)] : [corner(w / 2, 0), corner(w / 2, depth)];
    return { footprint, ridge };
  }
  return null;
}

/**
 * Whether a newly cut plot overlaps any already accepted. Plots cut on two
 * sides of a bending street, or along two ways that meet, can cross; the
 * first cut keeps the ground.
 */
export function overlapsAny(shape: Shape, accepted: readonly CutPlot[]): boolean {
  const b = shapeBounds(shape);
  return accepted.some((q) => {
    const qb = shapeBounds(q.shape);
    if (qb.maxX < b.minX || b.maxX < qb.minX || qb.maxY < b.minY || b.maxY < qb.minY) return false;
    return intersection(q.shape, shape).some((x) => shapeArea(x) > 1);
  });
}

function shapeBounds(shape: Shape) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of shape[0]) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Plot widths as perch multiples (1 perch = 16½ feet ≈ 5.03 m), drawn from weights. */
export function perchWidths(world: World, weights: Record<number, number>): () => number {
  const perch = 5.03;
  const units = Object.keys(weights).map(Number);
  const w = units.map((u) => weights[u]);
  return () => units[world.rng.weightedIndex(w)] * perch;
}

/** The parts of a polyline inside a shape, as separate runs. */
export function clipPolyline(pts: readonly Vec2[], shape: Shape, step = 4): Vec2[][] {
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of resample(pts, step)) {
    if (pointInShape(p, shape)) cur.push(p);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2 && polylineLength(r) > 0);
}

/** A plot's own frame: along its frontage (u), into it (n), and how far back it reaches. */
export interface PlotFrame {
  origin: Vec2;
  u: Vec2;
  n: Vec2;
  width: number;
  depth: number;
}

export function plotFrame(plot: Shape, f: Frontage): PlotFrame {
  const fw = dist(f.a, f.b);
  const u = { x: (f.b.x - f.a.x) / (fw || 1), y: (f.b.y - f.a.y) / (fw || 1) };
  let n = { x: -u.y, y: u.x };
  if (n.x * f.inward.x + n.y * f.inward.y < 0) n = { x: -n.x, y: -n.y };
  let depth = 0;
  for (const p of plot[0]) depth = Math.max(depth, (p.x - f.a.x) * n.x + (p.y - f.a.y) * n.y);
  return { origin: f.a, u, n, width: fw, depth };
}

/** A rectangle in a plot's frame: `u0..u1` along the frontage, `n0..n1` back from it. */
export function frameRect(fr: PlotFrame, u0: number, u1: number, n0: number, n1: number): Shape {
  const at = (du: number, dn: number) => ({
    x: fr.origin.x + fr.u.x * du + fr.n.x * dn,
    y: fr.origin.y + fr.u.y * du + fr.n.y * dn,
  });
  return [[at(u0, n0), at(u1, n0), at(u1, n1), at(u0, n1)]];
}

/**
 * Where the next back-land building goes: a range along one side boundary,
 * behind whatever already stands, working back from the street (repletion).
 * Returns null when the back land is full.
 */
export function nextBackBuilding(
  plot: Shape,
  f: Frontage,
  existing: Shape[],
  size: { width: number; depth: number },
  preferSide: 0 | 1,
): { footprint: Shape; ridge: [Vec2, Vec2] } | null {
  const fr = plotFrame(plot, f);
  const w = Math.min(size.width, fr.width * 0.55);
  if (w < 3) return null;
  const gap = 0.4;
  for (const side of preferSide ? [1, 0] : [0, 1]) {
    const u0 = side === 0 ? gap : fr.width - gap - w;
    for (let n0 = 6; n0 + size.depth < fr.depth - 3; n0 += 1.5) {
      const rect = frameRect(fr, u0, u0 + w, n0, n0 + size.depth);
      const inside = intersection(rect, plot);
      const area = inside.reduce((s, x) => s + shapeArea(x), 0);
      // Wholly within the plot: a range doesn't lean over the neighbour's wall.
      if (area < w * size.depth * 0.995) continue;
      // Keep clear of what stands, with a narrow passage between.
      const grown = frameRect(fr, u0 - 0.2, u0 + w + 0.2, n0 - 1, n0 + size.depth + 1);
      if (existing.some((b) => intersection(grown, b).some((x) => shapeArea(x) > 0.5))) continue;
      const ridge: [Vec2, Vec2] = [
        { x: fr.origin.x + fr.u.x * (u0 + w / 2) + fr.n.x * n0, y: fr.origin.y + fr.u.y * (u0 + w / 2) + fr.n.y * n0 },
        {
          x: fr.origin.x + fr.u.x * (u0 + w / 2) + fr.n.x * (n0 + size.depth),
          y: fr.origin.y + fr.u.y * (u0 + w / 2) + fr.n.y * (n0 + size.depth),
        },
      ];
      return { footprint: rect, ridge };
    }
  }
  return null;
}

/**
 * Split a plot lengthwise, from the middle of its frontage back along the
 * direction between its side boundaries. Returns the two halves, or null if
 * the cut does not divide it cleanly.
 */
export function splitLengthwise(plot: Shape, f: Frontage, at = 0.5): { shape: Shape; frontage: Frontage }[] | null {
  const m = { x: f.a.x + (f.b.x - f.a.x) * at, y: f.a.y + (f.b.y - f.a.y) * at };
  const fr = plotFrame(plot, f);
  const L = fr.depth * 3 + fr.width * 3 + 50;
  const d = f.inward;
  const dl = Math.hypot(d.x, d.y) || 1;
  const dir = { x: d.x / dl, y: d.y / dl };
  // Half-planes either side of the cut line, as big rectangles.
  const towards = (sign: 1 | -1): Shape => {
    const s = { x: fr.u.x * sign * L, y: fr.u.y * sign * L };
    const p0 = { x: m.x - dir.x * L, y: m.y - dir.y * L };
    const p1 = { x: m.x + dir.x * L, y: m.y + dir.y * L };
    return [[p0, p1, { x: p1.x + s.x, y: p1.y + s.y }, { x: p0.x + s.x, y: p0.y + s.y }]];
  };
  const pick = (parts: Shape[]) => parts.reduce<Shape | null>((a, b) => (!a || shapeArea(b) > shapeArea(a) ? b : a), null);
  const left = pick(intersection(plot, towards(-1)));
  const right = pick(intersection(plot, towards(1)));
  if (!left || !right || shapeArea(left) < 60 || shapeArea(right) < 60) return null;
  return [
    { shape: left, frontage: { a: f.a, b: m, inward: f.inward, street: f.street } },
    { shape: right, frontage: { a: m, b: f.b, inward: f.inward, street: f.street } },
  ];
}

/** Two plots side by side on the same street share a front corner. */
export function frontNeighbours(a: Frontage, b: Frontage): 'a-b' | 'b-a' | null {
  if (a.street !== b.street) return null;
  if (dist(a.b, b.a) < 0.5) return 'a-b';
  if (dist(b.b, a.a) < 0.5) return 'b-a';
  return null;
}

/** The frontage of two neighbouring plots joined into one. */
export function joinFrontages(left: Frontage, right: Frontage): Frontage {
  const inward = { x: (left.inward.x + right.inward.x) / 2, y: (left.inward.y + right.inward.y) / 2 };
  return { a: left.a, b: right.b, inward, street: left.street };
}
