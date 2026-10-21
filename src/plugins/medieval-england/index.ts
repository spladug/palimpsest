// Medieval England, from c. 900: scattered farmsteads with their closes, a
// minster church near the crossing, then the reorganisation of the township
// into open fields with its households drawn together into a village.

import { dist } from '../../sim/geom';
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
  events(world: World) {
    const minsterYear = 950 + world.rng.int(0, 30);
    const fieldsYear = Math.max(minsterYear + 30, 1000 + world.rng.int(0, 80));
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
