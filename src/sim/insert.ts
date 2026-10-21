// Merging a travelled route into the street graph ("incremental track
// insertion", after GPS map-inference methods such as Ahmed et al. 2015).
//
// The route is resampled; each sample is matched to the nearest existing edge
// within a snap radius. Matched stretches add usage to the edges they follow.
// Unmatched stretches become new edges, joined to the graph at junctions where
// they leave and rejoin existing ways.

import { dist, polylineLength, projectOnPolyline, removeSpikes, resample, simplify, type Vec2 } from './geom';
import type { StreetGraph } from './graph';

export interface InsertOptions {
  /** Samples within this distance of an edge follow that edge. */
  snap: number;
  /** Junctions closer than this to an existing node reuse it. */
  nodeSnap: number;
  /** Resampling step along the route. */
  step: number;
  /** Unmatched gaps shorter than this between stretches of the same way are ignored. */
  minNew: number;
  /** Matched stretches shorter than this are crossings, not travel along a way. */
  minMatch: number;
  year: number;
  /** A planned way: add it even where the network already offers a similar route. */
  planned?: boolean;
  /** Whether a new way may be made along this line (it must not run through a building, say). */
  allowed?: (pts: readonly Vec2[]) => boolean;
}

export const DEFAULT_INSERT: Omit<InsertOptions, 'year'> = {
  snap: 15,
  nodeSnap: 10,
  step: 5,
  minNew: 40,
  minMatch: 25,
};

/** A new way is redundant if the network already joins its ends within this detour factor. */
const REDUNDANT_DETOUR = 1.4;

interface Run {
  matched: boolean;
  from: number;
  to: number; // inclusive
}

export interface InsertResult {
  newEdges: number[];
  usedEdges: number[];
}

/**
 * Insert a route travelled `weight` times between two graph nodes. The route's
 * first and last points should be the nodes' positions.
 */
export function insertRoute(
  graph: StreetGraph,
  route: readonly Vec2[],
  weight: number,
  startNode: number,
  endNode: number,
  opts: InsertOptions,
): InsertResult {
  const samples = resample(route, opts.step);
  const result: InsertResult = { newEdges: [], usedEdges: [] };
  if (samples.length < 2) return result;

  // 1. Classify samples against the graph as it stands before insertion. A
  // sample keeps to the way the previous sample followed while it is within
  // reach, so a route between two close parallel ways doesn't flip-flop.
  const hitEdge: (number | null)[] = [];
  for (let i = 0; i < samples.length; i++) {
    const prev = i > 0 ? hitEdge[i - 1] : null;
    if (prev !== null && projectOnPolyline(samples[i], graph.edges.get(prev)!.pts).dist <= opts.snap) {
      hitEdge.push(prev);
    } else {
      hitEdge.push(graph.nearestEdge(samples[i], opts.snap)?.edge.id ?? null);
    }
  }
  const sharesNode = (e1: number, e2: number): boolean => {
    if (e1 === e2) return true;
    const a = graph.edges.get(e1)!;
    const b = graph.edges.get(e2)!;
    return a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
  };

  const runs: Run[] = [];
  for (let i = 0; i < samples.length; i++) {
    const matched = hitEdge[i] !== null;
    const last = runs[runs.length - 1];
    const continues =
      last &&
      last.matched === matched &&
      (!matched || sharesNode(hitEdge[i - 1]!, hitEdge[i]!));
    if (continues) last.to = i;
    else {
      // A jump between two unconnected ways splits the matched stretch with an empty gap.
      if (last && last.matched && matched) runs.push({ matched: false, from: i, to: i - 1 });
      runs.push({ matched, from: i, to: i });
    }
  }

  // Short excursions off a way that come straight back to it are wobble, not new ways.
  for (let k = 1; k < runs.length - 1; k++) {
    const r = runs[k];
    const prev = runs[k - 1];
    const next = runs[k + 1];
    const len = (r.to - r.from + 1) * opts.step;
    if (!r.matched && prev.matched && next.matched && len < opts.minNew && r.to >= r.from) {
      if (sharesNode(hitEdge[prev.to]!, hitEdge[next.from]!)) {
        prev.to = next.to;
        runs.splice(k, 2);
        k--;
      }
    }
  }

  // 2. Walk the runs, creating edges for unmatched stretches.
  const connect = (a: number, b: number, via: Vec2[]): number => {
    if (a === b || graph.areAdjacent(a, b)) return b;
    const na = graph.nodes.get(a)!;
    const nb = graph.nodes.get(b)!;
    if (dist(na.pos, nb.pos) < opts.nodeSnap) {
      // Keep whichever node marks a place.
      const keep = nb.placeId !== null || na.placeId === null ? b : a;
      graph.mergeNodes(keep, keep === b ? a : b);
      return keep;
    }
    const geom = removeSpikes(simplify([na.pos, ...via, nb.pos], opts.step * 0.4));
    // Skip ways the network already makes nearly redundant.
    const len = polylineLength(geom);
    if (!opts.planned && graph.networkDistance(a, b, len * REDUNDANT_DETOUR) <= len * REDUNDANT_DETOUR) return b;
    if (opts.allowed && !opts.allowed(geom)) return b;
    const e = graph.addEdge(a, b, geom, 'path', 0, opts.year);
    e.yearUse = weight;
    e.planned = opts.planned;
    result.newEdges.push(e.id);
    return b;
  };
  const materialize = (p: Vec2): number =>
    (graph.junctionAt(p, opts.snap * 1.5, opts.nodeSnap) ?? graph.addNode(p)).id;

  let anchor: number | null = startNode;
  let pendingExit: Vec2 | null = null;
  let via: Vec2[] = [];
  for (const r of runs) {
    if (r.matched) {
      if (anchor === null) anchor = materialize(pendingExit!);
      const entry = materialize(samples[r.from]);
      anchor = connect(anchor, entry, via);
      via = [];
      pendingExit = samples[r.to];
      anchor = null;
    } else {
      if (anchor === null) anchor = materialize(pendingExit!);
      via = samples.slice(Math.max(r.from, 1), Math.min(r.to + 1, samples.length - 1));
    }
  }
  if (anchor === null) anchor = materialize(pendingExit!);
  connect(anchor, endNode, via);

  // 3. Credit usage to the ways the route followed.
  const covered = new Map<number, number>();
  for (const r of runs) {
    if (!r.matched || (r.to - r.from + 1) * opts.step < opts.minMatch) continue;
    for (let i = r.from; i <= r.to; i++) {
      const hit = graph.nearestEdge(samples[i], opts.snap);
      if (hit) covered.set(hit.edge.id, (covered.get(hit.edge.id) ?? 0) + opts.step);
    }
  }
  for (const [id, len] of covered) {
    const e = graph.edges.get(id)!;
    if (result.newEdges.includes(id)) continue;
    if (len >= Math.min(0.3 * graph.length(e), 50)) {
      e.yearUse += weight;
      result.usedEdges.push(id);
    }
  }
  // A new way that crosses another meets it at a junction.
  if (result.newEdges.length) result.newEdges = graph.nodeCrossings(result.newEdges);
  return result;
}
