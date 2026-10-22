// The cadastre: every parcel of land, who holds which rights over it, and the
// history of how parcels were created, split, merged and retired.

import type { Vec2 } from './geom';
import { bounds, pointInShape, shapeArea, type Bounds, type Shape } from './polygon';
import type { Right } from '../plugins/types';

export type ParcelKind =
  | 'close'
  | 'strip'
  | 'meadow'
  | 'common'
  /** A village house plot (toft) with its garden behind (croft). */
  | 'toft'
  /** A town plot held by burgage tenure. */
  | 'burgage'
  | 'market'
  | 'churchyard'
  /** A freehold building plot, laid out after the medieval borough. */
  | 'plot'
  /** The grounds of an institution: a friary, school, workhouse or cemetery. */
  | 'precinct'
  /** Ground taken by a land-hungry trade or industry: tenter ground, tannery, brickworks. */
  | 'works';

/** Plots that stand in a built-up place and need a street in front of them. */
export const TOWN_PLOT_KINDS: ReadonlySet<ParcelKind> = new Set(['toft', 'burgage', 'plot']);
/** Parcels no way may run through: fields, commons and market places may have ways across them. */
export const SOLID_KINDS: ReadonlySet<ParcelKind> = new Set(['toft', 'burgage', 'plot', 'churchyard', 'precinct', 'works']);

/** The grounds of an institution or a works, which ways lead into from a gate. */
export const GROUNDS_KINDS: ReadonlySet<ParcelKind> = new Set(['precinct', 'works']);

/**
 * How a plot came to be laid out (a plan unit, after Conzen): with the village,
 * as part of the planted borough, along a way out of town, or as a builder's
 * estate on a whole field; or as the grounds of an institution or a works.
 */
export type PlanUnitKind = 'village' | 'borough' | 'ribbon' | 'estate' | 'grounds';

export interface PlanUnit {
  kind: PlanUnitKind;
  year: number;
  /** The street the unit was laid out along. */
  street?: string;
}

/** How a parcel is held overall; the detail is in its rights. */
export type Regime = 'private' | 'use-right' | 'common';

export type HolderKind = 'household' | 'community' | 'lord' | 'church' | 'borough' | 'company' | 'gentry';

export interface Holder {
  id: number;
  kind: HolderKind;
  name: string;
  /** Where a household lives (a place id). */
  placeId: number | null;
  /** Family name, carried by heirs. */
  surname?: string;
}

/**
 * Conzen's burgage cycle: a plot is laid out with a house at the front
 * (institutive), its back land fills with buildings (repletive) until it can
 * take no more (climax), then buildings are cleared (recessive) before the
 * plot is redeveloped.
 */
export type PlotPhase = 'institutive' | 'repletive' | 'climax' | 'recessive';

/** The street edge of a plot: its two front corners, and the direction into the plot. */
export interface Frontage {
  a: Vec2;
  b: Vec2;
  inward: Vec2;
  street: string;
}

export interface Parcel {
  id: number;
  kind: ParcelKind;
  frontage?: Frontage;
  /** Year the current holder took it up, for plots. */
  takenUp?: number;
  /** Where a town plot is in the burgage cycle. */
  phase?: PlotPhase;
  /** Land value, 0..1, from accessibility over the street graph. */
  value?: number;
  /** The land use a precinct or works ground was taken for. */
  use?: string;
  /** How and when the plot was laid out; kept through splits and merges. */
  unit?: PlanUnit;
  shape: Shape;
  bounds: Bounds;
  area: number;
  regime: Regime;
  /** Right → the holder who has it. A right nobody holds is absent. */
  rights: Partial<Record<Right, number>>;
  furlongId: number | null;
  created: number;
  retired: number | null;
}

export interface Building {
  id: number;
  parcelId: number | null;
  /** A land-use id from the technology plugin's catalogue. */
  use: string;
  footprint: Shape;
  /** Ridge line, for drawing the roof. */
  ridge: [Vec2, Vec2];
  storeys: number;
  built: number;
  /** Built on the back land of a plot rather than its street front. */
  back?: boolean;
}

export interface Furlong {
  id: number;
  name: string;
  shape: Shape;
  /** Direction strips run, radians. */
  orientation: number;
  /** Which great field the furlong lies in (for crop rotation). */
  field: number;
}

export interface GreatField {
  name: string;
}

export interface ParcelEvent {
  year: number;
  kind: 'create' | 'retire' | 'split' | 'merge' | 'reallocate' | 'inherit' | 'sale';
  parents: number[];
  children: number[];
  note: string;
}

export class Cadastre {
  readonly parcels = new Map<number, Parcel>();
  readonly holders = new Map<number, Holder>();
  readonly furlongs = new Map<number, Furlong>();
  readonly buildings = new Map<number, Building>();
  /** Buildings by the parcel they stand on. */
  private byParcel = new Map<number, Set<number>>();
  greatFields: GreatField[] = [];
  readonly history: ParcelEvent[] = [];
  /** Boundaries of retired parcels, which later divisions may follow. */
  readonly ghosts: Shape[] = [];
  private nextId = 1;
  /** Bumped on every change, so views can cache what they draw. */
  version = 0;
  /** The holder standing for the whole community of the township, once there is one. */
  community: number | null = null;
  lord: number | null = null;

  addHolder(kind: HolderKind, name: string, placeId: number | null = null): Holder {
    const h = { id: this.nextId++, kind, name, placeId };
    this.holders.set(h.id, h);
    return h;
  }

  addParcel(
    kind: ParcelKind,
    shape: Shape,
    regime: Regime,
    rights: Partial<Record<Right, number>>,
    year: number,
    furlongId: number | null = null,
  ): Parcel {
    const p: Parcel = {
      id: this.nextId++,
      kind,
      shape,
      bounds: bounds(shape),
      area: shapeArea(shape),
      regime,
      rights,
      furlongId,
      created: year,
      retired: null,
    };
    this.parcels.set(p.id, p);
    this.version++;
    return p;
  }

  addFurlong(name: string, shape: Shape, orientation: number, field: number): Furlong {
    const f = { id: this.nextId++, name, shape, orientation, field };
    this.furlongs.set(f.id, f);
    this.version++;
    return f;
  }

  addBuilding(b: Omit<Building, 'id'>): Building {
    const building = { ...b, id: this.nextId++ };
    this.buildings.set(building.id, building);
    if (building.parcelId !== null) {
      let set = this.byParcel.get(building.parcelId);
      if (!set) this.byParcel.set(building.parcelId, (set = new Set()));
      set.add(building.id);
    }
    this.version++;
    return building;
  }

  removeBuilding(id: number): void {
    const b = this.buildings.get(id);
    if (!b) return;
    this.buildings.delete(id);
    if (b.parcelId !== null) this.byParcel.get(b.parcelId)?.delete(id);
    this.version++;
  }

  /** The buildings standing on a parcel. */
  buildingsOn(parcelId: number): Building[] {
    const ids = this.byParcel.get(parcelId);
    return ids ? [...ids].map((id) => this.buildings.get(id)!) : [];
  }

  /** Move a building onto another parcel (when plots are split or merged). */
  moveBuilding(b: Building, parcelId: number): void {
    if (b.parcelId !== null) this.byParcel.get(b.parcelId)?.delete(b.id);
    b.parcelId = parcelId;
    let set = this.byParcel.get(parcelId);
    if (!set) this.byParcel.set(parcelId, (set = new Set()));
    set.add(b.id);
  }

  /** Give a parcel a new rights bundle (it changes hands). */
  regrant(
    parcel: Parcel,
    rights: Partial<Record<Right, number>>,
    regime: Regime,
    year: number,
    note: string,
    kind: 'reallocate' | 'inherit' | 'sale' = 'reallocate',
  ): void {
    parcel.rights = rights;
    parcel.regime = regime;
    parcel.takenUp = year;
    this.version++;
    this.history.push({ year, kind, parents: [parcel.id], children: [parcel.id], note });
  }

  /** The plot falls vacant: rights go back to whoever grants them, here the given holder. */
  vacate(parcel: Parcel, rights: Partial<Record<Right, number>>, regime: Regime, year: number, note: string): void {
    parcel.rights = rights;
    parcel.regime = regime;
    parcel.takenUp = undefined;
    this.version++;
    this.history.push({ year, kind: 'reallocate', parents: [parcel.id], children: [parcel.id], note });
  }

  /**
   * Replace a parcel by several (a split) or several by one (a merge). The old
   * parcels are retired with their boundaries kept as ghosts; their buildings
   * move to whichever new parcel holds their centre.
   */
  replace(
    oldIds: number[],
    parts: { shape: Shape; frontage?: Frontage }[],
    year: number,
    kind: 'split' | 'merge',
    note: string,
  ): Parcel[] {
    const first = this.parcels.get(oldIds[0])!;
    const children = parts.map((part) => {
      const p = this.addParcel(first.kind, part.shape, first.regime, { ...first.rights }, year, first.furlongId);
      p.frontage = part.frontage;
      p.takenUp = first.takenUp;
      p.phase = first.phase;
      p.value = first.value;
      p.unit = first.unit;
      return p;
    });
    for (const id of oldIds) {
      for (const b of this.buildingsOn(id)) {
        const c = centreOf(b.footprint);
        const home = children.find((p) => pointInShape(c, p.shape)) ?? children[0];
        this.moveBuilding(b, home.id);
      }
      const p = this.parcels.get(id);
      if (!p) continue;
      p.retired = year;
      this.ghosts.push(p.shape);
      this.parcels.delete(id);
    }
    this.version++;
    this.history.push({ year, kind, parents: oldIds, children: children.map((c) => c.id), note });
    return children;
  }

  /** Retire parcels, keeping their boundaries as ghosts. */
  retire(ids: number[], year: number, note: string, children: number[] = []): void {
    for (const id of ids) {
      const p = this.parcels.get(id);
      if (!p || p.retired !== null) continue;
      p.retired = year;
      this.ghosts.push(p.shape);
      this.parcels.delete(id);
      for (const b of this.buildingsOn(id)) this.removeBuilding(b.id);
    }
    this.version++;
    this.history.push({ year, kind: children.length ? 'reallocate' : 'retire', parents: ids, children, note });
  }

  record(event: ParcelEvent): void {
    this.history.push(event);
  }

  parcelAt(p: Vec2): Parcel | null {
    for (const parcel of this.parcels.values()) {
      const b = parcel.bounds;
      if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
      if (pointInShape(p, parcel.shape)) return parcel;
    }
    return null;
  }

  holderName(id: number | undefined): string {
    if (id === undefined) return 'nobody';
    return this.holders.get(id)?.name ?? 'unknown';
  }
}

function centreOf(shape: Shape): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of shape[0]) {
    x += p.x;
    y += p.y;
  }
  return { x: x / shape[0].length, y: y / shape[0].length };
}

/** What is growing in a great field this year, in a three-course rotation. */
export function cropIn(field: number, year: number): 'winter corn' | 'spring corn' | 'fallow' {
  return (['winter corn', 'spring corn', 'fallow'] as const)[(Math.floor(year) + field) % 3];
}
