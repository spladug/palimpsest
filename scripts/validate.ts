// Run several seeds to a final year and check them: physical-plausibility
// violations at fixed dates (layer 1), the form of the town by district
// (layer 2), and its history against historical targets (layer 3). Usage:
//   npm run validate -- [--seeds valley,a,b | -n 8] [--to 1900] [--jobs 8] [--json out.json] [--examples 3]
// Each seed runs in its own process; the parent collects and prints a table.

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../src/sim/world';
import { medievalEngland } from '../src/plugins/medieval-england';
import { checkWorld, tally, VIOLATION_KINDS, type Violation, type ViolationKind } from '../src/sim/validate';
import { computeMetrics } from '../src/sim/metrics';
import { DISTRICTS, measureTown, type Form, type TownForm } from '../src/sim/form';
import { historyChecks, type HistoryCheck } from './validation/history';

const CHECKPOINTS = [1100, 1250, 1400, 1600, 1760, 1850, 1900];
/** Dates at which the town's form is measured. */
const FORM_AT = [1300, 1600, 1900];

interface SeedResult {
  seed: string;
  /** Violations by checkpoint year. */
  counts: Record<number, Record<ViolationKind, number>>;
  /** A few examples of each kind at the last checkpoint. */
  examples: Partial<Record<ViolationKind, Violation[]>>;
  households: Record<number, number>;
  /** Households the town could support (the demand plugin's capacity). */
  capacity: Record<number, number>;
  /** The town's form by date, and the whole valley's street orientation entropy for comparison. */
  form: Record<number, TownForm & { valleyEntropy: number }>;
  history: HistoryCheck[];
  ms: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function runSeed(seed: string, to: number, keep: number): SeedResult {
  const t = performance.now();
  const world = createWorld(seed, medievalEngland);
  const result: SeedResult = { seed, counts: {}, examples: {}, households: {}, capacity: {}, form: {}, history: [], ms: 0 };
  const points = CHECKPOINTS.filter((y) => y <= to);
  for (let y = Math.floor(world.clock.now) + 1; y <= to; y++) {
    world.clock.advance(world, y);
    if (FORM_AT.includes(y)) result.form[y] = { ...measureTown(world), valleyEntropy: computeMetrics(world).orientationEntropy };
    if (!points.includes(y)) continue;
    const v = checkWorld(world);
    result.counts[y] = tally(v);
    result.households[y] = world.town.households;
    result.capacity[y] = Math.round(world.town.capacity);
    if (y === points[points.length - 1]) {
      for (const x of v) {
        const list = (result.examples[x.kind] ??= []);
        if (list.length < keep) list.push(x);
      }
    }
  }
  result.history = historyChecks(world);
  result.ms = performance.now() - t;
  return result;
}

async function main() {
  const to = Number(arg('--to') ?? 1900);
  const keep = Number(arg('--examples') ?? 3);
  const child = arg('--child');
  if (child) {
    process.stdout.write('@@' + JSON.stringify(runSeed(child, to, keep)) + '\n');
    return;
  }
  const seeds = arg('--seeds')?.split(',') ?? Array.from({ length: Number(arg('-n') ?? 8) }, (_, i) => (i === 0 ? 'valley' : `seed${i}`));
  const jobs = Number(arg('--jobs') ?? Math.max(1, Math.min(seeds.length, availableParallelism() - 1)));
  const results: SeedResult[] = [];
  const queue = [...seeds];
  const worker = async () => {
    for (let seed = queue.shift(); seed !== undefined; seed = queue.shift()) {
      const r = await new Promise<SeedResult>((resolve, reject) => {
        // Re-run this script under vite-node for one seed.
        const p = spawn(process.execPath, [process.argv[1], fileURLToPath(import.meta.url), '--', '--child', seed, '--to', String(to), '--examples', String(keep)], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', (code) => {
          const line = out.split('\n').find((l) => l.startsWith('@@'));
          if (code !== 0 || !line) reject(new Error(`seed ${seed} failed (exit ${code})`));
          else resolve(JSON.parse(line.slice(2)));
        });
      });
      results.push(r);
      console.error(`  ${seed}: ${(r.ms / 1000).toFixed(0)} s`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  results.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed));
  const json = arg('--json');
  if (json) writeFileSync(json, JSON.stringify(results, null, 2));
  report(results, to);
}

function report(results: SeedResult[], to: number) {
  const years = CHECKPOINTS.filter((y) => y <= to);
  const width = Math.max(...VIOLATION_KINDS.map((k) => k.length));
  console.log(`\nViolations summed over ${results.length} seeds (seeds affected in brackets)\n`);
  console.log(' '.repeat(width) + years.map((y) => String(y).padStart(10)).join(''));
  for (const k of VIOLATION_KINDS) {
    const cells = years.map((y) => {
      const n = results.reduce((s, r) => s + (r.counts[y]?.[k] ?? 0), 0);
      const seeds = results.filter((r) => (r.counts[y]?.[k] ?? 0) > 0).length;
      return (n ? `${n} (${seeds})` : '·').padStart(10);
    });
    console.log(k.padEnd(width) + cells.join(''));
  }
  const total = results.reduce((s, r) => s + VIOLATION_KINDS.reduce((t, k) => t + (r.counts[years[years.length - 1]]?.[k] ?? 0), 0), 0);
  console.log(`\nTotal at ${years[years.length - 1]}: ${total}`);
  // A town well short of what it could support is failing to find room to grow.
  console.log('\nHouseholds / could support, and the worst seed\'s share:');
  for (const y of years) {
    const shares = results.filter((r) => r.capacity[y] > 0).map((r) => r.households[y] / r.capacity[y]);
    const line = results.map((r) => `${r.households[y] ?? '-'}/${r.capacity[y] ?? '-'}`).join('  ');
    console.log(`  ${y}  ${line}${shares.length ? `   worst ${(Math.min(...shares) * 100).toFixed(0)}%` : ''}`);
  }
  reportForm(results);
  reportHistory(results);
  console.log('\nExamples at the last checkpoint:');
  for (const k of VIOLATION_KINDS) {
    const ex = results.flatMap((r) => (r.examples[k] ?? []).map((v) => ({ seed: r.seed, v }))).slice(0, 4);
    if (!ex.length) continue;
    console.log(`  ${k}:`);
    for (const { seed, v } of ex) console.log(`    ${seed} @${v.at.x.toFixed(0)},${v.at.y.toFixed(0)} ids ${v.ids.join(',')} size ${v.size.toFixed(1)} — ${v.note}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const med = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pc = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');

/** Layer 2: the town's form by district, as the median over seeds. */
function reportForm(results: SeedResult[]) {
  const rows: [string, (f: Form) => number, (x: number) => string][] = [
    ['plots', (f) => f.plots, (x) => String(Math.round(x))],
    ['frontage m', (f) => f.frontage.median, f1],
    ['frontage perches', (f) => f.frontage.median / 5.03, f1],
    ['depth m', (f) => f.depth.median, f1],
    ['width:depth', (f) => f.shape.median, f2],
    ['coverage', (f) => f.coverage, pc],
    ['back coverage', (f) => f.backCoverage, pc],
    ['front continuity', (f) => f.frontContinuity, pc],
    ['street length km', (f) => f.streets.length / 1000, f1],
    ['orientation order', (f) => f.streets.orientationOrder, f2],
    ['meshedness', (f) => f.streets.meshedness, f2],
    ['dead ends', (f) => f.streets.deadEndShare, pc],
    ['junction skew deg', (f) => f.streets.junctionSkew, f1],
    ['sinuosity', (f) => f.streets.sinuosity, f2],
  ];
  for (const year of FORM_AT) {
    const forms = results.map((r) => r.form[year]).filter((f) => f);
    if (!forms.length) continue;
    const cols: [string, (t: TownForm) => Form | undefined][] = [
      ['town', (t) => t.town],
      ...DISTRICTS.map((d) => [d, (t: TownForm) => t.districts[d]] as [string, (t: TownForm) => Form | undefined]),
    ];
    const present = cols.filter(([, get]) => forms.some((f) => get(f)));
    console.log(`\nForm in ${year} (median over seeds that have the district)\n`);
    console.log(' '.repeat(20) + present.map(([n]) => n.slice(0, 13).padStart(14)).join(''));
    for (const [label, get, fmt] of rows) {
      const cells = present.map(([, d]) => fmt(med(forms.map((f) => d(f)).filter((x): x is Form => !!x).map(get))).padStart(14));
      console.log(label.padEnd(20) + cells.join(''));
    }
    console.log(`whole-valley orientation order ${f2(med(forms.map((f) => 1 - Math.pow(Math.max(0, f.valleyEntropy - Math.log(4)) / (Math.log(36) - Math.log(4)), 2))))} (all ways, for comparison)`);
    const lf = forms.flatMap((f) => f.leapfrog);
    if (lf.length) console.log(`estates: ${lf.length}, distance from earlier plots median ${f1(med(lf))} m, over 150 m: ${lf.filter((x) => x > 150).length}`);
  }
}

/** Layer 3: the town's history against the targets. */
function reportHistory(results: SeedResult[]) {
  console.log('\nHistory (value per seed; * outside the range)\n');
  const names = [...new Set(results.flatMap((r) => r.history.map((h) => h.name)))];
  const fmt = (h: HistoryCheck | undefined) => {
    if (!h) return '·';
    const v = h.value === null ? 'none' : Math.abs(h.value) >= 100 ? String(Math.round(h.value)) : h.value.toFixed(2);
    return h.pass ? v : `${v}*`;
  };
  for (const name of names) {
    const hs = results.map((r) => r.history.find((h) => h.name === name));
    const any = hs.find((h) => h)!;
    const pass = hs.filter((h) => h?.pass).length;
    const n = hs.filter((h) => h).length;
    const range = `${any.range.min}–${any.range.max === Infinity ? '' : any.range.max}`;
    console.log(`${name.padEnd(34)} ${String(pass).padStart(2)}/${n}  [${range}]  ${hs.map(fmt).join(' ')}`);
  }
}
