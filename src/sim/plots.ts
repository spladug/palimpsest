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
    const quad: Shape = [[prev.front, next.front, backB, backA]];
    const mid = { x: (prev.front.x + next.front.x) / 2, y: (prev.front.y + next.front.y) / 2 };
    const inward = { x: (prev.dir.x + next.dir.x) / 2, y: (prev.dir.y + next.dir.y) / 2 };
    const probe = { x: mid.x + inward.x * 3, y: mid.y + inward.y * 3 };
    let best: Shape | null = null;
    for (const land of opts.land) {
      for (const part of intersection(quad, land)) {
        if (pointInShape(probe, part) && (!best || shapeArea(part) > shapeArea(best))) best = part;
      }
    }
    if (best && shapeArea(best) >= (opts.minArea ?? 150)) {
      out.push({
        shape: best,
        frontage: { a: prev.front, b: next.front, inward, street: opts.street },
        along: (prev.along + next.along) / 2,
      });
    }
    prev = next;
  }
  return out;
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
  const w = Math.max(3, fw - 2 * gap);
  const a = { x: f.a.x + u.x * gap + n.x * spec.setback, y: f.a.y + u.y * gap + n.y * spec.setback };
  const corner = (du: number, dn: number) => ({ x: a.x + u.x * du + n.x * dn, y: a.y + u.y * du + n.y * dn });
  const rect: Shape = [[corner(0, 0), corner(w, 0), corner(w, spec.depth), corner(0, spec.depth)]];
  const clipped = intersection(rect, plot);
  if (!clipped.length) return null;
  const footprint = clipped.reduce((x, y) => (shapeArea(y) > shapeArea(x) ? y : x));
  if (shapeArea(footprint) < 12) return null;
  // The ridge runs along the longer side.
  const ridge: [Vec2, Vec2] =
    w >= spec.depth
      ? [corner(0, spec.depth / 2), corner(w, spec.depth / 2)]
      : [corner(w / 2, 0), corner(w / 2, spec.depth)];
  return { footprint, ridge };
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
