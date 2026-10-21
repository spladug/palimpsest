// The plug-in seams. The simulation core knows nothing about any particular
// place, era or legal system; everything specific comes through these.

import type { Vec2 } from '../sim/geom';
import type { Raster } from '../sim/raster';
import type { Rng } from '../sim/rng';
import type { SimEvent } from '../sim/clock';
import type { World, Place, PlaceKind } from '../sim/world';
import type { EdgeClass } from '../sim/graph';

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

export interface TechnologyPlugin {
  name: string;
  movement: MovementRules;
  hierarchy: HierarchyRules;
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
  rights: readonly Right[];
  /** Partible inheritance splits holdings among heirs; impartible passes them whole. */
  inheritance: 'partible' | 'impartible';
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
  /** Scenario events to schedule at the start. */
  events(world: World): SimEvent<World>[];
}

export interface Plugins {
  geography: GeographyPlugin;
  technology: TechnologyPlugin;
  tenure: TenurePlugin;
  demand: DemandPlugin;
}
