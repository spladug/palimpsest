// Land value from accessibility over the street graph: how far a site is from
// the market by the ways, with better ways counting as shorter, plus a share
// for passing trade on busy ways (a simplified placement potential after
// Raimbault, with centrality approximated by traffic).

import type { Vec2 } from './geom';
import type { World } from './world';

/** Network distance (metres, discounted by way class) at which accessibility falls to 1/e. */
const REACH = 450;
/** Usage at which the passing-trade share is full. */
const BUSY = 8000;
const TRADE_SHARE = 0.25;

/** Shortest discounted network distance from the town centre to every node. */
export function updateAccess(world: World): void {
  const g = world.graph;
  const centre =
    world.places.find((p) => p.kind === 'market') ??
    world.places.find((p) => p.kind === 'village') ??
    world.places.find((p) => p.kind === 'church');
  const access = new Map<number, number>();
  world.access = access;
  if (!centre) return;
  const start = g.nodes.get(centre.nodeId)?.placeId === centre.id ? centre.nodeId : g.nearestNode(centre.pos, 60)?.id;
  if (start === undefined) return;
  const factor = world.plugins.technology.movement.classFactor;
  const heap = new MinHeap();
  access.set(start, 0);
  heap.push(0, start);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (access.get(u) ?? Infinity)) continue;
    for (const eid of g.edgesAt(u)) {
      const e = g.edges.get(eid)!;
      const v = g.other(e, u);
      const nd = d + g.length(e) / factor[e.cls];
      if (nd < (access.get(v) ?? Infinity)) {
        access.set(v, nd);
        heap.push(nd, v);
      }
    }
  }
}

/** Accessibility of a point, 0..1: from the nearest way within reach, or poor if there is none. */
export function accessAt(world: World, p: Vec2, reach = 40): number {
  const g = world.graph;
  const hit = g.nearestEdge(p, reach) ?? g.nearestEdge(p, reach * 5);
  if (!hit) return 0;
  const e = hit.edge;
  const len = g.length(e);
  const da = world.access.get(e.a) ?? Infinity;
  const db = world.access.get(e.b) ?? Infinity;
  const factor = world.plugins.technology.movement.classFactor[e.cls];
  const along = hit.proj.along;
  // Getting to the way from the site counts double: it is across fields or yards.
  const d = Math.min(da + along / factor, db + (len - along) / factor) + hit.proj.dist * 2;
  if (!Number.isFinite(d)) return 0;
  const trade = Math.min(1, Math.log1p(e.usage) / Math.log1p(BUSY));
  return (1 - TRADE_SHARE) * Math.exp(-d / REACH) + TRADE_SHARE * trade * Math.exp(-d / (REACH * 3));
}

/** A binary min-heap of (key, value) pairs. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[parent] <= k[i]) break;
      [k[parent], k[i]] = [k[i], k[parent]];
      [v[parent], v[i]] = [v[i], v[parent]];
      i = parent;
    }
  }

  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
