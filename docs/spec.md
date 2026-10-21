# Town growth simulation — spec

A browser simulation of a settlement growing from scratch over centuries.
It aims to be plausible and reasonably faithful to the research on how real
towns formed (see `reports/City growth simulation prior art.md`), without
being a true simulator of the world. It should be good to look at and easy
to build on.

Default scenario: **an English river valley, starting in 900 CE** with
scattered farmsteads, through village nucleation, open-field reorganisation,
a market town, and onward.

## Principles

- **Vector geometry is the source of truth.** Streets are a graph of
  polylines; parcels and buildings are polygons. Nothing visible is drawn
  from a grid, so no layout is forced into one.
- **Fields are rasters.** Continuous quantities — elevation, wetness,
  movement cost, ground wear, land value — live on rasters, used only as
  inputs to the vector processes.
- **Shape comes from history, not from shape rules.** Urban plots are cut
  from the rural parcels they replace; old boundaries persist.
- **Everything regional, technological or legal is a plugin.** The core
  knows nothing about England, ploughs or burgage tenure.
- **Deterministic.** All randomness flows from a seeded RNG; a seed and a
  plugin set reproduce a run exactly.
- **The simulation knows nothing about rendering.** Renderers read state.

## Core loop

A simulation clock (in years) runs **processes**, each with its own rate,
plus an **event queue** for discrete happenings (a building completes, a
householder dies, a charter is granted, the open fields are reorganised).

1. **Demand** — population and the settlement's role decide how many trips
   happen and which land uses are needed.
2. **Movement** — trips between destinations wear the ground and add usage
   to street-graph edges; edges upgrade or decay.
3. **Value** — land value from accessibility over the graph.
4. **Development** — the tenure plugin subdivides valuable parcels; uses bid
   for sites; buildings go up front-first and infill backward.
5. **Feedback** — new buildings and uses become destinations (back to 2).

## Subsystems

### Terrain and geography
- Heightmap raster, a river as a vector polyline with width, wetness, soils.
- Fords are explicit features where crossing is possible; bridges come from
  the technology plugin.
- External gateways: where routes leave the map toward other places.

### Movement and streets
- **Cost:** Tobler's hiking function (anisotropic: uphill ≠ downhill),
  16-neighbour least-cost search, point costs at fords, wet-ground penalty.
  Ground wear and existing roads lower cost.
- **Regional bootstrap:** before any walkers, sum least-cost routes between
  every pair of destinations ("everywhere to everywhere", White & Barber
  2012) to seed the through-routes.
- **Walkers:** each year, a sample of trips (weighted by a gravity model)
  is routed; each sample stands in for many real trips.
- **Wear raster:** walkers deposit wear, wear decays (Helbing 1997).
- **Graph insertion:** each route is resampled and matched to existing edges
  within a snap radius; matched stretches add usage, unmatched stretches
  become new edges joined at junctions (incremental track insertion, from
  GPS map inference, Ahmed et al. 2015). A periodic re-skeleton of the wear
  raster is a later addition.
- **Hierarchy:** path → track → lane → road (→ street once built up). An
  edge upgrades when its usage exceeds its upkeep and decays when it does
  not (Levinson & Yerra 2006; Tero's reinforcement rule). Unused tracks are
  abandoned.
- **Holloways (later):** heavily used unpaved slopes incise the terrain.

### Countryside (milestone 2)
- Pipeline: terrain and drainage → furlongs oriented by slope → strips
  (~a furlong long, reverse-S ends; Eyre 1955) → strips allocated to
  households as scattered holdings (McCloskey).
- **Open-field reorganisation is a dated event**, not the starting state.

### Parcels and plots (milestone 3+)
- Plot = polygon with edges tagged frontage / side / back.
- **Urbanisation consumes whole fields or furlong blocks at once**, streets
  parallel to the field's long side (Ward 1962).
- Initial burgage widths drawn from a **varied** distribution of perch
  multiples (Tait 2009; Slater), not one uniform unit.
- Operators: lengthwise split (direction interpolated between the side
  boundaries), depth split, merge (union of adjacent plots, same holder).
  Start with straight cut lines; weighted straight skeleton later.
- **History log:** every split, merge and boundary move is recorded with
  parent and child IDs. Retired boundaries are **ghosts** that later cuts
  prefer.
- Change probabilities depend on neighbours (Whitehand). Merges need
  purchases from several holders.
- **Burgage cycle:** per-plot state machine — layout → back-land infill →
  saturation → clearance — driven by built coverage (Conzen 1960).

### Land uses (milestone 3, expanded in 6)
A catalogue (part of the technology plugin) of use types: houses, shops,
market place, church, mill, tannery, friary, kilns and so on. Each declares:
- land needed; site requirements (water, fall of water, road class, market
  frontage, slope);
- a bid function over accessibility;
- nuisance radius; relocation cost; trips generated.

The demand plugin states what the settlement needs; uses bid for sites,
bid-rent style. A plot can hold several uses (shop front, workshop behind).
**No goods/price economy.**

**Fringe belts emerge**: during growth pauses, low-bid land-hungry uses take
cheap edge land; institutional holders rarely sell; large institutional
plots are costly to redevelop — so renewed growth jumps over them.

### Tenure
- Rights table: parcel × right → holder. Rights: access, withdrawal,
  management, exclusion, alienation (Schlager & Ostrom 1992) plus build,
  subdivide, inherit. Rights need not nest.
- Holders: household, community, lord, church, borough, state, company.
- Regimes: private, common, use-right. **Regime-change events** rewrite
  columns (enclosure, a borough charter, the 1992 ejido reform).
- Sales only where the alienation right is held.
- Inheritance: partible or impartible, a tenure parameter.

### Land value
- Placement potential after Raimbault (density × network distance ×
  centrality), with angular centrality (Hillier & Iida) approximated by
  sampling for browser speed.

### Planned growth
- Founding a planned town is an event that lays a template (streets, plot
  module) over the existing substrate; emergent processes take over after.
- Technology: surveying precision (improving from the mid-12th century)
  controls how regular a planned layout comes out.

## Plugins

| Plugin | Decides |
|---|---|
| Geography | terrain, water, soils, gateways, initial destinations |
| Technology | movement costs by mode, bridging, building types, land-use catalogue, surveying precision |
| Tenure | rights, regimes, subdivision/merge/inheritance rules, regime-change events |
| Demand | population, trips, land-use needs, scenario events |

Scenarios planned: medieval England (default), 19th-century US railroad
town (PLSS grid, company plat, rail-side industry), later ejido.

## Validation (cheap, in browser)

Computed live on the simulated town and tracked over time:
- street orientation entropy (Boeing 2019), meshedness, node-degree shares,
  circuity;
- later: block shape factor (Louf & Barthélemy 2014), plot frontage/depth,
  building coverage, Dibble et al.'s period variables.

An offline reference pipeline (momepy / OSMnx on real English towns) is a
stretch goal.

## Rendering

- 2D canvas debug view throughout (terrain, wear, graph, values, labels).
- 3D view (Three.js) from about milestone 5: terrain mesh, extruded
  footprints with gable roofs, roads draped on terrain.

## Milestones

1. **Paths** — terrain, river and ford, gateways and farmsteads, regional
   bootstrap, walkers, wear, graph insertion, edge hierarchy, cheap street
   metrics, new farmsteads drawn to tracks. *Done.*
2. **Countryside** — field pipeline, strip allocation, open-field event.
   *Done:* farmsteads get hedged closes; the open-field event (c. 1000–1080)
   pools the township, lays out furlongs (blocks about a ploughing length
   along strips running downslope, grown out from one another so they share
   headlands, and stopping at wet or steep ground, a turn in the slope, ways
   and the river; leftovers become meadow, common or gores) cut into
   reverse-S strips,
   allocates them by sun-division with demesne blocks and glebe, and draws
   most households into a nucleated village by the church (deserted
   farmsteads' ways then fade). Standing crops are costly to walk across, so
   journeys keep to headlands. A three-course rotation colours the fields.
   Click a parcel to see its rights bundle and the holder's scattered strips.
3. **Nucleus** — planting event, rights table, burgage plots from whole
   fields, history log, first land uses. *Done:* the village gets a
   churchyard (church facing east) and tofts and crofts cut along its ways;
   when they run out it spreads along its lanes, taking strips at the edge
   of the fields. A water mill follows (c. 1070–1150). A market charter
   (c. 1150–1230) plants a borough where the busiest road leaves the
   village: a cigar-shaped market place and burgage plots of varied perch
   widths whose side boundaries follow the old strips where they run within
   35° of square, with planned back lanes behind each row. The strips under
   the plots are given up (recorded in the history; slivers dropped).
   Burgesses take up plots nearest the market first, shops on the market
   frontage, houses beyond. Burgage tenure gives the burgess every right,
   including sale and division; village tofts stay held of the lord.
   Plot cutting is a general frontage cutter (`src/sim/plots.ts`).
4. **US railroad scenario.**
5. **3D view.**
6. **Town dynamics** — burgage cycle, full land-use catalogue, fringe belts,
   inheritance. *Done:* the demand plugin sets how many households the town
   can support each year (growth to c. 1300, the Black Death and a long
   slump, slow recovery, a pause before industry, the industrial boom); the
   town grows or shrinks toward it (`src/sim/dynamics.ts`). Householders die
   and plots pass to heirs (split among them where inheritance is partible),
   fall vacant or are sold; burgesses sell off half-plots; neighbours buy
   empty plots and merge them. Each plot runs the burgage cycle — workshops
   and later courts of cottages fill the back land to a climax, decline
   clears it, and old fronts are rebuilt in the style of the day — with
   neighbouring plots raising each other's odds. When the plots run out, new
   ones are laid out along the ways leaving the town; after enclosure
   (c. 1760–1820, a regime-change event, `src/sim/enclosure.ts`) builders buy
   whole fields next to the town and lay streets along their length with
   terraced, later villa, plots (`src/sim/expansion.ts`). Land value comes from
   network accessibility to the market (`src/sim/landvalue.ts`). Land uses bid
   for sites (`src/sim/landuse.ts`): inns and chapels take over plots;
   friaries, tanneries, workhouses, gasworks and cemeteries take cheap ground
   at the edge, mostly in growth pauses, and their holders rarely sell, so
   later growth jumps over them. Engulfed noisome trades move out. Walkers
   keep to the streets once plots and buildings are in the way.
7. **Offline reference pipeline** and fuller validation.
