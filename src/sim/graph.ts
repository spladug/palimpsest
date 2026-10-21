// The street graph: the source of truth for every way in the settlement.
// Nodes are junctions, ends and places; edges carry polyline geometry.

import {
  dist,
  polylineLength,
  removeSpikes,
  projectOnPolyline,
  splitPolylineAt,
  type PolylineProjection,
  type Vec2,
} from './geom';

export const EDGE_CLASSES = ['path', 'track', 'lane', 'road'] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

/** Width of each class of way on the ground, in metres: what the map draws and what must stay clear. */
export const WAY_WIDTH: Record<EdgeClass, number> = { path: 1.2, track: 3, lane: 6, road: 10 };

export interface GraphNode {
  id: number;
  pos: Vec2;
  placeId: number | null;
}

export interface GraphEdge {
  id: number;
  a: number;
  b: number;
  /** Geometry from node a to node b. */
  pts: Vec2[];
  cls: EdgeClass;
  /** Smoothed trips per year. */
  usage: number;
  /** Trips recorded since the hierarchy last ran. */
  yearUse: number;
  /** Consecutive years spent above the upgrade or below the downgrade threshold. */
  pressure: number;
  created: number;
  /** Laid out deliberately (a planned street or lane) and kept up, not just worn by use. */
  planned?: boolean;
  /** The lowest class a planned way is let fall to (default: track). */
  floor?: EdgeClass;
  /** Street name, once it is a named street of the town. */
  name?: string;
  /** Held to this width (m) where plots hem it in, whatever its class. */
  maxWidth?: number;
}

/** How wide a way is on the ground. */
export function wayWidth(e: GraphEdge): number {
  return Math.min(WAY_WIDTH[e.cls], e.maxWidth ?? Infinity);
}

/** Copy what a way is (beyond its geometry and use) onto its replacement. */
function carry(from: GraphEdge, to: GraphEdge): void {
  to.yearUse = from.yearUse;
  to.pressure = from.pressure;
  to.planned = from.planned;
  to.floor = from.floor;
  to.name = from.name;
  to.maxWidth = from.maxWidth;
}

/** Where two polylines first cross, strictly inside a segment of each, as distances along them. */
function firstCrossing(a: readonly Vec2[], b: readonly Vec2[]): { alongA: number; alongB: number } | null {
  const lenA = polylineLength(a);
  const lenB = polylineLength(b);
  let sa = 0;
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1];
    const q = a[i];
    const la = dist(p, q);
    let sb = 0;
    for (let j = 1; j < b.length; j++) {
      const r = b[j - 1];
      const s = b[j];
      const lb = dist(r, s);
      const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
      if (Math.abs(d) > 1e-9) {
        const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
        const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
        // Keep clear of the ends, where ways properly meet at a node.
        const ta = sa + t * la;
        const ub = sb + u * lb;
        if (t > 0 && t < 1 && u > 0 && u < 1 && ta > 0.5 && ub > 0.5 && ta < lenA - 0.5 && ub < lenB - 0.5) {
          return { alongA: ta, alongB: ub };
        }
      }
      sb += lb;
    }
    sa += la;
  }
  return null;
}

export interface EdgeHit {
  edge: GraphEdge;
  proj: PolylineProjection;
}

/** Uniform bucket grid over edge segments for nearest-edge queries. */
class EdgeIndex {
  private buckets = new Map<number, Set<number>>();

  constructor(private bucketSize: number) {}

  private key(bx: number, by: number): number {
    return (by + 4096) * 8192 + (bx + 4096);
  }

  private cellsFor(pts: readonly Vec2[], fn: (k: number) => void): void {
    const s = this.bucketSize;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) / s);
      const x1 = Math.floor(Math.max(a.x, b.x) / s);
      const y0 = Math.floor(Math.min(a.y, b.y) / s);
      const y1 = Math.floor(Math.max(a.y, b.y) / s);
      for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) fn(this.key(bx, by));
    }
  }

  add(id: number, pts: readonly Vec2[]): void {
    this.cellsFor(pts, (k) => {
      let set = this.buckets.get(k);
      if (!set) this.buckets.set(k, (set = new Set()));
      set.add(id);
    });
  }

  remove(id: number, pts: readonly Vec2[]): void {
    this.cellsFor(pts, (k) => this.buckets.get(k)?.delete(id));
  }

  /** Edges sharing a bucket with any segment of a polyline: every edge that could cross it. */
  along(pts: readonly Vec2[]): Set<number> {
    const out = new Set<number>();
    this.cellsFor(pts, (k) => {
      for (const id of this.buckets.get(k) ?? []) out.add(id);
    });
    return out;
  }

  near(p: Vec2, r: number): Set<number> {
    const s = this.bucketSize;
    const out = new Set<number>();
    const x0 = Math.floor((p.x - r) / s);
    const x1 = Math.floor((p.x + r) / s);
    const y0 = Math.floor((p.y - r) / s);
    const y1 = Math.floor((p.y + r) / s);
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) {
        const set = this.buckets.get(this.key(bx, by));
        if (set) for (const id of set) out.add(id);
      }
    }
    return out;
  }
}

export class StreetGraph {
  readonly nodes = new Map<number, GraphNode>();
  readonly edges = new Map<number, GraphEdge>();
  private adjacency = new Map<number, Set<number>>();
  private index: EdgeIndex;
  private nextNodeId = 1;
  private nextEdgeId = 1;

  constructor(bucketSize = 40) {
    this.index = new EdgeIndex(bucketSize);
  }

  addNode(pos: Vec2, placeId: number | null = null): GraphNode {
    const node = { id: this.nextNodeId++, pos: { ...pos }, placeId };
    this.nodes.set(node.id, node);
    this.adjacency.set(node.id, new Set());
    return node;
  }

  addEdge(a: number, b: number, pts: Vec2[], cls: EdgeClass, usage: number, year: number): GraphEdge {
    const na = this.nodes.get(a)!;
    const nb = this.nodes.get(b)!;
    const geom = pts.length >= 2 ? pts.slice() : [na.pos, nb.pos];
    geom[0] = { ...na.pos };
    geom[geom.length - 1] = { ...nb.pos };
    const edge: GraphEdge = {
      id: this.nextEdgeId++,
      a,
      b,
      pts: geom,
      cls,
      usage,
      yearUse: 0,
      pressure: 0,
      created: year,
    };
    this.edges.set(edge.id, edge);
    this.adjacency.get(a)!.add(edge.id);
    this.adjacency.get(b)!.add(edge.id);
    this.index.add(edge.id, edge.pts);
    return edge;
  }

  removeEdge(id: number): void {
    const e = this.edges.get(id);
    if (!e) return;
    this.index.remove(id, e.pts);
    this.adjacency.get(e.a)?.delete(id);
    this.adjacency.get(e.b)?.delete(id);
    this.edges.delete(id);
  }

  removeNode(id: number): void {
    for (const eid of [...this.edgesAt(id)]) this.removeEdge(eid);
    this.adjacency.delete(id);
    this.nodes.delete(id);
  }

  edgesAt(nodeId: number): ReadonlySet<number> {
    return this.adjacency.get(nodeId) ?? new Set();
  }

  degree(nodeId: number): number {
    return this.adjacency.get(nodeId)?.size ?? 0;
  }

  other(edge: GraphEdge, nodeId: number): number {
    return edge.a === nodeId ? edge.b : edge.a;
  }

  areAdjacent(a: number, b: number): boolean {
    for (const eid of this.edgesAt(a)) {
      if (this.other(this.edges.get(eid)!, a) === b) return true;
    }
    return false;
  }

  length(edge: GraphEdge): number {
    return polylineLength(edge.pts);
  }

  nearestEdge(p: Vec2, r: number, exclude?: ReadonlySet<number>): EdgeHit | null {
    let best: EdgeHit | null = null;
    for (const id of this.index.near(p, r)) {
      if (exclude?.has(id)) continue;
      const edge = this.edges.get(id)!;
      const proj = projectOnPolyline(p, edge.pts);
      if (proj.dist <= r && (!best || proj.dist < best.proj.dist)) best = { edge, proj };
    }
    return best;
  }

  nearestNode(p: Vec2, r: number): GraphNode | null {
    let best: GraphNode | null = null;
    let bestD = r;
    // Linear scan: node counts stay in the hundreds for a village.
    for (const n of this.nodes.values()) {
      const d = dist(n.pos, p);
      if (d <= bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /** Split an edge at a distance along it, returning the new middle node. */
  splitEdge(edgeId: number, along: number): GraphNode {
    const e = this.edges.get(edgeId)!;
    const [first, second] = splitPolylineAt(e.pts, along);
    const mid = this.addNode(first[first.length - 1]);
    this.removeEdge(edgeId);
    const e1 = this.addEdge(e.a, mid.id, first, e.cls, e.usage, e.created);
    const e2 = this.addEdge(mid.id, e.b, second, e.cls, e.usage, e.created);
    carry(e, e1);
    carry(e, e2);
    return mid;
  }

  /**
   * The node on the nearest edge (within `r`) at which to join a point: an end
   * of that edge if the point projects within `nodeSnap` of it, otherwise a new
   * node splitting the edge. With no edge near, any node within `nodeSnap`.
   */
  junctionAt(p: Vec2, r: number, nodeSnap: number): GraphNode | null {
    const hit = this.nearestEdge(p, r);
    if (!hit) return this.nearestNode(p, nodeSnap);
    const len = this.length(hit.edge);
    const a = this.nodes.get(hit.edge.a)!;
    const b = this.nodes.get(hit.edge.b)!;
    const toA = hit.proj.along;
    const toB = len - hit.proj.along;
    if (toA < nodeSnap && toA <= toB) return a;
    if (toB < nodeSnap) return b;
    return this.splitEdge(hit.edge.id, hit.proj.along);
  }

  /**
   * Make a junction wherever the given ways cross another way, so no two ways
   * pass through each other. Returns the ids of the given ways' pieces.
   */
  nodeCrossings(ids: Iterable<number>): number[] {
    const mine = new Set([...ids].filter((id) => this.edges.has(id)));
    for (let guard = 0; guard < 200; guard++) {
      const x = this.findCrossing(mine);
      if (!x) break;
      const ea = this.edges.get(x.a)!;
      const eb = this.edges.get(x.b)!;
      const ownB = mine.has(eb.id);
      mine.delete(ea.id);
      mine.delete(eb.id);
      const ma = this.splitEdge(ea.id, x.alongA);
      for (const id of this.edgesAt(ma.id)) mine.add(id);
      const mb = this.splitEdge(eb.id, x.alongB);
      const mbEdges = [...this.edgesAt(mb.id)];
      this.mergeNodes(ma.id, mb.id);
      // The other way's pieces now hang off the shared node, with new ids.
      if (ownB) {
        for (const id of this.edgesAt(ma.id)) mine.add(id);
      }
      for (const id of mbEdges) mine.delete(id);
    }
    return [...mine].filter((id) => this.edges.has(id));
  }

  private findCrossing(mine: ReadonlySet<number>): { a: number; b: number; alongA: number; alongB: number } | null {
    for (const id of mine) {
      const e = this.edges.get(id);
      if (!e) continue;
      for (const oid of this.index.along(e.pts)) {
        if (oid === id) continue;
        const f = this.edges.get(oid)!;
        const x = firstCrossing(e.pts, f.pts);
        if (x) return { a: id, b: oid, alongA: x.alongA, alongB: x.alongB };
      }
    }
    return null;
  }

  /**
   * Take out a short edge, folding its node `drop` into `keep`. The ways that
   * met at `drop` are carried on along the short edge's line to `keep`, rather
   * than swung straight across to it.
   */
  collapseEdge(edgeId: number, keep: number): void {
    const e = this.edges.get(edgeId)!;
    const drop = this.other(e, keep);
    const leg = e.a === drop ? e.pts : e.pts.slice().reverse();
    this.splitLinks(keep, drop, edgeId);
    this.removeEdge(edgeId);
    const k = this.nodes.get(keep)!;
    const d = this.nodes.get(drop)!;
    if (k.placeId === null) k.placeId = d.placeId;
    for (const fid of [...this.edgesAt(drop)]) {
      const f = this.edges.get(fid)!;
      const end = this.other(f, drop);
      this.removeEdge(fid);
      if (end === keep) continue;
      const toDrop = f.b === drop ? f.pts : f.pts.slice().reverse();
      carry(f, this.addEdge(end, keep, removeSpikes([...toDrop, ...leg.slice(1)]), f.cls, f.usage, f.created));
    }
    this.adjacency.delete(drop);
    this.nodes.delete(drop);
  }

  /**
   * Fold node `drop` into node `keep`, rerouting its edges. The junction stays
   * where the weightier ways meet: if `drop` carries them, `keep` moves there
   * and its own lesser ways are led across to it. Either way, a way that moves
   * gains a short leg to the new junction rather than swinging its last stretch.
   */
  mergeNodes(keep: number, drop: number): void {
    if (keep === drop) return;
    const k = this.nodes.get(keep)!;
    const d = this.nodes.get(drop)!;
    if (k.placeId === null) k.placeId = d.placeId;
    this.splitLinks(keep, drop);
    if (dist(k.pos, d.pos) > 0.01 && this.weight(drop) > this.weight(keep)) {
      k.pos = { ...d.pos };
      for (const eid of [...this.edgesAt(keep)]) this.reroute(eid, keep, keep, k.pos);
    }
    for (const eid of [...this.edgesAt(drop)]) this.reroute(eid, drop, keep, k.pos);
    this.adjacency.delete(drop);
    this.nodes.delete(drop);
  }

  /**
   * A way running between two nodes about to become one would close on
   * itself; split it in the middle so it survives as a loop of two ways.
   */
  private splitLinks(a: number, b: number, except?: number): void {
    for (const eid of [...this.edgesAt(a)]) {
      const e = this.edges.get(eid)!;
      if (eid === except || this.other(e, a) !== b) continue;
      const len = this.length(e);
      if (len > dist(this.nodes.get(a)!.pos, this.nodes.get(b)!.pos) + 10) this.splitEdge(eid, len / 2);
    }
  }

  /** How much a junction matters: the classes of the ways meeting there, planned streets counting double. */
  private weight(nodeId: number): number {
    let w = 0;
    for (const eid of this.edgesAt(nodeId)) {
      const e = this.edges.get(eid)!;
      w += (EDGE_CLASSES.indexOf(e.cls) + 1) * (e.planned ? 2 : 1);
    }
    return w;
  }

  /** Re-attach an edge's `from` end to node `to`, standing at `pos`, by a short added leg. */
  private reroute(eid: number, from: number, to: number, pos: Vec2): void {
    const e = this.edges.get(eid)!;
    const a = e.a === from ? to : e.a;
    const b = e.b === from ? to : e.b;
    this.removeEdge(eid);
    if (a === b) return;
    const pts = e.pts.slice();
    if (e.a === from && dist(pts[0], pos) > 0.01) pts.unshift({ ...pos });
    if (e.b === from && dist(pts[pts.length - 1], pos) > 0.01) pts.push({ ...pos });
    carry(e, this.addEdge(a, b, removeSpikes(pts), e.cls, e.usage, e.created));
  }

  /**
   * Join the two edges at a plain degree-2 node into one, so the graph keeps
   * junctions only where ways actually meet.
   */
  contract(nodeId: number): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.placeId !== null || this.degree(nodeId) !== 2) return false;
    const [id1, id2] = [...this.edgesAt(nodeId)];
    const e1 = this.edges.get(id1)!;
    const e2 = this.edges.get(id2)!;
    if (e1.cls !== e2.cls || !!e1.planned !== !!e2.planned || e1.floor !== e2.floor || e1.name !== e2.name) return false;
    const start = this.other(e1, nodeId);
    const end = this.other(e2, nodeId);
    if (start === end) return false;
    const p1 = e1.b === nodeId ? e1.pts : e1.pts.slice().reverse();
    const p2 = e2.a === nodeId ? e2.pts : e2.pts.slice().reverse();
    const l1 = polylineLength(p1);
    const l2 = polylineLength(p2);
    const usage = (e1.usage * l1 + e2.usage * l2) / Math.max(1e-9, l1 + l2);
    const yearUse = (e1.yearUse * l1 + e2.yearUse * l2) / Math.max(1e-9, l1 + l2);
    this.removeEdge(id1);
    this.removeEdge(id2);
    this.adjacency.delete(nodeId);
    this.nodes.delete(nodeId);
    const merged = this.addEdge(start, end, removeSpikes([...p1, ...p2.slice(1)]), e1.cls, usage, Math.min(e1.created, e2.created));
    carry(e1, merged);
    merged.yearUse = yearUse;
    merged.pressure = Math.min(e1.pressure, e2.pressure);
    if (e2.maxWidth !== undefined) merged.maxWidth = Math.min(e2.maxWidth, e1.maxWidth ?? Infinity);
    return true;
  }

  /**
   * Shortest network distance between two nodes, or Infinity if it exceeds
   * `limit`. Bounded, so it stays cheap for local questions.
   */
  networkDistance(from: number, to: number, limit: number): number {
    const d = new Map<number, number>([[from, 0]]);
    const queue: [number, number][] = [[0, from]];
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[bi][0]) bi = i;
      const [du, u] = queue[bi];
      queue[bi] = queue[queue.length - 1];
      queue.pop();
      if (du > (d.get(u) ?? Infinity)) continue;
      if (u === to) return du;
      for (const eid of this.edgesAt(u)) {
        const e = this.edges.get(eid)!;
        const v = this.other(e, u);
        const nd = du + this.length(e);
        if (nd <= limit && nd < (d.get(v) ?? Infinity)) {
          d.set(v, nd);
          queue.push([nd, v]);
        }
      }
    }
    return Infinity;
  }

  totalLength(): number {
    let len = 0;
    for (const e of this.edges.values()) len += this.length(e);
    return len;
  }
}
