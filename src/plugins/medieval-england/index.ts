// Medieval England, from c. 900: foot and pack-horse traffic, scattered
// farmsteads, a minster church founded near the crossing.

import { dist } from '../../sim/geom';
import { tobler } from '../../sim/pathfind';
import { addPlace, type World } from '../../sim/world';
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
};

const tenure: TenurePlugin = {
  name: 'Early medieval English',
  rights: ['access', 'withdrawal', 'management', 'exclusion', 'alienation', 'build', 'subdivide', 'inherit'],
  inheritance: 'impartible',
};

/** Gravity-model trips: real trips per year between two places. */
const GRAVITY = 60;
const RANGE = 1000;

const demand: DemandPlugin = {
  name: 'Dispersed settlement',
  trips(world: World): TripDemand[] {
    const out: TripDemand[] = [];
    const ps = world.places;
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const d = dist(ps[a].pos, ps[b].pos);
        const trips = (GRAVITY * ps[a].mass * ps[b].mass) / (1 + (d / RANGE) ** 2);
        if (trips >= 5) out.push({ from: ps[a], to: ps[b], tripsPerYear: trips });
      }
    }
    return out;
  },
  newFarmsteadRate(world: World): number {
    const farms = world.places.filter((p) => p.kind === 'farmstead').length;
    return Math.max(0, 0.12 * (1 - farms / 28));
  },
  events(world: World) {
    const year = 950 + world.rng.int(0, 30);
    return [
      {
        time: year,
        name: 'minster',
        fire(w: World) {
          const site = minsterSite(w);
          if (!site) return;
          addPlace(w, 'church', 'Minster', w.graph.nodes.get(site)!.pos, 5, site);
          w.log.push({ year, text: 'A minster church is built at the meeting of ways near the ford.' });
        },
      },
    ];
  },
};

/** The busiest junction on dry ground near the main ford. */
function minsterSite(world: World): number | null {
  const ford = world.terrain.fords[0];
  const g = world.graph;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const n of g.nodes.values()) {
    if (n.placeId !== null || g.degree(n.id) < 3) continue;
    const d = dist(n.pos, ford);
    if (d > 700 || world.terrain.wetness.sample(n.pos) > 0.3) continue;
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
