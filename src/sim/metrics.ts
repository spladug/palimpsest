// Cheap street-network measures for checking plausibility over time.
// Orientation entropy after Boeing (2019); meshedness after Buhl et al. (2006).

import { dist, polylineLength, undirectedBearing } from './geom';
import { EDGE_CLASSES, type EdgeClass, type StreetGraph } from './graph';
import type { World } from './world';

export interface Metrics {
  nodes: number;
  edges: number;
  /** Nodes where three or more ways meet. */
  junctions: number;
  lengthByClass: Record<EdgeClass, number>;
  /** Shannon entropy of street bearings over 36 bins, length-weighted (nats). */
  orientationEntropy: number;
  /** Boeing's orientation order: 0 = no order, 1 = a single grid. */
  orientationOrder: number;
  /** Share of cycles relative to a maximal planar graph, 0..1. */
  meshedness: number;
  /** Shares of dead ends, T-junctions and crossroads among non-trivial nodes. */
  deadEndShare: number;
  threeWayShare: number;
  fourWayShare: number;
  /** Mean ratio of network distance to straight-line distance between places. */
  circuity: number;
}

const BINS = 36;

export function orientationEntropy(graph: StreetGraph): number {
  const bins = new Float64Array(BINS);
  for (const e of graph.edges.values()) {
    for (let i = 1; i < e.pts.length; i++) {
      const len = dist(e.pts[i - 1], e.pts[i]);
      const b = undirectedBearing(e.pts[i - 1], e.pts[i]);
      // Count both directions, as Boeing does, so bins span 360 degrees.
      bins[Math.floor(b / 10) % BINS] += len;
      bins[(Math.floor(b / 10) + 18) % BINS] += len;
    }
  }
  const total = bins.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const v of bins) if (v > 0) h -= (v / total) * Math.log(v / total);
  return h;
}

export function computeMetrics(world: World): Metrics {
  const g = world.graph;
  const lengthByClass = Object.fromEntries(EDGE_CLASSES.map((c) => [c, 0])) as Record<EdgeClass, number>;
  for (const e of g.edges.values()) lengthByClass[e.cls] += polylineLength(e.pts);

  let n = 0;
  let deg1 = 0;
  let deg3 = 0;
  let deg4 = 0;
  let counted = 0;
  for (const node of g.nodes.values()) {
    const d = g.degree(node.id);
    if (d === 0) continue;
    n++;
    if (d === 2) continue;
    counted++;
    if (d === 1) deg1++;
    else if (d === 3) deg3++;
    else deg4++;
  }
  const m = g.edges.size;
  const meshedness = n >= 3 ? Math.max(0, (m - n + 1) / (2 * n - 5)) : 0;

  const h = orientationEntropy(g);
  const hMax = Math.log(BINS);
  const hGrid = Math.log(4);
  const order = 1 - Math.pow(Math.max(0, h - hGrid) / (hMax - hGrid), 2);

  return {
    nodes: g.nodes.size,
    edges: m,
    junctions: deg3 + deg4,
    lengthByClass,
    orientationEntropy: h,
    orientationOrder: order,
    meshedness,
    deadEndShare: counted ? deg1 / counted : 0,
    threeWayShare: counted ? deg3 / counted : 0,
    fourWayShare: counted ? deg4 / counted : 0,
    circuity: circuity(world),
  };
}

/** Dijkstra over the graph from each place to every other place. */
function circuity(world: World): number {
  const g = world.graph;
  const places = world.places.filter((p) => p.kind !== 'field' && g.nodes.has(p.nodeId));
  let sum = 0;
  let count = 0;
  for (const src of places) {
    const d = new Map<number, number>([[src.nodeId, 0]]);
    const queue: [number, number][] = [[0, src.nodeId]];
    const done = new Set<number>();
    while (queue.length) {
      // Small graphs: a sorted array is fine as a priority queue.
      queue.sort((a, b) => b[0] - a[0]);
      const [du, u] = queue.pop()!;
      if (done.has(u)) continue;
      done.add(u);
      for (const eid of g.edgesAt(u)) {
        const e = g.edges.get(eid)!;
        const v = g.other(e, u);
        const nd = du + g.length(e);
        if (nd < (d.get(v) ?? Infinity)) {
          d.set(v, nd);
          queue.push([nd, v]);
        }
      }
    }
    for (const dst of places) {
      if (dst === src) continue;
      const nd = d.get(dst.nodeId);
      const straight = dist(src.pos, dst.pos);
      if (nd !== undefined && straight > 0) {
        sum += nd / straight;
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}
