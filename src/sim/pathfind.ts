// Least-time routes over a terrain raster: A* on a 16-neighbour grid with an
// anisotropic slope cost (uphill and downhill differ) and per-cell speed factors.

import type { Vec2 } from './geom';
import type { Raster } from './raster';

export interface CostField {
  height: Raster;
  /** Multiplier on walking speed per cell (ground wear, ways, wet ground). */
  speedFactor: Raster;
  water: Raster;
  crossable: Raster;
  /** Extra multiplier when moving through crossable water. */
  fordFactor: number;
  /** Walking speed in m/s for a signed slope. */
  speed(slope: number): number;
  /** The largest value speedFactor can take (keeps the A* heuristic admissible). */
  maxFactor: number;
}

/**
 * Heuristic inflation. Above 1 the search is much faster and routes may be up
 * to this factor slower than optimal — fine for people choosing a way on foot.
 */
const HEURISTIC_WEIGHT = 1.5;

/** Speed lookup by slope, so the inner loop avoids exp(). */
class SpeedTable {
  private static readonly RANGE = 1.5;
  private static readonly STEPS = 3001;
  private table = new Float64Array(SpeedTable.STEPS);

  constructor(readonly fn: (slope: number) => number) {
    for (let i = 0; i < SpeedTable.STEPS; i++) {
      this.table[i] = fn(-SpeedTable.RANGE + (2 * SpeedTable.RANGE * i) / (SpeedTable.STEPS - 1));
    }
  }

  get(slope: number): number {
    const t = (slope + SpeedTable.RANGE) / (2 * SpeedTable.RANGE);
    const i = Math.round(Math.max(0, Math.min(1, t)) * (SpeedTable.STEPS - 1));
    return this.table[i];
  }
}

const OFFSETS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
];

class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  size = 0;

  constructor(capacity: number) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }

  push(id: number, key: number): void {
    if (this.size === this.ids.length) this.grow();
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.ids[i] = this.ids[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastKey) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = lastId;
    this.keys[i] = lastKey;
    return top;
  }

  clear(): void {
    this.size = 0;
  }

  private grow(): void {
    const ids = new Int32Array(this.ids.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    ids.set(this.ids);
    keys.set(this.keys);
    this.ids = ids;
    this.keys = keys;
  }
}

export class Pathfinder {
  private g: Float64Array;
  private from: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap: MinHeap;
  private speeds: SpeedTable | null = null;

  constructor(private readonly width: number, private readonly height: number) {
    const n = width * height;
    this.g = new Float64Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new MinHeap(1024);
  }

  private blocked(field: CostField, i: number, j: number): boolean {
    const k = j * this.width + i;
    return field.water.data[k] > 0 && field.crossable.data[k] === 0;
  }

  /** Route between two world points; null if unreachable. Returns points from `a` to `b`. */
  route(field: CostField, a: Vec2, b: Vec2): { points: Vec2[]; seconds: number } | null {
    const W = this.width;
    const H = this.height;
    const cs = field.height.cellSize;
    const [si, sj] = field.height.cellAt(a);
    const [ti, tj] = field.height.cellAt(b);
    const start = sj * W + si;
    const goal = tj * W + ti;
    const hd = field.height.data;
    const fd = field.speedFactor.data;
    const wd = field.water.data;
    const cd = field.crossable.data;
    const vmax = (field.speed(-0.05) * field.maxFactor) / HEURISTIC_WEIGHT;
    if (!this.speeds || this.speeds.fn !== field.speed) this.speeds = new SpeedTable(field.speed);
    const speeds = this.speeds;

    const gen = ++this.gen;
    const heap = this.heap;
    heap.clear();
    this.g[start] = 0;
    this.stamp[start] = gen;
    this.from[start] = -1;
    heap.push(start, Math.hypot(ti - si, tj - sj) * cs / vmax);

    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goal) break;
      const ci = cur % W;
      const cj = (cur - ci) / W;
      const gc = this.g[cur];
      for (const [di, dj] of OFFSETS) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nk = nj * W + ni;
        if (this.closed[nk] === gen) continue;
        if (wd[nk] > 0 && cd[nk] === 0) continue;
        // Don't let long moves hop across water.
        const adi = Math.abs(di);
        const adj = Math.abs(dj);
        if (adi + adj === 2 && adi === 1) {
          if (this.blocked(field, ci + di, cj) && this.blocked(field, ci, cj + dj)) continue;
        } else if (adi + adj === 3) {
          const mi = ci + (adi === 2 ? Math.sign(di) : 0);
          const mj = cj + (adj === 2 ? Math.sign(dj) : 0);
          if (this.blocked(field, mi, mj) || this.blocked(field, ci + Math.sign(di), cj + Math.sign(dj))) continue;
        }
        const len = Math.sqrt(di * di + dj * dj) * cs;
        const slope = (hd[nk] - hd[cur]) / len;
        let v = speeds.get(slope) * 0.5 * (fd[cur] + fd[nk]);
        if (wd[nk] > 0) v *= field.fordFactor;
        const gn = gc + len / v;
        if (this.stamp[nk] !== gen || gn < this.g[nk]) {
          this.stamp[nk] = gen;
          this.g[nk] = gn;
          this.from[nk] = cur;
          heap.push(nk, gn + Math.hypot(ti - ni, tj - nj) * cs / vmax);
        }
      }
    }

    if (this.closed[goal] !== gen) return null;
    const cells: number[] = [];
    for (let k = goal; k !== -1; k = this.from[k]) cells.push(k);
    cells.reverse();
    const points = cells.map((k) => {
      const i = k % W;
      return { x: (i + 0.5) * cs, y: ((k - i) / W + 0.5) * cs };
    });
    points[0] = { ...a };
    if (points.length > 1) points[points.length - 1] = { ...b };
    else points.push({ ...b });
    return { points, seconds: this.g[goal] };
  }
}

/** Tobler's hiking function, m/s. Fastest on a slight downhill (-5%). */
export function tobler(slope: number): number {
  return (6 * Math.exp(-3.5 * Math.abs(slope + 0.05))) / 3.6;
}
