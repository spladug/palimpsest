# /// script
# requires-python = ">=3.11"
# dependencies = ["osmnx>=2", "geopandas>=1", "shapely>=2", "pyproj", "numpy"]
# ///
"""
Measure the reference towns the way src/sim/form.ts measures the simulated
town, and write the results to scripts/validation/reference.json.

Plots are HM Land Registry INSPIRE title polygons (freehold titles, which in
historic cores follow the old burgage plots closely); streets and buildings
come from OpenStreetMap. Each town has two districts:

- core: plots fronting the town's medieval main streets, named in towns.py;
- victorian: plots fronting streets whose names date them to Victoria's reign
  (Victoria, Albert, Alma, Gladstone, Jubilee, Station...). A stand-in until
  plan-unit maps from the Extensive Urban Surveys are digitised.

Usage (needs uv, https://docs.astral.sh/uv/):
    uv run scripts/reference/measure.py --inspire DIR [--cache DIR] [--towns totnes,hitchin]

DIR holds the councils' INSPIRE GML files, named <Council>.gml as in towns.py,
from https://use-land-property-data.service.gov.uk/datasets/inspire/download
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import osmnx as ox
from shapely.geometry import LineString, MultiLineString, Point, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).parent))
from towns import TOWNS, VICTORIAN_WORDS  # noqa: E402

BNG = "EPSG:27700"
# Ways the simulation would have: streets, lanes, yards and back lanes, not footpaths.
EXCLUDE_HIGHWAYS = {"footway", "path", "steps", "cycleway", "bridleway", "corridor", "elevator", "platform", "construction", "proposed", "track"}
# How far a plot's front may sit from the street centreline (wide market streets need room).
FRONT_REACH = 22.0
# A street belongs to a district where half its length passes within this of the district's plot fronts (as in form.ts).
STREET_REACH = 30.0
ATTRIBUTION = (
    "Plots: HM Land Registry INSPIRE Index Polygons, Crown copyright and database rights 2026, "
    "reproduced with the permission of HM Land Registry; polygons subject to Crown copyright and database rights "
    "2026 Ordnance Survey AC0000851063. Streets and buildings: OpenStreetMap contributors, ODbL."
)


def spread(values: list[float]) -> dict:
    if not values:
        return {"median": 0, "p25": 0, "p75": 0}
    v = sorted(values)
    q = lambda f: v[min(len(v) - 1, int(f * len(v)))]  # noqa: E731
    return {"median": q(0.5), "p25": q(0.25), "p75": q(0.75)}


def names_of(row) -> list[str]:
    n = row.get("name")
    if isinstance(n, list):
        return [str(x) for x in n]
    if isinstance(n, str):
        return [n]
    return []


def load_town(town: dict, inspire_dir: Path):
    centre_ll = ox.geocode(town["geocode"])
    radius = town.get("radius", 1500)
    g = ox.graph_from_point(centre_ll, dist=radius, network_type="all", simplify=True, retain_all=False)
    g = ox.project_graph(g, to_crs=BNG)
    gu = ox.convert.to_undirected(g)
    nodes, edges = ox.graph_to_gdfs(gu)
    hw = edges["highway"].apply(lambda h: h if isinstance(h, list) else [h])
    edges = edges[~hw.apply(lambda hs: all(x in EXCLUDE_HIGHWAYS for x in hs))].copy()
    buildings = ox.features_from_point(centre_ll, tags={"building": True}, dist=radius).to_crs(BNG)
    buildings = buildings[buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    cx, cy = gpd.GeoSeries([Point(centre_ll[1], centre_ll[0])], crs="EPSG:4326").to_crs(BNG).iloc[0].coords[0]
    area = box(cx - radius, cy - radius, cx + radius, cy + radius)
    parcels = gpd.read_file(inspire_dir / f"{town['council']}.gml", bbox=area.bounds).to_crs(BNG)
    parcels = parcels[parcels.geometry.area.between(15, 6000)].reset_index(drop=True)
    return nodes, edges, buildings, parcels


def street_lines(edges: gpd.GeoDataFrame, match) -> MultiLineString | None:
    lines = [geom for (_, row), geom in zip(edges.iterrows(), edges.geometry) if any(match(n) for n in names_of(row))]
    return unary_union(lines) if lines else None


def tangent_at(line, p: Point) -> np.ndarray:
    s = line.project(p)
    a = line.interpolate(max(0, s - 8))
    b = line.interpolate(min(line.length, s + 8))
    t = np.array([b.x - a.x, b.y - a.y])
    n = np.linalg.norm(t)
    return t / n if n > 0 else np.array([1.0, 0.0])


def extent_along(geom, origin: Point, t: np.ndarray) -> float:
    pts = np.array([c for g in getattr(geom, "geoms", [geom]) for c in boundary_coords(g)])
    if not len(pts):
        return 0.0
    s = (pts - np.array(origin.coords[0])) @ t
    return float(s.max() - s.min())


def boundary_coords(g):
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return list(g.exterior.coords)
    if g.geom_type in ("LineString", "LinearRing"):
        return list(g.coords)
    return [c for x in getattr(g, "geoms", []) for c in boundary_coords(x)]


def district_plots(parcels: gpd.GeoDataFrame, buildings: gpd.GeoDataFrame, street) -> list[dict]:
    """Plots fronting a street: frontage, depth, what is built, and where the front is."""
    near = parcels[parcels.geometry.distance(street) < FRONT_REACH]
    bidx = buildings.sindex
    out = []
    for geom in near.geometry:
        d0 = geom.distance(street)
        # The front: the plot's edge within a few metres of its nearest approach to the street.
        front_zone = street.buffer(d0 + 3)
        front = geom.boundary.intersection(front_zone)
        if front.is_empty:
            continue
        mid = front.centroid
        t = tangent_at(street if street.geom_type == "LineString" else nearest_part(street, mid), mid)
        width = extent_along(front, mid, t)
        if width < 2:
            continue
        dists = [Point(c).distance(street) for c in boundary_coords(geom)]
        depth = max(dists) - d0
        if depth < 3:
            continue
        hits = buildings.iloc[list(bidx.query(geom, predicate="intersects"))]
        built = unary_union([b.intersection(geom) for b in hits.geometry]) if len(hits) else None
        built_area = built.area if built is not None else 0.0
        front_band = geom.intersection(street.buffer(d0 + 12))
        back_area = built_area - (built.intersection(front_band).area if built is not None else 0.0)
        front_strip = geom.intersection(street.buffer(d0 + 4))
        front_built = extent_along(built.intersection(front_strip), mid, t) if built is not None else 0.0
        out.append(
            {
                "area": geom.area,
                "width": width,
                "depth": depth,
                "built": built_area,
                "back": max(0.0, back_area),
                "frontBuilt": min(width, front_built),
                "front": (mid.x, mid.y),
            }
        )
    return out


def nearest_part(ml, p: Point):
    return min(ml.geoms, key=lambda g: g.distance(p))


def street_form(nodes, edges, fronts: list[tuple[float, float]], degree: dict) -> dict:
    """Street measures over the ways passing the district's plot fronts, as in form.ts."""
    if not fronts:
        return {}
    tree = gpd.GeoSeries([Point(f) for f in fronts]).sindex
    pts = gpd.GeoSeries([Point(f) for f in fronts])
    chosen = []
    for (u, v, _), geom in zip(edges.index, edges.geometry):
        samples = [geom.interpolate(s) for s in np.arange(0, geom.length + 1e-9, 10.0)] or [geom.interpolate(0)]
        nearby = 0
        for q in samples:
            idx = list(tree.query(q.buffer(STREET_REACH)))
            if any(pts.iloc[i].distance(q) <= STREET_REACH for i in idx):
                nearby += 1
        if nearby >= len(samples) / 2:
            chosen.append((u, v, geom))
    if not chosen:
        return {}
    # Orientation entropy over 36 bins, length weighted, both directions (Boeing 2019).
    bins = np.zeros(36)
    for _, _, geom in chosen:
        c = list(geom.coords)
        for (x0, y0), (x1, y1) in zip(c, c[1:]):
            ln = math.hypot(x1 - x0, y1 - y0)
            b = (math.degrees(math.atan2(x1 - x0, y1 - y0)) + 360) % 180
            bins[int(b // 10) % 36] += ln
            bins[(int(b // 10) + 18) % 36] += ln
    p = bins[bins > 0] / bins.sum()
    h = float(-(p * np.log(p)).sum())
    order = 1 - (max(0, h - math.log(4)) / (math.log(36) - math.log(4))) ** 2
    ns = {u for u, _, _ in chosen} | {v for _, v, _ in chosen}
    parent = {n: n for n in ns}

    def find(x):
        while parent[x] != x:
            x = parent[x]
        return x

    for u, v, _ in chosen:
        parent[find(u)] = find(v)
    c = sum(1 for n in ns if find(n) == n)
    n, m = len(ns), len(chosen)
    ends = [k for k in ns if degree.get(k, 0) != 2]
    dead = [k for k in ends if degree.get(k, 0) == 1]
    skews = []
    for k in ns:
        if degree.get(k, 0) < 3:
            continue
        kx, ky = nodes.loc[k].geometry.x, nodes.loc[k].geometry.y
        bearings = []
        for u, v, geom in chosen:
            if k not in (u, v):
                continue
            coords = list(geom.coords)
            if math.hypot(coords[0][0] - kx, coords[0][1] - ky) > math.hypot(coords[-1][0] - kx, coords[-1][1] - ky):
                coords = coords[::-1]
            target = next((q for q in coords if math.hypot(q[0] - kx, q[1] - ky) >= 10), coords[-1])
            bearings.append(math.degrees(math.atan2(target[1] - ky, target[0] - kx)) + 360)
        for i in range(len(bearings)):
            for j in range(i + 1, len(bearings)):
                diff = abs(bearings[i] - bearings[j]) % 90
                skews.append(min(diff, 90 - diff))
    length = sum(g.length for _, _, g in chosen)
    weighted = 0.0
    for _, _, g in chosen:
        chord = Point(g.coords[0]).distance(Point(g.coords[-1]))
        weighted += g.length * (g.length / chord) if chord > 1 else g.length
    return {
        "length": length,
        "orientationEntropy": h,
        "orientationOrder": order,
        "meshedness": max(0.0, (m - n + c) / (2 * n - 5)) if n >= 3 else 0.0,
        "deadEndShare": len(dead) / len(ends) if ends else 0.0,
        "junctionSkew": spread(skews)["median"],
        "sinuosity": weighted / length if length else 1.0,
    }


def form(plots: list[dict], street: dict) -> dict:
    area = sum(p["area"] for p in plots)
    frontage = sum(p["width"] for p in plots)
    return {
        "plots": len(plots),
        "frontage": spread([p["width"] for p in plots]),
        "depth": spread([p["depth"] for p in plots]),
        "shape": spread([p["width"] / p["depth"] for p in plots if p["depth"] > 0]),
        "coverage": sum(p["built"] for p in plots) / area if area else 0,
        "backCoverage": sum(p["back"] for p in plots) / area if area else 0,
        "frontContinuity": sum(p["frontBuilt"] for p in plots) / frontage if frontage else 0,
        "streets": street,
    }


def measure(town: dict, inspire_dir: Path) -> dict:
    nodes, edges, buildings, parcels = load_town(town, inspire_dir)
    degree = {}
    for u, v in zip(edges.index.get_level_values(0), edges.index.get_level_values(1)):
        degree[u] = degree.get(u, 0) + 1
        degree[v] = degree.get(v, 0) + 1
    core_names = set(town["core"])
    victorian = re.compile(r"\b(" + "|".join(VICTORIAN_WORDS) + r")\b")
    out = {"name": town["name"], "county": town["county"], "districts": {}}
    for district, match in (("core", lambda n: n in core_names), ("victorian", lambda n: bool(victorian.search(n)))):
        street = street_lines(edges, match)
        if street is None:
            continue
        plots = district_plots(parcels, buildings, street)
        if len(plots) < 10:
            continue
        out["districts"][district] = form(plots, street_form(nodes, edges, [p["front"] for p in plots], degree))
        print(f"  {town['name']} {district}: {len(plots)} plots", file=sys.stderr)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspire", type=Path, required=True)
    ap.add_argument("--cache", type=Path, default=None)
    ap.add_argument("--towns", default=",".join(TOWNS))
    ap.add_argument("--out", type=Path, default=Path(__file__).parents[1] / "validation" / "reference.json")
    args = ap.parse_args()
    ox.settings.use_cache = True
    if args.cache:
        ox.settings.cache_folder = str(args.cache)
    ox.settings.http_user_agent = "palimpsest-validation (town growth simulation research)"
    towns = {}
    for key in args.towns.split(","):
        print(f"measuring {TOWNS[key]['name']}", file=sys.stderr)
        towns[key] = measure(TOWNS[key], args.inspire)
    args.out.write_text(json.dumps({"attribution": ATTRIBUTION, "towns": towns}, indent=2) + "\n")
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
