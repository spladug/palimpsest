import { medievalEngland } from './plugins/medieval-england';
import { MapView, type Layers } from './render/canvas2d';
import { createWorld, type World } from './sim/world';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('map');
const view = new MapView(canvas);
const playBtn = $<HTMLButtonElement>('play');
const seedInput = $<HTMLInputElement>('seed');
const speedSelect = $<HTMLSelectElement>('speed');

const params = new URLSearchParams(location.search);
let world: World = newWorld(params.get('seed') ?? randomSeed());
// ?year=1100 fast-forwards on load.
const startAt = Number(params.get('year'));
if (startAt > world.clock.now) {
  for (let y = Math.floor(world.clock.now) + 1; y <= startAt; y++) world.clock.advance(world, y);
}
let playing = false;
/** Frame budget for simulation work, so the map stays responsive. */
const BUDGET_MS = 28;

function randomSeed(): string {
  const words = ['ash', 'brook', 'combe', 'dene', 'ford', 'holt', 'ley', 'mere', 'stow', 'thorp', 'wick', 'worth'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}${pick()}-${Math.floor(Math.random() * 1000)}`;
}

function newWorld(seed: string): World {
  seedInput.value = seed;
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  history.replaceState(null, '', url);
  const w = createWorld(seed, medievalEngland);
  view.fit(w);
  return w;
}

function layers(): Layers {
  return {
    wear: $<HTMLInputElement>('layer-wear').checked,
    routes: $<HTMLInputElement>('layer-routes').checked,
    labels: $<HTMLInputElement>('layer-labels').checked,
  };
}

/** Simulated years owed to the clock; work is spread across frames. */
let owed = 0;

function advance(years: number, maxBacklog: number): void {
  owed += years;
  const start = performance.now();
  while (owed >= 1 && performance.now() - start < BUDGET_MS) {
    world.clock.advance(world, Math.floor(world.clock.now) + 1);
    owed -= 1;
  }
  // Don't build up a backlog when the sim can't keep pace.
  owed = Math.min(owed, maxBacklog);
}

let last = performance.now();
let lastLogLen = -1;
let lastMetricsLen = -1;

function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (playing) advance(dt * Number(speedSelect.value), 2);
  else if (owed >= 1) advance(0, Infinity);
  view.draw(world, layers());
  $('year').textContent = `${Math.floor(world.clock.now)}`;
  if (world.log.length !== lastLogLen) renderLog();
  if (world.metrics.length !== lastMetricsLen) renderMetrics();
  requestAnimationFrame(frame);
}

function renderLog(): void {
  lastLogLen = world.log.length;
  const ol = $('log');
  ol.innerHTML = '';
  for (const e of world.log.slice(-40)) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = String(e.year);
    li.append(b, e.text);
    ol.append(li);
  }
}

function renderMetrics(): void {
  lastMetricsLen = world.metrics.length;
  const latest = world.metrics[world.metrics.length - 1]?.metrics;
  if (!latest) return;
  const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
  fill('ways', [
    ['Roads', km(latest.lengthByClass.road)],
    ['Lanes', km(latest.lengthByClass.lane)],
    ['Tracks', km(latest.lengthByClass.track)],
    ['Paths', km(latest.lengthByClass.path)],
    ['Junctions', String(latest.junctions)],
    ['Farmsteads', String(world.places.filter((p) => p.kind === 'farmstead').length)],
  ]);
  fill('shape', [
    ['Orientation entropy', latest.orientationEntropy.toFixed(2)],
    ['Grid order', latest.orientationOrder.toFixed(2)],
    ['Meshedness', latest.meshedness.toFixed(2)],
    ['Dead ends', pct(latest.deadEndShare)],
    ['T-junctions', pct(latest.threeWayShare)],
    ['Crossroads', pct(latest.fourWayShare)],
    ['Circuity', latest.circuity.toFixed(2)],
  ]);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function fill(id: string, rows: [string, string][]): void {
  const dl = $(id);
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
});
$('step').addEventListener('click', () => (owed += 10));
$('reset').addEventListener('click', () => {
  const seed = seedInput.value.trim() || randomSeed();
  world = newWorld(seed === world.seed ? randomSeed() : seed);
  lastLogLen = lastMetricsLen = -1;
});
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    world = newWorld(seedInput.value.trim() || randomSeed());
    lastLogLen = lastMetricsLen = -1;
  }
});

// ?zoom=x,y,scale centres the view on a world point (metres) at a scale (px per metre).
const zoom = params.get('zoom')?.split(',').map(Number);
if (zoom && zoom.length === 3 && zoom.every(Number.isFinite)) {
  const r = canvas.getBoundingClientRect();
  view.scale = zoom[2];
  view.origin = { x: zoom[0] - r.width / 2 / zoom[2], y: zoom[1] - r.height / 2 / zoom[2] };
}

requestAnimationFrame(frame);
