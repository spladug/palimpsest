// Medieval England, from c. 900: scattered farmsteads with their closes, a
// minster church near the crossing, then the reorganisation of the township
// into open fields with its households drawn together into a village.

import { dist, resample } from '../../sim/geom';
import { radialPolygon } from '../../sim/polygon';
import { layOutChurchyard, layOutTofts, plantBorough } from '../../sim/town';
import { tobler } from '../../sim/pathfind';
import { closesWithin, layOutOpenFields, townshipOutline } from '../../sim/fields';
import { abandonPlace, addPlace, updateLandUse, type World } from '../../sim/world';
import { pointInShape } from '../../sim/polygon';
import type { Right } from '../types';
import type { DemandPlugin, Plugins, TechnologyPlugin, TenurePlugin, TripDemand } from '../types';
import { riverValley } from './geography';

const technology: TechnologyPlugin = {
  name: 'Early medieval',
  movement: {
    speed: tobler,
    wetGroundFactor: 0.45,
    fordFactor: 0.35,
    wornGroundFactor: 1.35,
    wearHalf: 40,
    wearDecay: 0.3,
    classFactor: { path: 1.1, track: 1.25, lane: 1.45, road: 1.7 },
  },
  hierarchy: {
    upgradeAt: { path: 150, track: 1500, lane: 6000, road: Infinity },
    downgradeAt: { path: 20, track: 90, lane: 900, road: 3500 },
    patience: 5,
  },
  fields: {
    closeRadius: 130,
    closeSpacing: 55,
    // A furlong's strips were about a furlong (220 yards, ~200 m) long.
    furlongSpacing: 190,
    minFurlongArea: 4000,
    // Selions of roughly 5–22 m (1–4 perches) wide.
    stripWidth: { mean: 13, sd: 4, min: 6, max: 24 },
    minStripArea: 120,
    aratralCurve: 0.05,
    aratralMax: 9,
    drainageSlope: 0.012,
    meadowWetness: 0.42,
    wasteSlope: 0.11,
    demesneShare: 0.3,
    glebeEvery: 12,
    villageCoreRadius: 120,
    headland: 6,
    cropFactor: 0.5,
    closeFactor: 0.65,
    meadowFactor: 0.85,
    plotFactor: 0.35,
  },
  plots: {
    // Village tofts were broad; burgages narrow (Slater; Tait 2009 finds varied widths, not one unit).
    toftWidths: { 4: 0.2, 5: 0.35, 6: 0.3, 8: 0.15 },
    toftDepth: 70,
    villageGrowth: 50,
    burgageWidths: { 2: 0.15, 2.5: 0.15, 3: 0.3, 3.5: 0.25, 4: 0.15 },
    // Stratford-upon-Avon's burgages of 1196 were 3½ × 12 perches (~18 × 60 m).
    burgageDepth: 62,
    boroughLength: 420,
    marketLength: 120,
    marketWidth: 32,
  },
  uses: {
    cottage: { name: 'Cottage', building: { width: 12, depth: 6, setback: 4 }, storeys: 1 },
    townhouse: { name: 'House', building: { width: 'full', depth: 10, setback: 0 }, storeys: 2 },
    shop: { name: 'Shop and house', building: { width: 'full', depth: 12, setback: 0 }, storeys: 2 },
    mill: { name: 'Water mill', building: { width: 10, depth: 7, setback: 0 }, storeys: 2 },
  },
};

/**
 * Manorial tenure: households hold their strips and closes of the lord; the
 * township as a community governs the open fields and has grazing over them
 * once the crop is in. The bundles are deliberately not nested.
 */
const tenure: TenurePlugin = {
  name: 'Early medieval English',
  allRights: ['access', 'withdrawal', 'management', 'exclusion', 'alienation', 'build', 'subdivide', 'inherit'],
  inheritance: 'impartible',
  rights(kind, occupant, cad) {
    const lord = cad.lord!;
    const community = cad.community!;
    const r: Partial<Record<Right, number>> = {};
    switch (kind) {
      case 'close':
        Object.assign(r, { access: occupant, withdrawal: occupant, management: occupant, exclusion: occupant });
        Object.assign(r, { build: occupant, inherit: occupant, alienation: lord, subdivide: lord });
        return { regime: 'private', rights: r };
      case 'strip':
        // The crop is the holder's; what is sown, and grazing on the stubble and fallow, are the township's.
        Object.assign(r, { withdrawal: occupant, inherit: occupant, management: community, access: community });
        Object.assign(r, { alienation: lord, subdivide: lord });
        return { regime: 'use-right', rights: r };
      case 'meadow':
        Object.assign(r, { access: community, withdrawal: community, management: community, alienation: lord });
        return { regime: 'common', rights: r };
      case 'common':
        Object.assign(r, { access: community, withdrawal: community, management: lord, alienation: lord });
        return { regime: 'common', rights: r };
      case 'toft':
        // A villein's house plot: his to live in and pass on, but held of the lord.
        Object.assign(r, { access: occupant, withdrawal: occupant, management: occupant, exclusion: occupant });
        Object.assign(r, { build: occupant, inherit: occupant, alienation: lord, subdivide: lord });
        return { regime: 'private', rights: r };
      case 'burgage':
        // Burgage tenure: for a money rent the burgess may sell, divide, build and bequeath freely.
        for (const right of ['access', 'withdrawal', 'management', 'exclusion', 'alienation', 'build', 'subdivide', 'inherit'] as const) {
          r[right] = occupant;
        }
        return { regime: 'private', rights: r };
      case 'market':
        Object.assign(r, { access: community, management: lord, withdrawal: lord, alienation: lord });
        return { regime: 'common', rights: r };
      case 'churchyard':
        Object.assign(r, { access: community, management: occupant, withdrawal: occupant, exclusion: occupant, alienation: occupant });
        return { regime: 'private', rights: r };
    }
  },
};

/** Gravity-model trips: real trips per year between two places. */
const GRAVITY = 60;
const RANGE = 1000;
/** Trips a village household makes to its strips in a year. */
const FIELD_TRIPS_PER_HOUSEHOLD = 150;
const TOWNSHIP_RADIUS = 1050;

const VILLAGE_NAMES = ['Ashford', 'Brigford', 'Eastford', 'Fulford', 'Langford', 'Mickleford', 'Salford', 'Shefford', 'Wilford', 'Thornford'];

const GIVEN = ['John', 'William', 'Robert', 'Richard', 'Walter', 'Hugh', 'Thomas', 'Roger', 'Henry', 'Geoffrey', 'Ralph', 'Agnes', 'Alice', 'Matilda', 'Emma', 'Joan', 'Isabel', 'Margery'];
const TRADES = ['Smith', 'Baker', 'Tanner', 'Dyer', 'Webb', 'Fuller', 'Mercer', 'Cooper', 'Turner', 'Carter', 'Taylor', 'Glover', 'Chapman', 'Wright', 'Draper', 'Skinner', 'Brewer', 'Butcher', 'Chandler', 'Saddler'];

const demand: DemandPlugin = {
  name: 'Dispersed settlement, then a nucleated village',
  trips(world: World): TripDemand[] {
    const out: TripDemand[] = [];
    const ps = world.places.filter((p) => p.kind !== 'field');
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const d = dist(ps[a].pos, ps[b].pos);
        const trips = (GRAVITY * ps[a].mass * ps[b].mass) / (1 + (d / RANGE) ** 2);
        if (trips >= 5) out.push({ from: ps[a], to: ps[b], tripsPerYear: trips });
      }
    }
    const village = world.places.find((p) => p.kind === 'village');
    const gates = world.places.filter((p) => p.kind === 'field');
    if (village && gates.length) {
      const total = gates.reduce((s, g) => s + g.mass, 0);
      for (const g of gates) {
        out.push({ from: village, to: g, tripsPerYear: (village.mass * FIELD_TRIPS_PER_HOUSEHOLD * g.mass) / total });
      }
    }
    return out;
  },
  newFarmsteadRate(world: World): number {
    const farms = world.places.filter((p) => p.kind === 'farmstead').length;
    // Once the open fields exist, only outlying farms are founded.
    const base = world.township ? 0.03 : 0.12;
    return Math.max(0, base * (1 - farms / 28));
  },
  newHouseholdRate(world: World): number {
    const village = world.places.find((p) => p.kind === 'village');
    return village ? Math.max(0, 0.3 * (1 - village.mass / 70)) : 0;
  },
  newBurgessRate(world: World): number {
    const market = world.places.find((p) => p.kind === 'market');
    if (!market) return 0;
    // A rush of takers in the first decades, slowing as the best plots go.
    const age = world.clock.now - market.founded;
    return 0.8 + 5 * Math.exp(-age / 25);
  },
  burgessName(world: World): string {
    const given = world.rng.pick(GIVEN);
    // Many burgesses were named for their trade; others for the place they came from.
    if (world.rng.chance(0.65)) return `${given} ${world.rng.pick(TRADES)}`;
    const places = [...world.deserted.map((d) => d.name), ...world.places.filter((p) => p.kind === 'farmstead').map((p) => p.name)];
    return places.length ? `${given} of ${world.rng.pick(places)}` : `${given} ${world.rng.pick(TRADES)}`;
  },
  events(world: World) {
    const minsterYear = 950 + world.rng.int(0, 30);
    const fieldsYear = Math.max(minsterYear + 30, 1000 + world.rng.int(0, 80));
    const millYear = fieldsYear + 10 + world.rng.int(0, 30);
    // Most English boroughs were founded between about 1150 and 1250.
    const charterYear = Math.max(fieldsYear + 60, 1150 + world.rng.int(0, 80));
    return [
      {
        time: minsterYear,
        name: 'minster',
        fire(w: World) {
          const site = minsterSite(w);
          if (!site) return;
          const place = addPlace(w, 'church', 'Minster', w.graph.nodes.get(site)!.pos, 5, site);
          w.cadastre.addHolder('church', 'the minster', place.id);
          w.log.push({ year: minsterYear, text: 'A minster church is built at the meeting of ways near the ford.' });
        },
      },
      {
        time: fieldsYear,
        name: 'open fields',
        fire: (w: World) => reorganise(w, fieldsYear),
      },
      { time: millYear, name: 'mill', fire: (w: World) => buildMill(w, millYear) },
      { time: charterYear, name: 'borough', fire: (w: World) => foundBorough(w, charterYear) },
    ];
  },
};

/**
 * The township's land is pooled and laid out afresh in open fields; most
 * households leave their farmsteads for a village by the church.
 */
function reorganise(world: World, year: number): void {
  const church = world.places.find((p) => p.kind === 'church');
  const centre = church?.pos ?? world.terrain.fords[0];
  const rng = world.rng.fork('open-fields');
  const township = townshipOutline(world, centre, TOWNSHIP_RADIUS, rng);
  const cad = world.cadastre;

  const villageNode = villageSite(world, centre);
  const name = rng.pick(VILLAGE_NAMES);
  const village = addPlace(world, 'village', name, villageNode?.pos ?? { x: centre.x + 60, y: centre.y }, 0, villageNode?.id);

  const moved: number[] = [];
  const movers = world.places.filter((p) => p.kind === 'farmstead' && pointInShape(p.pos, township) && rng.chance(0.85));
  for (const farm of movers) {
    const household = [...cad.holders.values()].find((h) => h.kind === 'household' && h.placeId === farm.id);
    if (household) {
      household.placeId = village.id;
      moved.push(household.id);
    }
    abandonPlace(world, farm);
  }
  // A village needs people even if nobody moved in.
  while (moved.length < 4) moved.push(cad.addHolder('household', `household ${moved.length + 1}`, village.id).id);
  village.mass = moved.length;

  cad.retire(closesWithin(world, township, new Set(moved)), year, 'Closes thrown into the open fields');
  const layout = layOutOpenFields(world, township, centre, moved, rng);
  for (const g of layout.gates) addPlace(world, 'field', cad.furlongs.get(g.furlongId)!.name, g.pos, g.area);
  world.township = township;
  world.villageCore = layout.villageCore;
  world.villageRadius = world.plugins.technology.fields.villageCoreRadius;
  if (church) {
    const holder = [...cad.holders.values()].find((h) => h.kind === 'church')!;
    layOutChurchyard(world, church, holder.id);
  }
  layOutTofts(world, layout.villageCore, church?.pos ?? village.pos, moved);
  updateLandUse(world);

  const stayed = world.places.filter((p) => p.kind === 'farmstead' && pointInShape(p.pos, township)).length;
  world.log.push({
    year,
    text:
      `The township's land is laid out anew in three open fields: ${layout.furlongs} furlongs of ${layout.strips} strips, ` +
      `with meadow by the river. ${movers.length} households leave their farmsteads for a new village, ${name}` +
      (stayed ? `; ${stayed} outlying ${stayed > 1 ? 'farms remain' : 'farm remains'}.` : '.'),
  });
}

/** The lord's water mill, on the river bank near the village: every tenant must grind there. */
function buildMill(world: World, year: number): void {
  const village = world.places.find((p) => p.kind === 'village');
  if (!village) return;
  const river = world.terrain.rivers[0];
  const ford = world.terrain.fords[0];
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const p of resample(river.centreline, 10)) {
    if (dist(p, ford) < 180) continue;
    const d = dist(p, village.pos);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > 900) return;
  // Stand the mill on the village side of the river.
  const dx = village.pos.x - best.x;
  const dy = village.pos.y - best.y;
  const l = Math.hypot(dx, dy) || 1;
  const pos = { x: best.x + (dx / l) * (river.width / 2 + 9), y: best.y + (dy / l) * (river.width / 2 + 9) };
  const cad = world.cadastre;
  const { regime, rights } = world.plugins.tenure.rights('close', cad.lord!, cad);
  const holme = cad.addParcel('close', radialPolygon(pos, () => 22, 14), regime, rights, year);
  const ux = -dy / l;
  const uy = dx / l;
  const corner = (a: number, b: number) => ({ x: pos.x + ux * a + (dx / l) * b, y: pos.y + uy * a + (dy / l) * b });
  cad.addBuilding({
    parcelId: holme.id,
    use: 'mill',
    footprint: [[corner(-5, -3.5), corner(5, -3.5), corner(5, 3.5), corner(-5, 3.5)]],
    ridge: [corner(-5, 0), corner(5, 0)],
    storeys: 2,
    built: year,
  });
  addPlace(world, 'mill', 'Mill', pos, 3);
  updateLandUse(world);
  world.log.push({ year, text: 'The lord builds a water mill on the river; his tenants must grind their corn there.' });
}

/** A market charter, and a planted borough laid out beside the village. */
function foundBorough(world: World, year: number): void {
  const village = world.places.find((p) => p.kind === 'village');
  if (!village || !world.villageCore) return;
  const borough = plantBorough(world, world.villageCore);
  if (!borough) return;
  addPlace(world, 'market', `${village.name} market`, borough.marketCentre, 3);
  updateLandUse(world);
  world.log.push({
    year,
    text:
      `The lord obtains a market charter and plants a borough beside ${village.name}: a market place and ` +
      `${borough.plots} burgage plots along ${borough.streetName}, cut from the open-field strips.`,
  });
}

/** The busiest junction on dry ground near the main ford. */
function minsterSite(world: World): number | null {
  const ford = world.terrain.fords[0];
  return busiestJunction(world, ford, 700);
}

/** The village grows at the busiest junction near the church. */
function villageSite(world: World, centre: { x: number; y: number }) {
  const id = busiestJunction(world, centre, 350);
  return id === null ? null : world.graph.nodes.get(id)!;
}

function busiestJunction(world: World, near: { x: number; y: number }, within: number): number | null {
  const g = world.graph;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const n of g.nodes.values()) {
    if (n.placeId !== null || g.degree(n.id) < 3) continue;
    const d = dist(n.pos, near);
    if (d > within || world.terrain.wetness.sample(n.pos) > 0.3) continue;
    let use = 0;
    for (const eid of g.edgesAt(n.id)) use += g.edges.get(eid)!.usage;
    const score = Math.log(1 + use) - d / 400;
    if (score > bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}

export const medievalEngland: Plugins = {
  geography: riverValley,
  technology,
  tenure,
  demand,
};
