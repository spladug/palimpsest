// Medieval England, from c. 900: scattered farmsteads with their closes, a
// minster church near the crossing, then the reorganisation of the township
// into open fields with its households drawn together into a village.

import { dist, resample } from '../../sim/geom';
import { radialPolygon } from '../../sim/polygon';
import { layOutChurchyard, layOutTofts, plantBorough, takeLand } from '../../sim/town';
import { tobler } from '../../sim/pathfind';
import { closesWithin, layOutOpenFields, townshipOutline } from '../../sim/fields';
import { abandonPlace, addPlace, updateLandUse, type World } from '../../sim/world';
import { pointInShape } from '../../sim/polygon';
import { epidemic } from '../../sim/dynamics';
import { enclose } from '../../sim/enclosure';
import type { Right, TownPlotRules, UseType } from '../types';
import type { DemandPlugin, Plugins, TechnologyPlugin, TenurePlugin, TripDemand } from '../types';
import { riverValley } from './geography';

/**
 * How new town plots are laid out as the centuries pass: burgages along the
 * roads out of the medieval town; wider freehold plots later; then, once the
 * fields are enclosed, whole fields laid out by builders in narrow terraced
 * plots (Ward 1962), and at last villas in their gardens.
 */
function townPlots(year: number): TownPlotRules {
  if (year < 1600) {
    return { kind: 'burgage', widths: { 2: 0.25, 2.5: 0.3, 3: 0.3, 4: 0.15 }, depth: 48, use: 'townhouse', building: 'on take-up', wholeFields: false };
  }
  if (year < 1760) {
    return { kind: 'plot', widths: { 2: 0.3, 3: 0.4, 4: 0.3 }, depth: 40, use: 'house', building: 'on take-up', wholeFields: false };
  }
  if (year < 1890) {
    return { kind: 'plot', widths: { 1: 0.35, 1.25: 0.4, 1.5: 0.25 }, depth: 22, use: 'terrace', building: 'speculative', wholeFields: true };
  }
  return { kind: 'plot', widths: { 2: 0.45, 2.5: 0.35, 3: 0.2 }, depth: 34, use: 'villa', building: 'speculative', wholeFields: true };
}

/**
 * The land-use catalogue. Bids are over accessibility (0 at the fields' edge,
 * 1 at the market cross): shops and inns bid steeply for the centre;
 * institutions and noisome trades bid little and flatly, so they take cheap
 * ground at the edge.
 */
const USES: Record<string, UseType> = {
  cottage: { name: 'Cottage', building: { width: 12, depth: 6, setback: 4 }, storeys: 1, dwellings: 1 },
  townhouse: { name: 'House', building: { width: 'full', depth: 10, setback: 0 }, storeys: 2, dwellings: 1 },
  shop: { name: 'Shop and house', building: { width: 'full', depth: 12, setback: 0 }, storeys: 2, dwellings: 1 },
  house: { name: 'House', building: { width: 'full', depth: 9, setback: 0 }, storeys: 2, dwellings: 1 },
  'brick house': { name: 'Brick house', building: { width: 'full', depth: 11, setback: 0 }, storeys: 3, dwellings: 1 },
  shopfront: { name: 'Shop with rooms over', building: { width: 'full', depth: 15, setback: 0 }, storeys: 3, dwellings: 1 },
  terrace: { name: 'Terraced house', building: { width: 'full', depth: 8, setback: 1.5 }, storeys: 2, dwellings: 1 },
  villa: { name: 'Villa', building: { width: 9, depth: 10, setback: 7, sideGap: 2.5 }, storeys: 2, dwellings: 1 },
  workshop: { name: 'Workshop', building: { width: 5, depth: 7, setback: 0 }, storeys: 1 },
  warehouse: { name: 'Warehouse', building: { width: 6, depth: 9, setback: 0 }, storeys: 2 },
  court: { name: 'Cottage in a court', building: { width: 4.5, depth: 5, setback: 0 }, storeys: 2, dwellings: 1 },
  mill: { name: 'Water mill', building: { width: 10, depth: 7, setback: 0 }, storeys: 2 },
  church: { name: 'Church', building: { width: 22, depth: 8, setback: 0 }, storeys: 2 },
  range: { name: 'Range', building: { width: 8, depth: 8, setback: 0 }, storeys: 2 },
  shed: { name: 'Shed', building: { width: 8, depth: 5, setback: 0 }, storeys: 1 },
  inn: {
    name: 'Inn',
    building: { width: 'full', depth: 14, setback: 0 },
    storeys: 2,
    site: 'plot',
    bid: (a) => 0.4 + 1.3 * a,
  },
  guildhall: {
    name: 'Guildhall',
    building: { width: 'full', depth: 12, setback: 0 },
    storeys: 2,
    site: 'plot',
    needs: { market: true },
    holder: 'borough',
    holderName: 'the guild',
    bid: (a) => 0.6 + a,
  },
  chapel: {
    name: 'Chapel',
    building: { width: 11, depth: 15, setback: 3 },
    storeys: 2,
    site: 'plot',
    holder: 'church',
    holderName: 'the chapel trustees',
    bid: (a) => 0.3 + 0.5 * a,
  },
  friary: {
    name: 'Friary',
    building: { width: 30, depth: 9, setback: 10 },
    storeys: 2,
    site: 'land',
    area: 13000,
    parcel: 'precinct',
    holder: 'church',
    holderName: 'the Grey Friars',
    bid: (a) => 0.35 + 0.3 * a,
    relocation: 1,
    trips: 4,
    extra: [
      { use: 'range', at: [11, 19], size: [8, 22] },
      { use: 'range', at: [1, 41], size: [28, 8] },
    ],
  },
  hospital: {
    name: 'Hospital',
    building: { width: 22, depth: 8, setback: 5 },
    storeys: 1,
    site: 'land',
    area: 3500,
    parcel: 'precinct',
    holder: 'church',
    holderName: "the brethren of St John's hospital",
    bid: (a) => 0.3 + 0.3 * a,
    relocation: 1,
    extra: [{ use: 'church', at: [7, 15], size: [8, 12] }],
  },
  tannery: {
    name: 'Tannery',
    building: { width: 14, depth: 8, setback: 4 },
    storeys: 2,
    site: 'land',
    area: 2600,
    parcel: 'works',
    holderName: 'the tanner',
    needs: { water: 80 },
    nuisance: 90,
    bid: (a) => 0.25 + 0.2 * a,
    relocation: 0.4,
    extra: [{ use: 'shed', at: [-4, 18], size: [12, 6] }],
  },
  'tenter ground': {
    name: 'Tenter ground',
    building: { width: 6, depth: 4, setback: 3 },
    storeys: 1,
    site: 'land',
    area: 6000,
    parcel: 'works',
    holderName: 'the clothiers',
    bid: (a) => 0.2 + 0.15 * a,
    relocation: 0.1,
  },
  'grammar school': {
    name: 'Grammar school',
    building: { width: 22, depth: 9, setback: 8 },
    storeys: 2,
    site: 'land',
    area: 3200,
    parcel: 'precinct',
    holder: 'borough',
    holderName: 'the school governors',
    bid: (a) => 0.35 + 0.4 * a,
    relocation: 0.9,
    trips: 3,
  },
  brickworks: {
    name: 'Brickworks',
    building: { width: 10, depth: 10, setback: 8 },
    storeys: 1,
    site: 'land',
    area: 11000,
    parcel: 'works',
    holder: 'company',
    holderName: 'the brickmakers',
    nuisance: 120,
    bid: (a) => 0.15 + 0.1 * a,
    relocation: 0.2,
    extra: [{ use: 'shed', at: [0, 30], size: [34, 6] }],
  },
  workhouse: {
    name: 'Workhouse',
    building: { width: 42, depth: 10, setback: 12 },
    storeys: 3,
    site: 'land',
    area: 9000,
    parcel: 'precinct',
    holder: 'borough',
    holderName: 'the guardians of the poor',
    bid: (a) => 0.2 + 0.2 * a,
    relocation: 0.95,
    trips: 3,
    extra: [
      { use: 'range', at: [-16, 22], size: [8, 26] },
      { use: 'range', at: [16, 22], size: [8, 26] },
    ],
  },
  factory: {
    name: 'Mill',
    building: { width: 42, depth: 14, setback: 6 },
    storeys: 4,
    site: 'land',
    area: 6500,
    parcel: 'works',
    holder: 'company',
    holderName: 'the mill company',
    needs: { water: 120 },
    nuisance: 50,
    bid: (a) => 0.3 + 0.3 * a,
    relocation: 0.8,
    trips: 12,
    extra: [{ use: 'range', at: [-14, 26], size: [10, 10] }],
  },
  gasworks: {
    name: 'Gasworks',
    building: { width: 20, depth: 10, setback: 6 },
    storeys: 2,
    site: 'land',
    area: 5500,
    parcel: 'works',
    holder: 'company',
    holderName: 'the gas company',
    needs: { water: 150 },
    nuisance: 140,
    bid: (a) => 0.25 + 0.2 * a,
    relocation: 0.9,
    extra: [{ use: 'gasholder', at: [6, 30], size: [18, 18] }],
  },
  gasholder: { name: 'Gasholder', building: { width: 18, depth: 18, setback: 0 }, storeys: 3 },
  cemetery: {
    name: 'Cemetery',
    building: { width: 8, depth: 14, setback: 25 },
    storeys: 1,
    site: 'land',
    area: 22000,
    parcel: 'precinct',
    holder: 'borough',
    holderName: 'the burial board',
    bid: (a) => 0.2 + 0.25 * a,
    relocation: 1,
  },
  'board school': {
    name: 'Board school',
    building: { width: 30, depth: 10, setback: 8 },
    storeys: 2,
    site: 'land',
    area: 3500,
    parcel: 'precinct',
    holder: 'borough',
    holderName: 'the school board',
    bid: (a) => 0.35 + 0.4 * a,
    relocation: 0.9,
    trips: 4,
  },
};

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
    furlongSpacing: 190,
    // A furlong's strips were about a furlong (220 yards, ~200 m) long; blocks were of any breadth.
    furlongLength: { min: 140, max: 240 },
    furlongBreadth: { min: 60, max: 220 },
    furlongLie: 60,
    furlongTurn: (40 * Math.PI) / 180,
    furlongSnap: (25 * Math.PI) / 180,
    headlandSlack: 15,
    minGoreWidth: 12,
    crossFurlong: 0.5,
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
    // House plots are private: people go round by the streets and lanes.
    plotFactor: 0.12,
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
    townPlots,
    // Half a burgage of 2½ perches is a little over 6 m: about as narrow as a house goes.
    minFrontage: 6,
    climaxCoverage: 0.55,
    backland: (year) => ({ work: year < 1700 ? 'workshop' : 'warehouse', housing: year >= 1640 && year < 1920 ? 'court' : null }),
    rebuild: (year, onMarket) => {
      if (year < 1700) return onMarket ? 'shop' : 'townhouse';
      if (year < 1840) return onMarket ? 'shop' : 'brick house';
      return onMarket ? 'shopfront' : 'brick house';
    },
  },
  uses: USES,
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
      default:
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
      case 'plot':
      case 'precinct':
      case 'works':
        // Freehold: the holder has every right.
        for (const right of ['access', 'withdrawal', 'management', 'exclusion', 'alienation', 'build', 'subdivide', 'inherit'] as const) {
          r[right] = occupant;
        }
        return { regime: 'private', rights: r };
    }
  },
  willingToSell(parcel, cad) {
    const seller = cad.holders.get(parcel.rights.alienation ?? -1);
    switch (parcel.kind) {
      case 'strip':
        // The lord can take strips at the edge of the fields, giving the holders others.
        return 0.6;
      case 'close':
        // A freehold close (after enclosure) is readily sold; a farm's close held of the lord, less so.
        if (parcel.rights.alienation === parcel.rights.withdrawal) return seller?.kind === 'household' ? 0.55 : 0.4;
        return 0.15;
      case 'common':
        return 0.05;
      case 'precinct':
        // Institutions hardly ever sell: their grounds survive as fringe belts.
        if (seller?.kind === 'church') return 0.01;
        if (seller?.kind === 'borough') return 0.02;
        return 0.08;
      case 'works':
        return 0.12;
      default:
        return 0;
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

const SURNAMES = [
  'Atkinson', 'Bramley', 'Calvert', 'Dawson', 'Firth', 'Hargreaves', 'Hepworth', 'Holroyd', 'Jowett', 'Kitson',
  'Lister', 'Marsden', 'Pickles', 'Ramsden', 'Sugden', 'Townend', 'Whiteley', 'Wood', 'Walker', 'Green', 'Hall',
  'Jackson', 'Robinson', 'Wilson', 'Brown', 'Ellis', 'Barker', 'Greenwood', 'Holt', 'Crowther',
];
const BUILDER_GIVEN = ['John', 'William', 'Thomas', 'James', 'George', 'Joseph', 'Samuel', 'Benjamin', 'Isaac', 'Henry'];
const LATER_GIVEN = ['John', 'William', 'Thomas', 'James', 'George', 'Joseph', 'Samuel', 'Charles', 'Mary', 'Elizabeth', 'Ann', 'Sarah', 'Hannah', 'Martha', 'Jane', 'Susannah'];

const MEDIEVAL_STREETS = ['Sheep Street', 'Swine Street', 'Rother Street', 'Hog Lane', 'Horsefair', 'Cornhill', 'Wood Street', 'Bell Lane', 'Back Street', 'New Street', 'Chapel Street', 'Bull Ring'];
const GEORGIAN_STREETS = ['George Street', 'Union Street', 'Nelson Street', 'Wellington Street', 'Paradise Row', 'Albion Street', 'Waterloo Road', 'Trafalgar Street', 'Regent Street', 'Brunswick Terrace', 'Queen Street', 'King Street', 'Hanover Street', 'Duke Street'];
const VICTORIAN_STREETS = ['Victoria Street', 'Albert Road', 'Alma Road', 'Inkerman Street', 'Garibaldi Street', 'Gladstone Street', 'Palmerston Road', 'Clarence Street', 'Princes Street', 'Cobden Street', 'Peel Street', 'Railway Terrace', 'Jubilee Street', 'Osborne Road', 'Balmoral Avenue', 'Sandringham Road', 'Hope Street', 'Providence Row'];
const LATER_STREETS = ['Edward Street', 'Coronation Avenue', 'Ladysmith Road', 'Kitchener Road', 'Beech Avenue', 'Oak Avenue', 'The Crescent', 'Elm Grove', 'Laburnum Grove', 'Meadow Way', 'Orchard Close', 'Highfield Road', 'Park Avenue', 'Fairfield Road'];

/**
 * Households the town can support, by year. Rapid growth after the charter to
 * a peak about 1300; the Black Death and a long late-medieval slump; slow
 * recovery, a pause before industry, and then the industrial boom.
 */
const CAPACITY: [number, number][] = [
  [1100, 60], [1200, 110], [1300, 190], [1347, 200], [1352, 120], [1450, 100], [1520, 120], [1600, 190],
  [1660, 230], [1760, 260], [1800, 420], [1850, 850], [1900, 1250], [1950, 1450], [2000, 1550], [2400, 1700],
];

function interpolate(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** Some towns do better than others: a fixed scale for each seed. */
function townScale(world: World): number {
  let h = 0;
  for (const c of world.seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 0.8 + 0.4 * ((h % 1000) / 1000);
}

function givenName(world: World): string {
  return world.rng.pick(world.clock.now < 1500 ? GIVEN : LATER_GIVEN);
}

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
  burgessName(world: World): string {
    const given = givenName(world);
    // Surnames settled into families from about 1400; before, many burgesses were
    // named for their trade, others for the place they came from.
    if (world.clock.now >= 1400) return `${given} ${world.rng.pick(world.rng.chance(0.5) ? TRADES : SURNAMES)}`;
    if (world.rng.chance(0.65)) return `${given} ${world.rng.pick(TRADES)}`;
    const places = [...world.deserted.map((d) => d.name), ...world.places.filter((p) => p.kind === 'farmstead').map((p) => p.name)];
    return places.length ? `${given} of ${world.rng.pick(places)}` : `${given} ${world.rng.pick(TRADES)}`;
  },
  heirName: givenName,
  builderName(world: World): string {
    return `${world.rng.pick(BUILDER_GIVEN)} ${world.rng.pick(SURNAMES)}, builder`;
  },
  townCapacity(world: World): number {
    const market = world.places.find((p) => p.kind === 'market');
    if (!market) return 0;
    const year = world.clock.now;
    // A new borough takes a generation or two to fill its trade.
    const ramp = Math.min(1, 0.35 + (year - market.founded) / 60);
    return interpolate(CAPACITY, year) * ramp * townScale(world);
  },
  usesNeeded(world: World, n: number): Record<string, number> {
    const y = world.clock.now;
    const out: Record<string, number> = {};
    if (y >= 1220) out.inn = Math.min(14, Math.floor(n / 70));
    if (n >= 50) out.tannery = n >= 450 ? 2 : 1;
    if (y >= 1250 && n >= 70) out.hospital = 1;
    if (y >= 1230 && y < 1538 && n >= 90) out.friary = 1;
    if (y >= 1300 && y < 1820 && n >= 100) out['tenter ground'] = 1;
    if (y >= 1380 && n >= 110) out.guildhall = 1;
    if (y >= 1550 && n >= 150) out['grammar school'] = 1;
    if (y >= 1690) out.chapel = Math.min(6, Math.floor(n / 250));
    if (y >= 1760 && n >= 220) out.brickworks = 1;
    if (y >= 1780 && n >= 260) out.workhouse = 1;
    if (y >= 1790) out.factory = Math.floor(n / 450);
    if (y >= 1825 && n >= 400) out.gasworks = 1;
    if (y >= 1850 && n >= 450) out.cemetery = 1;
    if (y >= 1870) out['board school'] = Math.floor(n / 600);
    return out;
  },
  streetName(world: World, toward: string | null, wholeField: boolean): string {
    const used = new Set<string>();
    for (const e of world.graph.edges.values()) if (e.name) used.add(e.name);
    const fresh = (names: string[]) => {
      const free = names.filter((n) => !used.has(n));
      if (free.length) return world.rng.pick(free);
      for (const prefix of ['New', 'Upper', 'Lower', 'Little']) {
        const more = names.map((n) => `${prefix} ${n}`).filter((n) => !used.has(n));
        if (more.length) return world.rng.pick(more);
      }
      return `${world.rng.pick(names)} ${used.size}`;
    };
    if (wholeField) {
      const y = world.clock.now;
      return fresh(y < 1837 ? GEORGIAN_STREETS : y < 1901 ? VICTORIAN_STREETS : LATER_STREETS);
    }
    if (toward) {
      const road = /^(North|South|East|West) road$/.exec(toward);
      if (road) return fresh([`${road[1]} Street`, `${road[1]}gate`]);
      if (toward === 'Mill') return fresh(['Mill Lane', 'Mill Street']);
      if (toward === 'Ridgeway') return fresh(['Ridgeway', 'Ridge Lane']);
      return fresh([`${toward} Lane`, `${toward} Road`]);
    }
    return fresh(MEDIEVAL_STREETS);
  },
  events(world: World) {
    const minsterYear = 950 + world.rng.int(0, 30);
    const fieldsYear = Math.max(minsterYear + 30, 1000 + world.rng.int(0, 80));
    const millYear = fieldsYear + 10 + world.rng.int(0, 30);
    // Most English boroughs were founded between about 1150 and 1250.
    const charterYear = Math.max(fieldsYear + 60, 1150 + world.rng.int(0, 80));
    // Parliamentary enclosure came to most open-field townships between 1760 and 1820.
    const enclosureYear = 1760 + world.rng.int(0, 60);
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
      {
        time: 1348.5,
        name: 'black death',
        fire(w: World) {
          const lost = epidemic(w, 0.4);
          w.log.push({ year: 1348, text: `The Black Death: some ${lost} households die. Plots fall empty and their houses decay.` });
        },
      },
      {
        time: 1361.5,
        name: 'second pestilence',
        fire(w: World) {
          const lost = epidemic(w, 0.12);
          if (lost) w.log.push({ year: 1361, text: `Plague returns; ${lost} more households are lost.` });
        },
      },
      { time: 1538.5, name: 'dissolution', fire: (w: World) => dissolve(w) },
      { time: enclosureYear, name: 'enclosure', fire: (w: World) => encloseTownship(w, enclosureYear) },
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
  // The mill's holme is taken out of whatever land it stands on (usually the common meadow).
  const ground = radialPolygon(pos, () => 22, 14);
  const taken = takeLand(world, [ground], new Set(['meadow', 'strip', 'common']));
  const holme = cad.addParcel('close', ground, regime, rights, year);
  cad.retire(taken.consumed, year, 'Land taken for the mill', [holme.id, ...taken.rest]);
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

/** The friary is dissolved and its precinct granted to a gentleman, who makes a house of it. */
function dissolve(world: World): void {
  const cad = world.cadastre;
  for (const p of cad.parcels.values()) {
    if (p.use !== 'friary') continue;
    const owner = cad.addHolder('gentry', `Sir ${world.rng.pick(['Richard', 'Thomas', 'William', 'John', 'Edward'])} ${world.rng.pick(SURNAMES)}`);
    const { regime, rights } = world.plugins.tenure.rights(p.kind, owner.id, cad);
    cad.regrant(p, rights, regime, 1538, `The friary is dissolved; the Crown grants the precinct to ${owner.name}`, 'sale');
    world.log.push({ year: 1538, text: `The friary is dissolved. Its precinct is granted to ${owner.name}, who makes a house of it.` });
  }
}

/** Parliamentary enclosure: the open fields and commons are allotted in closes, held freehold. */
function encloseTownship(world: World, year: number): void {
  if (!world.township) return;
  const all = ['access', 'withdrawal', 'management', 'exclusion', 'alienation', 'build', 'subdivide', 'inherit'] as const;
  const result = enclose(world, world.rng.fork('enclosure'), (holder) => {
    const rights: Partial<Record<Right, number>> = {};
    for (const r of all) rights[r] = holder;
    return { regime: 'private', rights };
  });
  world.enclosed = year;
  updateLandUse(world);
  world.log.push({
    year,
    text: `An Act of Parliament encloses the township: ${result.strips} strips, the meadows and the commons are allotted in ${result.closes} hedged closes to ${result.allottees} proprietors.`,
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
