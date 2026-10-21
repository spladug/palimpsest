// A lowland English river valley: a river falling north to south through a
// floodplain, rolling slopes either side, and old routes leaving the map.

import { createNoise2D } from 'simplex-noise';
import { dist, projectOnSegment, type Vec2 } from '../../sim/geom';
import { Raster } from '../../sim/raster';
import type { Rng } from '../../sim/rng';
import type { GeographyPlugin, InitialPlace, Terrain } from '../types';

const CELLS = 256;
const CELL_SIZE = 10;
const RIVER_WIDTH = 14;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function riverCentreline(rng: Rng, W: number, H: number): Vec2[] {
  const noise = createNoise2D(() => rng.next());
  const cx = W * rng.range(0.42, 0.58);
  const pts: Vec2[] = [];
  for (let y = -40; y <= H + 40; y += 20) {
    const x = cx + 380 * noise(y / 1100, 0.5) + 110 * noise(y / 320, 7.3);
    pts.push({ x, y });
  }
  return pts;
}

/**
 * Distance to the river, plus a smooth-minimum version of it. The exact distance
 * has creases where the nearest river point jumps (far from bends), which show
 * up as false ridges; the smooth one is used for shaping the valley.
 */
function distanceToPolyline(p: Vec2, pts: readonly Vec2[]): { d: number; soft: number } {
  const k = 60;
  let best = Infinity;
  const ds: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = projectOnSegment(p, pts[i], pts[i + 1]).dist;
    ds.push(d);
    if (d < best) best = d;
  }
  let sum = 0;
  for (const d of ds) sum += Math.exp(-(d - best) / k);
  return { d: best, soft: Math.max(best, best - k * Math.log(sum) + k * Math.log(3)) };
}

/** River surface level falls gently downstream (southward). */
const riverLevel = (y: number, H: number) => 42 - 10 * (y / H);

function generate(rng: Rng): { terrain: Terrain; places: InitialPlace[] } {
  const W = CELLS * CELL_SIZE;
  const H = CELLS * CELL_SIZE;
  const river = riverCentreline(rng.fork('river'), W, H);
  const hills = createNoise2D(() => rng.next());
  const plainNoise = createNoise2D(() => rng.next());

  const height = new Raster(CELLS, CELLS, CELL_SIZE);
  const water = new Raster(CELLS, CELLS, CELL_SIZE);
  const wetness = new Raster(CELLS, CELLS, CELL_SIZE);
  const crossable = new Raster(CELLS, CELLS, CELL_SIZE);

  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const p = height.cellCentre(i, j);
      const { d, soft } = distanceToPolyline(p, river);
      const level = riverLevel(p.y, H);
      // Floodplain half-width varies along the valley.
      const plain = 90 + 70 * plainNoise(p.x / 900, p.y / 900);
      const valley = 34 * smoothstep(plain, plain + 750, soft);
      const relief =
        (16 * hills(p.x / 700, p.y / 700) + 5 * hills(p.x / 180 + 11, p.y / 180 - 4)) *
        smoothstep(plain * 0.6, plain + 400, soft);
      let h = level + 1.2 + valley + relief + 0.4 * hills(p.x / 60, p.y / 60);
      if (d < Math.max(RIVER_WIDTH / 2, CELL_SIZE * 0.75)) {
        water.set(i, j, 1);
        h = level - 1;
      }
      height.set(i, j, h);
      const above = h - level;
      wetness.set(i, j, water.get(i, j) ? 1 : Math.max(0, Math.min(1, 1.15 - above / 2.5)));
    }
  }

  const fords = chooseFords(rng, river, wetness, H);
  for (const f of fords) {
    const r = 16;
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        if (water.get(i, j) && dist(height.cellCentre(i, j), f) < r) crossable.set(i, j, 1);
      }
    }
  }

  const terrain: Terrain = {
    height,
    water,
    wetness,
    crossable,
    rivers: [{ centreline: river, width: RIVER_WIDTH }],
    fords,
  };
  const places = [...chooseGateways(rng, terrain, river), ...chooseFarmsteads(rng, terrain)];
  return { terrain, places };
}

/** Fords where the banks are firm (little wet ground nearby), away from the map edges. */
function chooseFords(rng: Rng, river: Vec2[], wetness: Raster, H: number): Vec2[] {
  const candidates: { p: Vec2; score: number }[] = [];
  for (let k = 0; k < river.length - 1; k++) {
    const p = river[k];
    if (p.y < H * 0.2 || p.y > H * 0.8) continue;
    let wet = 0;
    let n = 0;
    for (let dx = -80; dx <= 80; dx += 10) {
      for (let dy = -30; dy <= 30; dy += 10) {
        const q = { x: p.x + dx, y: p.y + dy };
        if (q.x < 0 || q.y < 0 || q.x >= wetness.worldWidth || q.y >= wetness.worldHeight) continue;
        wet += wetness.sample(q);
        n++;
      }
    }
    const central = 1 - Math.abs(p.y - H / 2) / (H / 2);
    candidates.push({ p, score: (1 - wet / Math.max(1, n)) + 0.4 * central + 0.15 * rng.next() });
  }
  candidates.sort((a, b) => b.score - a.score);
  const fords = [candidates[0].p];
  const second = candidates.find((c) => dist(c.p, fords[0]) > 900);
  if (second && rng.chance(0.5)) fords.push(second.p);
  return fords;
}

/** Old routes leave the map on higher, drier ground: two west, two east, one up and down the valley. */
function chooseGateways(rng: Rng, t: Terrain, river: Vec2[]): InitialPlace[] {
  const W = t.height.worldWidth;
  const H = t.height.worldHeight;
  const edgePoint = (side: 'w' | 'e' | 'n' | 's', lo: number, hi: number): Vec2 => {
    let best: Vec2 = { x: 0, y: 0 };
    let bestScore = -Infinity;
    for (let k = 0; k < 40; k++) {
      const s = rng.range(lo, hi);
      const p =
        side === 'w' ? { x: 5, y: s * H } :
        side === 'e' ? { x: W - 5, y: s * H } :
        side === 'n' ? { x: s * W, y: 5 } :
        { x: s * W, y: H - 5 };
      if (t.water.sample(p) > 0.1) continue;
      const score = t.height.sample(p) - 30 * t.wetness.sample(p) + rng.range(0, 6);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  };
  // The valley road keeps to one bank, clear of the river.
  const bank = rng.chance(0.5) ? 1 : -1;
  const valleyX = (y: number) => {
    const { x } = river.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
    return Math.max(0.08, Math.min(0.92, (x + bank * 260) / W));
  };
  return [
    { kind: 'gateway', name: 'West road', pos: edgePoint('w', 0.15, 0.45), mass: 6 },
    { kind: 'gateway', name: 'Ridgeway', pos: edgePoint('w', 0.55, 0.9), mass: 5 },
    { kind: 'gateway', name: 'East road', pos: edgePoint('e', 0.3, 0.7), mass: 6 },
    { kind: 'gateway', name: 'North road', pos: edgePoint('n', valleyX(0) - 0.04, valleyX(0) + 0.04), mass: 4 },
    { kind: 'gateway', name: 'South road', pos: edgePoint('s', valleyX(H) - 0.04, valleyX(H) + 0.04), mass: 4 },
  ];
}

function farmsteadSuitability(t: Terrain, p: Vec2): number {
  const h = t.height;
  if (p.x < 20 || p.y < 20 || p.x > h.worldWidth - 20 || p.y > h.worldHeight - 20) return 0;
  if (t.water.sample(p) > 0) return 0;
  const wet = t.wetness.sample(p);
  if (wet > 0.25) return 0;
  const e = 15;
  const dx = (h.sample({ x: p.x + e, y: p.y }) - h.sample({ x: p.x - e, y: p.y })) / (2 * e);
  const dy = (h.sample({ x: p.x, y: p.y + e }) - h.sample({ x: p.x, y: p.y - e })) / (2 * e);
  const slope = Math.hypot(dx, dy);
  if (slope > 0.14) return 0;
  // Water within reach but above the flood: use wetness as a proxy for nearness to the river.
  let nearWater = 0;
  for (let a = 0; a < 8; a++) {
    const q = { x: p.x + 300 * Math.cos((a * Math.PI) / 4), y: p.y + 300 * Math.sin((a * Math.PI) / 4) };
    nearWater = Math.max(nearWater, t.wetness.sample(q));
  }
  // South-facing slopes (height falling toward +y) are warmer.
  const sunny = Math.max(0, Math.min(1, 0.5 + dy * 8));
  return (1 - slope / 0.14) * (0.4 + 0.6 * nearWater) * (0.6 + 0.4 * sunny) * (1 - wet);
}

function chooseFarmsteads(rng: Rng, t: Terrain): InitialPlace[] {
  const names = ['Aldwick', 'Brockhurst', 'Cherwell Farm', 'Dene', 'Edgecote', 'Fulbrook'];
  const out: InitialPlace[] = [];
  const W = t.height.worldWidth;
  const H = t.height.worldHeight;
  for (const name of names) {
    let best: Vec2 | null = null;
    let bestScore = 0;
    for (let k = 0; k < 120; k++) {
      const p = { x: rng.range(100, W - 100), y: rng.range(100, H - 100) };
      if (out.some((o) => dist(o.pos, p) < 380)) continue;
      const s = farmsteadSuitability(t, p) * rng.range(0.7, 1);
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    if (best) out.push({ kind: 'farmstead', name, pos: best, mass: 1 });
  }
  return out;
}

export const riverValley: GeographyPlugin = {
  name: 'English river valley',
  generate,
  farmsteadSuitability,
};
