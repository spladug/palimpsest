// Layer 3: does the town's history hold up? Population changes, the dates of
// events, and street names, checked against the targets.

import type { World } from '../../src/sim/world';
import { EVENTS, NAMES_FROM, POPULATION, type Range } from './targets';

export interface HistoryCheck {
  name: string;
  /** null when the run gives nothing to measure (an event that never happened). */
  value: number | null;
  range: Range;
  pass: boolean;
  note?: string;
}

/** Town households in a year, from the town's five-yearly record. */
function householdsAt(world: World, year: number): number | null {
  const h = world.town.history;
  let best: { year: number; households: number } | null = null;
  for (const x of h) if (!best || Math.abs(x.year - year) < Math.abs(best.year - year)) best = x;
  return best && Math.abs(best.year - year) <= 5 ? best.households : null;
}

function check(name: string, value: number | null, range: Range, note?: string): HistoryCheck {
  return { name, value, range, pass: value !== null && value >= range.min && value <= range.max, note };
}

const ratio = (a: number | null, b: number | null) => (a !== null && b ? a / b : null);

export function historyChecks(world: World): HistoryCheck[] {
  const out: HistoryCheck[] = [];
  const at = (y: number) => householdsAt(world, y);
  const P = POPULATION;

  out.push(check('households about 1300', at(1300), P.sizeAt1300));
  const peak = Math.max(...[1300, 1320, 1340, 1345].map((y) => at(y) ?? 0));
  out.push(check('trough (1450) against peak', ratio(at(1450), peak), P.troughVsPeak));
  out.push(check('growth 1450–1600', ratio(at(1600), at(1450)), P.recovery1450to1600));
  out.push(check('growth 1600–1750', ratio(at(1750), at(1600)), P.growth1600to1750));
  out.push(check('growth 1800–1900', ratio(at(1900), at(1800)), P.growth1801to1901));

  for (const [name, target] of Object.entries(EVENTS)) {
    const hits = world.log.filter((e) => target.pattern.test(e.text));
    if (!hits.length) {
      if (target.required) out.push(check(name, null, target, 'never happened'));
      continue;
    }
    // Every occurrence must fall in the range; report the one furthest out.
    const worst = hits.reduce((w, e) => (outside(e.year, target) > outside(w.year, target) ? e : w));
    out.push(check(name, worst.year, target, hits.length > 1 ? `${hits.length} times` : undefined));
  }

  // Street names given before they could have been.
  const railway = world.log.some((e) => /railway (comes|opens|station)/i.test(e.text));
  const named = world.log.flatMap((e) => {
    const m = /lays out (.+?) along|spreads along (.+?):|opens on (.+?)\.|, on (.+?)\./.exec(e.text);
    const street = m?.slice(1).find((x) => x);
    return street ? [{ year: e.year, street }] : [];
  });
  const firstNamed = new Map<string, number>();
  for (const n of named) if (!firstNamed.has(n.street)) firstNamed.set(n.street, n.year);
  for (const [street, year] of firstNamed) {
    for (const [word, from] of Object.entries(NAMES_FROM)) {
      if (!street.includes(word)) continue;
      const tooEarly = year < from.min;
      const noRailway = word === 'Railway' && !railway;
      if (tooEarly || noRailway) out.push({ name: `street name: ${street}`, value: year, range: from, pass: false, note: noRailway ? 'there is no railway' : 'too early' });
    }
  }
  return out;
}

function outside(v: number, r: Range): number {
  return v < r.min ? r.min - v : v > r.max ? v - r.max : 0;
}
