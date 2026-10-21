// 2D map view. Reads world state; never changes it.

import { cropIn, type Parcel } from '../sim/cadastre';
import type { Vec2 } from '../sim/geom';
import type { Shape } from '../sim/polygon';
import type { EdgeClass } from '../sim/graph';
import { Raster } from '../sim/raster';
import type { World } from '../sim/world';

export interface Layers {
  wear: boolean;
  routes: boolean;
  labels: boolean;
  fields: boolean;
  ghosts: boolean;
}

const CROP_COLOUR = {
  'winter corn': 'rgba(222, 196, 110, 0.75)',
  'spring corn': 'rgba(176, 196, 112, 0.75)',
  fallow: 'rgba(196, 176, 146, 0.7)',
};

function shapePath(path: Path2D, shape: Shape): void {
  for (const ring of shape) {
    ring.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();
  }
}

/** Paths for each group of parcels, rebuilt only when the cadastre changes. */
interface ParcelPaths {
  version: number;
  stripsByField: Path2D[];
  furlongs: Path2D;
  closes: Path2D;
  meadow: Path2D;
  common: Path2D;
  ghosts: Path2D;
}

interface WayStyle {
  width: number;
  colour: string;
  casing?: string;
  dash?: number[];
}

const WAY_STYLES: Record<EdgeClass, WayStyle> = {
  path: { width: 1, colour: '#8a7a62', dash: [3, 3] },
  track: { width: 1.8, colour: '#8b6b43' },
  lane: { width: 3, colour: '#d9c79f', casing: '#6b4a2a' },
  road: { width: 4.5, colour: '#f2e4b8', casing: '#4a3320' },
};

export class MapView {
  private ctx: CanvasRenderingContext2D;
  private terrainImage: HTMLCanvasElement | null = null;
  private terrainFor: World | null = null;
  private wearCanvas = document.createElement('canvas');
  /** Pixels per metre, and the world point at the canvas origin. */
  scale = 1;
  origin: Vec2 = { x: 0, y: 0 };
  private fitted = false;
  private paths: ParcelPaths | null = null;
  private pathsFor: World | null = null;
  /** The holder whose land is highlighted, if any. */
  selectedHolder: number | null = null;
  selectedParcel: Parcel | null = null;
  onClick: ((world: Vec2) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.attachControls();
  }

  fit(world: World): void {
    const r = this.canvas.getBoundingClientRect();
    const W = world.terrain.height.worldWidth;
    const H = world.terrain.height.worldHeight;
    this.scale = Math.min(r.width / W, r.height / H) * 0.98;
    this.origin = { x: W / 2 - r.width / 2 / this.scale, y: H / 2 - r.height / 2 / this.scale };
    this.fitted = true;
  }

  private attachControls(): void {
    let drag: { x: number; y: number } | null = null;
    let moved = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      moved = 0;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      this.origin.x -= (e.clientX - drag.x) / this.scale;
      this.origin.y -= (e.clientY - drag.y) / this.scale;
      drag = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      drag = null;
      if (moved < 5 && this.onClick) {
        const r = this.canvas.getBoundingClientRect();
        this.onClick({ x: this.origin.x + (e.clientX - r.left) / this.scale, y: this.origin.y + (e.clientY - r.top) / this.scale });
      }
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const before = { x: this.origin.x + mx / this.scale, y: this.origin.y + my / this.scale };
        this.scale *= Math.exp(-e.deltaY * 0.0015);
        this.scale = Math.max(0.05, Math.min(20, this.scale));
        this.origin = { x: before.x - mx / this.scale, y: before.y - my / this.scale };
      },
      { passive: false },
    );
  }

  draw(world: World, layers: Layers): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.round(r.width * dpr) || this.canvas.height !== Math.round(r.height * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    if (!this.fitted) this.fit(world);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--map-bg') || '#ddd';
    ctx.fillRect(0, 0, r.width, r.height);

    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, -this.origin.x * this.scale * dpr, -this.origin.y * this.scale * dpr);
    const W = world.terrain.height.worldWidth;
    const H = world.terrain.height.worldHeight;
    if (this.terrainFor !== world) {
      this.terrainImage = renderTerrain(world);
      this.terrainFor = world;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrainImage!, 0, 0, W, H);
    if (layers.fields) this.drawFields(world, layers.ghosts);
    this.drawRivers(world);
    if (layers.wear) {
      this.renderWear(world);
      ctx.drawImage(this.wearCanvas, 0, 0, W, H);
    }
    if (layers.routes) this.drawRoutes(world);
    this.drawWays(world);
    this.drawFords(world);
    this.drawPlaces(world, layers.labels);
  }

  private parcelPaths(world: World): ParcelPaths {
    const cad = world.cadastre;
    if (this.paths && this.pathsFor === world && this.paths.version === cad.version) return this.paths;
    const paths: ParcelPaths = {
      version: cad.version,
      stripsByField: [new Path2D(), new Path2D(), new Path2D()],
      furlongs: new Path2D(),
      closes: new Path2D(),
      meadow: new Path2D(),
      common: new Path2D(),
      ghosts: new Path2D(),
    };
    for (const p of cad.parcels.values()) {
      if (p.kind === 'strip') {
        const f = p.furlongId !== null ? cad.furlongs.get(p.furlongId) : undefined;
        shapePath(paths.stripsByField[f?.field ?? 0], p.shape);
      } else if (p.kind === 'close') shapePath(paths.closes, p.shape);
      else if (p.kind === 'meadow') shapePath(paths.meadow, p.shape);
      else shapePath(paths.common, p.shape);
    }
    for (const f of cad.furlongs.values()) shapePath(paths.furlongs, f.shape);
    for (const g of cad.ghosts) shapePath(paths.ghosts, g);
    this.paths = paths;
    this.pathsFor = world;
    return paths;
  }

  private drawFields(world: World, ghosts: boolean): void {
    const ctx = this.ctx;
    const paths = this.parcelPaths(world);
    const year = world.clock.now;
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(205, 196, 150, 0.4)';
    ctx.fill(paths.common, 'evenodd');
    ctx.fillStyle = 'rgba(140, 192, 165, 0.5)';
    ctx.fill(paths.meadow, 'evenodd');
    paths.stripsByField.forEach((path, field) => {
      ctx.fillStyle = CROP_COLOUR[cropIn(field, year)];
      ctx.fill(path, 'evenodd');
    });
    // Ridge-and-furrow: the lines between strips.
    ctx.strokeStyle = 'rgba(95, 75, 45, 0.35)';
    ctx.lineWidth = this.px(0.5);
    for (const path of paths.stripsByField) ctx.stroke(path);
    ctx.strokeStyle = 'rgba(85, 62, 35, 0.55)';
    ctx.lineWidth = this.px(1);
    ctx.stroke(paths.furlongs);
    ctx.fillStyle = 'rgba(150, 178, 105, 0.45)';
    ctx.fill(paths.closes, 'evenodd');
    ctx.strokeStyle = '#4f6b38';
    ctx.lineWidth = this.px(1.6);
    ctx.stroke(paths.closes);
    if (ghosts) {
      ctx.strokeStyle = 'rgba(110, 40, 30, 0.6)';
      ctx.lineWidth = this.px(1);
      ctx.setLineDash([this.px(3), this.px(3)]);
      ctx.stroke(paths.ghosts);
      ctx.setLineDash([]);
    }
    this.drawSelection(world);
  }

  private drawSelection(world: World): void {
    const ctx = this.ctx;
    if (this.selectedHolder !== null) {
      const path = new Path2D();
      for (const p of world.cadastre.parcels.values()) {
        if (p.rights.withdrawal === this.selectedHolder && (p.kind === 'strip' || p.kind === 'close')) shapePath(path, p.shape);
      }
      ctx.fillStyle = 'rgba(122, 31, 31, 0.65)';
      ctx.fill(path, 'evenodd');
    }
    if (this.selectedParcel && world.cadastre.parcels.has(this.selectedParcel.id)) {
      const path = new Path2D();
      shapePath(path, this.selectedParcel.shape);
      ctx.strokeStyle = '#fff6d8';
      ctx.lineWidth = this.px(2.5);
      ctx.stroke(path);
      ctx.strokeStyle = '#7a1f1f';
      ctx.lineWidth = this.px(1.2);
      ctx.stroke(path);
    }
  }

  /** Line width in world units for a desired screen width that grows gently with zoom. */
  private px(screen: number): number {
    return (screen * Math.max(0.6, Math.min(3, Math.sqrt(this.scale * 2)))) / this.scale;
  }

  private drawRivers(world: World): void {
    const ctx = this.ctx;
    for (const river of world.terrain.rivers) {
      ctx.beginPath();
      river.centreline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.strokeStyle = '#4f7f9a';
      ctx.lineWidth = river.width + 3;
      ctx.stroke();
      ctx.strokeStyle = '#7fb2cc';
      ctx.lineWidth = river.width;
      ctx.stroke();
    }
  }

  private renderWear(world: World): void {
    const w = world.wear;
    if (this.wearCanvas.width !== w.width) {
      this.wearCanvas.width = w.width;
      this.wearCanvas.height = w.height;
    }
    const wctx = this.wearCanvas.getContext('2d')!;
    const img = wctx.createImageData(w.width, w.height);
    for (let k = 0; k < w.data.length; k++) {
      const a = Math.min(1, Math.log1p(w.data[k]) / 7);
      img.data[k * 4] = 190;
      img.data[k * 4 + 1] = 60;
      img.data[k * 4 + 2] = 30;
      img.data[k * 4 + 3] = Math.round(a * 200);
    }
    wctx.putImageData(img, 0, 0);
  }

  private drawRoutes(world: World): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(200, 40, 40, 0.35)';
    ctx.lineWidth = this.px(1);
    ctx.setLineDash([]);
    for (const route of world.recentRoutes) {
      ctx.beginPath();
      route.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }

  private drawWays(world: World): void {
    const ctx = this.ctx;
    ctx.lineJoin = ctx.lineCap = 'round';
    const order: EdgeClass[] = ['path', 'track', 'lane', 'road'];
    const edges = [...world.graph.edges.values()];
    const stroke = (cls: EdgeClass, colour: string, width: number, dash?: number[]) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = this.px(width);
      ctx.setLineDash(dash ? dash.map((d) => this.px(d)) : []);
      ctx.beginPath();
      for (const e of edges) {
        if (e.cls !== cls) continue;
        e.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      }
      ctx.stroke();
    };
    for (const cls of order) {
      const s = WAY_STYLES[cls];
      if (s.casing) stroke(cls, s.casing, s.width + 1.6);
    }
    for (const cls of order) {
      const s = WAY_STYLES[cls];
      stroke(cls, s.colour, s.width, s.dash);
    }
    ctx.setLineDash([]);
  }

  private drawFords(world: World): void {
    const ctx = this.ctx;
    for (const f of world.terrain.fords) {
      ctx.strokeStyle = '#2d5a72';
      ctx.lineWidth = this.px(1.2);
      ctx.setLineDash([this.px(2), this.px(2)]);
      ctx.beginPath();
      ctx.arc(f.x, f.y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawPlaces(world: World, labels: boolean): void {
    const ctx = this.ctx;
    const size = this.px(7);
    for (const d of world.deserted) {
      ctx.save();
      ctx.translate(d.pos.x, d.pos.y);
      ctx.strokeStyle = 'rgba(70, 60, 50, 0.7)';
      ctx.lineWidth = this.px(1);
      ctx.strokeRect(-size / 2, -size / 3, size, size * 0.66);
      ctx.restore();
      if (labels) this.label(d.name, d.pos, 9, true, 'rgba(70, 60, 50, 0.75)');
    }
    for (const p of world.places) {
      if (p.kind === 'field') continue;
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      if (p.kind === 'village') {
        this.drawVillage(Math.round(p.mass), size);
      } else if (p.kind === 'farmstead') {
        ctx.fillStyle = '#5a3b22';
        ctx.strokeStyle = '#f5ecd8';
        ctx.lineWidth = this.px(1);
        ctx.beginPath();
        ctx.moveTo(-size / 2, size / 3);
        ctx.lineTo(-size / 2, -size / 6);
        ctx.lineTo(0, -size / 2);
        ctx.lineTo(size / 2, -size / 6);
        ctx.lineTo(size / 2, size / 3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (p.kind === 'church') {
        ctx.strokeStyle = '#f5ecd8';
        ctx.lineWidth = this.px(4);
        const cross = () => {
          ctx.beginPath();
          ctx.moveTo(0, -size * 0.8);
          ctx.lineTo(0, size * 0.8);
          ctx.moveTo(-size * 0.5, -size * 0.25);
          ctx.lineTo(size * 0.5, -size * 0.25);
          ctx.stroke();
        };
        cross();
        ctx.strokeStyle = '#7a1f1f';
        ctx.lineWidth = this.px(2);
        cross();
      } else {
        ctx.fillStyle = '#2f2a24';
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      if (labels) {
        if (p.kind === 'village') this.label(p.name, { x: p.pos.x + 40, y: p.pos.y - 30 }, 14, false, '#2b2118', true);
        else this.label(p.name, p.pos, p.kind === 'gateway' ? 11 : 10, p.kind === 'gateway');
      }
    }
  }

  /** Until houses have plots of their own (milestone 3), a village is a cluster of houses. */
  private drawVillage(households: number, size: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#5a3b22';
    ctx.strokeStyle = '#f5ecd8';
    ctx.lineWidth = this.px(0.8);
    const s = size * 0.8;
    for (let k = 0; k < households; k++) {
      // A sunflower spiral keeps the houses evenly spread.
      const a = k * 2.39996;
      const r = 14 + 9 * Math.sqrt(k);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      ctx.beginPath();
      ctx.rect(x - s / 2, y - s / 3, s, s * 0.66);
      ctx.fill();
      ctx.stroke();
    }
  }

  private label(text: string, at: Vec2, sizePx: number, italic: boolean, colour = '#2b2118', bold = false): void {
    const ctx = this.ctx;
    const W = this.terrainFor!.terrain.height.worldWidth;
    const H = this.terrainFor!.terrain.height.worldHeight;
    ctx.save();
    ctx.font = `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${sizePx / this.scale}px Georgia, serif`;
    const tw = ctx.measureText(text).width;
    // Keep labels inside the map.
    let x = at.x + 9 / this.scale;
    const y = Math.min(H - 6 / this.scale, Math.max(14 / this.scale, at.y - 6 / this.scale));
    if (x + tw > W) x = at.x - 9 / this.scale - tw;
    ctx.lineWidth = 3 / this.scale;
    ctx.strokeStyle = 'rgba(250, 245, 230, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

/** Hypsometric tints with hillshade and contours, at twice the raster resolution. */
function renderTerrain(world: World): HTMLCanvasElement {
  const h = world.terrain.height;
  const wet = world.terrain.wetness;
  const water = world.terrain.water;
  const k = 2;
  const cw = h.width * k;
  const ch = h.height * k;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(cw, ch);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h.data) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const cs = h.cellSize / k;
  const sample = (x: number, y: number) => h.sample({ x, y });
  // Gradients at cell centres, interpolated, give shading without seams at cell edges.
  const gx = new Raster(h.width, h.height, h.cellSize);
  const gy = new Raster(h.width, h.height, h.cellSize);
  for (let j = 0; j < h.height; j++) {
    for (let i = 0; i < h.width; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(h.width - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(h.height - 1, j + 1);
      gx.set(i, j, (h.get(i1, j) - h.get(i0, j)) / ((i1 - i0) * h.cellSize));
      gy.set(i, j, (h.get(i, j1) - h.get(i, j0)) / ((j1 - j0) * h.cellSize));
    }
  }
  const contour = 2.5;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const wx = (x + 0.5) * cs;
      const wy = (y + 0.5) * cs;
      const z = sample(wx, wy);
      const t = (z - lo) / Math.max(1e-6, hi - lo);
      // Meadow green → pasture → upland brown.
      let r = 150 + 70 * t;
      let g = 178 + 10 * t - 20 * t * t;
      let b = 112 + 30 * t;
      const wv = wet.sample({ x: wx, y: wy });
      r = r * (1 - 0.25 * wv) + 120 * 0.25 * wv;
      g = g * (1 - 0.25 * wv) + 170 * 0.25 * wv;
      b = b * (1 - 0.25 * wv) + 160 * 0.25 * wv;
      // Hillshade from the north-west.
      const dzdx = gx.sample({ x: wx, y: wy });
      const dzdy = gy.sample({ x: wx, y: wy });
      const shade = Math.max(0.55, Math.min(1.2, 1 + 3 * (-dzdx * 0.7 - dzdy * 0.7)));
      r *= shade;
      g *= shade;
      b *= shade;
      // Contours where the band changes between this pixel and its neighbours.
      const band = Math.floor(z / contour);
      if (Math.floor(sample(wx + cs, wy) / contour) !== band || Math.floor(sample(wx, wy + cs) / contour) !== band) {
        r *= 0.88;
        g *= 0.88;
        b *= 0.88;
      }
      if (water.sample({ x: wx, y: wy }) > 0.5) {
        r = 127;
        g = 178;
        b = 204;
      }
      const o = (y * cw + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
