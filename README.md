# Palimpsest

A browser simulation of a settlement growing from scratch over centuries.
The default scenario is an English river valley starting in 900 CE.

- Design: [`docs/spec.md`](docs/spec.md)
- Prior art: [`reports/City growth simulation prior art.md`](reports/City%20growth%20simulation%20prior%20art.md)

## Running

```sh
npm install
npm run dev        # open the printed URL; ?seed=valley&year=1100 picks a seed and fast-forwards
npm test
npm run headless -- valley 200   # run without a browser and print metrics
```

## Layout

- `src/sim/` — the core: clock, rasters, routing, street graph, route insertion, metrics
- `src/plugins/` — plug-in interfaces and the medieval England scenario
- `src/render/` — the 2D map view
