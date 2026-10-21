import type { Vec2 } from './geom';

/** A scalar field on a regular grid. Cell (i, j) covers [i, i+1) × [j, j+1) cells of `cellSize` metres. */
export class Raster {
  readonly data: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cellSize: number,
    fill = 0,
  ) {
    this.data = new Float32Array(width * height);
    if (fill !== 0) this.data.fill(fill);
  }

  index(i: number, j: number): number {
    return j * this.width + i;
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.width && j < this.height;
  }

  get(i: number, j: number): number {
    return this.data[j * this.width + i];
  }

  set(i: number, j: number, v: number): void {
    this.data[j * this.width + i] = v;
  }

  /** World coordinates of a cell centre. */
  cellCentre(i: number, j: number): Vec2 {
    return { x: (i + 0.5) * this.cellSize, y: (j + 0.5) * this.cellSize };
  }

  /** Cell containing a world point, clamped to the grid. */
  cellAt(p: Vec2): [number, number] {
    const i = Math.min(this.width - 1, Math.max(0, Math.floor(p.x / this.cellSize)));
    const j = Math.min(this.height - 1, Math.max(0, Math.floor(p.y / this.cellSize)));
    return [i, j];
  }

  /** Bilinear sample at a world point (cell centres are sample points). */
  sample(p: Vec2): number {
    const fx = Math.min(this.width - 1, Math.max(0, p.x / this.cellSize - 0.5));
    const fy = Math.min(this.height - 1, Math.max(0, p.y / this.cellSize - 0.5));
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const i1 = Math.min(this.width - 1, i0 + 1);
    const j1 = Math.min(this.height - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;
    const a = this.get(i0, j0) * (1 - tx) + this.get(i1, j0) * tx;
    const b = this.get(i0, j1) * (1 - tx) + this.get(i1, j1) * tx;
    return a * (1 - ty) + b * ty;
  }

  get worldWidth(): number {
    return this.width * this.cellSize;
  }

  get worldHeight(): number {
    return this.height * this.cellSize;
  }
}
