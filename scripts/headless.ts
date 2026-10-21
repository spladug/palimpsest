// Run the simulation without a browser and print a summary. Usage: npx vite-node scripts/headless.ts [seed] [years]
import { createWorld } from '../src/sim/world';
import { medievalEngland } from '../src/plugins/medieval-england';

const seed = process.argv[2] ?? 'valley';
const years = Number(process.argv[3] ?? 200);
let t = performance.now();
const world = createWorld(seed, medievalEngland);
console.log(`created in ${(performance.now() - t).toFixed(0)} ms; edges ${world.graph.edges.size}`);
t = performance.now();
for (let y = 1; y <= years; y++) {
  world.clock.advance(world, 900 + y);
  if (y % 50 === 0) {
    const m = world.metrics[world.metrics.length - 1].metrics;
    console.log(
      `${900 + y}: places ${world.places.length}, nodes ${m.nodes}, edges ${m.edges}, ` +
        `len ${Object.entries(m.lengthByClass).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}km`).join(' ')}, ` +
        `H=${m.orientationEntropy.toFixed(2)} mesh=${m.meshedness.toFixed(3)} dead=${m.deadEndShare.toFixed(2)} circ=${m.circuity.toFixed(2)}; ` +
        `town ${world.town.households}/${Math.round(world.town.capacity)} parcels ${world.cadastre.parcels.size} buildings ${world.cadastre.buildings.size} ` +
        `(${(performance.now() - t).toFixed(0)} ms)`,
    );
  }
}
console.log(`${years} years in ${(performance.now() - t).toFixed(0)} ms`);
for (const e of world.log) console.log(`  ${e.year}: ${e.text}`);
