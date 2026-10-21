// Land uses bidding for sites (bid-rent, with no goods or prices). The demand
// plugin says how many of each use the settlement needs; each missing use
// takes the site where its bid most exceeds what houses would pay.
//
// Uses that sit on a town plot (an inn, a chapel) take over a plot's front.
// Land-hungry uses (a friary, a tannery, later a workhouse or a gasworks) take
// ground of their own at the edge of the town. They bid little for access, so
// while the town is growing housing outbids them near it and they go further
// out; in a pause they settle right on the edge. Their holders rarely sell,
// so when growth resumes it jumps over them: a fringe belt (Conzen; Whitehand).

import { dist, projectOnPolyline, resample, type Vec2 } from './geom';
import { bufferPolyline, differenceMany, intersection, pointInShape, ringCentroid, shapeArea, thickness, type Shape } from './polygon';
import type { Parcel, ParcelKind } from './cadastre';
import { frameRect, frontBuilding, plotFrame } from './plots';
import { mid, putUpFront, takeLand, wayBuffers, WAY_HALF_WIDTH, mapShape } from './town';
import { accessAt } from './landvalue';
import { edgeDistance, forSale } from './expansion';
import { plotValue, TOWN_PLOTS } from './dynamics';
import { addPlace, type World } from './world';
import type { UseType } from '../plugins/types';

/** Rural land a land-hungry use may take. */
const TAKE_FROM = new Set<ParcelKind>(['strip', 'close', 'common']);

/** Uses present: front buildings on town plots, and grounds taken for a use. */
function present(world: World): Map<string, number> {
  const cad = world.cadastre;
  const counts = new Map<string, number>();
  const add = (u: string) => counts.set(u, (counts.get(u) ?? 0) + 1);
  for (const p of cad.parcels.values()) {
    if (p.use) add(p.use);
    else if (TOWN_PLOTS.has(p.kind)) {
      for (const b of cad.buildingsOn(p.id)) if (!b.back) add(b.use);
    }
  }
  return counts;
}

/** Provide at most one missing use of each siting kind this year. */
export function provideUses(world: World, households: number): void {
  relocateNuisances(world);
  const needed = world.plugins.demand.usesNeeded(world, households);
  const have = present(world);
  const uses = world.plugins.technology.uses;
  let plotDone = false;
  let landDone = false;
  for (const [id, n] of Object.entries(needed)) {
    if ((have.get(id) ?? 0) >= n) continue;
    const use = uses[id];
    if (!use) continue;
    if (use.site === 'plot' && !plotDone) plotDone = placeOnPlot(world, id, use);
    else if (use.site === 'land' && !landDone) {
      // Institutions and trades seek ground mostly when the town is not pressing outward.
      const p = world.town.pressure < 0.3 ? 0.3 : 0.06;
      if (world.rng.chance(p)) landDone = placeOnLand(world, id, use);
    }
  }
}

/** Houses near enough to a noisome works to count against it. */
const ENGULFED = 15;

/**
 * A noisome trade the town has grown round moves out, more readily the less
 * it cost to set up. Its ground is sold as a field for building; the need for
 * the trade remains, so it is set up again further out.
 */
function relocateNuisances(world: World): void {
  const cad = world.cadastre;
  const uses = world.plugins.technology.uses;
  let houses: Vec2[] | null = null;
  for (const p of [...cad.parcels.values()]) {
    const use = p.use ? uses[p.use] : undefined;
    if (!use?.nuisance || p.kind !== 'works') continue;
    if (!world.rng.chance(0.05 * (1 - (use.relocation ?? 0.5)))) continue;
    houses ??= dwellingFronts(world);
    const c = ringCentroid(p.shape[0]);
    const near = houses.filter((h) => dist(h, c) < use.nuisance!).length;
    if (near < ENGULFED) continue;
    const year = Math.round(world.clock.now);
    const holder = p.rights.alienation ?? cad.lord!;
    const { regime, rights } = world.plugins.tenure.rights('close', holder, cad);
    // Freehold ground: its holder may sell it on.
    rights.alienation = holder;
    rights.withdrawal = holder;
    const field = cad.addParcel('close', p.shape, regime, rights, year);
    cad.retire([p.id], year, `The ${use.name.toLowerCase()} moves out; its ground is to be sold`, [field.id]);
    const place = world.places.find((q) => q.kind === 'institution' && q.name === use.name && dist(q.pos, c) < 80);
    if (place) world.places = world.places.filter((q) => q !== place);
    world.log.push({ year, text: `Hemmed in by houses, the ${use.name.toLowerCase()} moves out of the town; its ground is sold for building.` });
  }
}

function meetsNeeds(world: World, use: UseType, p: Vec2): boolean {
  const n = use.needs;
  if (!n) return true;
  if (n.market) {
    const market = world.places.find((q) => q.kind === 'market');
    if (!market || dist(p, market.pos) > world.plugins.technology.plots.marketLength * 0.6 + 15) return false;
  }
  if (n.water !== undefined) {
    const d = Math.min(...world.terrain.rivers.map((r) => projectOnPolyline(p, r.centreline).dist - r.width / 2));
    if (d > n.water) return false;
  }
  if (n.maxSlope !== undefined) {
    const h = world.terrain.height;
    const s = Math.hypot(h.sample({ x: p.x + 10, y: p.y }) - h.sample({ x: p.x - 10, y: p.y }), h.sample({ x: p.x, y: p.y + 10 }) - h.sample({ x: p.x, y: p.y - 10 })) / 20;
    if (s > n.maxSlope) return false;
  }
  return true;
}

/** A use takes over the front of the town plot where it bids highest. */
function placeOnPlot(world: World, id: string, use: UseType): boolean {
  const cad = world.cadastre;
  const uses = world.plugins.technology.uses;
  // Like uses keep apart: a new inn or chapel seeks its own custom.
  const same: Vec2[] = [];
  for (const b of cad.buildings.values()) if (b.use === id && b.parcelId !== null) {
    const q = cad.parcels.get(b.parcelId);
    if (q?.frontage) same.push(mid(q));
  }
  let best: Parcel | null = null;
  let bestBid = -Infinity;
  for (const p of cad.parcels.values()) {
    if (!TOWN_PLOTS.has(p.kind) || !p.frontage) continue;
    // Only ordinary houses give way; a plot already given to some other use keeps it.
    const fronts = cad.buildingsOn(p.id).filter((b) => !b.back);
    if (fronts.some((b) => !(uses[b.use]?.dwellings ?? 0))) continue;
    const m = mid(p);
    if (!meetsNeeds(world, use, m)) continue;
    if (same.some((q) => dist(q, m) < 80)) continue;
    // The use must outbid the house that is there (bid-rent): houses pay about the land's value.
    const v = plotValue(world, p);
    const bid = (use.bid ?? ((a: number) => a))(v) - v + world.rng.range(0, 0.05);
    if (bid > bestBid) {
      bestBid = bid;
      best = p;
    }
  }
  if (!best) return false;
  for (const b of cad.buildingsOn(best.id)) if (!b.back) cad.removeBuilding(b.id);
  if (best.takenUp === undefined) {
    const h = cad.addHolder(use.holder ?? 'household', use.holderName ?? `the keeper of the ${use.name.toLowerCase()}`);
    const { regime, rights } = world.plugins.tenure.rights(best.kind, h.id, cad);
    cad.regrant(best, rights, regime, Math.round(world.clock.now), `${h.name} takes the plot for ${article(use.name)}`);
  }
  putUpFront(world, best, id);
  best.phase = 'institutive';
  world.log.push({ year: Math.round(world.clock.now), text: `${cap(article(use.name))} opens on ${best.frontage!.street}.` });
  return true;
}

/** A land-hungry use takes ground of its own beside a way at the edge of the town. */
function placeOnLand(world: World, id: string, use: UseType): boolean {
  const g = world.graph;
  const pressure = world.town.pressure;
  const area = use.area ?? 4000;
  const houses = dwellingFronts(world);
  const candidates: { p: Vec2; edge: number; score: number }[] = [];
  for (const e of g.edges.values()) {
    if (e.cls === 'path') continue;
    for (const p of resample(e.pts, 30)) {
      const d = edgeDistance(world, p);
      if (d < 20 || d > 260) continue;
      if (!meetsNeeds(world, use, p)) continue;
      if (use.nuisance && houses.some((h) => Math.abs(h.x - p.x) < use.nuisance! && dist(h, p) < use.nuisance!)) continue;
      // Trades that need the river take damp ground by it; others keep to the dry.
      if (world.terrain.wetness.sample(p) > (use.needs?.water !== undefined ? 0.8 : 0.45)) continue;
      const a = accessAt(world, p);
      // What the use would pay, less what houses would pay there while the town is growing.
      const score = (use.bid ?? (() => 0.3))(a) - pressure * a * 0.9 + world.rng.range(0, 0.04);
      candidates.push({ p, edge: e.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates.slice(0, 8)) {
    const site = siteAt(world, c.p, c.edge, area);
    if (!site) continue;
    commitSite(world, id, use, site, g.edges.get(c.edge)?.name ?? null);
    return true;
  }
  return false;
}

function dwellingFronts(world: World): Vec2[] {
  const out: Vec2[] = [];
  for (const p of world.cadastre.parcels.values()) {
    if ((TOWN_PLOTS.has(p.kind) || p.kind === 'toft') && p.frontage && p.takenUp !== undefined) out.push(mid(p));
  }
  return out;
}

interface Site {
  shape: Shape;
  frontage: { a: Vec2; b: Vec2; inward: Vec2; street: string };
}

/** A block of land of about `area` fronting a way at a point, from land whose holders will sell. */
function siteAt(world: World, p: Vec2, edgeId: number, area: number): Site | null {
  const e = world.graph.edges.get(edgeId);
  if (!e) return null;
  const proj = projectOnPolyline(p, e.pts);
  const a = e.pts[proj.segment];
  const b = e.pts[proj.segment + 1];
  const l = dist(a, b) || 1;
  const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  const width = Math.sqrt(area) * 1.15;
  const depth = (area / width) * 1.1;
  const off = WAY_HALF_WIDTH[e.cls] + 1;
  let best: Site | null = null;
  for (const side of [1, -1]) {
    const n = { x: -t.y * side, y: t.x * side };
    const fa = { x: proj.point.x - (t.x * width) / 2 + n.x * off, y: proj.point.y - (t.y * width) / 2 + n.y * off };
    const fb = { x: proj.point.x + (t.x * width) / 2 + n.x * off, y: proj.point.y + (t.y * width) / 2 + n.y * off };
    const rect: Shape = [[fa, fb, { x: fb.x + n.x * depth, y: fb.y + n.y * depth }, { x: fa.x + n.x * depth, y: fa.y + n.y * depth }]];
    const land = landFor(world, rect);
    const probe = { x: (fa.x + fb.x) / 2 + n.x * 4, y: (fa.y + fb.y) / 2 + n.y * 4 };
    const part = land.filter((x) => pointInShape(probe, x)).sort((x, y) => shapeArea(y) - shapeArea(x))[0];
    if (!part || shapeArea(part) < area * 0.55 || thickness(part) < 12) continue;
    if (!best || shapeArea(part) > shapeArea(best.shape)) best = { shape: part, frontage: { a: fa, b: fb, inward: n, street: e.name ?? 'the road' } };
  }
  return best;
}

function landFor(world: World, area: Shape): Shape[] {
  const blocked = wayBuffers(world, area);
  const b = boundsOf(area);
  for (const p of world.cadastre.parcels.values()) {
    const pb = p.bounds;
    if (pb.maxX < b.minX || pb.minX > b.maxX || pb.maxY < b.minY || pb.minY > b.maxY) continue;
    if (!TAKE_FROM.has(p.kind) || !forSale(world, p)) blocked.push(p.shape);
  }
  for (const r of world.terrain.rivers) blocked.push(bufferPolyline(r.centreline, r.width / 2 + 8));
  return differenceMany(intersection(area, mapShape(world))[0] ?? area, blocked);
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

function commitSite(world: World, id: string, use: UseType, site: Site, street: string | null): void {
  const cad = world.cadastre;
  const year = Math.round(world.clock.now);
  const kind = use.parcel ?? 'works';
  const holder = cad.addHolder(use.holder ?? 'household', use.holderName ?? `the ${use.name.toLowerCase()}`);
  const taken = takeLand(world, [site.shape], TAKE_FROM);
  const { regime, rights } = world.plugins.tenure.rights(kind, holder.id, cad);
  const parcel = cad.addParcel(kind, site.shape, regime, rights, year);
  parcel.use = id;
  parcel.frontage = site.frontage;
  parcel.takenUp = year;
  cad.retire(taken.consumed, year, `Land taken for ${article(use.name)}`, [parcel.id, ...taken.rest]);
  const main = frontBuilding(site.shape, site.frontage, use.building);
  if (main) cad.addBuilding({ parcelId: parcel.id, use: id, footprint: main.footprint, ridge: main.ridge, storeys: use.storeys, built: year });
  const fr = plotFrame(site.shape, site.frontage);
  for (const x of use.extra ?? []) {
    const u0 = fr.width / 2 + x.at[0] - x.size[0] / 2;
    const n0 = x.at[1];
    const rect = frameRect(fr, u0, u0 + x.size[0], n0, n0 + x.size[1]);
    const fp = intersection(rect, site.shape)[0];
    if (!fp || shapeArea(fp) < 10) continue;
    const long = x.size[0] >= x.size[1];
    const at = (du: number, dn: number) => ({ x: fr.origin.x + fr.u.x * du + fr.n.x * dn, y: fr.origin.y + fr.u.y * du + fr.n.y * dn });
    const ridge: [Vec2, Vec2] = long
      ? [at(u0, n0 + x.size[1] / 2), at(u0 + x.size[0], n0 + x.size[1] / 2)]
      : [at(u0 + x.size[0] / 2, n0), at(u0 + x.size[0] / 2, n0 + x.size[1])];
    const extraUse = world.plugins.technology.uses[x.use];
    cad.addBuilding({ parcelId: parcel.id, use: x.use, footprint: fp, ridge, storeys: extraUse?.storeys ?? 1, built: year });
  }
  if (use.trips) addPlace(world, 'institution', use.name, ringCentroid(site.shape[0]), use.trips);
  const acres = (shapeArea(site.shape) / 4047).toFixed(1);
  world.log.push({
    year,
    text: `${cap(article(use.name))} is set up on ${acres} acres at the edge of the town${street ? `, on ${street}` : ''}.`,
  });
}

function article(name: string): string {
  const lower = name.toLowerCase();
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
