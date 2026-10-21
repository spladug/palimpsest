// The street graph: the source of truth for every way in the settlement.
// Nodes are junctions, ends and places; edges carry polyline geometry.

import {
  dist,
  polylineLength,
  projectOnPolyline,
  splitPolylineAt,
  type PolylineProjection,
  type Vec2,
} from './geom';

export const EDGE_CLASSES = ['path', 'track', 'lane', 'road'] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

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
    e1.yearUse = e2.yearUse = e.yearUse;
    e1.pressure = e2.pressure = e.pressure;
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

  /** Fold node `drop` into node `keep`, rerouting its edges. */
  mergeNodes(keep: number, drop: number): void {
    if (keep === drop) return;
    const k = this.nodes.get(keep)!;
    const d = this.nodes.get(drop)!;
    if (k.placeId === null) k.placeId = d.placeId;
    for (const eid of [...this.edgesAt(drop)]) {
      const e = this.edges.get(eid)!;
      const a = e.a === drop ? keep : e.a;
      const b = e.b === drop ? keep : e.b;
      this.removeEdge(eid);
      if (a === b) continue;
      const ne = this.addEdge(a, b, e.pts, e.cls, e.usage, e.created);
      ne.yearUse = e.yearUse;
      ne.pressure = e.pressure;
    }
    this.adjacency.delete(drop);
    this.nodes.delete(drop);
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
    if (e1.cls !== e2.cls) return false;
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
    const merged = this.addEdge(start, end, [...p1, ...p2.slice(1)], e1.cls, usage, Math.min(e1.created, e2.created));
    merged.yearUse = yearUse;
    merged.pressure = Math.min(e1.pressure, e2.pressure);
    return true;
  }

  totalLength(): number {
    let len = 0;
    for (const e of this.edges.values()) len += this.length(e);
    return len;
  }
}
