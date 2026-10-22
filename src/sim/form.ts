// The form of the town itself, as opposed to the whole valley: its plots,
// buildings and streets, measured for the whole built-up area and for each
// district laid out in a different period (a plan unit, after Conzen).

import { dist, polylineLength, resample, type Vec2 } from './geom';
import { shapeArea, ringCentroid } from './polygon';
import { orientationEntropyOf, orientationOrder } from './metrics';
import { plotFrame } from './plots';
import type { GraphEdge } from './graph';
import type { Parcel } from './cadastre';
import type { World } from './world';

export const DISTRICTS = [
  'village',
  'planted borough',
  'medieval ribbons',
  'early modern ribbons',
  'Georgian estates',
  'Victorian estates',
] as const;
export type District = (typeof DISTRICTS)[number];

/** The district a plot belongs to, from how and when it was laid out. */
export function districtOf(p: Parcel): District | null {
  const u = p.unit;
  if (!u) return null;
  switch (u.kind) {
    case 'village':
      return 'village';
    case 'borough':
      return 'planted borough';
    case 'ribbon':
      return u.year < 1540 ? 'medieval ribbons' : 'early modern ribbons';
    case 'estate':
      return u.year < 1837 ? 'Georgian estates' : 'Victorian estates';
    default:
      return null;
  }
}

export interface Spread {
  median: number;
  p25: number;
  p75: number;
}

export interface StreetForm {
  /** Length of street (m). */
  length: number;
  orientationEntropy: number;
  orientationOrder: number;
  meshedness: number;
  /** Dead ends among the junctions and ends of these streets. */
  deadEndShare: number;
  /** Typical departure of junction angles from a right angle (degrees; 0 for a grid, ~22 for random). */
  junctionSkew: number;
  /** Length-weighted ratio of street length to straight-line length. */
  sinuosity: number;
}

export interface Form {
  plots: number;
  /** Plot frontage (m). */
  frontage: Spread;
  depth: Spread;
  /** Frontage over depth. */
  shape: Spread;
  /** Share of plot area built on. */
  coverage: number;
  /** Share of plot area under back buildings. */
  backCoverage: number;
  /** Share of street frontage taken by front buildings. */
  frontContinuity: number;
  streets: StreetForm;
}

export interface TownForm {
  town: Form;
  districts: Partial<Record<District, Form>>;
  /**
   * For each estate laid out on a field: how far it stood from the nearest
   * plot laid out before it (m, plot centre to plot centre, so a neighbouring
   * estate is a few tens of metres). Large values are estates out in the fields.
   */
  leapfrog: number[];
}

const TOWN_KINDS = new Set(['toft', 'burgage', 'plot']);

export function measureTown(world: World): TownForm {
  const cad = world.cadastre;
  const plots = [...cad.parcels.values()].filter((p) => TOWN_KINDS.has(p.kind) && p.frontage);
  // A street is part of the town where most of its length runs past plot fronts;
  // it belongs to the district whose plots it mostly passes.
  const fronts = new FrontIndex(plots);
  const streetsOf = new Map<District, GraphEdge[]>();
  const townStreets: GraphEdge[] = [];
  for (const e of world.graph.edges.values()) {
    const samples = resample(e.pts, 10);
    const votes = new Map<District | null, number>();
    let near = 0;
    for (const q of samples) {
      const p = fronts.nearest(q, STREET_REACH);
      if (!p) continue;
      near++;
      const d = districtOf(p);
      votes.set(d, (votes.get(d) ?? 0) + 1);
    }
    if (near < samples.length / 2) continue;
    townStreets.push(e);
    const d = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    if (!d) continue;
    let list = streetsOf.get(d);
    if (!list) streetsOf.set(d, (list = []));
    list.push(e);
  }
  const byDistrict = new Map<District, Parcel[]>();
  for (const p of plots) {
    const d = districtOf(p);
    if (!d) continue;
    let list = byDistrict.get(d);
    if (!list) byDistrict.set(d, (list = []));
    list.push(p);
  }
  const districts: Partial<Record<District, Form>> = {};
  for (const d of DISTRICTS) {
    const ps = byDistrict.get(d);
    if (ps?.length) districts[d] = formOf(world, ps, streetsOf.get(d) ?? []);
  }
  return { town: formOf(world, plots, townStreets), districts, leapfrog: leapfrog(plots) };
}

/** How far from a plot's front a street still counts as passing it. */
const STREET_REACH = 30;

/** Plot fronts by 30 m bucket, for finding the nearest one to a point. */
class FrontIndex {
  private buckets = new Map<number, { p: Parcel; at: Vec2 }[]>();
  constructor(plots: Parcel[]) {
    for (const p of plots) {
      const at = front(p);
      const k = this.key(Math.floor(at.x / STREET_REACH), Math.floor(at.y / STREET_REACH));
      let list = this.buckets.get(k);
      if (!list) this.buckets.set(k, (list = []));
      list.push({ p, at });
    }
  }
  private key(bx: number, by: number): number {
    return (by + 4096) * 8192 + (bx + 4096);
  }
  nearest(q: Vec2, r: number): Parcel | null {
    const bx = Math.floor(q.x / STREET_REACH);
    const by = Math.floor(q.y / STREET_REACH);
    let best: Parcel | null = null;
    let bestD = r;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const x of this.buckets.get(this.key(bx + dx, by + dy)) ?? []) {
          const d = dist(x.at, q);
          if (d < bestD) [best, bestD] = [x.p, d];
        }
      }
    }
    return best;
  }
}

function front(p: Parcel): Vec2 {
  const f = p.frontage!;
  return { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
}

function spread(values: number[]): Spread {
  if (!values.length) return { median: 0, p25: 0, p75: 0 };
  const v = values.slice().sort((a, b) => a - b);
  const q = (f: number) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
  return { median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

function formOf(world: World, plots: Parcel[], streets: GraphEdge[]): Form {
  const cad = world.cadastre;
  const widths: number[] = [];
  const depths: number[] = [];
  const shapes: number[] = [];
  let area = 0;
  let built = 0;
  let back = 0;
  let frontage = 0;
  let frontBuilt = 0;
  for (const p of plots) {
    const f = p.frontage!;
    const fr = plotFrame(p.shape, f);
    widths.push(fr.width);
    depths.push(fr.depth);
    if (fr.depth > 0) shapes.push(fr.width / fr.depth);
    area += p.area;
    frontage += fr.width;
    // Front buildings' extent along the frontage, merged where they meet.
    const spans: [number, number][] = [];
    for (const b of cad.buildingsOn(p.id)) {
      const a = shapeArea(b.footprint);
      built += a;
      if (b.back) {
        back += a;
        continue;
      }
      const us = b.footprint[0].map((q) => (q.x - fr.origin.x) * fr.u.x + (q.y - fr.origin.y) * fr.u.y);
      spans.push([Math.max(0, Math.min(...us)), Math.min(fr.width, Math.max(...us))]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let end = 0;
    for (const [s, e] of spans) {
      if (e <= end) continue;
      frontBuilt += e - Math.max(s, end);
      end = e;
    }
  }
  return {
    plots: plots.length,
    frontage: spread(widths),
    depth: spread(depths),
    shape: spread(shapes),
    coverage: area ? built / area : 0,
    backCoverage: area ? back / area : 0,
    frontContinuity: frontage ? frontBuilt / frontage : 0,
    streets: streetForm(world, streets),
  };
}

function streetForm(world: World, edges: GraphEdge[]): StreetForm {
  const g = world.graph;
  const nodes = new Set<number>();
  for (const e of edges) nodes.add(e.a).add(e.b);
  let ends = 0;
  let deadEnds = 0;
  const skews: number[] = [];
  const mine = new Set(edges.map((e) => e.id));
  for (const n of nodes) {
    const d = g.degree(n);
    if (d === 2) continue;
    ends++;
    if (d === 1) deadEnds++;
    if (d < 3) continue;
    // The bearings of the ways leaving a junction, in order round it.
    const pos = g.nodes.get(n)!.pos;
    const bearings = [...g.edgesAt(n)]
      .filter((id) => mine.has(id))
      .map((id) => {
        const e = g.edges.get(id)!;
        const pts = e.a === n ? e.pts : e.pts.slice().reverse();
        return bearingAway(pos, pts);
      });
    for (let i = 0; i < bearings.length; i++) {
      for (let j = i + 1; j < bearings.length; j++) {
        const diff = Math.abs(bearings[i] - bearings[j]) % 90;
        skews.push(Math.min(diff, 90 - diff));
      }
    }
  }
  let length = 0;
  let weighted = 0;
  for (const e of edges) {
    const len = polylineLength(e.pts);
    length += len;
    const chord = dist(e.pts[0], e.pts[e.pts.length - 1]);
    weighted += chord > 1 ? len * (len / chord) : len;
  }
  const n = nodes.size;
  const m = edges.length;
  const h = orientationEntropyOf(edges);
  const c = components(edges);
  return {
    length,
    orientationEntropy: h,
    orientationOrder: orientationOrder(h),
    // Independent loops (m - n + c, for c separate pieces) against the most a planar graph could have.
    meshedness: n >= 3 ? Math.max(0, (m - n + c) / (2 * n - 5)) : 0,
    deadEndShare: ends ? deadEnds / ends : 0,
    junctionSkew: spread(skews).median,
    sinuosity: length ? weighted / length : 1,
  };
}

/** Number of separate connected pieces a set of edges forms. */
function components(edges: GraphEdge[]): number {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x)! !== x) x = parent.get(x)!;
    return x;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    parent.set(find(e.a), find(e.b));
  }
  let c = 0;
  for (const [k, v] of parent) if (k === v) c++;
  return c;
}

/** Bearing (degrees) of a way leaving a point, taken some metres out so kinks at the junction don't count. */
function bearingAway(from: Vec2, pts: readonly Vec2[]): number {
  let target = pts[pts.length - 1];
  for (const p of pts) {
    if (dist(from, p) >= 10) {
      target = p;
      break;
    }
  }
  return (Math.atan2(target.y - from.y, target.x - from.x) * 180) / Math.PI + 360;
}

function leapfrog(plots: Parcel[]): number[] {
  const estates = new Map<string, Parcel[]>();
  for (const p of plots) {
    if (p.unit?.kind !== 'estate') continue;
    const key = `${p.unit.year} ${p.unit.street}`;
    let list = estates.get(key);
    if (!list) estates.set(key, (list = []));
    list.push(p);
  }
  const out: number[] = [];
  for (const list of estates.values()) {
    const year = list[0].unit!.year;
    const before = plots.filter((q) => q.unit && q.unit.year < year).map((q) => ringCentroid(q.shape[0]));
    if (!before.length) continue;
    let best = Infinity;
    for (const p of list) {
      const c = ringCentroid(p.shape[0]);
      for (const q of before) best = Math.min(best, dist(c, q));
    }
    out.push(best);
  }
  return out;
}

