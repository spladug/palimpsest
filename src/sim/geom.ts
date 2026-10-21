// Small 2D geometry helpers. Coordinates are metres in world space.

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function polylineLength(pts: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

/** Points spaced `step` apart along the polyline, always including both ends. */
export function resample(pts: readonly Vec2[], step: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    let d = step - carry;
    while (d <= segLen) {
      out.push(lerp(a, b, d / segLen));
      d += step;
    }
    carry = segLen - (d - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Douglas–Peucker simplification. */
export function simplify(pts: readonly Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projectOnSegment(pts[i], pts[s], pts[e]).dist;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting; keeps endpoints fixed. */
export function smooth(pts: readonly Vec2[], iterations = 1): Vec2[] {
  let cur = pts.slice();
  for (let k = 0; k < iterations && cur.length > 2; k++) {
    const next: Vec2[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      if (i > 0) next.push(lerp(a, b, 0.25));
      if (i < cur.length - 2) next.push(lerp(a, b, 0.75));
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

export interface Projection {
  point: Vec2;
  /** Parameter along the segment, 0..1. */
  t: number;
  dist: number;
}

export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): Projection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { point, t, dist: dist(p, point) };
}

export interface PolylineProjection extends Projection {
  /** Index of the segment the projection falls on. */
  segment: number;
  /** Distance along the polyline from its start to the projection. */
  along: number;
}

export function projectOnPolyline(p: Vec2, pts: readonly Vec2[]): PolylineProjection {
  let best: PolylineProjection | null = null;
  let along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const pr = projectOnSegment(p, pts[i], pts[i + 1]);
    const segLen = dist(pts[i], pts[i + 1]);
    if (!best || pr.dist < best.dist) {
      best = { ...pr, segment: i, along: along + segLen * pr.t };
    }
    along += segLen;
  }
  return best!;
}

/** Split a polyline at a distance along it. Both halves include the split point. */
export function splitPolylineAt(pts: readonly Vec2[], at: number): [Vec2[], Vec2[]] {
  let along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const segLen = dist(pts[i], pts[i + 1]);
    if (along + segLen >= at) {
      const p = lerp(pts[i], pts[i + 1], segLen === 0 ? 0 : (at - along) / segLen);
      return [[...pts.slice(0, i + 1), p], [p, ...pts.slice(i + 1)]];
    }
    along += segLen;
  }
  const last = pts[pts.length - 1];
  return [pts.slice(), [last, last]];
}

/** Bearing of a segment in degrees, folded to 0..180 (undirected). */
export function undirectedBearing(a: Vec2, b: Vec2): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return ((deg % 180) + 180) % 180;
}

/**
 * Remove vertices where the line doubles back on itself (turns sharper than
 * `maxTurnDeg`), repeating until none remain. Endpoints are kept.
 */
export function removeSpikes(pts: readonly Vec2[], maxTurnDeg = 135): Vec2[] {
  const out = pts.slice();
  const limit = Math.cos(((180 - maxTurnDeg) * Math.PI) / 180);
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const ax = out[i].x - out[i - 1].x;
      const ay = out[i].y - out[i - 1].y;
      const bx = out[i + 1].x - out[i].x;
      const by = out[i + 1].y - out[i].y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      // cos of the angle between the incoming and outgoing directions.
      const c = la && lb ? (ax * bx + ay * by) / (la * lb) : 1;
      if (c < -limit || la === 0 || lb === 0) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}
