# Validation plan

Milestone 7. The question: where does the simulated town hold up against real
English towns, and where doesn't it? We check it in three layers, from cheapest
to most demanding:

1. **Is it physically possible?** Hard invariants that should always be zero.
2. **Do the shapes look right?** Distributions of form (plots, buildings,
   streets, blocks) against measured real towns, period by period, plus a
   side-by-side visual review.
3. **Does the history hold up?** Population, the order and timing of events,
   the town's role, against documented towns.

Every mismatch gets triaged as a **bug**, a **missing process**, a
**parameter**, or **out of scope** (knowingly). That triage is the backlog.

Method: pattern-oriented modelling (Grimm et al. 2005). Many weak patterns
at several scales are more convincing than one strong fit, and harder to hit
by tuning.

## Reference towns

One per county (Ross standing in for Wiltshire), chosen so the set spans
the kinds of town the simulation claims to make, plus a planted contrast:

| County | Town | Why |
|---|---|---|
| Devon | **Totnes** | Saxon burh on a ridge above a river crossing (the Dart); a long main street climbing from the bridge; tight burgages. The closest match to the default river-valley scenario. |
| Yorkshire | **Skipton** | Castle and market town in the Aire valley (charter 1204); a wide market street; canal and textile growth in the 19th century. Tests the industrial phase. |
| Herefordshire | **Ross-on-Wye** | A market town on a sandstone bluff above a crossing of the Wye; the church on the hilltop, a 17th-century market hall in the market place, a long main street down to the bridge; modest Victorian growth. Tests siting on a slope, market-place shape and late-medieval stasis. |
| Hertfordshire | **Hitchin** | An organic market town, not planted; a railway in 1850; large Victorian and Edwardian suburbs. Tests unplanned growth and post-enclosure estates. |
| Hertfordshire (contrast) | **Baldock** | Planted by the Templars c. 1140s; wide crossing streets. A planted control. |

Alternatives if one proves awkward for data: Okehampton or Tavistock
(Devon), Otley or Thirsk (Yorkshire), Marlborough or Ledbury
(Wiltshire / Herefordshire), Ware or Berkhamsted (Hertfordshire).

### Sources

- **Extensive Urban Surveys** (Historic England with the county councils):
  plan-unit maps that zone each town by period — medieval core, ribbon
  growth, post-enclosure estates and so on. These give the period districts
  we compare against.
- **OS 1st-edition 25-inch** (c. 1880s; NLS georeferenced): the 1900 state
  of plots, buildings and streets, before 20th-century change. Digitise the
  core and one Victorian district per town. This is the costly part, so it's
  limited to Totnes and Hitchin first.
- **Tithe maps** (c. 1840): the pre-Victorian plot and field pattern.
- **OpenStreetMap** via OSMnx / momepy: present-day streets and buildings.
  Medieval street lines and plot fronts in historic cores have mostly
  survived, so these are usable for cores, not suburbs.
- **Plot-level literature:** Conzen (Alnwick, Ludlow), Slater, Tait
  (burgage widths in perches), Baker & Slater on plan units.
- **Documents:** Domesday, the 1377 poll tax, the 1524 lay subsidy, the
  1801–1901 censuses; the Gazetteer of Markets and Fairs (to 1516) for
  charters; dates of enclosure acts, railways, gasworks and board schools.

The offline pipeline (Python: OSMnx, momepy, geopandas) writes reference
distributions to `validation/reference/*.json`. The simulation side stays
TypeScript.

## Layer 1: physical plausibility (automated, target zero)

A `validate` script runs N seeds to 1900 and counts violations at fixed
dates. Also exposed in the browser as an overlay that highlights offenders
on the map.

- Parcels overlapping parcels; slivers; self-intersecting rings.
- Buildings overlapping buildings; buildings outside their parcel; buildings
  on a way's carriageway or in the river (mills excepted).
- Town parcels (tofts, burgages, plots, precincts, works) cut across a way.
- Ways crossing without a junction (no bridges or level crossings yet);
  ways crossing the river away from a ford or bridge; self-crossing ways.
- Plots with no street access; buildings that don't face their frontage
  (front ranges whose ridge is more than ~15° off the frontage line).
- Degenerate shapes: wedge or triangular building footprints, buildings
  under a minimum width, plots narrower than a minimum frontage.
- Buildings on implausibly steep ground or, before drainage, on wet ground.

## Layer 2: shapes and form

### 2a. Distributions against the reference towns

Measured **within the built-up area and per period district**, never over
the whole valley (whole-valley metrics drown the town in rural tracks).
For each metric we compare the spread across seeds to the spread across
reference towns and districts.

- **Plots:** frontage width (in perches as well as metres), depth,
  width-to-depth ratio, how parallel the side boundaries are; how far side
  boundaries follow the old strips (the sim's own history log against the
  ridge-and-furrow alignment on tithe maps).
- **Buildings:** footprint area and aspect, ridge orientation to street,
  street-front continuity (share of frontage built) by period, back-land
  coverage by period (the burgage cycle against Conzen's dated stages).
- **Streets:** sinuosity, junction angles (medieval oblique against
  Victorian square), orientation entropy and order by district, meshedness,
  dead-end share, gradient profiles and how streets sit relative to the
  contours.
- **Blocks:** shape factor (Louf & Barthélemy 2014), size, number of plots.
- **Market place:** area, length-to-width ratio, position relative to the
  church, the crossing and the main road.
- **Siting:** the town against the river, ford or bridge, floodplain and
  slope; the church against the core; noisome trades against water and wind.
- **Countryside:** furlong size and strip length (against Hall's surveys of
  Northamptonshire fields as the best measured set); after enclosure,
  allotment size and straightness of hedges and new roads.

### 2b. Side-by-side visual review

Numbers miss things the eye catches at once, so we also look:

- **Same-style rendering.** Import the reference geometry (digitised 1880s
  plots and buildings, OSM streets) into the sim's own renderer, so the
  comparison is of shapes, not styles. Same scale, same date.
- **A gallery page** (published as an artifact): for each period, a sim
  core and district next to Totnes, Skipton, Ross-on-Wye, Hitchin and
  Baldock, with the layer 1 offenders highlighted.
- **A review rubric:** a fixed checklist per image (streets follow the
  ground? the market reads as a market? plots and fronts continuous? anything
  floating, wedged or overlapping? growth contiguous or scattered?), scored
  each round so we can see progress.
- **A blind test, later:** mix sim and real plans at the same style and see
  whether people can tell them apart, and what gives the sim away.
- **Snapshot regression:** fixed seeds rendered at fixed dates and zooms
  after each change, so unintended changes in form show up.

## Layer 3: history

- **Population:** households over time against documented towns of similar
  size and type: size at c. 1300, Black Death losses (30–50% at once, then
  slow recovery), the 16th–17th-century recovery, growth from 1801 by census.
- **Events:** order and dates (charter, friary, Dissolution, enclosure,
  gasworks, cemetery, board school) against the documented ranges; nothing
  before it was possible.
- **Anachronisms:** street, building and institution names checked against
  the date they could first appear.
- **Role:** the number of inns, chapels, markets and trades per head
  against directories (Pigot 1830s, Kelly 1880s).

## Sensitivity

Vary the seed (at least 20) and the main parameters one at a time. Report
which results are robust and which hang on a lucky value. A result that
only holds for one seed counts as unexplained.

## First findings (seed `valley` only, 2026-10-21)

From a quick probe and screenshots, before any of the above is built:

**Holds up**
- Parcels never overlap; no slivers; no buildings in the river.
- Size: ~175 households at 1300 and ~1,260 at 1900, plausible for a small
  market town that industrialised.
- Burgage rows perpendicular to the main street, the town strung along it,
  the church and village apart; event dates mostly sensible (friary 1249,
  Dissolution 1538, cemetery 1867, board school 1872).

**Doesn't hold up**
- *Ways and plots collide:* by 1900, 43 buildings stand on a road or lane
  carriageway and ~70 town plots extend into one. Likely when a way is
  upgraded (wider) or rerouted after the plots are cut. Some are large
  (works plots with 450–500 m² under a road).
- *Buildings overlap:* 11 pairs by 1900, often a back workshop and a rebuilt
  front townhouse (exactly 20 m² each time: the rebuild doesn't clear what's
  behind). 18 buildings stick out of their parcel by 2–3 m².
- *Ways cross without junctions:* 4 by 1900, all between new streets.
- *Wedge-shaped front buildings* along the curved stretch of Market Street:
  a sawtooth of triangles, physically implausible.
- *Gappy medieval fronts in 1900:* real market-town fronts were near
  continuous by then.
- *Back land fills too early:* 101 of 195 plots have full back land by 1300;
  heavy repletion is mostly post-medieval.
- *Victorian growth is scattered:* estates spring up in isolated fields well
  out in the countryside rather than mostly next to the built-up edge.
- *Enclosure doesn't look like enclosure:* the new closes keep the furlongs'
  irregular outlines; parliamentary allotments are straight-hedged and
  regular, with straight new roads.
- *Street network gets less connected as the town grows* (meshedness 0.24 →
  0.07, dead ends 0.07 → 0.34). Consistent with new streets ending blind.
- *Black Death looks weak* at 50-year sampling (175 → 165 households).
- *Anachronisms:* Waterloo Road in 1768, Albert Road in 1838; "Railway
  Terrace" in 1864 with no railway.
- *Metrics can't see the town:* computed over the whole valley, so orientation
  entropy barely moves in a thousand years.

## Layer 1 results (2026-10-21)

`npm run validate` runs 8 seeds (`valley`, `seed1`…`seed7`) to 1900 in
parallel (about a minute) and prints violations at 1100, 1250, 1400, 1600,
1760, 1850 and 1900, with examples, and households against what the town
could support. `--json` writes everything out. The map's **Problems** layer
rings each violation. The checks live in `src/sim/validate.ts`.

At 1900, summed over the 8 seeds:

| Check | Before | After |
|---|---:|---:|
| Plot on a way | 795 | 11 |
| Building off its parcel | 329 | 2 |
| Building on a way | 300 | 6 |
| Plot without access | 456 | 10 |
| Narrow building | 132 | 4 |
| Building overlap | 74 | 0 |
| Wedge building | 57 | 2 |
| Ways cross without a junction | 44 | 3 |
| Parcel overlap | 11 | 0 |
| Malformed plot | (new) | 2 |
| **Total** | **2,199** | **40** |

("Before" is the first version of the checks; since then access via a
market place counts, and malformed plots are a new check.)

What was wrong, and the fix:

- **Ways moved after plots were cut.** Merging two junctions swung the last
  stretch of every way at one of them, sometimes across a whole row of
  houses; tidying away a short way did the same; and a way running between
  two merged junctions was deleted outright. Junctions now merge toward the
  weightier ways, moved ways gain a short leg instead of swinging, and a way
  between the two is kept (`graph.ts`: `mergeNodes`, `collapseEdge`).
- **Ways widened over plots.** A way upgraded to a road widened to 10 m
  whatever stood beside it. It now widens only as far as the plots and
  buildings allow, and keeps that width (`GraphEdge.maxWidth`, `wayWidth`).
- **New ways through plots.** Walkers' paths only avoided buildings; they now
  avoid plots, churchyards and precincts too. Back lanes and field streets are
  checked at their full width.
- **Crossings without junctions.** New streets laid out over fields now make a
  crossroads where they cross an old way (`graph.nodeCrossings`).
- **Malformed plots and wedge buildings.** The plot cutter kept scraps of land
  whose recorded front wasn't really their front, and buildings clipped to
  them came out as triangles. A plot's front is now the stretch where it
  really reaches the street, plot fronts follow a bending street rather than a
  chord, houses are fitted (shallower where a plot narrows) rather than
  clipped, and a plot too narrow for a 3.6 m house stays a yard.
- **Back buildings and rebuilt fronts.** Back ranges could lean 10% over the
  neighbour's wall; now they fit wholly inside. A new front pulls down what
  stands where it goes.
- **Churchyards over closes**, and **plots losing their street** (ways that
  plots open onto are no longer left to vanish).

Stricter plots made ribbon growth fail more often, so towns fell behind
what they could support; ribbon growth now tries more of the ways out of town.
Households stay within 77–92% of capacity at every checkpoint.

**Still open** (the backlog for layer 1): a few plots and buildings on old
roads at bends; a handful of crossings without junctions between old ways;
the odd malformed plot from a merge. The tests now require no overlaps, no
buildings in the river and fewer than 20 violations in a whole town.

**Not covered by layer 1, but visible on the map:** large empty plots and
irregular leftovers behind the market; Victorian streets ending blind at the
edge of their field; estates scattered across the countryside.

## Order of work

1. ~~Batch runner and layer 1 invariants (`npm run validate`), with the map
   overlay. Fix the collisions it finds.~~ Done; see above.
2. Town-scoped and per-district metrics; layer 3 population and event checks.
3. Reference pipeline: EUS plan units and OSM for all five towns; digitise
   1880s cores for Totnes and Hitchin.
4. Layer 2 distributions and the gallery; the review rubric.
5. Sensitivity runs; triage everything into the backlog.
