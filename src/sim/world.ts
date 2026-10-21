// World state and the processes that advance it.

import { Clock } from './clock';
import { dist, resample, smooth, type Vec2 } from './geom';
import { StreetGraph, EDGE_CLASSES, type EdgeClass } from './graph';
import { DEFAULT_INSERT, insertRoute } from './insert';
import { Pathfinder, type CostField } from './pathfind';
import { Raster } from './raster';
import { Rng } from './rng';
import { computeMetrics, type Metrics } from './metrics';
import { Cadastre } from './cadastre';
import { layOutCloses, rasteriseLandUse } from './fields';
import { pointInShape, type Shape } from './polygon';
import { extendVillage, takeUp, vacantPlots } from './town';
import { newTownState, townYear, updateValues, type TownState } from './dynamics';
import type { Plugins, Terrain, TripDemand } from '../plugins/types';

/** 'field' places are the gates of furlongs: trip ends, not drawn. */
export type PlaceKind = 'gateway' | 'farmstead' | 'church' | 'village' | 'field' | 'market' | 'mill' | 'institution';

export interface Place {
  id: number;
  kind: PlaceKind;
  name: string;
  pos: Vec2;
  mass: number;
  founded: number;
  nodeId: number;
}

export interface LogEntry {
  year: number;
  text: string;
}

export interface World {
  seed: string;
  rng: Rng;
  plugins: Plugins;
  clock: Clock<World>;
  terrain: Terrain;
  /** Accumulated ground wear, trips/year/cell. */
  wear: Raster;
  /** Speed multiplier from the ways drawn on the ground. */
  wayFactor: Raster;
  cost: CostField;
  graph: StreetGraph;
  places: Place[];
  log: LogEntry[];
  metrics: { year: number; metrics: Metrics }[];
  pathfinder: Pathfinder;
  /** Routes walked in the latest year, for display. */
  recentRoutes: Vec2[][];
  nextPlaceId: number;
  cadastre: Cadastre;
  /** Speed multiplier from land use (standing crops, hedged closes, meadow). */
  landFactor: Raster;
  /** The township laid out in open fields, once it has been. */
  township: Shape | null;
  /** Abandoned farmsteads, for the map. */
  deserted: { name: string; pos: Vec2; year: number }[];
  /** The village's house-plot area, once there is a village, and its typical radius. */
  villageCore: Shape | null;
  villageRadius: number;
  /** The town's households, capacity, growth pressure and built-up edge. */
  town: TownState;
  /** Discounted network distance from the town centre to each graph node. */
  access: Map<number, number>;
  /** Year the open fields were enclosed, if they have been. */
  enclosed: number | null;
}

/** Sampled walker routes per year; each stands for many real trips. */
const ROUTES_PER_YEAR = 18;

export function createWorld(seed: string, plugins: Plugins, startYear = 900): World {
  const rng = new Rng(seed);
  const { terrain, places: initial } = plugins.geography.generate(rng.fork('geography'));
  const h = terrain.height;
  const wear = new Raster(h.width, h.height, h.cellSize);
  const wayFactor = new Raster(h.width, h.height, h.cellSize, 1);
  const mv = plugins.technology.movement;
  const speedFactor = new Raster(h.width, h.height, h.cellSize, 1);
  const cost: CostField = {
    height: h,
    speedFactor,
    water: terrain.water,
    crossable: terrain.crossable,
    fordFactor: mv.fordFactor,
    speed: mv.speed,
    maxFactor: Math.max(mv.wornGroundFactor, ...EDGE_CLASSES.map((c) => mv.classFactor[c])),
  };
  const world: World = {
    seed,
    rng: rng.fork('sim'),
    plugins,
    clock: new Clock<World>(startYear),
    terrain,
    wear,
    wayFactor,
    cost,
    graph: new StreetGraph(),
    places: [],
    log: [],
    metrics: [],
    pathfinder: new Pathfinder(h.width, h.height),
    recentRoutes: [],
    nextPlaceId: 1,
    cadastre: new Cadastre(),
    landFactor: new Raster(h.width, h.height, h.cellSize, 1),
    township: null,
    deserted: [],
    villageCore: null,
    villageRadius: 0,
    town: newTownState(),
    access: new Map(),
    enclosed: null,
  };
  world.cadastre.lord = world.cadastre.addHolder('lord', 'the lord').id;
  world.cadastre.community = world.cadastre.addHolder('community', 'the township').id;
  for (const p of initial) addPlace(world, p.kind, p.name, p.pos, p.mass);
  updateCostField(world);

  bootstrapRoutes(world);
  // Closes are laid out once the old routes exist, so hedges follow the tracks.
  for (const p of world.places) if (p.kind === 'farmstead') settleHousehold(world, p);
  updateLandUse(world);
  world.log.push({ year: startYear, text: 'Old routes cross the valley; a few farmsteads stand on the slopes.' });

  world.clock.addProcess({ name: 'movement', interval: 1, run: (w) => walk(w) }, startYear + 1);
  world.clock.addProcess({ name: 'hierarchy', interval: 1, run: (w, now) => updateHierarchy(w, now) }, startYear + 1);
  world.clock.addProcess({ name: 'settlement', interval: 1, run: (w, now) => settle(w, now) }, startYear + 1);
  world.clock.addProcess({ name: 'values', interval: 5, run: (w) => updateValues(w) }, startYear + 1);
  let landVersion = -1;
  world.clock.addProcess(
    {
      name: 'town',
      interval: 1,
      run: (w, now) => {
        townYear(w, now);
        // Walkers keep to the streets once plots and buildings are in the way.
        if (Math.round(now) % 2 === 0 && w.cadastre.version !== landVersion) {
          updateLandUse(w);
          landVersion = w.cadastre.version;
        }
      },
    },
    startYear + 1,
  );
  world.clock.addProcess(
    { name: 'metrics', interval: 5, run: (w, now) => w.metrics.push({ year: now, metrics: computeMetrics(w) }) },
    startYear + 5,
  );
  for (const ev of plugins.demand.events(world)) world.clock.schedule(ev);
  return world;
}

/** Add a place, either on its own new node or on an existing graph node. */
export function addPlace(
  world: World,
  kind: PlaceKind,
  name: string,
  pos: Vec2,
  mass: number,
  onNode?: number,
): Place {
  const id = world.nextPlaceId++;
  const existing = onNode !== undefined ? world.graph.nodes.get(onNode) : undefined;
  const node = existing && existing.placeId === null ? existing : world.graph.addNode(pos, id);
  node.placeId = id;
  const place: Place = { id, kind, name, pos, mass, founded: world.clock.now, nodeId: node.id };
  world.places.push(place);
  return place;
}

/** A household for a new farmstead, with closes around it. */
function settleHousehold(world: World, place: Place): void {
  const holder = world.cadastre.addHolder('household', place.name, place.id);
  layOutCloses(world, place.pos, holder.id, world.rng.fork(`closes-${place.id}`));
}

/** Remove a place: nobody travels to it any more and its ways will fade. */
export function abandonPlace(world: World, place: Place): void {
  const node = world.graph.nodes.get(placeNode(world, place));
  if (node) node.placeId = null;
  world.places = world.places.filter((p) => p !== place);
  if (place.kind === 'farmstead') world.deserted.push({ name: place.name, pos: place.pos, year: Math.round(world.clock.now) });
}

/** Recompute land-use walking costs after the cadastre changes. */
export function updateLandUse(world: World): void {
  rasteriseLandUse(world);
  refreshSpeed(world);
}

/** Place nodes can be merged away during insertion; find the live one. */
function placeNode(world: World, place: Place): number {
  if (world.graph.nodes.get(place.nodeId)?.placeId === place.id) return place.nodeId;
  for (const n of world.graph.nodes.values()) {
    if (n.placeId === place.id) {
      place.nodeId = n.id;
      return n.id;
    }
  }
  place.nodeId = world.graph.addNode(place.pos, place.id).id;
  return place.nodeId;
}

/** Walk one route and record it on the ground and in the graph. */
function travel(world: World, trip: TripDemand, weight: number): boolean {
  const r = world.pathfinder.route(world.cost, trip.from.pos, trip.to.pos);
  if (!r) return false;
  const route = smooth(r.points, 2);
  refreshSpeed(world, depositWear(world, route, weight));
  insertRoute(world.graph, route, weight, placeNode(world, trip.from), placeNode(world, trip.to), {
    ...DEFAULT_INSERT,
    year: world.clock.now,
    // A path worn across a yard is one thing; a way through a house is not.
    allowed: (pts) => !crossesBuilding(world, pts),
  });
  world.recentRoutes.push(route);
  return true;
}

/** Buildings by 20 m bucket, rebuilt when the cadastre changes. */
let buildingIndex: { world: World; version: number; buckets: Map<number, Shape[]> } | null = null;
const BUCKET = 20;

/** Whether a line passes through any building. */
export function crossesBuilding(world: World, pts: readonly Vec2[]): boolean {
  const cad = world.cadastre;
  if (!buildingIndex || buildingIndex.world !== world || buildingIndex.version !== cad.version) {
    const buckets = new Map<number, Shape[]>();
    for (const b of cad.buildings.values()) {
      const bb = b.footprint[0];
      const xs = bb.map((p) => p.x);
      const ys = bb.map((p) => p.y);
      for (let by = Math.floor(Math.min(...ys) / BUCKET); by <= Math.floor(Math.max(...ys) / BUCKET); by++) {
        for (let bx = Math.floor(Math.min(...xs) / BUCKET); bx <= Math.floor(Math.max(...xs) / BUCKET); bx++) {
          const k = by * 4096 + bx;
          let list = buckets.get(k);
          if (!list) buckets.set(k, (list = []));
          list.push(b.footprint);
        }
      }
    }
    buildingIndex = { world, version: cad.version, buckets };
  }
  for (const p of resample(pts, 1.5)) {
    const list = buildingIndex.buckets.get(Math.floor(p.y / BUCKET) * 4096 + Math.floor(p.x / BUCKET));
    if (list?.some((f) => pointInShape(p, f))) return true;
  }
  return false;
}

/** Returns the cells whose wear changed. */
function depositWear(world: World, route: Vec2[], weight: number): Set<number> {
  const w = world.wear;
  const step = w.cellSize * 0.5;
  // Wear is per cell per pass, so sample densely but count each cell once.
  const seen = new Set<number>();
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let s = 0; s <= n; s++) {
      const [ci, cj] = w.cellAt({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
      const k = w.index(ci, cj);
      if (!seen.has(k)) {
        seen.add(k);
        w.data[k] += weight;
      }
    }
  }
  return seen;
}

/** "Everywhere to everywhere" least-cost routes seed the old regional tracks (White & Barber 2012). */
function bootstrapRoutes(world: World): void {
  // Busiest pairs first, so through-routes form and lesser routes join them.
  const demand = world.plugins.demand.trips(world).sort((a, b) => b.tripsPerYear - a.tripsPerYear);
  world.recentRoutes = [];
  for (const trip of demand) {
    travel(world, trip, trip.tripsPerYear);
    rasteriseWays(world);
  }
  updateHierarchy(world, world.clock.now, true);
  world.metrics.push({ year: world.clock.now, metrics: computeMetrics(world) });
}

function walk(world: World): void {
  const demand = world.plugins.demand.trips(world);
  if (!demand.length) return;
  const total = demand.reduce((s, d) => s + d.tripsPerYear, 0);
  const weights = demand.map((d) => d.tripsPerYear);
  const n = ROUTES_PER_YEAR;
  world.recentRoutes = [];
  // Wear fades before this year's walking adds to it.
  const decay = 1 - world.plugins.technology.movement.wearDecay;
  for (let k = 0; k < world.wear.data.length; k++) world.wear.data[k] *= decay;
  for (let i = 0; i < n; i++) {
    const trip = demand[world.rng.weightedIndex(weights)];
    travel(world, trip, total / n);
  }
}

/**
 * Edges gain or lose class depending on whether their use justifies their
 * upkeep (after Levinson & Yerra 2006). Unused paths are abandoned.
 */
function updateHierarchy(world: World, now: number, immediate = false): void {
  const { upgradeAt, downgradeAt, patience } = world.plugins.technology.hierarchy;
  const g = world.graph;
  const alpha = immediate ? 1 : 0.3;
  for (const e of [...g.edges.values()]) {
    e.usage = alpha * e.yearUse + (1 - alpha) * e.usage;
    e.yearUse = 0;
    const level = EDGE_CLASSES.indexOf(e.cls);
    if (e.usage > upgradeAt[e.cls] && level < EDGE_CLASSES.length - 1) {
      e.pressure = Math.max(1, e.pressure + 1);
      if (immediate || e.pressure >= patience) {
        e.cls = nextClass(e.cls, e.usage, upgradeAt);
        e.pressure = 0;
      }
    } else if (e.usage < downgradeAt[e.cls] && now - e.created > patience) {
      e.pressure = Math.min(-1, e.pressure - 1);
      if (e.pressure <= -patience) {
        // Planned ways are kept up: back lanes may decline to a track, town streets no lower than a lane.
        const floor = e.planned ? EDGE_CLASSES.indexOf(e.floor ?? 'track') : -1;
        if (level <= floor) e.pressure = 0;
        else if (level === 0) g.removeEdge(e.id);
        else e.cls = EDGE_CLASSES[level - 1];
        e.pressure = 0;
      }
    } else e.pressure = 0;
  }
  tidyGraph(world);
  updateCostField(world);
}

function nextClass(cls: EdgeClass, usage: number, upgradeAt: Record<EdgeClass, number>): EdgeClass {
  let level = EDGE_CLASSES.indexOf(cls);
  while (level < EDGE_CLASSES.length - 1 && usage > upgradeAt[EDGE_CLASSES[level]]) level++;
  return EDGE_CLASSES[level];
}

/** Ways shorter than this are folded into a single junction. */
const MIN_EDGE = 12;
/** A way running this close beside a busier one for most of its length is merged into it. */
const PARALLEL_GAP = 16;
const PARALLEL_SHARE = 0.8;

/**
 * Two worn ways side by side a few metres apart are really one way. Fold the
 * quieter into the busier, keeping its ends connected.
 */
function consolidateParallel(world: World): void {
  const g = world.graph;
  const edges = [...g.edges.values()].filter((e) => !e.planned).sort((a, b) => a.usage - b.usage);
  for (const e of edges) {
    if (!g.edges.has(e.id)) continue;
    const len = g.length(e);
    if (len < 40) continue;
    const samples = resample(e.pts, 8).slice(1, -1);
    const counts = new Map<number, number>();
    const exclude = new Set([e.id]);
    for (const p of samples) {
      const hit = g.nearestEdge(p, PARALLEL_GAP, exclude);
      if (hit) counts.set(hit.edge.id, (counts.get(hit.edge.id) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [id, c] of counts) if (c > bestCount) [best, bestCount] = [id, c];
    if (best === null || bestCount < samples.length * PARALLEL_SHARE) continue;
    const f = g.edges.get(best)!;
    if (EDGE_CLASSES.indexOf(f.cls) < EDGE_CLASSES.indexOf(e.cls) && f.usage < e.usage) continue;
    f.usage += e.usage;
    f.yearUse += e.yearUse;
    const ends = [e.a, e.b];
    g.removeEdge(e.id);
    for (const nodeId of ends) {
      const node = g.nodes.get(nodeId);
      if (!node || (g.degree(nodeId) === 0 && node.placeId === null)) continue;
      const j = g.junctionAt(node.pos, PARALLEL_GAP * 1.5, 10);
      if (!j || j.id === nodeId || g.areAdjacent(j.id, nodeId)) continue;
      if (dist(j.pos, node.pos) < 10) {
        const keepNode = node.placeId !== null ? nodeId : j.id;
        g.mergeNodes(keepNode, keepNode === nodeId ? j.id : nodeId);
      } else {
        g.addEdge(nodeId, j.id, [node.pos, j.pos], e.cls, e.usage, e.created);
      }
    }
  }
}

function tidyGraph(world: World): void {
  const g = world.graph;
  consolidateParallel(world);
  for (const e of [...g.edges.values()]) {
    if (!g.edges.has(e.id) || g.length(e) >= MIN_EDGE) continue;
    const a = g.nodes.get(e.a)!;
    const b = g.nodes.get(e.b)!;
    if (a.placeId !== null && b.placeId !== null) continue;
    // Keep the place node, else the busier junction.
    const keepA = a.placeId !== null || (b.placeId === null && g.degree(a.id) >= g.degree(b.id));
    g.mergeNodes(keepA ? a.id : b.id, keepA ? b.id : a.id);
  }
  for (const n of [...g.nodes.values()]) {
    if (!g.nodes.has(n.id)) continue;
    if (n.placeId === null && g.degree(n.id) === 0) g.removeNode(n.id);
    else g.contract(n.id);
  }
}

/** Rasterise the ways and wear into the per-cell speed multiplier used for routing. */
export function updateCostField(world: World): void {
  const wf = world.wayFactor;
  wf.data.fill(1);
  rasteriseWays(world);
  refreshSpeed(world);
}

/** Draw every way into the way-factor raster (only ever raises cells). */
function rasteriseWays(world: World): void {
  const mv = world.plugins.technology.movement;
  const wf = world.wayFactor;
  wf.data.fill(1);
  for (const e of world.graph.edges.values()) {
    const f = mv.classFactor[e.cls];
    const step = wf.cellSize * 0.5;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1];
      const b = e.pts[i];
      const n = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let s = 0; s <= n; s++) {
        const [ci, cj] = wf.cellAt({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
        const k = wf.index(ci, cj);
        if (f > wf.data[k]) {
          wf.data[k] = f;
          world.cost.speedFactor.data[k] = Math.max(world.cost.speedFactor.data[k], f);
        }
      }
    }
  }
}

/**
 * Recompute the speed multiplier from ways, wear and wet ground, for the given
 * cells or the whole raster. Each walker sees the ground as the last one left it.
 */
function refreshSpeed(world: World, cells?: Iterable<number>): void {
  const mv = world.plugins.technology.movement;
  const sf = world.cost.speedFactor.data;
  const wf = world.wayFactor.data;
  const wet = world.terrain.wetness.data;
  const wear = world.wear.data;
  const worn = mv.wornGroundFactor - 1;
  const land = world.landFactor.data;
  const update = (k: number) => {
    const wearF = 1 + (worn * wear[k]) / (wear[k] + mv.wearHalf);
    const ground = (1 - (1 - mv.wetGroundFactor) * wet[k]) * land[k];
    // A made way overrides wet ground and crops; worn ground only partly does.
    sf[k] = Math.max(wf[k], wearF * ground);
  };
  if (cells) for (const k of cells) update(k);
  else for (let k = 0; k < sf.length; k++) update(k);
}

/** New farmsteads favour good land near existing ways ("roads attract settlers"). */
function settle(world: World, now: number): void {
  const rate = world.plugins.demand.newFarmsteadRate(world);
  let count = Math.floor(rate);
  if (world.rng.chance(rate - count)) count++;
  for (let c = 0; c < count; c++) {
    const site = chooseFarmsteadSite(world);
    if (!site) continue;
    const name = farmName(world);
    const place = addPlace(world, 'farmstead', name, site, 1);
    settleHousehold(world, place);
    world.log.push({ year: Math.round(now), text: `A new farmstead, ${name}, is founded.` });
  }
  if (count) updateLandUse(world);

  // Villages grow by new households (cottagers, younger sons) rather than new farms.
  const villageRate = world.plugins.demand.newHouseholdRate(world);
  const village = world.places.find((p) => p.kind === 'village');
  if (village && world.rng.chance(villageRate)) {
    village.mass += 1;
    const h = world.cadastre.addHolder('household', `household ${Math.round(village.mass)}`, village.id);
    const church = world.places.find((p) => p.kind === 'church');
    const centre = church?.pos ?? village.pos;
    let toft = vacantPlots(world, 'toft', centre)[0];
    if (!toft) {
      const added = extendVillage(world, centre, world.rng.fork(`village-${Math.round(now)}`));
      if (added) {
        world.log.push({ year: Math.round(now), text: `${village.name} spreads along its lanes: ${added} new tofts are taken from the edge of the fields.` });
        updateLandUse(world);
      }
      toft = vacantPlots(world, 'toft', centre)[0];
    }
    if (toft) takeUp(world, toft, h.id, 'cottage');
    if (Math.round(village.mass) % 5 === 0) {
      world.log.push({ year: Math.round(now), text: `${village.name} now has ${Math.round(village.mass)} households.` });
    }
  }
}

const FARM_NAMES = [
  'Ashcote', 'Bradley', 'Coldwell', 'Dunstall', 'Elmhurst', 'Fenwick', 'Goldthorpe', 'Hatherley',
  'Ingleby', 'Kelsall', 'Langridge', 'Middleton', 'Northwood', 'Oakley', 'Pinfold', 'Radwell',
  'Shelford', 'Thornbury', 'Upcott', 'Westbrook', 'Whitley', 'Yarwell',
];

function farmName(world: World): string {
  const used = new Set([...world.places.map((p) => p.name), ...world.deserted.map((d) => d.name)]);
  const free = FARM_NAMES.filter((n) => !used.has(n));
  if (free.length) return world.rng.pick(free);
  // Out of names: a "Nether" or "Upper" form of an existing one.
  for (const prefix of ['Upper', 'Nether', 'Little', 'Great']) {
    const options = FARM_NAMES.map((n) => `${prefix} ${n}`).filter((n) => !used.has(n));
    if (options.length) return world.rng.pick(options);
  }
  return `Farm ${world.places.length}`;
}

function chooseFarmsteadSite(world: World): Vec2 | null {
  const t = world.terrain;
  const W = t.height.worldWidth;
  const H = t.height.worldHeight;
  const margin = 120;
  let best: Vec2 | null = null;
  let bestScore = 0;
  for (let k = 0; k < 60; k++) {
    const p = { x: world.rng.range(margin, W - margin), y: world.rng.range(margin, H - margin) };
    const base = world.plugins.geography.farmsteadSuitability(t, p);
    if (base <= 0) continue;
    // Not inside the open fields, nor on another farm's land.
    if (world.township && pointInShape(p, world.township)) continue;
    if (world.cadastre.parcelAt(p)) continue;
    let nearest = Infinity;
    for (const pl of world.places) nearest = Math.min(nearest, dist(pl.pos, p));
    if (nearest < 220) continue;
    const hit = world.graph.nearestEdge(p, 400);
    const access = hit ? 1 - hit.proj.dist / 400 : 0;
    const score = base * (0.35 + access);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
