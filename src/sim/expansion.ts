// How a town grows beyond its first plan: plots laid out along the ways
// leaving it, and later whole fields bought and laid out with new streets
// running along their length (Ward 1962 on Leeds; Beresford). Land is only
// taken where whoever holds its alienation right is willing to sell.

import { dist, polylineLength, resample, simplify, type Vec2 } from './geom';
import { bufferPolyline, differenceMany, distanceToBoundary, intersection, pointInShape, ringCentroid, shapeArea, type Shape } from './polygon';
import { clipPolyline, cutFrontage, overlapsAny, perchWidths, type CutPlot } from './plots';
import type { Parcel, ParcelKind } from './cadastre';
import { WAY_WIDTH, type GraphEdge } from './graph';
import { mapShape, plotsFromLand, putUpFront, streetFrom, trimTo, wayBuffers, WAY_HALF_WIDTH } from './town';
import { accessAt } from './landvalue';
import { crossesBuilding, crossesSolid, type World } from './world';
import type { TownPlotRules } from '../plugins/types';

/** Rural parcels a ribbon of new plots may be cut from. */
const RIBBON_FROM = new Set<ParcelKind>(['strip', 'close', 'common']);
/** Parcels a builder may buy whole and lay out. */
const FIELD_FROM = new Set<ParcelKind>(['close', 'common', 'works', 'precinct']);

/** A number in [0, 1) fixed for a parcel over a decade: whether its holder will sell just now. */
function hash01(id: number, salt: number): number {
  const x = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Whether a parcel's land can be had this decade. */
export function forSale(world: World, p: Parcel): boolean {
  const year = world.clock.now;
  const w = world.plugins.tenure.willingToSell(p, world.cadastre, year);
  return w > hash01(p.id, Math.floor(year / 10));
}

/** Distance from a point to the built-up area, in metres (from the town's edge raster). */
export function edgeDistance(world: World, p: Vec2): number {
  const r = world.town.edge;
  return r ? r.sample(p) : Infinity;
}

/** Lay out new plots for a growing town. Returns how many were laid out. */
export function expandTown(world: World): number {
  const rules = world.plugins.technology.plots.townPlots(world.clock.now);
  if (rules.wholeFields) {
    const n = developField(world, rules);
    if (n) return n;
  }
  return extendAlongWays(world, rules);
}

interface Ribbon {
  street: Vec2[];
  edges: number[];
  plots: CutPlot[];
  name: string;
  score: number;
}

/** Plots along a way where it leaves the built-up area, on land whose holders will sell. */
function extendAlongWays(world: World, rules: TownPlotRules): number {
  const g = world.graph;
  // Ways that leave the town: an end in the built-up area, running out of it.
  const exits: { edge: GraphEdge; node: number }[] = [];
  for (const e of g.edges.values()) {
    if (e.cls === 'path') continue;
    for (const nodeId of [e.a, e.b]) {
      const here = g.nodes.get(nodeId)!.pos;
      const there = g.nodes.get(g.other(e, nodeId))!.pos;
      if (edgeDistance(world, here) < 25 && edgeDistance(world, there) > 25) exits.push({ edge: e, node: nodeId });
    }
  }
  exits.sort((a, b) => b.edge.usage - a.edge.usage);
  // The busiest ways first, going on to quieter ones until a few could take plots.
  let best: Ribbon | null = null;
  let found = 0;
  for (const exit of exits.slice(0, 16)) {
    const r = layOutRibbon(world, rules, exit.edge, exit.node);
    if (!r) continue;
    if (!best || r.score > best.score) best = r;
    if (++found >= 3) break;
  }
  if (!best) return 0;
  for (const id of best.edges) {
    const e = g.edges.get(id);
    if (!e) continue;
    e.planned = true;
    e.floor = 'lane';
    e.name ??= best.name;
    if (e.cls === 'path' || e.cls === 'track') e.cls = 'lane';
  }
  const year = Math.round(world.clock.now);
  const parcels = plotsFromLand(world, best.plots, rules.kind, `Land along ${best.name} taken for building plots`, RIBBON_FROM);
  for (const p of parcels) p.unit = { kind: 'ribbon', year, street: best.name };
  if (rules.building === 'speculative') buildSpeculatively(world, parcels, rules.use);
  world.log.push({ year, text: `The town spreads along ${best.name}: ${parcels.length} new plots.` });
  return parcels.length;
}

function layOutRibbon(world: World, rules: TownPlotRules, edge: GraphEdge, node: number): Ribbon | null {
  // Follow the way out until it leaves the built-up area, however far the town already reaches along it.
  const { pts, edges } = streetFrom(world, edge, node, 1400);
  const along = resample(pts, 2);
  const start = along.findIndex((p) => edgeDistance(world, p) > 15);
  if (start < 0) return null;
  const street = trimTo(along.slice(Math.max(0, start - 2)), 90 + world.rng.range(0, 120));
  if (polylineLength(street) < 50) return null;
  // A cheap look before any polygon work: is enough land along the way to be had?
  if (saleableShare(world, street, rules.depth, RIBBON_FROM) < 0.3) return null;
  const name = world.plugins.demand.streetName(world, toward(world, street), false);
  const area = bufferPolyline(street, rules.depth + 25);
  // Every way keeps its corridor, the street included: the plots begin beyond it.
  const land = availableLand(world, area, RIBBON_FROM, new Set());
  const cad = world.cadastre;
  const grain = (p: Vec2): number | null => {
    for (const f of cad.furlongs.values()) if (pointInShape(p, f.shape)) return f.orientation;
    return null;
  };
  const cls = world.graph.edges.get(edges[0])?.cls ?? 'lane';
  const width = perchWidths(world, rules.widths);
  const plots: CutPlot[] = [];
  for (const side of [1, -1] as const) {
    const offset = () => WAY_HALF_WIDTH[cls] + 1;
    for (const p of cutFrontage(street, side, { offset, depth: rules.depth, width, land, grain, street: name })) {
      if (world.terrain.wetness.sample(frontMid(p)) > 0.45 || overlapsAny(p.shape, plots)) continue;
      plots.push(p);
    }
  }
  if (plots.length < 4) return null;
  const access = plots.reduce((s, p) => s + accessAt(world, frontMid(p)), 0) / plots.length;
  return { street, edges, plots, name, score: plots.length * access };
}

/** The share of points either side of a way that lie on land whose holders would sell. */
function saleableShare(world: World, street: Vec2[], depth: number, from: Set<ParcelKind>): number {
  let ok = 0;
  let n = 0;
  const pts = resample(street, 20);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const l = dist(a, b) || 1;
    const nx = -(b.y - a.y) / l;
    const ny = (b.x - a.x) / l;
    for (const side of [1, -1]) {
      const p = { x: a.x + nx * side * depth * 0.5, y: a.y + ny * side * depth * 0.5 };
      n++;
      // Land in no parcel is the lord's waste, free to build on unless it is wet.
      const parcel = world.cadastre.parcelAt(p);
      if (parcel ? from.has(parcel.kind) && forSale(world, parcel) : world.terrain.wetness.sample(p) < 0.45) ok++;
    }
  }
  return n ? ok / n : 0;
}

/** Land within an area not taken by ways, the river or parcels that are not for sale. */
function availableLand(world: World, area: Shape, from: Set<ParcelKind>, exceptEdges: Set<number>): Shape[] {
  const b = boundsOf(area);
  const blocked = wayBuffers(world, area, exceptEdges);
  for (const p of world.cadastre.parcels.values()) {
    const pb = p.bounds;
    if (pb.maxX < b.minX || pb.minX > b.maxX || pb.maxY < b.minY || pb.minY > b.maxY) continue;
    if (!from.has(p.kind) || !forSale(world, p)) blocked.push(p.shape);
  }
  const clipped = intersection(area, mapShape(world))[0] ?? area;
  return differenceMany(clipped, blocked);
}

function boundsOf(shape: Shape) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of shape[0]) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

function frontMid(p: CutPlot): Vec2 {
  return { x: (p.frontage.a.x + p.frontage.b.x) / 2, y: (p.frontage.a.y + p.frontage.b.y) / 2 };
}

/** The place an old way heads for, if it points at one. */
function toward(world: World, street: Vec2[]): string | null {
  const a = street[0];
  const b = street[street.length - 1];
  const d = { x: b.x - a.x, y: b.y - a.y };
  const l = Math.hypot(d.x, d.y) || 1;
  let best: string | null = null;
  let bestCos = Math.cos((30 * Math.PI) / 180);
  for (const p of world.places) {
    if (p.kind !== 'gateway' && p.kind !== 'mill' && p.kind !== 'farmstead') continue;
    const v = { x: p.pos.x - a.x, y: p.pos.y - a.y };
    const vl = Math.hypot(v.x, v.y) || 1;
    const c = (v.x * d.x + v.y * d.y) / (vl * l);
    // Nearer places win ties: a farm on the way beats a far gateway.
    const score = c + (p.kind === 'gateway' ? 0 : 0.02);
    if (score > bestCos) {
      bestCos = score;
      best = p.name;
    }
  }
  return best;
}

/** A builder puts up every house at once, to let. */
function buildSpeculatively(world: World, parcels: Parcel[], use: string): void {
  for (const p of parcels) putUpFront(world, p, use);
}

/** The long axis of a shape, and its extent along and across it. */
function longAxis(shape: Shape): { c: Vec2; d: Vec2; t0: number; t1: number; s0: number; s1: number } {
  const ring = resample([...shape[0], shape[0][0]], 4);
  const c = ringCentroid(shape[0]);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of ring) {
    const x = p.x - c.x;
    const y = p.y - c.y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d = { x: Math.cos(theta), y: Math.sin(theta) };
  let t0 = Infinity;
  let t1 = -Infinity;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (const p of ring) {
    const t = (p.x - c.x) * d.x + (p.y - c.y) * d.y;
    const s = -(p.x - c.x) * d.y + (p.y - c.y) * d.x;
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
  }
  return { c, d, t0, t1, s0, s1 };
}

interface FieldPlan {
  field: Parcel;
  /** Street centrelines; an end flagged as joined meets an existing way there. */
  streets: { pts: Vec2[]; joinStart: boolean; joinEnd: boolean }[];
  score: number;
}

/**
 * A builder buys a whole field next to the town and lays it out: one or more
 * streets along its length, joined to the nearest way, and narrow plots both
 * sides. The old field boundary becomes the edge of the estate.
 */
function developField(world: World, rules: TownPlotRules): number {
  const cad = world.cadastre;
  const candidates: { p: Parcel; score: number }[] = [];
  for (const p of cad.parcels.values()) {
    if (!FIELD_FROM.has(p.kind) || p.area < 3500 || p.area > 70000) continue;
    if (world.town.unbuildable.has(p.id)) continue;
    // Only fields that touch the built-up area: towns grew field by field from their edge.
    const b = p.bounds;
    const centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    if (edgeDistance(world, centre) > Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 40) continue;
    const d = Math.min(...resample([...p.shape[0], p.shape[0][0]], 15).map((q) => edgeDistance(world, q)));
    if (d > 40) continue;
    const c = ringCentroid(p.shape[0]);
    if (world.terrain.wetness.sample(c) > 0.4) continue;
    if (!forSale(world, p)) continue;
    candidates.push({ p, score: accessAt(world, c, 150) / (1 + d / 150) });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const { p, score } of candidates.slice(0, 5)) {
    const plan = planField(world, p, rules, score);
    const n = plan ? layOutField(world, plan, rules) : 0;
    if (n) return n;
    // Its shape will not take streets and plots; don't try it again.
    world.town.unbuildable.add(p.id);
  }
  return 0;
}

function planField(world: World, field: Parcel, rules: TownPlotRules, score: number): FieldPlan | null {
  const g = world.graph;
  const ax = longAxis(field.shape);
  const width = ax.s1 - ax.s0;
  const length = ax.t1 - ax.t0;
  const block = 2 * rules.depth + 2 * WAY_HALF_WIDTH.lane + 2;
  if (length < 60 || width < block * 0.7) return null;
  const k = Math.max(1, Math.min(3, Math.floor(width / block)));
  const perp = { x: -ax.d.y, y: ax.d.x };
  const streets: FieldPlan['streets'] = [];
  for (let i = 0; i < k; i++) {
    const s = ax.s0 + ((i + 0.5) * width) / k;
    const base = { x: ax.c.x + perp.x * s, y: ax.c.y + perp.y * s };
    const line = [
      { x: base.x + ax.d.x * (ax.t0 - 20), y: base.y + ax.d.y * (ax.t0 - 20) },
      { x: base.x + ax.d.x * (ax.t1 + 20), y: base.y + ax.d.y * (ax.t1 + 20) },
    ];
    const run = clipPolyline(line, field.shape, 2).sort((a, b) => polylineLength(b) - polylineLength(a))[0];
    if (!run || polylineLength(run) < 50) continue;
    // Join each end to the blind end of an earlier street if one is near (the next field's
    // streets carry the last ones on), else to the nearest way within reach, if the link is clear.
    // Only where the join lies roughly straight ahead: builders ran their streets straight.
    const joinTo = (p: Vec2, ahead: Vec2): { proj: { point: Vec2 } } | null => {
      const straight = (q: Vec2) => {
        const d = dist(p, q);
        return d < 3 || ((q.x - p.x) * ahead.x + (q.y - p.y) * ahead.y) / d > Math.cos((35 * Math.PI) / 180);
      };
      const end = deadEndNear(world, p, 60);
      if (end && straight(end) && !crossesBuilding(world, [end, p]) && !crossesSolid(world, [end, p], WAY_WIDTH.lane / 2, false)) {
        return { proj: { point: end } };
      }
      const hit = g.nearestEdge(p, 45);
      return hit && straight(hit.proj.point) && !crossesBuilding(world, [hit.proj.point, p]) ? hit : null;
    };
    const first = joinTo(run[0], { x: -ax.d.x, y: -ax.d.y });
    const last = joinTo(run[run.length - 1], ax.d);
    if (first || last) {
      const pts = [...(first ? [first.proj.point] : []), ...run, ...(last ? [last.proj.point] : [])];
      streets.push({ pts, joinStart: !!first, joinEnd: !!last });
      continue;
    }
    // No way at either end: a short cross street from the middle to the nearest way.
    const mi = Math.floor(run.length / 2);
    const m = run[mi];
    const hit = g.nearestEdge(m, width);
    if (!hit || crossesBuilding(world, [hit.proj.point, m])) continue;
    streets.push({ pts: [hit.proj.point, m], joinStart: true, joinEnd: false });
    streets.push({ pts: run.slice(0, mi + 1), joinStart: false, joinEnd: false });
    streets.push({ pts: run.slice(mi), joinStart: false, joinEnd: false });
  }
  if (!streets.length) return null;
  return { field, streets, score };
}

/** The nearest node where a street ends blind, within reach of a point. */
function deadEndNear(world: World, p: Vec2, reach: number): Vec2 | null {
  const g = world.graph;
  let best: Vec2 | null = null;
  let bestD = reach;
  for (const n of g.nodes.values()) {
    if (g.degree(n.id) !== 1 || n.placeId !== null) continue;
    const e = g.edges.get([...g.edgesAt(n.id)][0])!;
    if (!e.planned) continue;
    const d = dist(n.pos, p);
    if (d < bestD) [best, bestD] = [n.pos, d];
  }
  return best;
}

/**
 * Carry a street that ends blind on to the nearest way ahead, as a lane across
 * the fields, if one is within reach and the lane would cross no one's plot.
 */
function throughLane(world: World, end: number, year: number, streets: Set<number>): void {
  const g = world.graph;
  const node = g.nodes.get(end)!;
  const e = g.edges.get([...g.edgesAt(end)][0])!;
  const pts = e.a === end ? e.pts : e.pts.slice().reverse();
  const from = pts[0];
  const prev = pts.find((q) => dist(q, from) > 5) ?? pts[pts.length - 1];
  const len = dist(from, prev) || 1;
  const dir = { x: (from.x - prev.x) / len, y: (from.y - prev.y) / len };
  // Straight on if a way lies ahead; failing that, a lane turning square to either side, as
  // builders laid them: a slanting link would spoil the estate's grid.
  let best: { point: Vec2; reach: number } | null = null;
  for (const turn of [0, -90, 90]) {
    const a = (turn * Math.PI) / 180;
    const d = { x: dir.x * Math.cos(a) - dir.y * Math.sin(a), y: dir.x * Math.sin(a) + dir.y * Math.cos(a) };
    for (let reach = 20; reach <= THROUGH_LANE_REACH; reach += 10) {
      const tip = { x: from.x + d.x * reach, y: from.y + d.y * reach };
      const hit = g.nearestEdge(tip, 8, new Set([e.id]));
      if (!hit) continue;
      const line = [from, hit.proj.point];
      // A straight run is worth a longer lane than a turn.
      const cost = dist(from, hit.proj.point) * (turn ? 1.5 : 1);
      if (!crossesBuilding(world, line) && !crossesSolid(world, line, WAY_WIDTH.lane / 2, false) && (!best || cost < best.reach)) {
        best = { point: hit.proj.point, reach: cost };
      }
      break;
    }
  }
  if (!best) return;
  const j = g.junctionAt(best.point, 8, 6);
  if (!j || j.id === end) return;
  const lane = g.addEdge(end, j.id, [node.pos, j.pos], 'lane', world.plugins.technology.hierarchy.downgradeAt.lane * 2, year);
  lane.planned = true;
  lane.floor = 'lane';
  // Its own way, not a bend in the street it leads from (it takes a name when plots are cut along it).
  // The lane may cross the estate's own streets: keep track of all their pieces.
  const pieces = g.nodeCrossings([lane.id, ...streets]);
  streets.clear();
  for (const id of pieces) streets.add(id);
}

/** How far a blind street is carried on across the fields to meet another way. */
const THROUGH_LANE_REACH = 150;

function layOutField(world: World, plan: FieldPlan, rules: TownPlotRules): number {
  const g = world.graph;
  const year = Math.round(world.clock.now);
  const name = world.plugins.demand.streetName(world, null, true);
  const newEdges = new Set<number>();
  // Ends shared between the new streets meet at one node.
  const shared: { pos: Vec2; id: number }[] = [];
  const nodeAt = (p: Vec2, joined: boolean): number => {
    if (joined) return (g.junctionAt(p, 8, 6) ?? g.addNode(p)).id;
    const s = shared.find((x) => dist(x.pos, p) < 1);
    if (s) return s.id;
    const id = g.addNode(p).id;
    shared.push({ pos: p, id });
    return id;
  };
  for (const s of plan.streets) {
    const a = nodeAt(s.pts[0], s.joinStart);
    const b = nodeAt(s.pts[s.pts.length - 1], s.joinEnd);
    if (a === b) continue;
    const e = g.addEdge(a, b, s.pts, 'lane', world.plugins.technology.hierarchy.downgradeAt.lane * 2, year);
    e.planned = true;
    e.floor = 'lane';
    e.name = name;
    newEdges.add(e.id);
  }
  if (!newEdges.size) return 0;
  // Where a new street crosses an old way, or another new one, they meet at a crossroads.
  const pieces = g.nodeCrossings(newEdges);
  newEdges.clear();
  for (const id of pieces) newEdges.add(id);
  // A street that would run over someone else's plot or yard is not laid out.
  if ([...newEdges].some((id) => crossesSolid(world, g.edges.get(id)!.pts, WAY_WIDTH.lane / 2, false))) {
    for (const id of newEdges) g.removeEdge(id);
    return 0;
  }
  // Streets left ending blind are carried on to the next way, where the way across the fields is clear.
  for (const id of [...newEdges]) {
    const e = g.edges.get(id);
    if (!e) continue;
    for (const end of [e.a, e.b]) {
      if (!g.nodes.has(end) || g.degree(end) !== 1 || g.nodes.get(end)!.placeId !== null) continue;
      if (g.nodes.has(end) && g.degree(end) === 1) throughLane(world, end, year, newEdges);
    }
  }

  // Plots along the new streets first, then along any old way on the field's edge.
  // Enclosed closes keep every kink of the strips they were pooled from; a simpler outline is enough here.
  const field: Shape = plan.field.shape.map((ring) => simplify([...ring, ring[0]], 0.8).slice(0, -1));
  const land = differenceMany(field, wayBuffers(world, field));
  const width = perchWidths(world, rules.widths);
  const plots: CutPlot[] = [];
  const edges = [...newEdges].map((id) => g.edges.get(id)!).concat(
    [...g.edges.values()].filter((e) => !newEdges.has(e.id) && e.cls !== 'path'),
  );
  for (const e of edges) {
    for (const run of newEdges.has(e.id) ? clipPolyline(e.pts, field) : runsNear(e.pts, field, 14)) {
      if (polylineLength(run) < 20) continue;
      const street = e.name ?? name;
      for (const side of [1, -1] as const) {
        const offset = () => WAY_HALF_WIDTH[e.cls] + 1;
        for (const p of cutFrontage(run, side, { offset, depth: rules.depth, width, land, street, minArea: 60 })) {
          // Cut on a simplified outline, so trim back to the field's true boundary.
          const inside = intersection(p.shape, plan.field.shape).sort((x, y) => shapeArea(y) - shapeArea(x))[0];
          if (!inside || shapeArea(inside) < 60 || overlapsAny(inside, plots)) continue;
          plots.push({ ...p, shape: [inside[0]] });
        }
      }
    }
  }
  if (plots.length < 6) {
    for (const id of newEdges) g.removeEdge(id);
    return 0;
  }
  const seller = sellerName(world, plan.field.rights.alienation);
  const builder = world.cadastre.addHolder('company', world.plugins.demand.builderName?.(world) ?? 'a builder');
  const parcels = plotsFromLand(world, plots, rules.kind, `${seller} sells the field to ${builder.name}, who lays out ${name}`, new Set([plan.field.kind]));
  for (const p of parcels) p.unit = { kind: 'estate', year, street: name };
  const { regime, rights } = world.plugins.tenure.rights(rules.kind, builder.id, world.cadastre);
  for (const p of parcels) {
    p.rights = { ...rights };
    p.regime = regime;
  }
  if (rules.building === 'speculative') buildSpeculatively(world, parcels, rules.use);
  world.log.push({
    year,
    text: `${cap(seller)} sells a field to ${builder.name}, who lays out ${name} along its length: ${parcels.length} ${rules.building === 'speculative' ? 'houses' : 'plots'}.`,
  });
  return parcels.length;
}

/** How a seller is named in the chronicle. */
function sellerName(world: World, id: number | undefined): string {
  const h = id !== undefined ? world.cadastre.holders.get(id) : undefined;
  if (!h) return 'the lord';
  // Farm households are known by their farm's name.
  if (h.kind === 'household' && !h.name.includes(' ')) return `the farmer at ${h.name}`;
  if (h.kind === 'household' && /^household \d+$/.test(h.name)) return 'a villager';
  return h.name;
}

/** The stretches of a polyline that run along (within `r` of) a shape's edge or through it. */
function runsNear(pts: readonly Vec2[], shape: Shape, r: number): Vec2[][] {
  const b = boundsOf(shape);
  if (!pts.some((p) => p.x > b.minX - r && p.x < b.maxX + r && p.y > b.minY - r && p.y < b.maxY + r)) return [];
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of resample(pts, 4)) {
    if (pointInShape(p, shape) || distanceToBoundary(p, shape) < r) cur.push(p);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((x) => x.length >= 2);
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
