// The plug-in seams. The simulation core knows nothing about any particular
// place, era or legal system; everything specific comes through these.

import type { Vec2 } from '../sim/geom';
import type { Raster } from '../sim/raster';
import type { Rng } from '../sim/rng';
import type { SimEvent } from '../sim/clock';
import type { World, Place, PlaceKind } from '../sim/world';
import type { EdgeClass } from '../sim/graph';
import type { Cadastre, HolderKind, Parcel, ParcelKind, Regime } from '../sim/cadastre';
import type { BuildingSpec } from '../sim/plots';

export interface Terrain {
  /** Elevation in metres. */
  height: Raster;
  /** 1 where there is open water, 0 elsewhere. */
  water: Raster;
  /** 0..1, how waterlogged the ground is. */
  wetness: Raster;
  /** 1 where open water can be crossed on foot or by cart. */
  crossable: Raster;
  rivers: { centreline: Vec2[]; width: number }[];
  fords: Vec2[];
}

export interface InitialPlace {
  kind: PlaceKind;
  pos: Vec2;
  name: string;
  /** Relative importance as a trip origin/destination. */
  mass: number;
}

export interface GeographyPlugin {
  name: string;
  generate(rng: Rng): { terrain: Terrain; places: InitialPlace[] };
  /** Suitability of a site for a new farmstead, 0..1 (before network effects). */
  farmsteadSuitability(terrain: Terrain, p: Vec2): number;
}

export interface MovementRules {
  /** Walking speed in m/s for a signed slope (rise over run, uphill positive). */
  speed(slope: number): number;
  /** Speed multiplier on fully waterlogged ground (0..1). */
  wetGroundFactor: number;
  /** Speed multiplier when wading a ford. */
  fordFactor: number;
  /** Speed multiplier on fully worn ground. Wear attracts later walkers. */
  wornGroundFactor: number;
  /** Wear at which the worn-ground benefit is half reached, in trips/year/cell. */
  wearHalf: number;
  /** Fraction of wear lost each year. */
  wearDecay: number;
  /** Speed multiplier for travelling along each class of way. */
  classFactor: Record<EdgeClass, number>;
}

export interface HierarchyRules {
  /** Usage (trips/year) above which an edge of this class is upgraded. */
  upgradeAt: Record<EdgeClass, number>;
  /** Usage below which an edge of this class is downgraded (or abandoned, for paths). */
  downgradeAt: Record<EdgeClass, number>;
  /** Years a condition must hold before the class changes. */
  patience: number;
}

/** How land is laid out into fields. Lengths in metres, areas in m². */
export interface FieldRules {
  /** Typical reach of a farmstead's closes. */
  closeRadius: number;
  /** Spacing of close boundaries. */
  closeSpacing: number;
  /** Typical spacing between furlong centres. */
  furlongSpacing: number;
  minFurlongArea: number;
  stripWidth: { mean: number; sd: number; min: number; max: number };
  minStripArea: number;
  /** Reverse-S amplitude as a fraction of strip length, and its cap. */
  aratralCurve: number;
  aratralMax: number;
  /** Mean slope above which strips are turned to run downhill. */
  drainageSlope: number;
  /** Mean wetness above which land is meadow rather than arable. */
  meadowWetness: number;
  /** Mean slope above which land is left as common pasture. */
  wasteSlope: number;
  /** Chance a furlong holds a block of demesne. */
  demesneShare: number;
  /** Every nth strip in the rotation is glebe (the church's). */
  glebeEvery: number;
  /** Ground left open around the village centre for houses and yards. */
  villageCoreRadius: number;
  /** Width of walkable headland round each furlong. */
  headland: number;
  /** Walking-speed multipliers across standing crops, closes and meadow. */
  cropFactor: number;
  closeFactor: number;
  meadowFactor: number;
  plotFactor: number;
}

/** How village and town plots are laid out. Widths are in perches (≈5.03 m) with weights. */
export interface PlotRules {
  toftWidths: Record<number, number>;
  toftDepth: number;
  /** How far the village edge moves out each time it runs out of tofts. */
  villageGrowth: number;
  burgageWidths: Record<number, number>;
  burgageDepth: number;
  /** Length of planted town street, and of the market place at its start. */
  boroughLength: number;
  marketLength: number;
  marketWidth: number;
  /** How new town plots are laid out in a given year, when the town outgrows the plots it has. */
  townPlots(year: number): TownPlotRules;
  /** Narrowest frontage a plot may be split down to, in metres. */
  minFrontage: number;
  /** Built coverage at which a plot's back land is full (the burgage cycle's climax). */
  climaxCoverage: number;
  /**
   * Back-land buildings by year: `work` (workshops, stables, warehouses) as a
   * plot fills; `housing` (courts of cottages) when the town is short of houses.
   */
  backland(year: number): { work: string; housing: string | null };
  /** The front building put up when a plot is rebuilt in a given year. */
  rebuild(year: number, onMarket: boolean): string;
}

export interface TownPlotRules {
  kind: ParcelKind;
  /** Frontage widths in perches, with weights. */
  widths: Record<number, number>;
  depth: number;
  /** The house put up on each plot. */
  use: string;
  /** 'speculative': a builder puts up every house at once and lets them; otherwise each taker builds. */
  building: 'on take-up' | 'speculative';
  /** Whole fields are laid out with new streets (Ward 1962), rather than plots along existing ways. */
  wholeFields: boolean;
}

/** What a land use needs of its site. */
export interface SiteNeeds {
  /** Within this distance of the river (a tannery, a gasworks, a wharf). */
  water?: number;
  /** On the market place. */
  market?: boolean;
  /** Steepest mean slope it can be built on. */
  maxSlope?: number;
}

/**
 * A land use from the catalogue: a kind of building, what it needs of its
 * site, and how much it will bid for land of a given accessibility.
 */
export interface UseType {
  name: string;
  building: BuildingSpec;
  storeys: number;
  /** Households living in it. */
  dwellings?: number;
  /**
   * 'plot': takes over a town plot's front building (an inn, a chapel).
   * 'land': takes a parcel of its own of `area` m² (a friary, a brickworks).
   */
  site?: 'plot' | 'land';
  area?: number;
  /** The kind of parcel a 'land' use takes, and who holds it. */
  parcel?: ParcelKind;
  holder?: HolderKind;
  needs?: SiteNeeds;
  /** Bid for a site of a given accessibility, 0..1 (bid-rent). */
  bid?: (access: number) => number;
  /** Distance within which it is a nuisance to houses. */
  nuisance?: number;
  /** How hard it is to move once established, 0..1. */
  relocation?: number;
  /** Trips per year it draws, as a destination. */
  trips?: number;
  /** Who holds a 'land' use's ground, by name. */
  holderName?: string;
  /** Extra buildings on a 'land' site, beside the main one (relative positions in metres). */
  extra?: { use: string; at: [number, number]; size: [number, number] }[];
}

export interface TechnologyPlugin {
  name: string;
  movement: MovementRules;
  hierarchy: HierarchyRules;
  fields: FieldRules;
  plots: PlotRules;
  uses: Record<string, UseType>;
}

/** A right over a parcel (Schlager & Ostrom 1992, plus building rights). */
export type Right =
  | 'access'
  | 'withdrawal'
  | 'management'
  | 'exclusion'
  | 'alienation'
  | 'build'
  | 'subdivide'
  | 'inherit';

export interface TenurePlugin {
  name: string;
  allRights: readonly Right[];
  /** Partible inheritance splits holdings among heirs; impartible passes them whole. */
  inheritance: 'partible' | 'impartible';
  /** The regime and rights bundle for a new parcel of a kind, occupied by a holder. */
  rights(kind: ParcelKind, occupant: number, cadastre: Cadastre): { regime: Regime; rights: Partial<Record<Right, number>> };
  /**
   * How readily a parcel's land can be had for building, 0..1: whoever holds
   * its alienation right must be willing to sell. Institutions rarely sell.
   */
  willingToSell(parcel: Parcel, cadastre: Cadastre, year: number): number;
}

export interface TripDemand {
  from: Place;
  to: Place;
  /** Real trips per year this pair stands for. */
  tripsPerYear: number;
}

export interface DemandPlugin {
  name: string;
  /** Origin–destination demand for the current year. */
  trips(world: World): TripDemand[];
  /** Expected number of new farmsteads founded this year. */
  newFarmsteadRate(world: World): number;
  /** Expected number of new households in villages this year. */
  newHouseholdRate(world: World): number;
  /** A name for a newcomer to the town. */
  burgessName(world: World): string;
  /** A given name for an heir. */
  heirName(world: World): string;
  /**
   * Households the town can support this year: its trade, its hinterland and
   * later its industry. The town grows toward this and shrinks when it falls.
   */
  townCapacity(world: World): number;
  /** How many of each land use the settlement needs now. */
  usesNeeded(world: World, households: number): Record<string, number>;
  /** A name for a builder who buys a field to lay out. */
  builderName?(world: World): string;
  /** A name for a new street; `toward` is the name of where an old way leads, if any. */
  streetName(world: World, toward: string | null, wholeField: boolean): string;
  /** Scenario events to schedule at the start. */
  events(world: World): SimEvent<World>[];
}

export interface Plugins {
  geography: GeographyPlugin;
  technology: TechnologyPlugin;
  tenure: TenurePlugin;
  demand: DemandPlugin;
}
