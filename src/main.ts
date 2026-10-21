import { medievalEngland } from './plugins/medieval-england';
import { MapView, type Layers } from './render/canvas2d';
import { createWorld, type World } from './sim/world';
import { cropIn, type Parcel } from './sim/cadastre';
import type { Right } from './plugins/types';

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
    fields: $<HTMLInputElement>('layer-fields').checked,
    ghosts: $<HTMLInputElement>('layer-ghosts').checked,
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
let lastCadastreVersion = -1;
let lastInspectYear = -1;

function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (playing) advance(dt * Number(speedSelect.value), 2);
  else if (owed >= 1) advance(0, Infinity);
  view.draw(world, layers());
  $('year').textContent = `${Math.floor(world.clock.now)}`;
  if (world.log.length !== lastLogLen) renderLog();
  if (world.metrics.length !== lastMetricsLen) renderMetrics();
  if (world.cadastre.version !== lastCadastreVersion || Math.floor(world.clock.now) !== lastInspectYear) {
    renderLand();
    renderInspector();
  }
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
const acres = (m2: number) => `${(m2 / 4047).toFixed(m2 < 4047 * 10 ? 2 : 0)} acres`;

const RIGHT_LABELS: Record<Right, string> = {
  access: 'Enter and graze',
  withdrawal: 'Take the crop',
  management: 'Decide its use',
  exclusion: 'Keep others out',
  alienation: 'Sell or grant it',
  build: 'Build on it',
  subdivide: 'Divide it',
  inherit: 'Pass it to heirs',
};

const KIND_LABELS: Record<Parcel['kind'], string> = {
  close: 'Close',
  strip: 'Strip',
  meadow: 'Common meadow',
  common: 'Common pasture',
};

function renderLand(): void {
  lastCadastreVersion = world.cadastre.version;
  const cad = world.cadastre;
  let strips = 0;
  let closes = 0;
  for (const p of cad.parcels.values()) {
    if (p.kind === 'strip') strips++;
    else if (p.kind === 'close') closes++;
  }
  const village = world.places.find((p) => p.kind === 'village');
  fill('land', [
    ['Furlongs', String(cad.furlongs.size)],
    ['Strips', String(strips)],
    ['Closes', String(closes)],
    ['Village households', village ? String(Math.round(village.mass)) : '—'],
    ['Deserted farmsteads', String(world.deserted.length)],
  ]);
}

function renderInspector(): void {
  lastInspectYear = Math.floor(world.clock.now);
  const section = $('inspect');
  const parcel = view.selectedParcel;
  const cad = world.cadastre;
  if (!parcel || !cad.parcels.has(parcel.id)) {
    section.hidden = true;
    view.selectedParcel = null;
    view.selectedHolder = null;
    return;
  }
  section.hidden = false;
  const body = $('inspect-body');
  body.innerHTML = '';
  const furlong = parcel.furlongId !== null ? cad.furlongs.get(parcel.furlongId) : undefined;
  const h3 = document.createElement('h3');
  h3.textContent = furlong ? `${KIND_LABELS[parcel.kind]} in ${furlong.name}` : KIND_LABELS[parcel.kind];
  const sub = document.createElement('p');
  const bits = [acres(parcel.area)];
  if (furlong) bits.push(`${cad.greatFields[furlong.field]?.name ?? ''}, ${cropIn(furlong.field, world.clock.now)} this year`);
  bits.push(`laid out ${parcel.created}`);
  sub.textContent = bits.join(' · ');
  const table = document.createElement('table');
  table.className = 'rights';
  for (const right of world.plugins.tenure.allRights) {
    const tr = document.createElement('tr');
    const k = document.createElement('td');
    k.textContent = RIGHT_LABELS[right];
    const v = document.createElement('td');
    const holder = parcel.rights[right];
    v.textContent = holder === undefined ? 'no one' : cad.holderName(holder);
    if (holder === undefined) v.className = 'none';
    tr.append(k, v);
    table.append(tr);
  }
  body.append(h3, sub, table);
  const holder = parcel.rights.withdrawal;
  const h = holder !== undefined ? cad.holders.get(holder) : undefined;
  if (h && (h.kind === 'household' || h.kind === 'lord' || h.kind === 'church')) {
    let n = 0;
    let area = 0;
    const furlongs = new Set<number>();
    for (const p of cad.parcels.values()) {
      if (p.rights.withdrawal !== holder || (p.kind !== 'strip' && p.kind !== 'close')) continue;
      n++;
      area += p.area;
      if (p.furlongId !== null) furlongs.add(p.furlongId);
    }
    const holding = document.createElement('p');
    holding.textContent =
      `${h.name[0].toUpperCase()}${h.name.slice(1)} holds ${n} parcel${n === 1 ? '' : 's'} (${acres(area)})` +
      (furlongs.size ? `, scattered over ${furlongs.size} furlongs — shown in red.` : ', shown in red.');
    body.append(holding);
  }
}

view.onClick = (p) => {
  const parcel = world.cadastre.parcelAt(p);
  view.selectedParcel = parcel;
  const holder = parcel?.rights.withdrawal;
  const kind = holder !== undefined ? world.cadastre.holders.get(holder)?.kind : undefined;
  view.selectedHolder = kind === 'household' || kind === 'lord' || kind === 'church' ? holder! : null;
  renderInspector();
};

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
  lastLogLen = lastMetricsLen = lastCadastreVersion = -1;
  view.selectedParcel = null;
  view.selectedHolder = null;
});
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    world = newWorld(seedInput.value.trim() || randomSeed());
    lastLogLen = lastMetricsLen = lastCadastreVersion = -1;
    view.selectedParcel = null;
    view.selectedHolder = null;
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
