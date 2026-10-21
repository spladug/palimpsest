// World state and the processes that advance it.

import { Clock } from './clock';
import { dist, smooth, type Vec2 } from './geom';
import { StreetGraph, EDGE_CLASSES, type EdgeClass } from './graph';
import { DEFAULT_INSERT, insertRoute } from './insert';
import { Pathfinder, type CostField } from './pathfind';
import { Raster } from './raster';
import { Rng } from './rng';
import { computeMetrics, type Metrics } from './metrics';
import type { Plugins, Terrain, TripDemand } from '../plugins/types';

export type PlaceKind = 'gateway' | 'farmstead' | 'church';

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
}

/** Sampled walker routes per year; each stands for many real trips. */
const ROUTES_PER_YEAR = 14;

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
  };
  for (const p of initial) addPlace(world, p.kind, p.name, p.pos, p.mass);
  updateCostField(world);

  bootstrapRoutes(world);
  world.log.push({ year: startYear, text: 'Old routes cross the valley; a few farmsteads stand on the slopes.' });

  world.clock.addProcess({ name: 'movement', interval: 1, run: (w) => walk(w) }, startYear + 1);
  world.clock.addProcess({ name: 'hierarchy', interval: 1, run: (w, now) => updateHierarchy(w, now) }, startYear + 1);
  world.clock.addProcess({ name: 'settlement', interval: 1, run: (w, now) => settle(w, now) }, startYear + 1);
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
  });
  world.recentRoutes.push(route);
  return true;
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
        if (level === 0) g.removeEdge(e.id);
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

function tidyGraph(world: World): void {
  const g = world.graph;
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
  const update = (k: number) => {
    const wearF = 1 + (worn * wear[k]) / (wear[k] + mv.wearHalf);
    const ground = 1 - (1 - mv.wetGroundFactor) * wet[k];
    // A made way overrides wet ground; worn ground only partly does.
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
    addPlace(world, 'farmstead', name, site, 1);
    world.log.push({ year: Math.round(now), text: `A new farmstead, ${name}, is founded.` });
  }
}

const FARM_NAMES = [
  'Ashcote', 'Bradley', 'Coldwell', 'Dunstall', 'Elmhurst', 'Fenwick', 'Goldthorpe', 'Hatherley',
  'Ingleby', 'Kelsall', 'Langridge', 'Middleton', 'Northwood', 'Oakley', 'Pinfold', 'Radwell',
  'Shelford', 'Thornbury', 'Upcott', 'Westbrook', 'Whitley', 'Yarwell',
];

function farmName(world: World): string {
  const used = new Set(world.places.map((p) => p.name));
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
