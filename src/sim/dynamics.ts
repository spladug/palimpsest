// Town dynamics: households arriving, dying and leaving; plots passing to
// heirs, sold, split and merged; and each plot's burgage cycle (Conzen 1960):
// laid out with a house at the front, its back land filling with buildings to
// a climax, then cleared and rebuilt. Change on a plot is more likely when its
// neighbours are changing too (Whitehand's neighbour effect).
//
// The town grows toward a capacity the demand plugin sets; when the plots it
// has are full it lays out more (see expansion.ts).

import { dist, type Vec2 } from './geom';
import { Raster } from './raster';
import { intersection, pointInShape, shapeArea, union } from './polygon';
import type { Building, Holder, Parcel, ParcelKind } from './cadastre';
import { frontNeighbours, joinFrontages, nextBackBuilding, splitLengthwise } from './plots';
import { mid, putUpFront, takeUp } from './town';
import { accessAt, updateAccess } from './landvalue';
import { expandTown } from './expansion';
import { provideUses } from './landuse';
import type { World } from './world';

export interface TownState {
  /** Households the town can support this year. */
  capacity: number;
  households: number;
  /** How hard demand for houses presses on supply, 0..1. */
  pressure: number;
  /** Distance in metres from each cell to the built-up area. */
  edge: Raster | null;
  edgeVersion: number;
  /** No new streets are tried before this year after a failed attempt. */
  nextExpansion: number;
  /** Failed attempts in a row; each doubles the wait before the next. */
  failedExpansions: number;
  /** Fields a builder has found impossible to lay out. */
  unbuildable: Set<number>;
  history: { year: number; households: number; capacity: number }[];
  /** The highest size announced in the chronicle, so it is not announced twice. */
  announced: number;
}

export function newTownState(): TownState {
  return {
    capacity: 0,
    households: 0,
    pressure: 0,
    edge: null,
    edgeVersion: -1,
    nextExpansion: 0,
    failedExpansions: 0,
    unbuildable: new Set(),
    history: [],
    announced: 0,
  };
}

/** Plots that house the town's households. */
export const TOWN_PLOTS = new Set<ParcelKind>(['burgage', 'plot']);
/**
 * Parcels that make up the built-up area the town grows out from. Precincts
 * and works grounds are not counted: they stand at the edge, and growth jumps
 * over them rather than starting from them.
 */
const BUILT = new Set<ParcelKind>(['burgage', 'plot', 'toft', 'market', 'churchyard']);
/** Chance a householder dies in a given year (a generation is about 28 years). */
const MORTALITY = 1 / 28;
/** Chance someone is left to inherit. */
const HEIR_CHANCE = 0.72;
const EDGE_CELL = 20;

function townPlots(world: World): Parcel[] {
  const out: Parcel[] = [];
  for (const p of world.cadastre.parcels.values()) if (TOWN_PLOTS.has(p.kind) && p.frontage) out.push(p);
  return out;
}

const isDwelling = (world: World, use: string) => (world.plugins.technology.uses[use]?.dwellings ?? 0) > 0;

/** Households in the town: one per occupied plot, plus any living in back-land cottages. */
export function townHouseholds(world: World): number {
  const cad = world.cadastre;
  let n = 0;
  for (const p of cad.parcels.values()) {
    if (!TOWN_PLOTS.has(p.kind) || p.takenUp === undefined) continue;
    n++;
    for (const b of cad.buildingsOn(p.id)) if (b.back) n += world.plugins.technology.uses[b.use]?.dwellings ?? 0;
  }
  return n;
}

export function plotValue(world: World, p: Parcel): number {
  if (p.value === undefined) p.value = p.frontage ? accessAt(world, mid(p)) : 0;
  return p.value;
}

/** Recompute accessibility and every town plot's land value. */
export function updateValues(world: World): void {
  updateAccess(world);
  for (const p of world.cadastre.parcels.values()) {
    if (p.frontage) p.value = accessAt(world, mid(p));
  }
}

/** Rebuild the distance-to-built-up raster after the cadastre changes. */
export function updateEdge(world: World): void {
  const t = world.town;
  const h = world.terrain.height;
  const W = Math.ceil(h.worldWidth / EDGE_CELL);
  const H = Math.ceil(h.worldHeight / EDGE_CELL);
  const r = new Raster(W, H, EDGE_CELL, Infinity);
  let any = false;
  for (const p of world.cadastre.parcels.values()) {
    if (!BUILT.has(p.kind)) continue;
    const b = p.bounds;
    const i0 = Math.max(0, Math.floor(b.minX / EDGE_CELL));
    const i1 = Math.min(W - 1, Math.floor(b.maxX / EDGE_CELL));
    const j0 = Math.max(0, Math.floor(b.minY / EDGE_CELL));
    const j1 = Math.min(H - 1, Math.floor(b.maxY / EDGE_CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (r.get(i, j) === 0) continue;
        if (pointInShape(r.cellCentre(i, j), p.shape)) {
          r.set(i, j, 0);
          any = true;
        }
      }
    }
  }
  if (any) chamfer(r);
  t.edge = any ? r : null;
  t.edgeVersion = world.cadastre.version;
}

/** Two-pass chamfer distance transform, in metres. */
function chamfer(r: Raster): void {
  const s = r.cellSize;
  const d1 = s;
  const d2 = s * Math.SQRT2;
  const W = r.width;
  const H = r.height;
  const D = r.data;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let v = D[j * W + i];
      if (i > 0) v = Math.min(v, D[j * W + i - 1] + d1);
      if (j > 0) {
        v = Math.min(v, D[(j - 1) * W + i] + d1);
        if (i > 0) v = Math.min(v, D[(j - 1) * W + i - 1] + d2);
        if (i < W - 1) v = Math.min(v, D[(j - 1) * W + i + 1] + d2);
      }
      D[j * W + i] = v;
    }
  }
  for (let j = H - 1; j >= 0; j--) {
    for (let i = W - 1; i >= 0; i--) {
      let v = D[j * W + i];
      if (i < W - 1) v = Math.min(v, D[j * W + i + 1] + d1);
      if (j < H - 1) {
        v = Math.min(v, D[(j + 1) * W + i] + d1);
        if (i < W - 1) v = Math.min(v, D[(j + 1) * W + i + 1] + d2);
        if (i > 0) v = Math.min(v, D[(j + 1) * W + i - 1] + d2);
      }
      D[j * W + i] = v;
    }
  }
}

/** One year of town life. */
export function townYear(world: World, now: number): void {
  const market = world.places.find((p) => p.kind === 'market');
  if (!market) return;
  const t = world.town;
  const year = Math.round(now);
  if (world.cadastre.version !== t.edgeVersion) updateEdge(world);
  t.capacity = world.plugins.demand.townCapacity(world);

  lifeAndDeath(world);
  let n = townHouseholds(world);
  const K = t.capacity;
  t.pressure = Math.max(0, Math.min(1, ((K - n) / Math.max(25, K)) * 4));
  if (n < K) {
    // Newcomers: fast when the town is well short of what it could hold.
    const expected = Math.min((K - n) * 0.12, 2 + 0.05 * n);
    let arrivals = Math.floor(expected) + (world.rng.chance(expected % 1) ? 1 : 0);
    while (arrivals-- > 0 && settleNewcomer(world, market.pos)) n++;
  } else if (n > K * 1.02) {
    const expected = (n - K) * 0.06;
    const leaving = Math.floor(expected) + (world.rng.chance(expected % 1) ? 1 : 0);
    for (let k = 0; k < leaving; k++) householdLeaves(world);
  }
  burgageCycle(world);
  provideUses(world, townHouseholds(world));
  t.households = townHouseholds(world);
  // The market draws more as the town grows, but less than in proportion: through traffic still counts.
  market.mass = 3 + 2.5 * Math.sqrt(t.households);
  // Note each new size the town reaches: every fifty households while it is small, then every hundred.
  const step = t.households < 200 ? 50 : 100;
  const reached = Math.floor(t.households / step) * step;
  if (reached > t.announced) {
    t.announced = reached;
    world.log.push({ year, text: `The town reaches ${reached} households.` });
  }
  if (year % 5 === 0) t.history.push({ year, households: t.households, capacity: Math.round(K) });
}

function surnameOf(h: Holder): string {
  if (h.surname) return h.surname;
  const parts = h.name.split(' ');
  return parts.slice(1).join(' ') || parts[0];
}

function newHousehold(world: World, name: string, placeId: number | null): Holder {
  const h = world.cadastre.addHolder('household', name, placeId);
  const parts = name.split(' ');
  h.surname = parts.slice(1).join(' ') || parts[0];
  return h;
}

function heirOf(world: World, h: Holder): Holder {
  const heir = world.cadastre.addHolder('household', `${world.plugins.demand.heirName(world)} ${surnameOf(h)}`, h.placeId);
  heir.surname = surnameOf(h);
  return heir;
}

/** The plot falls back to whoever grants it (the lord, or the builder who let it). */
function vacate(world: World, p: Parcel, note: string): void {
  const cad = world.cadastre;
  const g = cad.holders.get(p.rights.alienation ?? -1);
  const grantor = g && g.kind !== 'household' ? g.id : cad.lord!;
  const { regime, rights } = world.plugins.tenure.rights(p.kind, grantor, cad);
  cad.vacate(p, rights, regime, Math.round(world.clock.now), note);
}

/** Householders die; their plots pass to heirs, are divided among them, or fall vacant. */
function lifeAndDeath(world: World, mortality = MORTALITY, heirChance = HEIR_CHANCE): number {
  const cad = world.cadastre;
  const rng = world.rng;
  const year = Math.round(world.clock.now);
  const partible = world.plugins.tenure.inheritance === 'partible';
  let deaths = 0;
  for (const p of townPlots(world)) {
    if (p.takenUp === undefined) continue;
    const h = cad.holders.get(p.rights.withdrawal ?? -1);
    if (!h || h.kind !== 'household' || !rng.chance(mortality)) continue;
    deaths++;
    if (!rng.chance(heirChance)) {
      vacate(world, p, `${h.name} dies without heirs; the plot falls vacant`);
      continue;
    }
    if (partible && p.rights.subdivide === h.id && rng.chance(0.6)) {
      const halves = splitPlot(world, p, `${h.name}'s plot is divided between heirs`);
      if (halves) {
        for (const half of halves) {
          const heir = heirOf(world, h);
          const { regime, rights } = world.plugins.tenure.rights(half.kind, heir.id, cad);
          cad.regrant(half, rights, regime, year, `${heir.name} inherits part of ${h.name}'s plot`, 'inherit');
        }
        continue;
      }
    }
    const heir = heirOf(world, h);
    const { regime, rights } = world.plugins.tenure.rights(p.kind, heir.id, cad);
    cad.regrant(p, rights, regime, year, `${heir.name} inherits from ${h.name}`, 'inherit');
    p.takenUp = p.takenUp ?? year;
  }
  // Back-land cottagers come and go without record; when one dies, another moves in.
  return deaths;
}

/** A sudden mortality (plague): returns the number of households lost. */
export function epidemic(world: World, mortality: number): number {
  const cad = world.cadastre;
  let lost = 0;
  const before = townHouseholds(world);
  lifeAndDeath(world, mortality, 0.35);
  for (const p of townPlots(world)) {
    for (const b of cad.buildingsOn(p.id)) {
      if (b.back && isDwelling(world, b.use) && world.rng.chance(mortality)) cad.removeBuilding(b.id);
    }
  }
  lost += before - townHouseholds(world);
  const village = world.places.find((p) => p.kind === 'village');
  if (village) {
    const v = Math.round(village.mass * mortality * 0.8);
    village.mass = Math.max(4, village.mass - v);
    lost += v;
  }
  return lost;
}

/** What house a newcomer puts up on a plot. */
function houseFor(world: World, p: Parcel, market: Vec2): string {
  const rules = world.plugins.technology.plots;
  const onMarket = dist(mid(p), market) < rules.marketLength * 0.6 + 15;
  if (p.kind === 'burgage') return onMarket ? 'shop' : 'townhouse';
  return onMarket ? rules.rebuild(world.clock.now, true) : rules.townPlots(world.clock.now).use;
}

/**
 * House one newcomer: in a vacant plot if there is one (the best first), else
 * by a burgess selling half his plot, a cottage in a court behind a house, or
 * new plots laid out at the edge of the town.
 */
function settleNewcomer(world: World, market: Vec2): boolean {
  const rng = world.rng;
  const vacant = townPlots(world).filter((p) => p.takenUp === undefined);
  if (vacant.length) {
    // Most take the best plot going; some take whatever they can get.
    vacant.sort((a, b) => plotValue(world, b) - plotValue(world, a));
    const p = vacant[rng.chance(0.75) ? 0 : rng.int(0, vacant.length)];
    const h = newHousehold(world, world.plugins.demand.burgessName(world), null);
    takeUp(world, p, h.id, houseFor(world, p, market));
    return true;
  }
  const rules = world.plugins.technology.plots;
  const housing = rules.backland(world.clock.now).housing;
  const r = rng.next();
  if (housing && r < 0.45 && addCourtCottage(world, housing)) return true;
  if (r < 0.75 && sellHalf(world, market)) return true;
  const year = Math.round(world.clock.now);
  if (year >= world.town.nextExpansion) {
    const laid = expandTown(world);
    if (laid) {
      world.town.failedExpansions = 0;
      updateEdge(world);
      return settleNewcomer(world, market);
    }
    world.town.failedExpansions++;
    world.town.nextExpansion = year + Math.min(24, 4 * 2 ** (world.town.failedExpansions - 1));
  }
  if (housing && addCourtCottage(world, housing)) return true;
  return sellHalf(world, market);
}

/** A cottage built in the yard behind a house, let to a newcomer. */
function addCourtCottage(world: World, use: string): boolean {
  const plots = townPlots(world)
    .filter((p) => p.takenUp !== undefined && p.phase !== 'climax')
    .sort((a, b) => plotValue(world, b) - plotValue(world, a));
  // Courts went up behind the busiest frontages, but not only there.
  const pool = plots.slice(0, Math.max(8, Math.ceil(plots.length * 0.4)));
  for (let k = 0; k < 6 && pool.length; k++) {
    const p = pool.splice(world.rng.int(0, pool.length), 1)[0];
    if (addBackBuilding(world, p, use)) return true;
    p.phase = 'climax';
  }
  return false;
}

/** Add the next back-land building to a plot. False if the plot is full. */
function addBackBuilding(world: World, p: Parcel, use: string): boolean {
  const cad = world.cadastre;
  const type = world.plugins.technology.uses[use];
  if (!type || !p.frontage) return false;
  const existing = cad.buildingsOn(p.id).map((b) => b.footprint);
  const size = { width: typeof type.building.width === 'number' ? type.building.width : 5, depth: type.building.depth };
  const b = nextBackBuilding(p.shape, p.frontage, existing, size, (p.id % 2) as 0 | 1);
  if (!b) return false;
  cad.addBuilding({ parcelId: p.id, use, footprint: b.footprint, ridge: b.ridge, storeys: type.storeys, built: Math.round(world.clock.now), back: true });
  p.phase = coverage(world, p) >= world.plugins.technology.plots.climaxCoverage ? 'climax' : 'repletive';
  return true;
}

function coverage(world: World, p: Parcel): number {
  let a = 0;
  for (const b of world.cadastre.buildingsOn(p.id)) a += shapeArea(b.footprint);
  return a / Math.max(1, p.area);
}

/** A burgess sells off half his plot to a newcomer. */
function sellHalf(world: World, market: Vec2): boolean {
  const cad = world.cadastre;
  const minF = world.plugins.technology.plots.minFrontage;
  const candidates = townPlots(world).filter((p) => {
    if (p.takenUp === undefined || !p.frontage) return false;
    const h = p.rights.subdivide;
    if (h === undefined || h !== p.rights.alienation || cad.holders.get(h)?.kind !== 'household') return false;
    return dist(p.frontage.a, p.frontage.b) >= 2 * minF;
  });
  if (!candidates.length) return false;
  // Wide plots in good places are divided first.
  candidates.sort((a, b) => plotValue(world, b) * frontWidth(b) - plotValue(world, a) * frontWidth(a));
  const p = candidates[world.rng.int(0, Math.min(4, candidates.length))];
  const seller = cad.holderName(p.rights.withdrawal);
  const halves = splitPlot(world, p, `${seller} sells half the plot`);
  if (!halves) return false;
  const h = newHousehold(world, world.plugins.demand.burgessName(world), null);
  const half = halves[1];
  const { regime, rights } = world.plugins.tenure.rights(half.kind, h.id, cad);
  cad.regrant(half, rights, regime, Math.round(world.clock.now), `${h.name} buys half of ${seller}'s plot`, 'sale');
  if (!cad.buildingsOn(half.id).some((b) => !b.back)) putUpFront(world, half, houseFor(world, half, market));
  return true;
}

function frontWidth(p: Parcel): number {
  return p.frontage ? dist(p.frontage.a, p.frontage.b) : 0;
}

/**
 * Divide a plot lengthwise. The house at the front is divided too (rebuilt as
 * two); back buildings stay with whichever half they stand in, and any the
 * new boundary would cut through are pulled down.
 */
export function splitPlot(world: World, p: Parcel, note: string): Parcel[] | null {
  const cad = world.cadastre;
  if (!p.frontage) return null;
  const parts = splitLengthwise(p.shape, p.frontage);
  if (!parts) return null;
  const fronts = cad.buildingsOn(p.id).filter((b) => !b.back);
  for (const b of cad.buildingsOn(p.id)) {
    if (!b.back) continue;
    const inBoth = parts.every((part) => intersection(b.footprint, part.shape).some((x) => shapeArea(x) > 1));
    if (inBoth) cad.removeBuilding(b.id);
  }
  for (const b of fronts) cad.removeBuilding(b.id);
  const children = cad.replace([p.id], parts, Math.round(world.clock.now), 'split', note);
  const use = fronts[0]?.use;
  if (use) for (const c of children) putUpFront(world, c, use);
  return children;
}

/** Join two neighbouring plots into one (one holder has bought the other). */
function mergePlots(world: World, left: Parcel, right: Parcel, note: string): Parcel | null {
  if (!left.frontage || !right.frontage) return null;
  const joined = union(left.shape, right.shape);
  if (joined.length !== 1) return null;
  const shape = joined[0].length > 1 ? [joined[0][0]] : joined[0];
  const frontage = joinFrontages(left.frontage, right.frontage);
  const holder = left.rights;
  const [merged] = world.cadastre.replace([left.id, right.id], [{ shape, frontage }], Math.round(world.clock.now), 'merge', note);
  merged.rights = { ...holder };
  return merged;
}

/** Each plot's neighbours along its street, left and right. */
function neighbours(plots: Parcel[]): Map<number, { left?: Parcel; right?: Parcel }> {
  const key = (p: Vec2) => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
  const byA = new Map<string, Parcel[]>();
  for (const p of plots) {
    const k = key(p.frontage!.a);
    let list = byA.get(k);
    if (!list) byA.set(k, (list = []));
    list.push(p);
  }
  const out = new Map<number, { left?: Parcel; right?: Parcel }>();
  for (const p of plots) {
    for (const q of byA.get(key(p.frontage!.b)) ?? []) {
      if (q === p || frontNeighbours(p.frontage!, q.frontage!) !== 'a-b') continue;
      out.set(p.id, { ...out.get(p.id), right: q });
      out.set(q.id, { ...out.get(q.id), left: p });
    }
  }
  return out;
}

/**
 * The burgage cycle. Occupied plots fill with back buildings while the town
 * prospers, faster where the neighbours are filling too. In decline, back
 * buildings are cleared and empty houses fall down. Old or cleared plots on
 * good frontages are rebuilt, sometimes with the plot next door bought in.
 */
function burgageCycle(world: World): void {
  const cad = world.cadastre;
  const rng = world.rng;
  const t = world.town;
  const rules = world.plugins.technology.plots;
  const year = Math.round(world.clock.now);
  const work = rules.backland(year).work;
  const declining = t.households > t.capacity * 1.02;
  const plots = townPlots(world);
  const near = neighbours(plots);
  const active = (q?: Parcel) => (q && (q.phase === 'repletive' || q.phase === 'climax') ? 1 : 0);
  const rebuiltLately = (q?: Parcel) => (q && cad.buildingsOn(q.id).some((b) => !b.back && year - b.built < 30) ? 1 : 0);

  for (const p of plots) {
    if (!cad.parcels.has(p.id)) continue;
    const buildings = cad.buildingsOn(p.id);
    const value = plotValue(world, p);
    const nb = near.get(p.id) ?? {};

    if (p.takenUp === undefined) {
      // Empty tenements decay: back ranges first, then the house itself.
      if (buildings.length && rng.chance(0.035)) {
        const back = buildings.filter((b) => b.back);
        const victim = back.length ? latest(back) : buildings[0];
        cad.removeBuilding(victim.id);
        if (back.length) p.phase = 'recessive';
      }
      // A neighbour buys up an empty, fallen plot.
      if (!buildings.length && rng.chance(declining ? 0.04 : 0.01)) {
        const buyer = [nb.left, nb.right].find((q) => q && q.takenUp !== undefined);
        if (buyer && frontWidth(buyer) + frontWidth(p) < rules.minFrontage * 6) {
          const [l, r] = buyer === nb.left ? [buyer, p] : [p, buyer];
          const keep = buyer.rights;
          const m = mergePlots(world, l, r, `${cad.holderName(buyer.rights.withdrawal)} buys the empty plot next door`);
          if (m) m.rights = { ...keep };
        }
      }
      continue;
    }

    if (declining || value < 0.08) {
      // Back buildings are let go in hard times (the "urban fallow").
      const back = buildings.filter((b) => b.back);
      if (back.length && rng.chance(0.02)) {
        cad.removeBuilding(latest(back).id);
        p.phase = 'recessive';
      }
    } else if (p.phase !== 'climax') {
      const pIn = (0.003 + 0.04 * t.pressure) * (0.3 + value) * (1 + 0.6 * (active(nb.left) + active(nb.right)));
      if (rng.chance(pIn) && !addBackBuilding(world, p, work)) p.phase = 'climax';
    }

    // Rebuilding: old houses on valuable frontage, and cleared plots, are replaced.
    const front = buildings.filter((b) => !b.back);
    const age = front.length ? year - Math.max(...front.map((b) => b.built)) : 999;
    if (age > 120 || p.phase === 'recessive') {
      const pRe = 0.004 * (0.3 + value) * (0.4 + t.pressure) * (1 + 0.5 * (rebuiltLately(nb.left) + rebuiltLately(nb.right)));
      if (rng.chance(pRe)) rebuild(world, p, nb);
    }
  }
}

function latest(bs: Building[]): Building {
  return bs.reduce((a, b) => (b.built > a.built || (b.built === a.built && b.id > a.id) ? b : a));
}

/** Clear a plot and put up a new front building, sometimes taking in the plot next door. */
function rebuild(world: World, p: Parcel, nb: { left?: Parcel; right?: Parcel }): void {
  const cad = world.cadastre;
  const rules = world.plugins.technology.plots;
  const market = world.places.find((q) => q.kind === 'market')!;
  let plot = p;
  const holder = p.rights.withdrawal;
  // Amalgamation needs the neighbour to sell (Whitehand): an empty plot, or a willing burgess.
  const other = [nb.left, nb.right].find(
    (q) => q && cad.parcels.has(q.id) && (q.takenUp === undefined || world.rng.chance(0.2)) && q.rights.alienation === q.rights.withdrawal,
  );
  // An inn or a chapel is rebuilt as what it was; houses as the house of the day.
  const special = cad.buildingsOn(p.id).find((b) => !b.back && !isDwelling(world, b.use));
  if (other && frontWidth(other) + frontWidth(p) < rules.minFrontage * 5 && world.rng.chance(0.35)) {
    const [l, r] = other === nb.left ? [other, p] : [p, other];
    // If the neighbour was lived in, that household moves away.
    const merged = mergePlots(world, l, r, `${cad.holderName(holder)} buys the plot next door and rebuilds`);
    if (merged) {
      merged.takenUp = Math.round(world.clock.now);
      plot = merged;
    }
  }
  // Clear all but the cottages in the yard, which are let.
  for (const b of cad.buildingsOn(plot.id)) {
    if (!b.back || !isDwelling(world, b.use)) cad.removeBuilding(b.id);
  }
  const onMarket = dist(mid(plot), market.pos) < rules.marketLength * 0.6 + 15;
  putUpFront(world, plot, special?.use ?? rules.rebuild(world.clock.now, onMarket));
  plot.phase = cad.buildingsOn(plot.id).some((b) => b.back) ? 'repletive' : 'institutive';
}

/** A household leaves (or dies out): a back-land cottage is given up first, else a plot. */
function householdLeaves(world: World): void {
  const cad = world.cadastre;
  const plots = townPlots(world).sort((a, b) => plotValue(world, a) - plotValue(world, b));
  for (const p of plots) {
    const cottage = cad.buildingsOn(p.id).find((b) => b.back && isDwelling(world, b.use));
    if (cottage) {
      cad.removeBuilding(cottage.id);
      p.phase = 'recessive';
      return;
    }
  }
  // The poorest occupied plots empty first, with some chance.
  const occupied = plots.filter((p) => p.takenUp !== undefined);
  if (!occupied.length) return;
  const p = occupied[Math.min(occupied.length - 1, Math.floor(world.rng.next() ** 2 * occupied.length))];
  vacate(world, p, `${cad.holderName(p.rights.withdrawal)} leaves the town; the plot falls vacant`);
}
