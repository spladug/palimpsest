// The plug-in seams. The simulation core knows nothing about any particular
// place, era or legal system; everything specific comes through these.

import type { Vec2 } from '../sim/geom';
import type { Raster } from '../sim/raster';
import type { Rng } from '../sim/rng';
import type { SimEvent } from '../sim/clock';
import type { World, Place, PlaceKind } from '../sim/world';
import type { EdgeClass } from '../sim/graph';
import type { Cadastre, ParcelKind, Regime } from '../sim/cadastre';
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
}

/** A kind of building and what it needs (the start of the land-use catalogue). */
export interface UseType {
  name: string;
  building: BuildingSpec;
  storeys: number;
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
  /** Expected number of burgesses taking up town plots this year. */
  newBurgessRate(world: World): number;
  /** A name for a newcomer to the town. */
  burgessName(world: World): string;
  /** Scenario events to schedule at the start. */
  events(world: World): SimEvent<World>[];
}

export interface Plugins {
  geography: GeographyPlugin;
  technology: TechnologyPlugin;
  tenure: TenurePlugin;
  demand: DemandPlugin;
}
