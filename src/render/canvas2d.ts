// 2D map view. Reads world state; never changes it.

import type { Vec2 } from '../sim/geom';
import type { EdgeClass } from '../sim/graph';
import { Raster } from '../sim/raster';
import type { World } from '../sim/world';

export interface Layers {
  wear: boolean;
  routes: boolean;
  labels: boolean;
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
    this.canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.origin.x -= (e.clientX - drag.x) / this.scale;
      this.origin.y -= (e.clientY - drag.y) / this.scale;
      drag = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', () => (drag = null));
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
    for (const p of world.places) {
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      if (p.kind === 'farmstead') {
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
      if (labels) this.label(p.name, p.pos, p.kind === 'gateway' ? 11 : 10, p.kind === 'gateway');
    }
  }

  private label(text: string, at: Vec2, sizePx: number, italic: boolean): void {
    const ctx = this.ctx;
    const W = this.terrainFor!.terrain.height.worldWidth;
    const H = this.terrainFor!.terrain.height.worldHeight;
    ctx.save();
    ctx.font = `${italic ? 'italic ' : ''}${sizePx / this.scale}px Georgia, serif`;
    const tw = ctx.measureText(text).width;
    // Keep labels inside the map.
    let x = at.x + 9 / this.scale;
    const y = Math.min(H - 6 / this.scale, Math.max(14 / this.scale, at.y - 6 / this.scale));
    if (x + tw > W) x = at.x - 9 / this.scale - tw;
    ctx.lineWidth = 3 / this.scale;
    ctx.strokeStyle = 'rgba(250, 245, 230, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#2b2118';
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
