// Village and town plots: tofts along village streets, a planted borough with
// its market place and burgage plots, and plots being taken up over time.

import { dist, polylineLength, resample, type Vec2 } from './geom';
import {
  bounds,
  bufferPolyline,
  difference,
  differenceMany,
  intersection,
  pointInShape,
  radialPolygon,
  rectangle,
  shapeArea,
  thickness,
  union,
  type Shape,
} from './polygon';
import { clipPolyline, cutFrontage, frameRect, frontBuilding, overlapsAny, perchWidths, plotFrame, splitLengthwise, type CutPlot } from './plots';
import type { Frontage, Parcel, ParcelKind } from './cadastre';
import { WAY_WIDTH, type EdgeClass, type GraphEdge } from './graph';
import { insertRoute, DEFAULT_INSERT } from './insert';
import { crossesBuilding, crossesSolid, type Place, type World } from './world';
import type { Rng } from './rng';
import { wobblyOutline } from './fields';

export const WAY_HALF_WIDTH: Record<EdgeClass, number> = { path: 2, track: 3, lane: 4, road: 5 };

/** Corridors of ways (and the river) near an area, which plots must keep clear of. */
export function wayBuffers(world: World, near: Shape, except: Set<number> = new Set()): Shape[] {
  const b = bounds(near);
  const pad = 20;
  const touches = (pts: readonly Vec2[]) =>
    pts.some((p) => p.x > b.minX - pad && p.x < b.maxX + pad && p.y > b.minY - pad && p.y < b.maxY + pad);
  const out: Shape[] = [];
  for (const e of world.graph.edges.values()) {
    if (!except.has(e.id) && touches(e.pts)) out.push(bufferPolyline(e.pts, WAY_HALF_WIDTH[e.cls] + 0.5));
  }
  for (const r of world.terrain.rivers) {
    if (touches(resample(r.centreline, 10))) out.push(bufferPolyline(r.centreline, r.width / 2 + 6));
  }
  return out.filter((s) => s.length && s[0].length >= 3);
}

export function mapShape(world: World): Shape {
  const h = world.terrain.height;
  return rectangle({ minX: 2, minY: 2, maxX: h.worldWidth - 2, maxY: h.worldHeight - 2 });
}

export function addPlot(world: World, kind: ParcelKind, plot: CutPlot): Parcel {
  const lord = world.cadastre.lord!;
  const { regime, rights } = world.plugins.tenure.rights(kind, lord, world.cadastre);
  const p = world.cadastre.addParcel(kind, plot.shape, regime, rights, Math.round(world.clock.now));
  p.frontage = plot.frontage;
  return p;
}

/** The churchyard around a church, and the church itself, facing east. */
export function layOutChurchyard(world: World, church: Place, holder: number): void {
  const yard = intersection(radialPolygon(church.pos, () => 26, 20), mapShape(world))[0];
  // Short of the ways, and of any land already held (a farm's closes near the meeting of ways).
  const held = [...world.cadastre.parcels.values()].filter((p) => p.kind !== 'strip').map((p) => p.shape);
  const parts = differenceMany(yard, [...wayBuffers(world, yard), ...held]).filter((p) => shapeArea(p) >= 200);
  if (!parts.length) return;
  const year = Math.round(world.clock.now);
  const { regime, rights } = world.plugins.tenure.rights('churchyard', holder, world.cadastre);
  const parcels = parts.map((part) => world.cadastre.addParcel('churchyard', part, regime, rights, year));
  // The church stands in the largest part: nave and chancel, east–west.
  const parcel = parcels.reduce((a, b) => (b.area > a.area ? b : a));
  const part = parcel.shape;
  {
    const c = centroidOf(part);
    const L = 22;
    const W = 8;
    const rect: Shape = [[
      { x: c.x - L / 2, y: c.y - W / 2 },
      { x: c.x + L / 2, y: c.y - W / 2 },
      { x: c.x + L / 2, y: c.y + W / 2 },
      { x: c.x - L / 2, y: c.y + W / 2 },
    ]];
    const fp = intersection(rect, part)[0];
    if (fp) {
      world.cadastre.addBuilding({
        parcelId: parcel.id,
        use: 'church',
        footprint: fp,
        ridge: [{ x: c.x - L / 2, y: c.y }, { x: c.x + L / 2, y: c.y }],
        storeys: 2,
        built: year,
      });
    }
  }
}

function centroidOf(shape: Shape): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of shape[0]) {
    x += p.x;
    y += p.y;
  }
  return { x: x / shape[0].length, y: y / shape[0].length };
}

/**
 * Tofts and crofts along the ways through the village core. Households move
 * into the plots nearest the church first.
 */
export function layOutTofts(world: World, core: Shape, church: Vec2, households: number[]): number {
  const rules = world.plugins.technology.plots;
  // Anything already held there (the churchyard, the closes of a farm that stayed) is kept clear.
  const taken = [...world.cadastre.parcels.values()].filter((p) => p.kind !== 'strip').map((p) => p.shape);
  const land = differenceMany(core, [...wayBuffers(world, core), ...taken]);
  const width = perchWidths(world, rules.toftWidths);
  const cut = plotsAlongWays(world, core, land, rules.toftDepth, width, 'the village street');
  const parcels = cut.map((p) => addPlot(world, 'toft', p));
  for (const p of parcels) p.unit = { kind: 'village', year: Math.round(world.clock.now) };
  parcels.sort((a, b) => dist(mid(a), church) - dist(mid(b), church));
  let housed = 0;
  for (const h of households) {
    const plot = parcels[housed];
    if (!plot) break;
    takeUp(world, plot, h, 'cottage');
    housed++;
  }
  return parcels.length;
}

export function mid(p: Parcel): Vec2 {
  const f = p.frontage!;
  return { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
}

/**
 * Turn cut plots into parcels, giving up the open-field strips beneath them.
 * What is left of each strip beyond the plots stays in cultivation, except
 * for slivers along the plot edges.
 */
function plotsFromStrips(world: World, plots: CutPlot[], kind: ParcelKind, note: string): Parcel[] {
  return plotsFromLand(world, plots, kind, note, new Set(['strip']));
}

/**
 * Turn cut plots into parcels, taking the land from whatever parcels of the
 * given kinds lie beneath. What is left of each is kept, except slivers.
 */
export function plotsFromLand(world: World, plots: CutPlot[], kind: ParcelKind, note: string, from: Set<ParcelKind>): Parcel[] {
  const trimmed = takeLand(world, plots.map((p) => p.shape), from);
  const parcels = plots.map((p) => addPlot(world, kind, p));
  const year = Math.round(world.clock.now);
  world.cadastre.retire(trimmed.consumed, year, note, [...parcels.map((p) => p.id), ...trimmed.rest]);
  return parcels;
}

/**
 * Cut shapes out of the parcels of the given kinds beneath them. Returns the
 * parcels to retire and the remainders added in their place (not yet retired,
 * so the caller can record one history event).
 */
export function takeLand(world: World, shapes: Shape[], from: Set<ParcelKind>): { consumed: number[]; rest: number[] } {
  const cad = world.cadastre;
  const year = Math.round(world.clock.now);
  const consumed: number[] = [];
  const rest: number[] = [];
  const b = shapes.map(bounds);
  for (const parcel of [...cad.parcels.values()]) {
    if (!from.has(parcel.kind)) continue;
    const pb = parcel.bounds;
    const near = b.filter((x) => x.minX <= pb.maxX && pb.minX <= x.maxX && x.minY <= pb.maxY && pb.minY <= x.maxY);
    if (!near.length) continue;
    const overlap = shapes.some((s) => intersection(s, parcel.shape).some((x) => shapeArea(x) > 1));
    if (!overlap) continue;
    const minArea = parcel.kind === 'strip' ? world.plugins.technology.fields.minStripArea : 300;
    const parts = differenceMany(parcel.shape, shapes).filter((x) => shapeArea(x) > minArea && thickness(x) > 5);
    consumed.push(parcel.id);
    for (const part of parts) {
      const p = cad.addParcel(parcel.kind, part, parcel.regime, { ...parcel.rights }, year, parcel.furlongId);
      p.use = parcel.use;
      p.takenUp = parcel.takenUp;
      p.unit = parcel.unit;
      rest.push(p.id);
    }
  }
  return { consumed, rest };
}

/** Land plots may be cut from near an area: anything but ways, the river and parcels of the kinds given. */
export function plotLand(world: World, area: Shape, keep: Set<ParcelKind>, exceptEdges: Set<number> = new Set()): Shape[] {
  const blocked = [
    ...wayBuffers(world, area, exceptEdges),
    ...[...world.cadastre.parcels.values()].filter((p) => keep.has(p.kind)).map((p) => p.shape),
  ];
  return differenceMany(intersection(area, mapShape(world))[0] ?? area, blocked);
}

/** Plots cut along every way through an area, both sides, skipping overlaps where ways meet. */
export function plotsAlongWays(world: World, area: Shape, land: Shape[], depth: number, width: () => number, street: string): CutPlot[] {
  const cut: CutPlot[] = [];
  for (const e of world.graph.edges.values()) {
    for (const run of clipPolyline(e.pts, area)) {
      if (polylineLength(run) < 25) continue;
      for (const side of [1, -1] as const) {
        const plots = cutFrontage(run, side, { offset: () => WAY_HALF_WIDTH[e.cls] + 1, depth, width, land, street });
        for (const p of plots) {
          if (overlapsAny(p.shape, cut)) continue;
          cut.push(p);
        }
      }
    }
  }
  return cut;
}

/**
 * The village spreads along its lanes: a ring of new tofts beyond the old
 * core, taken from the edge of the open fields.
 */
export function extendVillage(world: World, centre: Vec2, rng: Rng): number {
  const rules = world.plugins.technology.plots;
  const core = world.villageCore;
  if (!core) return 0;
  world.villageRadius += rules.villageGrowth;
  const outline = wobblyOutline(rng, centre, world.villageRadius, 0.15);
  const ring = differenceMany(outline, [core]);
  const keep = new Set<ParcelKind>(['toft', 'burgage', 'plot', 'precinct', 'works', 'market', 'churchyard', 'close', 'meadow', 'common']);
  const width = perchWidths(world, rules.toftWidths);
  const cut: CutPlot[] = [];
  for (const part of ring) {
    const land = plotLand(world, part, keep);
    for (const p of plotsAlongWays(world, part, land, rules.toftDepth, width, 'the village street')) {
      if (world.terrain.wetness.sample(p.frontage.a) > 0.45) continue;
      cut.push(p);
    }
  }
  world.villageCore = union(core, outline)[0] ?? core;
  if (!cut.length) return 0;
  const tofts = plotsFromStrips(world, cut, 'toft', 'Strips at the edge of the fields taken for new tofts');
  for (const p of tofts) p.unit = { kind: 'village', year: Math.round(world.clock.now) };
  return cut.length;
}

/** A holder takes up a plot: the rights pass to them and they build at the front. */
export function takeUp(world: World, plot: Parcel, holder: number, use: string): void {
  const { regime, rights } = world.plugins.tenure.rights(plot.kind, holder, world.cadastre);
  const year = Math.round(world.clock.now);
  world.cadastre.regrant(plot, rights, regime, year, `${world.cadastre.holderName(holder)} takes up a ${plot.kind}`);
  plot.phase = 'institutive';
  // A builder may already have put the house up.
  if (world.cadastre.buildingsOn(plot.id).some((b) => !b.back)) return;
  putUpFront(world, plot, use);
}

/** Put up a plot's front building for a use. */
export function putUpFront(world: World, plot: Parcel, use: string): boolean {
  const type = world.plugins.technology.uses[use];
  if (!type || !plot.frontage) return false;
  const b = frontBuilding(plot.shape, plot.frontage, type.building);
  if (!b) return false;
  // Whatever stands where the new front goes is pulled down first.
  for (const old of world.cadastre.buildingsOn(plot.id)) {
    if (intersection(old.footprint, b.footprint).some((x) => shapeArea(x) > 0.5)) world.cadastre.removeBuilding(old.id);
  }
  const year = Math.round(world.clock.now);
  world.cadastre.addBuilding({ parcelId: plot.id, use, footprint: b.footprint, ridge: b.ridge, storeys: type.storeys, built: year });
  for (const o of type.outbuildings ?? []) putUpOutbuilding(world, plot, b.footprint, o, year);
  return true;
}

/** An outbuilding along one side of a plot: a wing behind the house, or at the far end of the yard. */
function putUpOutbuilding(
  world: World,
  plot: Parcel,
  house: Shape,
  o: { use: string; width: number; depth: number; place: 'wing' | 'yard' },
  year: number,
): void {
  const fr = plotFrame(plot.shape, plot.frontage!);
  const w = Math.min(o.width, fr.width * 0.6);
  if (w < 1.2) return;
  // Every other plot builds on its other side, so wings pair up across the party wall as they did.
  const u0 = plot.id % 2 ? 0.2 : fr.width - 0.2 - w;
  const back = Math.max(...house[0].map((p) => (p.x - fr.origin.x) * fr.n.x + (p.y - fr.origin.y) * fr.n.y));
  const n0 = o.place === 'wing' ? back : fr.depth - 0.5 - o.depth;
  if (n0 < back || n0 + o.depth > fr.depth - 0.3) return;
  const rect = frameRect(fr, u0, u0 + w, n0, n0 + o.depth);
  if (intersection(rect, plot.shape).reduce((a, x) => a + shapeArea(x), 0) < w * o.depth * 0.995) return;
  const standing = world.cadastre.buildingsOn(plot.id).filter((x) => x.footprint !== house);
  if (standing.some((x) => intersection(rect, x.footprint).some((y) => shapeArea(y) > 0.2))) return;
  const at = (du: number, dn: number) => ({ x: fr.origin.x + fr.u.x * du + fr.n.x * dn, y: fr.origin.y + fr.u.y * du + fr.n.y * dn });
  const ridge: [Vec2, Vec2] = [at(u0 + w / 2, n0), at(u0 + w / 2, n0 + o.depth)];
  const storeys = world.plugins.technology.uses[o.use]?.storeys ?? 1;
  world.cadastre.addBuilding({ parcelId: plot.id, use: o.use, footprint: rect, ridge, storeys, built: year, back: true });
}

/** Vacant plots of a kind, nearest a point first. */
export function vacantPlots(world: World, kind: ParcelKind, near: Vec2): Parcel[] {
  return [...world.cadastre.parcels.values()]
    .filter((p) => p.kind === kind && p.takenUp === undefined && p.frontage)
    .sort((a, b) => dist(mid(a), near) - dist(mid(b), near));
}

export interface Borough {
  street: Vec2[];
  market: Shape;
  marketCentre: Vec2;
  plots: number;
  streetName: string;
}

/**
 * Follow the busiest ways outward from where a road leaves the village, to
 * get the line of the new town street.
 */
export function streetFrom(world: World, start: GraphEdge, fromNode: number, length: number): { pts: Vec2[]; edges: number[] } {
  const g = world.graph;
  const pts: Vec2[] = [];
  const edges: number[] = [];
  let edge = start;
  let node = fromNode;
  while (polylineLength(pts) < length) {
    const geom = edge.a === node ? edge.pts : edge.pts.slice().reverse();
    pts.push(...(pts.length ? geom.slice(1) : geom));
    edges.push(edge.id);
    node = g.other(edge, node);
    let next: GraphEdge | null = null;
    for (const eid of g.edgesAt(node)) {
      const e = g.edges.get(eid)!;
      if (edges.includes(e.id)) continue;
      // Keep going roughly straight on along the busiest way.
      const g2 = e.a === node ? e.pts : e.pts.slice().reverse();
      const d1 = direction(pts.slice(-6));
      const d2 = direction(g2.slice(0, 6));
      if (d1.x * d2.x + d1.y * d2.y < 0.5) continue;
      if (!next || e.usage > next.usage) next = e;
    }
    if (!next) break;
    edge = next;
  }
  return { pts: trimTo(pts, length), edges };
}

export function direction(pts: Vec2[]): Vec2 {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

export function trimTo(pts: Vec2[], length: number): Vec2[] {
  const out = [pts[0]];
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (len + d >= length) {
      const f = (length - len) / d;
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f });
      return out;
    }
    len += d;
    out.push(pts[i]);
  }
  return out;
}

interface BoroughLayout {
  street: Vec2[];
  /** The graph edges the street runs along. */
  edges: number[];
  plots: CutPlot[];
  streetName: string;
}

/** Lay out (without committing) a borough along the way leaving the village by `edge` from `node`. */
function layOutBorough(world: World, core: Shape, edge: GraphEdge, node: number): BoroughLayout | null {
  const rules = world.plugins.technology.plots;
  const cad = world.cadastre;
  const { pts: raw, edges } = streetFrom(world, edge, node, rules.boroughLength + 200);
  // Start the town street at the edge of the village.
  const along = resample(raw, 2);
  let startIdx = along.findIndex((p) => !pointInShape(p, core));
  if (startIdx < 0) return null;
  startIdx = Math.max(0, startIdx - 4);
  const street = trimTo(along.slice(startIdx), rules.boroughLength);
  if (polylineLength(street) < rules.marketLength + 40) return null;

  const keep = new Set(['meadow', 'toft', 'close', 'churchyard', 'common'] as ParcelKind[]);
  const area = bufferPolyline(street, rules.burgageDepth + 40);
  const blocked = [
    ...wayBuffers(world, area, new Set(edges)),
    ...[...cad.parcels.values()].filter((p) => keep.has(p.kind)).map((p) => p.shape),
    core,
  ];
  const wet = world.terrain.wetness;
  const land = differenceMany(intersection(area, mapShape(world))[0] ?? area, blocked);
  const grain = (p: Vec2): number | null => {
    for (const f of cad.furlongs.values()) if (pointInShape(p, f.shape)) return f.orientation;
    return null;
  };
  const half = rules.marketWidth / 2;
  const roadHalf = WAY_HALF_WIDTH.road + 1;
  // The market place is the street widened, narrowing again beyond it.
  const offset = (s: number) =>
    s < rules.marketLength ? half : s < rules.marketLength + 30 ? half - ((half - roadHalf) * (s - rules.marketLength)) / 30 : roadHalf;
  const width = perchWidths(world, rules.burgageWidths);
  const streetName = 'Market Street';
  const plots: CutPlot[] = [];
  for (const side of [1, -1] as const) {
    for (const p of cutFrontage(street, side, { offset, depth: rules.burgageDepth, width, land, grain, street: streetName })) {
      const m = { x: (p.frontage.a.x + p.frontage.b.x) / 2, y: (p.frontage.a.y + p.frontage.b.y) / 2 };
      if (wet.sample(m) > 0.45 || overlapsAny(p.shape, plots)) continue;
      plots.push(p);
    }
  }
  return plots.length >= 6 ? { street, edges, plots, streetName } : null;
}

/**
 * Plant a borough: the lord lays out a market place where the busiest road
 * leaves the village, and burgage plots along the road beyond it. The plots
 * are cut from whatever the land was — mostly open-field strips, whose lines
 * the plot boundaries follow — and the strips under them are given up.
 */
export function plantBorough(world: World, core: Shape): Borough | null {
  const rules = world.plugins.technology.plots;
  const g = world.graph;
  // Each way leaving the village core is a possible line for the town street.
  const exits: { edge: GraphEdge; node: number }[] = [];
  for (const e of g.edges.values()) {
    if (e.cls === 'path') continue;
    for (const nodeId of [e.a, e.b]) {
      if (pointInShape(g.nodes.get(nodeId)!.pos, core) && !pointInShape(g.nodes.get(g.other(e, nodeId))!.pos, core)) {
        exits.push({ edge: e, node: nodeId });
      }
    }
  }
  // Try the busiest few, and take the one that gives the most plots on good ground, weighted by traffic.
  exits.sort((a, b) => b.edge.usage - a.edge.usage);
  let best: (BoroughLayout & { score: number }) | null = null;
  for (const exit of exits.slice(0, 5)) {
    const layout = layOutBorough(world, core, exit.edge, exit.node);
    if (!layout) continue;
    const score = layout.plots.length * Math.log(1 + exit.edge.usage);
    if (!best || score > best.score) best = { ...layout, score };
  }
  if (!best) return null;
  const { street, plots, streetName } = best;
  const year = Math.round(world.clock.now);
  const cad = world.cadastre;
  // The town street is the lord's: made up to at least a lane and kept up.
  for (const id of best.edges) {
    const e = g.edges.get(id);
    if (!e) continue;
    e.planned = true;
    e.floor = 'lane';
    e.name = 'Market Street';
    if (e.cls === 'path' || e.cls === 'track') e.cls = 'lane';
  }
  const passages = setAsidePassages(plots, street);
  const parcels = plotsFromStrips(world, plots, 'burgage', 'Open-field strips taken for burgage plots');
  for (const p of parcels) p.unit = { kind: 'borough', year, street: streetName };
  const underPassages = takeLand(world, passages.map((p) => p.shape), new Set(['strip']));
  cad.retire(underPassages.consumed, year, 'Open-field strips taken for passages between the plots', underPassages.rest);
  const plotShapes = [...plots.map((p) => p.shape), ...passages.map((p) => p.shape)];

  const marketLine = trimTo(street, rules.marketLength);
  const half = rules.marketWidth / 2;
  // The market place is the street widened, short of the new plots and anything already built there.
  const standing = [...cad.parcels.values()].filter((p) => p.kind !== 'strip').map((p) => p.shape);
  const market = difference(bufferPolyline(marketLine, half), ...plotShapes, ...standing)[0] ?? bufferPolyline(marketLine, half);
  const { regime, rights } = world.plugins.tenure.rights('market', cad.lord!, cad);
  // The market place, too, is taken out of the strips beneath it.
  const underMarket = takeLand(world, [market], new Set(['strip']));
  const marketParcel = cad.addParcel('market', market, regime, rights, year);
  cad.retire(underMarket.consumed, year, 'Open-field strips taken for the market place', [marketParcel.id, ...underMarket.rest]);

  if (addBackLanes(world, plots, street)) world.log.push({ year, text: 'Back lanes are laid out behind both rows of plots.' });
  layOutPassages(world, passages, year);
  const marketCentre = resample(marketLine, 2)[Math.floor(resample(marketLine, 2).length / 2)];
  return { street, market, marketCentre, plots: parcels.length, streetName };
}

/** Every so many plots along a row, a passage is left between two of them. */
const PASSAGE_EVERY = 6;
/** Width of a passage between plots (an entry, wynd or vennel). */
const PASSAGE_WIDTH = 3;

interface Passage {
  shape: Shape;
  frontage: Frontage;
  depth: number;
}

/** The plots on each side of a street, in order along it. */
function rowsOf(plots: CutPlot[], street: Vec2[]): CutPlot[][] {
  const t = direction(street);
  return [1, -1].map((side) => {
    const n = { x: -t.y * side, y: t.x * side };
    return plots.filter((p) => p.frontage.inward.x * n.x + p.frontage.inward.y * n.y > 0).sort((a, b) => a.along - b.along);
  });
}

/**
 * Narrow passages from the street to the back of the plots: every few plots,
 * one gives up a strip along its side. Changes `plots` in place.
 */
function setAsidePassages(plots: CutPlot[], street: Vec2[]): Passage[] {
  const out: Passage[] = [];
  for (const row of rowsOf(plots, street)) {
    for (let i = PASSAGE_EVERY - 1; i < row.length - 2; i += PASSAGE_EVERY) {
      const p = row[i];
      const width = dist(p.frontage.a, p.frontage.b);
      if (width < PASSAGE_WIDTH + 5) continue;
      const parts = splitLengthwise(p.shape, p.frontage, PASSAGE_WIDTH / width);
      if (!parts) continue;
      const [passage, rest] = parts;
      out.push({ shape: passage.shape, frontage: passage.frontage, depth: plotFrame(p.shape, p.frontage).depth });
      Object.assign(p, { shape: rest.shape, frontage: rest.frontage });
    }
  }
  return out;
}

/** A path down each passage, from the street to the back lane (or to the back of the plots, if there is none). */
function layOutPassages(world: World, passages: Passage[], year: number): void {
  const g = world.graph;
  for (const p of passages) {
    const f = p.frontage;
    const l = Math.hypot(f.inward.x, f.inward.y) || 1;
    const n = { x: f.inward.x / l, y: f.inward.y / l };
    const front = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
    const onStreet = g.nearestEdge(front, 25);
    if (!onStreet) continue;
    const backPoint = { x: front.x + n.x * (p.depth + BACK_LANE_GAP), y: front.y + n.y * (p.depth + BACK_LANE_GAP) };
    const a = g.junctionAt(onStreet.proj.point, 25, 4);
    const b = g.nearestEdge(backPoint, 8) ? g.junctionAt(backPoint, 8, 4) : g.addNode({ x: front.x + n.x * p.depth, y: front.y + n.y * p.depth });
    if (!a || !b || a.id === b.id) continue;
    const e = g.addEdge(a.id, b.id, [a.pos, front, b.pos], 'path', 0, year);
    e.planned = true;
    e.floor = 'path';
  }
}

/** From the back of the plots to a back lane's centreline: half a lane, and room for the line to be simplified. */
const BACK_LANE_GAP = 5.5;

/** Planned back lanes behind each row of plots, joined to the street at each end. */
export function addBackLanes(world: World, plots: CutPlot[], street: Vec2[], depth = world.plugins.technology.plots.burgageDepth): boolean {
  let lanes = 0;
  for (const side of [1, -1]) {
    const row = plots
      .filter((p) => {
        const f = p.frontage;
        const t = direction(street);
        const n = { x: -t.y * side, y: t.x * side };
        return f.inward.x * n.x + f.inward.y * n.y > 0;
      })
      .sort((a, b) => a.along - b.along);
    if (row.length < 4) continue;
    const back = row.map((p) => {
      const f = p.frontage;
      const m = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
      return { x: m.x + f.inward.x * (depth + BACK_LANE_GAP), y: m.y + f.inward.y * (depth + BACK_LANE_GAP) };
    });
    const first = row[0].frontage.a;
    const last = row[row.length - 1].frontage.b;
    const start = world.graph.junctionAt(first, 25, 10);
    const end = world.graph.junctionAt(last, 25, 10);
    if (!start || !end) continue;
    // The lane leaves the street just beyond the end plots and runs back beside them, not across them.
    const out = (f: { a: Vec2; b: Vec2; inward: Vec2 }, corner: Vec2, sign: number) => {
      const l = dist(f.a, f.b) || 1;
      const u = { x: ((f.b.x - f.a.x) / l) * sign * BACK_LANE_GAP, y: ((f.b.y - f.a.y) / l) * sign * BACK_LANE_GAP };
      const front = { x: corner.x + u.x, y: corner.y + u.y };
      return [front, { x: front.x + f.inward.x * (depth + BACK_LANE_GAP), y: front.y + f.inward.y * (depth + BACK_LANE_GAP) }];
    };
    const [startFront, startBack] = out(row[0].frontage, first, -1);
    const [endFront, endBack] = out(row[row.length - 1].frontage, last, 1);
    const route = [start.pos, startFront, startBack, ...back, endBack, endFront, end.pos];
    const res = insertRoute(world.graph, route, 0, start.id, end.id, {
      ...DEFAULT_INSERT,
      year: world.clock.now,
      planned: true,
      allowed: (pts) => !crossesBuilding(world, pts) && !crossesSolid(world, pts, WAY_WIDTH.lane / 2, false),
    });
    for (const id of res.newEdges) {
      const e = world.graph.edges.get(id);
      if (e) {
        e.cls = 'lane';
        e.usage = world.plugins.technology.hierarchy.downgradeAt.lane * 2;
      }
    }
    if (res.newEdges.length) lanes++;
  }
  return lanes > 0;
}
