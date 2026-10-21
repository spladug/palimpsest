# Historical Town Formation and Plot-Pattern Evolution: Models, Simulations and Computational Analyses

Scope note: this is an annotated bibliography for a browser-based vector simulation of a town growing over centuries (default: medieval England). Sources already known to the team (Weber et al. 2009, Emilien et al. 2012, Vanegas et al. 2012, Parish & Müller 2001, Lechner 2003, Hillier, Erickson & Lloyd-Jones, SLEUTH, White & Engelen, Batty) are excluded. Verification status: [V] means I confirmed the title, authors and venue through a search result this session. [K] means the citation comes from my own knowledge and only partly matches search results, so check the DOI before formal citation. Direct page fetches failed in this session (connection errors), so the summaries come from abstracts and search-result descriptions, not full texts.

## Q1. Computational, agent-based or CA models of medieval and pre-modern town formation (Europe and beyond)

### Takeaway
Few models simulate the internal growth of a single pre-modern town over centuries. The closest are (a) a graphics-side simulation of walled-city evolution (Mas, Martin & Patow 2020), (b) archaeological ABMs of regional settlement concentration in medieval NW Europe (SimFeodal), and (c) empirical "physics of cities" studies of street networks over 200 years, which give calibration targets (Barthelemy et al. 2013; Strano et al. 2012). Digital-heritage procedural work (Puuc/Xkipché) reconstructs one moment in time and does not simulate growth.

### Cited Findings

**1. Mas, A., Martin, I. & Patow, G. (2020). "Simulating the Evolution of Ancient Fortified Cities." *Computer Graphics Forum* 39(1).** [V] DOI handle: https://diglib.eg.org/handle/10.1111/cgf13897 (DOI 10.1111/cgf.13897)
- Summary: An interactive loop steps through a user-set number of years. User-defined events (city growth, battles, wall creation or expansion) drive the city's evolution, and battle simulation finds weak points in the walls, which are then strengthened as offensive weaponry develops. It supports forward and inverse design and was tested on Carcassonne, Gerunda (Girona) and the Barcelona Ciutadella, with results "validated by historians" — [EG Digital Library](https://diglib.eg.org:443/handle/10.1111/cgf13897).
- Relevance: This is the nearest graphics precedent for "a town over centuries" and for an event timeline that can be scripted or emergent. Borrow the year-stepping loop, the event hooks and the inverse-design idea (fit the simulation to a known end state). Gap: it centres on walls and defence and has no plot or burgage dynamics. Follow-up: Mas's PhD thesis *Temporal evolution of ancient buildings* (Universitat de Girona) — [TDX](https://www.tdx.cat/handle/10803/668980).

**2. SimFeodal: Cura, R., Tannier, C., Leturcq, S., Zadora-Rio, E., Lorans, E. & Rodier, X. "An agent-based model for exploring the combined effects of social and demographic changes on the concentration and hierarchy of rural settlement patterns in North-Western Europe during the Middle Ages (800–1200 CE)." *Journal of Anthropological Archaeology* (2020).** [V for title and authors; volume and article number not confirmed] Publisher page: https://www.sciencedirect.com/science/article/abs/pii/S027841651930279X ; open version: https://hal.archives-ouvertes.fr/hal-02282723
- Summary: A GAMA-platform ABM of peasant households relocating between 800 and 1200 CE. Its hypotheses are weakening central authority, fragmentation of seigneurial power and parish formation. It reproduces the emergence of enduring, concentrated, hierarchical settlement clusters — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S027841651930279X); [HAL](https://hal.archives-ouvertes.fr/hal-02282723). An earlier book-chapter version is in the TransMonDyn volume — [OpenEdition](https://books.openedition.org/pufr/19927).
- Relevance: Covers the stage just before a town exists, when attractors (church, castle, market) pull households into nuclei. Borrow its attractor rules, which map onto a "pluggable tenure" (lordship, parish) module. Gap: regional scale with point settlements and no geometry.

**3. Barthelemy, M., Bordin, P., Berestycki, H. & Gribaudi, M. (2013). "Self-organization versus top-down planning in the evolution of a city." *Scientific Reports* 3:2153.** [V] https://arxiv.org/abs/1307.2203 ; PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC3703887
- Summary: An empirical study of the Paris street network from 1789 to 2010. Most network measures change smoothly. The main signatures of central planning (Haussmann) are a spatial reorganisation of centrality and a change in the distribution of block shapes — [arXiv](https://arxiv.org/pdf/1307.2203).
- Relevance: Gives quantitative fingerprints for telling planned growth from emergent growth, which can serve as validation metrics (block-shape distribution, centrality shifts) for a hybrid engine. Gap: it is analysis, not a generative model.

**4. Strano, E., Nicosia, V., Latora, V., Porta, S. & Barthelemy, M. (2012). "Elementary processes governing the evolution of road networks." *Scientific Reports* 2:296.** [V] https://arxiv.org/abs/1203.0300 ; https://strathprints.strath.ac.uk/40090/
- Summary: Covers about 200 years of road-network change in the Groane area north of Milan. Two elementary processes drive growth: "densification" around existing centres and "exploration" at the urbanisation front. High-centrality roads stay stable over time as the backbone, and cell (block) shapes become more homogeneous as urbanisation proceeds — [Strathprints](https://strathprints.strath.ac.uk/40090/).
- Relevance: Densification vs exploration maps directly onto the walkers-wear-trails design (infill trails vs frontier trails). The stability of the high-centrality backbone empirically supports persistent "ghost" structure. Gap: the network only, with no plots.

**5. Müller, P., Vereenooghe, T., Wonka, P., Paap, I. & Van Gool, L. (2006). "Procedural 3D Reconstruction of Puuc Buildings in Xkipché." *VAST 2006 (Eurographics Symposium on Virtual Reality, Archaeology and Cultural Heritage)*, pp. 139–146.** [V] https://diglib.eg.org/handle/10.2312/VAST.VAST06.139-146 ; PDF: https://peterwonka.net/Publications/pdfs/2006.VAST.Mueller.Xkipche.pdf
- Summary: Shape-grammar rules for Puuc Maya architectural parts are driven by GIS inputs (footprints, elevation, architectural attributes) to reconstruct a whole Mesoamerican site — [EG Digital Library](https://diglib.eg.org/handle/10.2312/VAST.VAST06.139-146).
- Relevance: A template for linking archaeological GIS data to procedural building generation, and the main Mesoamerican digital-heritage precedent. Gap: one moment in time, with no growth dynamics.

### Inferences
- No ABM or CA model I found simulates the internal plot-level growth of a medieval English town over centuries. The project would fill a real gap between regional ABMs (SimFeodal) and graphics simulations of single sites (Mas et al.).
- The Paris and Milan studies give metrics (centrality stability, block-shape distributions, densification vs exploration rates) usable as "realism tests" for simulated output.

### Gaps
- I found no published ABM of the growth of a Roman, Pompeian, East Asian (e.g. Kyoto or Chinese walled-city) or Mesoamerican town that runs over time with plot geometry. The search for "procedural Pompeii" growth simulation found nothing in this pass. Older static procedural Pompeii reconstructions exist (Müller et al., c. 2005, from my knowledge), but they reconstruct rather than simulate growth.
- The "Recreating a medieval urban scene with virtual intelligent characters" paper (academia.edu) showed up in a search but was not checked; it looks like a crowd or scene paper, not a growth model.

## Q2. Computational treatment of Conzenian concepts (burgage cycle, fringe belts, plan units, plot metrology)

### Takeaway
Conzenian concepts are still mainly qualitative and descriptive. The computational work is analytical: GIS and statistical plot metrology, GIS atlases of planted towns, and recent attempts to systematise fringe-belt mapping and quantify morphological regions. I found no generative simulation of the burgage cycle itself, so this is an open niche the project can fill.

### Cited Findings

**6. Conzen, M.R.G. (1960). *Alnwick, Northumberland: A Study in Town-Plan Analysis*. Institute of British Geographers Publication 27.** [K] DOI 10.2307/621094 (JSTOR). The four phases of the burgage cycle as summarised in later literature: institutive (initial plot layout), repletive (progressive infill of plot backs), climax (saturation) and recessive (a sharp drop in building coverage before redevelopment) — [Sciforum conference paper summarising Conzen](https://sciforum.net/manuscripts/5993/manuscript.pdf).
- Relevance: The state machine for each plot in the engine. The four phases are discrete and easy to implement as plot-level state with coverage thresholds.

**7. Lilley, K.D., Lloyd, C.D. & Trick, S. (2007). "Designs and designers of medieval 'new towns' in Wales." *Antiquity* 81: 279–293.** [V] https://www.cambridge.org/core/journals/antiquity/article/designs-and-designers-of-medieval-new-towns-in-wales/5F2B4C5ED16C8DA5BFDFC575C3981FFF
- Summary: Uses GIS analysis of Edward I's new towns to test whether they followed a standard plan "applied by the hand of authority", and examines their grid layouts and plan geometry — [Cambridge Core](https://resolve.cambridge.org/core/journals/antiquity/article/designs-and-designers-of-medieval-new-towns-in-wales/5F2B4C5ED16C8DA5BFDFC575C3981FFF).
- Relevance: Evidence for parameterising "planned" plantation templates (street grid, plot module) in the planned-growth mode.

**8. Lilley, K.D., Lloyd, C.D. & Trick, S. (2005). *Mapping the Medieval Townscape: a digital atlas of the new towns of Edward I*. Archaeology Data Service.** [V] https://doi.org/10.5284/1000022
- Summary: A GIS database with downloadable raw data for 13 towns founded between 1277 and 1303: Aberystwyth, Beaumaris, Caernarfon, Caerwys, Conwy, Cricieth, Flint, Harlech, Holt, Newborough, Overton, Rhuddlan and Winchelsea — [ADS](https://archaeologydataservice.ac.uk/archives/view/atlas_ahrb_2005/).
- Relevance: The most directly usable dataset, with real vector plans of planted English and Welsh towns for calibration and validation.

**9. Lilley, K.D. (2011). "Taking measures across the medieval landscape: aspects of urban design before the Renaissance." *Urban Morphology* 15(1).** [V for title and venue; issue from memory] https://journal.urbanform.org/index.php/jum/article/view/3880
- Summary: Argues that improvements in measurement from the mid-12th century let towns be laid out more accurately, and that surveying based on practical and theoretical geometry produced orthogonal plans — [Urban Morphology](https://journal.urbanform.org/index.php/jum/article/view/3880).
- Relevance: Justifies a "technology" parameter (surveying precision over time) that changes how regular planned layouts are. Related: Slater, T.R., Lilley, K.D. & Scrase, T., "Geometry and medieval town planning," *Urban Morphology* — [link](https://journal.urbanform.org/index.php/jum/article/view/4178) [V for title and authors only].

**10. Tait, R. (2009). "Burgage plot patterns and dimensions in four Scottish burghs." *Proceedings of the Society of Antiquaries of Scotland* 138: 223–237.** [V] https://journals.socantscot.org/index.php/psas/article/view/9724
- Summary: A cartographic study of plot widths in Edinburgh, Canongate, St Andrews and Perth. Widths cluster around a unit width, with groups at quarter fractions: for Edinburgh the main group averages 7.7 m (25.3 ft), with groups at 5.8 m (¾ unit) and 9.7 m (1¼ unit) — [PSAS](https://journals.socantscot.org/index.php/psas/article/view/9724). A companion Elgin study (also in PSAS) found an 8.1 m unit with plots at 1¼, 1½, 1¾ and 2 units — [PSAS](https://journals.socantscot.org/index.php/psas/article/download/9756/9723/9707).
- Relevance: Hard numbers for plot metrology. Plots can be laid out in perch-based units and then split or merged in quarter-unit fractions, which yields the observed multimodal width histograms. These histograms can also serve as validation targets. Related review: "The archaeology of burgage plots in Scottish medieval towns: a review," PSAS — [link](https://journals.socantscot.org/index.php/psas/article/view/9608).

**11. Lilley, K.D. (2000). "Mapping the medieval city: plan analysis and urban history." *Urban History* 27(1): 5–30.** [V for title and venue; volume and pages from memory] https://www.cambridge.org/core/journals/urban-history/article/abs/mapping-the-medieval-city-plan-analysis-and-urban-history/BE0EA268097701D7DFD63A05FE4F8CD9
- Summary: A methodological review of Conzenian plan analysis (plan units, plot series) as a tool for reconstructing medieval urban development.
- Relevance: Conceptual vocabulary (plan units, plot series, plan seams) for the engine's data model. Each plot should record its plan unit or origin event, so plan seams can be read off the simulated output.

**12. Fringe-belt and morphological-region quantification (ISUF literature).** [V for existence; full citations not checked]
- A recent study proposes a systematic three-order hierarchy for fringe-belt mapping (formation, then modification, then forms and uses), because the lack of a systematic framework has limited the concept's use — summarised from [Urban Morphology / KTUN repository](https://gcris.ktun.edu.tr/entities/publication/f82c26d3-523f-4d70-9c3d-20ca65b8ebcb). Other work turns qualitative morphological regionalisation into quantitative GIS descriptors with statistical clustering — [Urban Morphology](https://journal.urbanform.org/index.php/jum/article/view/3945); see also Chen & Song, ISUF 2021, on the complexity and uncertainty of urban form — [Strathprints](https://strathprints.strath.ac.uk/80425/).
- Fleischmann, M. et al. (2022). "Evolution of Urban Patterns: Urban Morphology as an Open Reproducible Data Science." *Geographical Analysis*. [V] https://onlinelibrary.wiley.com/doi/10.1111/gean.12302 — open-source (momepy) morphometrics that could score simulated output.
- Relevance: These give analysis metrics, not generators. The engine can implement fringe belts generatively: land-extensive uses (friaries, tenter grounds, later institutions) placed at the edge when growth pauses, which then persist as the town grows past them.

### Inferences
- The burgage cycle has been formalised conceptually as four phases and linked to resilience and adaptive-cycle theory, but I found no generative computational model of it. Implementing it as a per-plot state machine on vector plots would be novel.
- Plot metrology data (Tait, the Elgin study, the Lilley atlas) give quantitative validation targets that most procedural-city work lacks.

### Gaps
- I could not confirm specific computational work by Baker & Slater, Whitehand or Kropf that simulates plot change, and I believe none exists in generative form. Kropf's work (e.g. "Aspects of urban form," *Urban Morphology* 2009, from memory) is a conceptual hierarchy, useful for the data model but not verified this session.
- A computational fringe-belt detection paper using network or historical GIS data was not found in this pass.

## Q3. Models of organic or irregular street formation (Islamic cities, vernacular settlements)

### Takeaway
The strongest formal generative work is on the Islamic medina. Duarte et al.'s Marrakech shape grammar, with its urban, negotiation and housing subgrammars, encodes bottom-up growth. Hakim gives rule-based generative processes drawn from Islamic building law, and Ben-Hamouche shows how inheritance-driven repeated subdivision gives Muslim cities their fractal complexity.

### Cited Findings

**13. Duarte, J.P., Rocha, J.M. & Ducla-Soares, G. (2007). "Unveiling the structure of the Marrakech Medina: A shape grammar and an interpreter for generating urban form." *AI EDAM* 21(4): 317–349.** [V for title, venue and year; issue, pages and DOI 10.1017/S0890060407000315 from memory] https://resolve-he.cambridge.org/core/journals/ai-edam/article/unveiling-the-structure-of-the-marrakech-medina-a-shape-grammar-and-an-interpreter-for-generating-urban-form/0C066743F7EF8E72F79C27D897D05E17 ; repository: https://rdpc.uevora.pt/handle/10174/2791
- Summary: A parametric urban shape grammar for the Zaouiat Lakhdar quarter of Marrakech with three subgrammars (urban, negotiation, housing). It compares top-down and bottom-up grammar design and shows a hand derivation of the existing fabric — [Penn State Pure](https://pure.psu.edu/en/publications/unveiling-the-structure-of-the-marrakech-medina-a-shape-grammar-a/).
- Relevance: The "negotiation grammar", in which neighbouring houses adjust boundaries against each other, is a direct precedent for neighbour-negotiated plot splitting and merging. The bottom-up derivation of cul-de-sac (derb) networks is a template for an "Islamic tenure" plugin.

**14. Hakim, B.S. (2007). "Generative processes for revitalizing historic towns or heritage districts." *Urban Design International* 12: 87–99.** [V] https://intbau.org/wp-content/uploads/2014/10/Generativeprocessesforrevitalisinghistorictownsorheritagedistricts.pdf
- Summary: Argues for dynamic generative processes, meaning rules and codes applied incrementally, rather than static master plans. Case studies: Albuquerque, and Muharraq and Manama in Bahrain — [araburbanism.com](https://www.araburbanism.com/magazine/generative-processes-for-revitalizing-historic-towns-or-heritage-districts). It builds on Hakim's *Arabic-Islamic Cities: Building and Planning Principles* (1986) [K].
- Relevance: Treats historic towns as the result of local rules (rights of way, privacy, harm avoidance or *darar*, fina' or the space in front of a house) applied over time. These suit "tenure/custom" plugins that constrain building and plot edits.

**15. Ben-Hamouche, M. (2009). "Can Chaos Theory Explain Complexity in Urban Fabric? Applications in Traditional Muslim Settlements." *Nexus Network Journal* 11(2): 217–242.** [V for venue and pages] (Springer; DOI not confirmed) — overview via [Architexturez](https://architexturez.net/node/215716)
- Summary: Argues that Islamic inheritance law, through successive iterations of subdivision over decades or centuries, gave Muslim cities a fractal character and is the main source of their complexity. The author works on Chaos, Fractals and CA applied to traditional fabrics — [search summary of Architexturez/Nexus](https://architexturez.net/node/215716).
- Relevance: The clearest theoretical model of inheritance-driven plot splitting, which is exactly the project's split/merge/inherit mechanic. Inheritance rules (partible vs primogeniture) become a pluggable tenure parameter that produces fine-grained fractal (Islamic, partible) or stable (English burgage, impartible) plot fabrics.

**16. Bekhelifi, A.E. & Djedid, A. (2025). "Urban morphogenesis and fractal pattern: scaling invariance of traditional Islamic cities in Algeria." *Urban Morphology* 29(2): 191–206.** [V] https://journal.urbanform.org/index.php/jum/article/view/11439
- Summary: Applies betweenness and closeness centrality to the street networks of Algiers, Tlemcen, Ghardaia and Ouargla and confirms power-law and scale-invariance properties — [Urban Morphology](https://journal.urbanform.org/index.php/jum/article/view/11439).
- Relevance: Validation metrics (centrality distributions) for organic street networks the simulation generates.

**17. Popov, N. (2010). "Generative urban design with cellular automata and agent based modelling." 44th ANZAScA Conference.** [V for author, title and venue only] https://www.researchbank.ac.nz/items/1ac0eadf-e1bf-4f21-b136-bff17adb4b90
- Summary: Models the morphologies of unplanned settlements as emergent phenomena using CA and ABM on parallel computing.
- Relevance: A minor precedent for agent-driven vernacular tissue, and evidence that the walkers-plus-cells approach has been tried at small scale. Raster-based, unlike the project's vector design.

**18. Courtat, T., Gloaguen, C. & Douady, S. (2011). "Mathematics and morphogenesis of cities: a geometrical approach." *Physical Review E* 83: 036106.** [K] https://arxiv.org/abs/1010.1762 (arXiv ID from memory; check it)
- Summary (from my knowledge): A geometric growth model of street networks in which new streets attach to existing ones by local geometric rules, compared with Paris.
- Relevance: A vector-native street-growth rule set that sits naturally alongside trail-wearing.

### Inferences
- An "Islamic medina" scenario is well supported by formal rules: Duarte's grammar, Hakim's customary rules and Ben-Hamouche's inheritance subdivision. It is a good second scenario to show that the engine's geography, tenure and demand settings can be swapped.
- Inheritance-driven subdivision (Ben-Hamouche) and the burgage cycle (Conzen) are complementary plot-dynamics models and could share one split/merge engine with different rule parameters.

### Gaps
- Bianca's *Urban Form in the Arab World* (2000) is a qualitative book (from my knowledge) and I did not verify it here. I found no computational model of cul-de-sac formation by gradual privatisation of through-routes beyond the Duarte grammar.
- An East Asian equivalent (e.g. machiya plot evolution in Kyoto, or the Chinese lilong or hutong) was not found in this pass.

## Q4. Combining planned and emergent growth (planted towns, bastides, new towns)

### Takeaway
The empirical literature on planted towns (the Lilley atlas and Antiquity paper, Boerefijn's thesis) supplies templates and metrology. The network-evolution literature (Barthelemy et al. 2013) supplies metrics that separate planned from self-organised change. I found no model that simulates both a planted framework and its emergent infill and decay in one engine.

### Cited Findings
- **Boerefijn, W. (2010). *The foundation, planning and building of new towns in the 13th and 14th centuries in Europe: an architectural-historical research into urban form and its creation*. PhD thesis, University of Amsterdam.** [K, not verified this session; UvA DARE repository] A comparative study of bastides and planted towns covering survey methods, plot modules and the building process. Relevance: planned templates and the build-out sequence.
- Lilley et al. (2005, 2007), items 7 and 8 above: GIS evidence that Edward I's towns share design principles but are not one standard plan — [Cambridge Core](https://resolve.cambridge.org/core/journals/antiquity/article/designs-and-designers-of-medieval-new-towns-in-wales/5F2B4C5ED16C8DA5BFDFC575C3981FFF).
- Barthelemy et al. (2013), item 3: in Paris, top-down planning shows up as a reorganisation of centrality and of block shapes laid over otherwise smooth self-organised growth — [arXiv](https://arxiv.org/pdf/1307.2203).
- Mas et al. (2020), item 1: user-scripted "events" such as wall expansion interleaved with automatic growth — [EG](https://diglib.eg.org:443/handle/10.1111/cgf13897).

### Inferences
- A workable design: planned interventions are events that impose a template (a grid plus a plot module from the Lilley and Tait metrology) on the substrate. Emergent processes (trail-wearing, burgage-cycle infill, inheritance splitting) then act on it. Paris-style centrality and block-shape metrics tell you whether the mix looks right.

### Gaps
- I found no computational model of bastide build-out (the rate plots were taken up, empty plots, failed plantations), although the historical sources discuss failed and shrunken plantations.
- Not verified: Beresford's *New Towns of the Middle Ages* (1967) and Slater's work on planned small boroughs. Both are standard qualitative references and would supply foundation dates and plan data.
