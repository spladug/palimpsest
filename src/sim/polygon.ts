// Polygon helpers. A shape is a list of rings: the first is the outer boundary,
// any others are holes. Boolean operations go through polygon-clipping, which
// is robust to the awkward cases (touching edges, collinear points).

import * as pcModule from 'polygon-clipping';
import type { MultiPolygon, Polygon as PcPolygon } from 'polygon-clipping';
import { dist, type Vec2 } from './geom';

// The package's types declare named exports, but its ES build has only a default.
const polygonClipping = (pcModule as unknown as { default?: typeof pcModule }).default ?? pcModule;

export type Ring = Vec2[];
export type Shape = Ring[];

const toPc = (shape: Shape): PcPolygon => shape.map((ring) => ring.map((p) => [p.x, p.y] as [number, number]));

/** polygon-clipping rings repeat their first point at the end; ours don't. */
const fromPc = (mp: MultiPolygon): Shape[] =>
  mp.map((poly) =>
    poly.map((ring) => {
      const pts = ring.map(([x, y]) => ({ x, y }));
      if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
      return pts;
    }),
  );

/** Snap coordinates to a millimetre grid; often enough to get past a degenerate case. */
const snapShape = (shape: Shape): Shape =>
  shape.map((ring) => ring.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })));

/**
 * polygon-clipping occasionally fails on near-degenerate input (many overlapping
 * buffers meeting at shallow angles). Retry on a snapped grid before giving up.
 */
function robust<T>(op: (snap: (s: Shape) => Shape) => T): T {
  try {
    return op((x) => x);
  } catch {
    return op(snapShape);
  }
}

export function union(...shapes: Shape[]): Shape[] {
  if (!shapes.length) return [];
  try {
    return robust((snap) => {
      const [first, ...rest] = shapes.map((x) => toPc(snap(x)));
      return fromPc(polygonClipping.union(first, ...rest));
    });
  } catch {
    // Fold the shapes in one at a time, skipping any that still fail.
    let acc: Shape[] = [shapes[0]];
    for (const next of shapes.slice(1)) {
      try {
        acc = fromPc(polygonClipping.union(acc.map(toPc), toPc(snapShape(next))));
      } catch {
        /* skip */
      }
    }
    return acc;
  }
}

export function intersection(a: Shape, ...others: Shape[]): Shape[] {
  try {
    return robust((snap) => fromPc(polygonClipping.intersection(toPc(snap(a)), ...others.map((o) => toPc(snap(o))))));
  } catch {
    return [];
  }
}

export function difference(a: Shape, ...others: Shape[]): Shape[] {
  return differenceMany(a, others);
}

/** Subtract many shapes from one. */
export function differenceMany(a: Shape, others: Shape[]): Shape[] {
  if (!others.length) return [a];
  try {
    return robust((snap) => fromPc(polygonClipping.difference(toPc(snap(a)), others.map((o) => toPc(snap(o))))));
  } catch {
    let acc: Shape[] = [a];
    for (const o of others) {
      try {
        acc = fromPc(polygonClipping.difference(acc.map((x) => toPc(snapShape(x))), toPc(snapShape(o))));
      } catch {
        /* skip a subtrahend that cannot be processed */
      }
    }
    return acc;
  }
}

export function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return a / 2;
}

export function shapeArea(shape: Shape): number {
  if (!shape.length) return 0;
  let a = Math.abs(ringArea(shape[0]));
  for (let k = 1; k < shape.length; k++) a -= Math.abs(ringArea(shape[k]));
  return a;
}

/** Average thickness of a shape (2 × area ÷ perimeter): small for slivers. */
export function thickness(shape: Shape): number {
  let perimeter = 0;
  for (const ring of shape) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) perimeter += dist(ring[i], ring[j]);
  return perimeter ? (2 * shapeArea(shape)) / perimeter : 0;
}

export function ringCentroid(ring: readonly Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    a += f;
    cx += (ring[j].x + ring[i].x) * f;
    cy += (ring[j].y + ring[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInShape(p: Vec2, shape: Shape): boolean {
  if (!shape.length || !pointInRing(p, shape[0])) return false;
  for (let k = 1; k < shape.length; k++) if (pointInRing(p, shape[k])) return false;
  return true;
}

/** Distance from a point to the nearest edge of any ring. */
export function distanceToBoundary(p: Vec2, shape: Shape): number {
  let best = Infinity;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
  }
  return best;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(shape: Shape): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of shape) {
    for (const p of ring) {
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return b;
}

/**
 * A polygon covering everything within `halfWidth` of a polyline, with square
 * ends. Joints use the averaged normal, which is adequate for gentle bends.
 */
export function bufferPolyline(pts: readonly Vec2[], halfWidth: number): Shape {
  if (pts.length < 2) return [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Extend the ends a little so neighbouring buffers overlap at junctions.
    let p = pts[i];
    if (i === 0) p = { x: p.x - dx * halfWidth, y: p.y - dy * halfWidth };
    if (i === pts.length - 1) p = { x: p.x + dx * halfWidth, y: p.y + dy * halfWidth };
    left.push({ x: p.x - dy * halfWidth, y: p.y + dx * halfWidth });
    right.push({ x: p.x + dy * halfWidth, y: p.y - dx * halfWidth });
  }
  return [[...left, ...right.reverse()]];
}

/** A regular-ish polygon around a centre with a radius that varies by angle. */
export function radialPolygon(centre: Vec2, radius: (angle: number) => number, sides = 48): Shape {
  const ring: Vec2[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    const r = radius(a);
    ring.push({ x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) });
  }
  return [ring];
}

export function rectangle(b: Bounds): Shape {
  return [
    [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ],
  ];
}
