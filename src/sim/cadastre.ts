// The cadastre: every parcel of land, who holds which rights over it, and the
// history of how parcels were created, split, merged and retired.

import type { Vec2 } from './geom';
import { bounds, pointInShape, shapeArea, type Bounds, type Shape } from './polygon';
import type { Right } from '../plugins/types';

export type ParcelKind = 'close' | 'strip' | 'meadow' | 'common';

/** How a parcel is held overall; the detail is in its rights. */
export type Regime = 'private' | 'use-right' | 'common';

export type HolderKind = 'household' | 'community' | 'lord' | 'church';

export interface Holder {
  id: number;
  kind: HolderKind;
  name: string;
  /** Where a household lives (a place id). */
  placeId: number | null;
}

export interface Parcel {
  id: number;
  kind: ParcelKind;
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
  kind: 'create' | 'retire' | 'split' | 'merge' | 'reallocate';
  parents: number[];
  children: number[];
  note: string;
}

export class Cadastre {
  readonly parcels = new Map<number, Parcel>();
  readonly holders = new Map<number, Holder>();
  readonly furlongs = new Map<number, Furlong>();
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

  /** Retire parcels, keeping their boundaries as ghosts. */
  retire(ids: number[], year: number, note: string, children: number[] = []): void {
    for (const id of ids) {
      const p = this.parcels.get(id);
      if (!p || p.retired !== null) continue;
      p.retired = year;
      this.ghosts.push(p.shape);
      this.parcels.delete(id);
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

/** What is growing in a great field this year, in a three-course rotation. */
export function cropIn(field: number, year: number): 'winter corn' | 'spring corn' | 'fallow' {
  return (['winter corn', 'spring corn', 'fallow'] as const)[(Math.floor(year) + field) % 3];
}
