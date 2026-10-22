import { medievalEngland } from './plugins/medieval-england';
import { MapView, type Layers } from './render/canvas2d';
import { createWorld, type World } from './sim/world';
import { cropIn, type Parcel, type PlotPhase } from './sim/cadastre';
import type { Right } from './plugins/types';
import { shapeArea as polygonArea } from './sim/polygon';

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
    values: $<HTMLInputElement>('layer-values').checked,
    problems: $<HTMLInputElement>('layer-problems').checked,
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
/** Whether the map needs drawing again, and whether a frame is already booked. */
let dirty = true;
let frameQueued = false;
let lastLogLen = -1;
let lastMetricsLen = -1;
let lastCadastreVersion = -1;
let lastInspectYear = -1;

/**
 * Frames run only while there is something to do: the simulation is playing
 * or stepping, or the view has changed. The map is redrawn only when the
 * year or the view changes, so an idle page costs nothing.
 */
function frame(now: number): void {
  frameQueued = false;
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const year = Math.floor(world.clock.now);
  if (playing) advance(dt * Number(speedSelect.value), 2);
  else if (owed >= 1) advance(0, Infinity);
  if (Math.floor(world.clock.now) !== year) dirty = true;
  if (dirty) {
    dirty = false;
    view.draw(world, layers());
    $('year').textContent = `${Math.floor(world.clock.now)}`;
    if (world.log.length !== lastLogLen) renderLog();
    if (world.metrics.length !== lastMetricsLen) renderMetrics();
    if (world.cadastre.version !== lastCadastreVersion || Math.floor(world.clock.now) !== lastInspectYear) {
      renderLand();
      renderTown();
      renderInspector();
    }
  }
  if (playing || owed >= 1) schedule();
}

function schedule(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(frame);
}

/** Ask for the map to be drawn again on the next frame. */
function redraw(): void {
  dirty = true;
  schedule();
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
  const town = world.metrics[world.metrics.length - 1]?.town;
  fill('shape', [
    ...(town
      ? ([
          ['Town grid order', town.streets.orientationOrder.toFixed(2)],
          ['Town meshedness', town.streets.meshedness.toFixed(2)],
          ['Town dead ends', pct(town.streets.deadEndShare)],
          ['Plot frontage', `${town.frontage.median.toFixed(1)} m`],
          ['Frontage built up', pct(town.frontContinuity)],
          ['Plot area built on', pct(town.coverage)],
        ] as [string, string][])
      : []),
    ['Valley orientation entropy', latest.orientationEntropy.toFixed(2)],
    ['Valley grid order', latest.orientationOrder.toFixed(2)],
    ['Valley meshedness', latest.meshedness.toFixed(2)],
    ['Valley dead ends', pct(latest.deadEndShare)],
    ['T-junctions', pct(latest.threeWayShare)],
    ['Crossroads', pct(latest.fourWayShare)],
    ['Circuity', latest.circuity.toFixed(2)],
  ]);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const acres = (m2: number) => `${(m2 / 4047).toFixed(m2 < 4047 * 10 ? 2 : 0)} acres`;

/** Parcels that count as someone's holding (not commons, markets or churchyards). */
const HELD_KINDS = new Set<Parcel['kind']>(['strip', 'close', 'toft', 'burgage', 'plot', 'precinct', 'works']);

const PHASE_LABELS: Record<PlotPhase, string> = {
  institutive: 'house at the front, yard behind',
  repletive: 'back land filling with buildings',
  climax: 'back land full',
  recessive: 'back buildings being cleared',
};

function renderTown(): void {
  const t = world.town;
  const cad = world.cadastre;
  let plots = 0;
  let vacant = 0;
  let courts = 0;
  const phases: Record<PlotPhase, number> = { institutive: 0, repletive: 0, climax: 0, recessive: 0 };
  for (const p of cad.parcels.values()) {
    if (p.kind !== 'burgage' && p.kind !== 'plot') continue;
    plots++;
    if (p.takenUp === undefined) vacant++;
    else if (p.phase) phases[p.phase]++;
    for (const b of cad.buildingsOn(p.id)) if (b.back && b.use === 'court') courts++;
  }
  const market = world.places.some((p) => p.kind === 'market');
  if (!market) {
    fill('town', [['Households', '—']]);
    drawTownChart();
    return;
  }
  fill('town', [
    ['Households', String(t.households)],
    ['Could support', String(Math.round(t.capacity))],
    ['Town plots', String(plots)],
    ['Empty plots', String(vacant)],
    ['Cottages in courts', String(courts)],
    ['Back land filling', String(phases.repletive)],
    ['Back land full', String(phases.climax)],
    ['Being cleared', String(phases.recessive)],
  ]);
  drawTownChart();
}

/** Households against capacity over the town's history. */
function drawTownChart(): void {
  const canvas = $<HTMLCanvasElement>('town-chart');
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const h = world.town.history;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim() || '#2b2118';
  const muted = css.getPropertyValue('--muted').trim() || '#74685a';
  const line = css.getPropertyValue('--line').trim() || '#ddd3c1';
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, r.height - 12.5);
  ctx.lineTo(r.width, r.height - 12.5);
  ctx.stroke();
  if (h.length < 2) return;
  const x0 = h[0].year;
  const x1 = Math.max(h[h.length - 1].year, x0 + 50);
  const top = Math.max(50, ...h.map((d) => Math.max(d.households, d.capacity)));
  const x = (year: number) => ((year - x0) / (x1 - x0)) * (r.width - 2) + 1;
  const y = (v: number) => r.height - 13 - (v / top) * (r.height - 20);
  const plot = (key: 'households' | 'capacity', colour: string, dash: number[]) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    h.forEach((d, i) => (i ? ctx.lineTo(x(d.year), y(d[key])) : ctx.moveTo(x(d.year), y(d[key]))));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  plot('capacity', muted, [4, 3]);
  plot('households', ink, []);
  ctx.fillStyle = muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(String(x0), 0, r.height);
  ctx.textAlign = 'right';
  ctx.fillText(String(h[h.length - 1].year), r.width, r.height);
  ctx.textBaseline = 'top';
  ctx.fillText(String(Math.round(top)), r.width, 0);
}

const RIGHT_LABELS: Record<Right, string> = {
  access: 'Enter or graze',
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
  toft: 'Toft and croft',
  burgage: 'Burgage plot',
  market: 'Market place',
  churchyard: 'Churchyard',
  plot: 'Building plot',
  precinct: 'Precinct',
  works: 'Works',
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
  const useName = parcel.use ? world.plugins.technology.uses[parcel.use]?.name : undefined;
  h3.textContent = furlong
    ? `${KIND_LABELS[parcel.kind]} in ${furlong.name}`
    : useName
      ? `${useName} (${KIND_LABELS[parcel.kind].toLowerCase()})`
      : KIND_LABELS[parcel.kind];
  const sub = document.createElement('p');
  if (parcel.frontage) h3.textContent += ` on ${parcel.frontage.street}`;
  const bits = [acres(parcel.area)];
  if (parcel.frontage) {
    const f = parcel.frontage;
    const perches = Math.round((Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y) / 5.03) * 2) / 2;
    bits.push(`${perches} perch${perches === 1 ? '' : 'es'} of frontage`);
  }
  if (furlong) bits.push(`${cad.greatFields[furlong.field]?.name ?? ''}, ${cropIn(furlong.field, world.clock.now)} this year`);
  bits.push(`laid out ${parcel.created}`);
  if (parcel.takenUp !== undefined) bits.push(`taken up ${parcel.takenUp}`);
  else if (parcel.kind === 'toft' || parcel.kind === 'burgage' || parcel.kind === 'plot') bits.push('empty');
  const uses = world.plugins.technology.uses;
  if (parcel.use) bits.push(uses[parcel.use]?.name.toLowerCase() ?? parcel.use);
  const buildings = cad.buildingsOn(parcel.id);
  const counts = new Map<string, number>();
  for (const b of buildings) {
    const name = uses[b.use]?.name.toLowerCase() ?? b.use;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size) bits.push([...counts].map(([n, c]) => (c > 1 ? `${c} × ${n}` : n)).join(', '));
  if (parcel.value !== undefined && parcel.frontage) bits.push(`land value ${Math.round(parcel.value * 100)}`);
  if (parcel.phase && parcel.takenUp !== undefined) {
    const built = buildings.reduce((s, b) => s + polygonArea(b.footprint), 0);
    bits.push(`${PHASE_LABELS[parcel.phase]} (${pct(built / parcel.area)} built over)`);
  }
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
  // The plot's lineage: how it came to be what it is.
  const lineage = cad.history.filter((e) => e.children.includes(parcel.id)).slice(-4);
  if (lineage.length) {
    const ul = document.createElement('p');
    ul.textContent = lineage.map((e) => `${e.year}: ${e.note}`).join(' · ');
    body.append(ul);
  }
  const holder = parcel.rights.withdrawal;
  const h = holder !== undefined ? cad.holders.get(holder) : undefined;
  if (h && h.kind !== 'community') {
    let n = 0;
    let area = 0;
    const furlongs = new Set<number>();
    for (const p of cad.parcels.values()) {
      if (p.rights.withdrawal !== holder || !HELD_KINDS.has(p.kind)) continue;
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
  view.selectedHolder = kind !== undefined && kind !== 'community' ? holder! : null;
  renderInspector();
  redraw();
};
view.onChange = redraw;
window.addEventListener('resize', redraw);
document.querySelector('.layers')!.addEventListener('change', redraw);

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
  // Don't count the idle time before pressing play as simulated time.
  last = performance.now();
  redraw();
});
$('step').addEventListener('click', () => {
  owed += 10;
  redraw();
});
$('reset').addEventListener('click', () => {
  const seed = seedInput.value.trim() || randomSeed();
  world = newWorld(seed === world.seed ? randomSeed() : seed);
  lastLogLen = lastMetricsLen = lastCadastreVersion = -1;
  view.selectedParcel = null;
  view.selectedHolder = null;
  redraw();
});
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    world = newWorld(seedInput.value.trim() || randomSeed());
    lastLogLen = lastMetricsLen = lastCadastreVersion = -1;
    view.selectedParcel = null;
    view.selectedHolder = null;
    redraw();
  }
});

// ?zoom=x,y,scale centres the view on a world point (metres) at a scale (px per metre).
const zoom = params.get('zoom')?.split(',').map(Number);
if (zoom && zoom.length === 3 && zoom.every(Number.isFinite)) {
  const r = canvas.getBoundingClientRect();
  view.scale = zoom[2];
  view.origin = { x: zoom[0] - r.width / 2 / zoom[2], y: zoom[1] - r.height / 2 / zoom[2] };
}

redraw();
// Labels are measured with the web font; draw again once it has loaded.
document.fonts?.ready.then(redraw);

// For poking at the simulation from the console or test tools (dev builds only).
if (import.meta.env.DEV) {
  (window as unknown as { sim: unknown }).sim = {
    get world() {
      return world;
    },
    view,
  };
}
