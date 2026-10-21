// Enclosure: the open fields, meadows and commons are divided into hedged
// closes held in severalty. A regime-change event: the community's rights over
// the fields end, and each allottee holds the new close outright.
//
// Allotments are made furlong by furlong. Neighbouring strips are pooled into
// closes, so the new hedges run along the old strip lines and furlong edges,
// and the closes keep the furlongs' grain.

import type { Vec2 } from './geom';
import { ringCentroid, shapeArea, union, type Shape } from './polygon';
import type { Parcel, Regime } from './cadastre';
import { cutStrips } from './fields';
import type { Right } from '../plugins/types';
import type { Rng } from './rng';
import type { World } from './world';

export interface EnclosureResult {
  closes: number;
  strips: number;
  allottees: number;
}

/**
 * Enclose the township. `allot` gives the rights bundle for a close allotted
 * to a holder (the tenure plugin's post-enclosure rights).
 */
export function enclose(
  world: World,
  rng: Rng,
  allot: (holder: number) => { regime: Regime; rights: Partial<Record<Right, number>> },
): EnclosureResult {
  const cad = world.cadastre;
  const year = Math.round(world.clock.now);
  const retired: number[] = [];
  const created: number[] = [];
  const allottees = new Set<number>();
  let strips = 0;

  const byFurlong = new Map<number, Parcel[]>();
  for (const p of cad.parcels.values()) {
    if (p.kind !== 'strip' || p.furlongId === null) continue;
    let list = byFurlong.get(p.furlongId);
    if (!list) byFurlong.set(p.furlongId, (list = []));
    list.push(p);
  }

  for (const [fid, list] of byFurlong) {
    const f = cad.furlongs.get(fid);
    if (!f) continue;
    // Order the strips across the furlong, then pool runs of them into closes.
    const across = { x: -Math.sin(f.orientation), y: Math.cos(f.orientation) };
    const pos = (p: Parcel) => {
      const c = ringCentroid(p.shape[0]);
      return c.x * across.x + c.y * across.y;
    };
    list.sort((a, b) => pos(a) - pos(b));
    let group: Parcel[] = [];
    let groupArea = 0;
    let target = rng.range(9000, 26000);
    const flush = () => {
      if (!group.length) return;
      // The close goes to whoever held most of the land in it.
      const held = new Map<number, number>();
      for (const s of group) {
        const h = s.rights.withdrawal;
        if (h !== undefined) held.set(h, (held.get(h) ?? 0) + s.area);
      }
      let holder = cad.lord!;
      let most = 0;
      for (const [h, a] of held) if (a > most) [holder, most] = [h, a];
      // Keep any holes: houses that took strips from the middle of a furlong stay out of the close.
      for (const part of union(...group.map((s) => s.shape))) {
        if (shapeArea(part) < 300) continue;
        const { regime, rights } = allot(holder);
        created.push(cad.addParcel('close', part, regime, rights, year).id);
        allottees.add(holder);
      }
      for (const s of group) retired.push(s.id);
      strips += group.length;
      group = [];
      groupArea = 0;
      target = rng.range(9000, 26000);
    };
    for (const s of list) {
      group.push(s);
      groupArea += s.area;
      if (groupArea >= target) flush();
    }
    // A small remainder joins the last close rather than standing alone.
    if (group.length && groupArea < 3000 && created.length) {
      const last = cad.parcels.get(created[created.length - 1])!;
      const merged = union(last.shape, ...group.map((s) => s.shape));
      if (merged.length === 1) {
        cad.parcels.delete(last.id);
        created.pop();
        const holder = last.rights.withdrawal ?? cad.lord!;
        const { regime, rights } = allot(holder);
        created.push(cad.addParcel('close', merged[0], regime, rights, year).id);
        for (const s of group) retired.push(s.id);
        strips += group.length;
        group = [];
      }
    }
    flush();
  }

  // Commons and meadows are divided too, in broad straight-sided allotments.
  const households = [...allottees].filter((h) => cad.holders.get(h)?.kind === 'household');
  const rules = world.plugins.technology.fields;
  const broad = { ...rules, stripWidth: { mean: 110, sd: 25, min: 60, max: 170 }, aratralCurve: 0, aratralMax: 0, minStripArea: 1500 };
  for (const p of [...cad.parcels.values()]) {
    if (p.kind !== 'common' && p.kind !== 'meadow') continue;
    const theta = longestSideAngle(p.shape);
    for (const part of cutStrips(p.shape, theta + Math.PI / 2, rng, broad)) {
      const holder = households.length && rng.chance(0.6) ? rng.pick(households) : cad.lord!;
      const { regime, rights } = allot(holder);
      created.push(cad.addParcel('close', part, regime, rights, year).id);
    }
    retired.push(p.id);
  }

  // The furlongs are gone as units of husbandry; their bounds live on as ghosts.
  for (const f of cad.furlongs.values()) cad.ghosts.push(f.shape);
  cad.furlongs.clear();
  cad.retire(retired, year, 'Enclosure: the open fields and commons are allotted in closes', created);
  return { closes: created.length, strips, allottees: allottees.size };
}

function longestSideAngle(shape: Shape): number {
  const ring = shape[0];
  let best = 0;
  let angle = 0;
  for (let i = 0; i < ring.length; i++) {
    const a: Vec2 = ring[i];
    const b: Vec2 = ring[(i + 1) % ring.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > best) {
      best = l;
      angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return angle;
}
