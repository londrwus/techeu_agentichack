"""Orbit Rent Radar, neighbourhood detail: London H3 hexagons (res 8, ~0.7 km2) with REAL Sentinel-2
built-up change (NDBI, summer 2019 vs latest summer) + plausible synthetic rents.

    modal run modal_app/rent_detail.py            # cached if /data/built/rent/hex.json exists
    modal run modal_app/rent_detail.py --force

Fan-out: one CPU container per Sentinel-2 scene reads a ~35 m London mosaic (B04/B08/B11/SCL),
the builder median-composites each year and aggregates pixels into hexagons.
Writes /data/built/rent/hex.json (GeoJSON) + /data/built/rent/_hex_stats.json on Volume "orbit-data".
"""
import json
import math
import time

import modal

BBOX = (-0.52, 51.28, 0.34, 51.70)          # Greater London
DLON, DLAT = 0.0005, 0.0003                 # ~35 m x 33 m grid in EPSG:4326
RES = 8
BASE_YEAR, LATEST_YEARS = 2019, (2026, 2025)
CENTRE = (-0.1276, 51.5072)                 # Charing Cross

app = modal.App("orbit-rent-detail")
vol = modal.Volume.from_name("orbit-data", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "numpy", "shapely", "rasterio", "pystac-client", "planetary-computer", "h3>=4", "httpx"
)

# Thames centre line, west -> east (approximate).
THAMES = [(-0.335, 51.405), (-0.31, 51.41), (-0.305, 51.435), (-0.315, 51.455), (-0.29, 51.47), (-0.255, 51.485),
          (-0.245, 51.475), (-0.225, 51.47), (-0.215, 51.485), (-0.225, 51.495), (-0.2, 51.47), (-0.185, 51.47),
          (-0.165, 51.482), (-0.14, 51.485), (-0.125, 51.492), (-0.122, 51.505), (-0.1, 51.509), (-0.075, 51.506),
          (-0.05, 51.503), (-0.03, 51.508), (-0.02, 51.49), (-0.005, 51.485), (0.005, 51.505), (0.03, 51.5),
          (0.07, 51.505), (0.1, 51.505), (0.13, 51.5), (0.17, 51.485), (0.2, 51.47)]

# Neighbourhood names for hexagon labels (nearest place wins).
PLACES = {
    "Mayfair": (-0.148, 51.511), "Soho": (-0.134, 51.513), "Covent Garden": (-0.123, 51.512), "Marylebone": (-0.153, 51.52),
    "Paddington": (-0.176, 51.516), "Bayswater": (-0.188, 51.512), "Notting Hill": (-0.205, 51.509), "Kensington": (-0.191, 51.499),
    "Chelsea": (-0.169, 51.487), "South Kensington": (-0.174, 51.494), "Earl's Court": (-0.195, 51.49), "Fulham": (-0.195, 51.473),
    "Hammersmith": (-0.223, 51.492), "Shepherd's Bush": (-0.22, 51.504), "Chiswick": (-0.258, 51.492), "Acton": (-0.27, 51.508),
    "Ealing": (-0.305, 51.513), "Southall": (-0.377, 51.511), "Hanwell": (-0.338, 51.509), "Hounslow": (-0.361, 51.468),
    "Brentford": (-0.309, 51.486), "Twickenham": (-0.325, 51.447), "Richmond": (-0.302, 51.461), "Kingston": (-0.301, 51.41),
    "Surbiton": (-0.304, 51.394), "Wimbledon": (-0.206, 51.421), "Putney": (-0.216, 51.461), "Wandsworth": (-0.19, 51.457),
    "Battersea": (-0.155, 51.47), "Clapham": (-0.138, 51.462), "Balham": (-0.152, 51.443), "Tooting": (-0.168, 51.427),
    "Streatham": (-0.132, 51.428), "Brixton": (-0.115, 51.462), "Vauxhall": (-0.123, 51.486), "Stockwell": (-0.122, 51.472),
    "Waterloo": (-0.113, 51.503), "Bermondsey": (-0.064, 51.498), "Elephant & Castle": (-0.1, 51.495), "Peckham": (-0.069, 51.47),
    "Camberwell": (-0.093, 51.474), "Dulwich": (-0.085, 51.445), "Crystal Palace": (-0.072, 51.418), "Norwood": (-0.103, 51.43),
    "Deptford": (-0.026, 51.479), "New Cross": (-0.035, 51.475), "Lewisham": (-0.013, 51.461), "Catford": (-0.02, 51.445),
    "Greenwich": (-0.009, 51.482), "Blackheath": (0.009, 51.466), "Woolwich": (0.069, 51.49), "Eltham": (0.052, 51.451),
    "Thamesmead": (0.117, 51.5), "Bexleyheath": (0.15, 51.456), "Sidcup": (0.103, 51.425), "Bromley": (0.015, 51.406),
    "Beckenham": (-0.025, 51.408), "Orpington": (0.098, 51.375), "Croydon": (-0.099, 51.372), "Purley": (-0.114, 51.337),
    "Sutton": (-0.194, 51.36), "Morden": (-0.195, 51.402), "Mitcham": (-0.168, 51.402), "Cheam": (-0.214, 51.36),
    "City of London": (-0.092, 51.515), "Clerkenwell": (-0.105, 51.524), "Islington": (-0.103, 51.538), "Holloway": (-0.118, 51.555),
    "King's Cross": (-0.124, 51.531), "Camden Town": (-0.143, 51.539), "Kentish Town": (-0.141, 51.55), "Hampstead": (-0.178, 51.556),
    "Highgate": (-0.147, 51.572), "Kilburn": (-0.195, 51.543), "St John's Wood": (-0.174, 51.534), "Swiss Cottage": (-0.174, 51.543),
    "Shoreditch": (-0.078, 51.527), "Hoxton": (-0.081, 51.533), "Dalston": (-0.075, 51.546), "Hackney": (-0.055, 51.545),
    "Stoke Newington": (-0.075, 51.562), "Clapton": (-0.056, 51.558), "Whitechapel": (-0.061, 51.517), "Bethnal Green": (-0.055, 51.527),
    "Bow": (-0.024, 51.529), "Mile End": (-0.035, 51.522), "Canary Wharf": (-0.019, 51.505), "Poplar": (-0.012, 51.511),
    "Isle of Dogs": (-0.013, 51.492), "Stratford": (-0.003, 51.542), "West Ham": (0.005, 51.528), "Canning Town": (0.009, 51.514),
    "Royal Docks": (0.05, 51.507), "East Ham": (0.054, 51.539), "Forest Gate": (0.024, 51.549), "Ilford": (0.07, 51.559),
    "Barking": (0.081, 51.536), "Dagenham": (0.148, 51.542), "Romford": (0.183, 51.575), "Hornchurch": (0.219, 51.557),
    "Upminster": (0.25, 51.558), "Rainham": (0.19, 51.518), "Walthamstow": (-0.02, 51.584), "Leyton": (-0.006, 51.561),
    "Leytonstone": (0.008, 51.568), "Chingford": (-0.0, 51.631), "Tottenham": (-0.07, 51.598), "Wood Green": (-0.109, 51.597),
    "Crouch End": (-0.12, 51.579), "Muswell Hill": (-0.143, 51.59), "Finchley": (-0.18, 51.6), "Barnet": (-0.2, 51.652),
    "Edgware": (-0.275, 51.613), "Hendon": (-0.226, 51.583), "Golders Green": (-0.195, 51.572), "Enfield": (-0.08, 51.652),
    "Edmonton": (-0.06, 51.615), "Southgate": (-0.128, 51.632), "Wembley": (-0.296, 51.556), "Harlesden": (-0.247, 51.537),
    "Willesden": (-0.232, 51.547), "Harrow": (-0.336, 51.58), "Pinner": (-0.381, 51.594), "Stanmore": (-0.303, 51.618),
    "Ruislip": (-0.423, 51.573), "Uxbridge": (-0.479, 51.546), "Hayes": (-0.42, 51.513), "Heathrow": (-0.454, 51.47),
    "Feltham": (-0.414, 51.446), "Northolt": (-0.368, 51.548), "Greenford": (-0.354, 51.529), "Woodford": (0.027, 51.607),
    "Wanstead": (0.028, 51.576), "Chadwell Heath": (0.13, 51.568), "Erith": (0.178, 51.481), "Welling": (0.107, 51.462),
    "Charlton": (0.035, 51.486), "Nine Elms": (-0.133, 51.48), "Pimlico": (-0.136, 51.489), "Westminster": (-0.127, 51.5),
    "Belgravia": (-0.153, 51.497), "Holborn": (-0.118, 51.517), "Bloomsbury": (-0.127, 51.522), "Euston": (-0.133, 51.527),
    "Wapping": (-0.059, 51.504), "Rotherhithe": (-0.051, 51.5), "Surrey Quays": (-0.043, 51.494), "Archway": (-0.135, 51.566),
    "Finsbury Park": (-0.106, 51.564), "Highbury": (-0.1, 51.548), "Tulse Hill": (-0.103, 51.44), "Herne Hill": (-0.102, 51.452),
    "Sydenham": (-0.054, 51.428), "Forest Hill": (-0.053, 51.44), "Kidbrooke": (0.028, 51.463), "Thornton Heath": (-0.106, 51.398),
    "Colindale": (-0.25, 51.595), "Brent Cross": (-0.222, 51.576), "Old Oak": (-0.25, 51.525), "White City": (-0.224, 51.512),
}


def _km(a, b):
    return math.hypot((a[0] - b[0]) * 69.4, (a[1] - b[1]) * 111.2)


def _seg_km(p, a, b):
    ax, ay, bx, by, px, py = a[0] * 69.4, a[1] * 111.2, b[0] * 69.4, b[1] * 111.2, p[0] * 69.4, p[1] * 111.2
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / max(dx * dx + dy * dy, 1e-9)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _thames_km(p):
    return min(_seg_km(p, THAMES[i], THAMES[i + 1]) for i in range(len(THAMES) - 1))


@app.function(image=image, timeout=900, max_containers=24, retries=1, cpu=2.0, memory=4096)
def scene_mosaic(href: dict, offset: int) -> dict:
    """Read one Sentinel-2 scene onto the shared London lat/lon grid -> float16 NDBI/NDVI (NaN = invalid)."""
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT

    w = int(round((BBOX[2] - BBOX[0]) / DLON))
    h = int(round((BBOX[3] - BBOX[1]) / DLAT))
    tr = rasterio.transform.from_origin(BBOX[0], BBOX[3], DLON, DLAT)
    bands = {}
    t0 = time.time()
    for name, rs in (("B04", Resampling.average), ("B08", Resampling.average), ("B11", Resampling.average), ("SCL", Resampling.nearest)):
        with rasterio.open(href[name]) as src, WarpedVRT(src, crs="EPSG:4326", transform=tr, width=w, height=h,
                                                         resampling=rs, nodata=0) as vrt:
            bands[name] = vrt.read(1).astype("f4")
    ok = (bands["B08"] > 0) & np.isin(bands["SCL"], [4, 5, 6, 7, 11])  # veg / bare / water / unclassified / snow
    r, n, s = (bands[k] - offset for k in ("B04", "B08", "B11"))
    with np.errstate(invalid="ignore", divide="ignore"):
        ndbi = np.where(ok, (s - n) / np.maximum(s + n, 1), np.nan).astype("f2")
        ndvi = np.where(ok, (n - r) / np.maximum(n + r, 1), np.nan).astype("f2")
    print("scene", href["id"], "valid", round(float(ok.mean()), 3), round(time.time() - t0, 1), "s")
    return {"id": href["id"], "valid": float(ok.mean()), "ndbi": ndbi.tobytes(), "ndvi": ndvi.tobytes(), "shape": [h, w]}


def _scenes(year: int, n: int = 6):
    import planetary_computer
    from pystac_client import Client
    cat = Client.open("https://planetarycomputer.microsoft.com/api/stac/v1", modifier=planetary_computer.sign_inplace)
    items = list(cat.search(collections=["sentinel-2-l2a"], bbox=list(BBOX), datetime=f"{year}-05-15/{year}-09-10",
                            query={"eo:cloud_cover": {"lt": 20}}, max_items=200).items())
    by_tile = {}
    for it in sorted(items, key=lambda it: it.properties["eo:cloud_cover"]):
        by_tile.setdefault(it.properties.get("s2:mgrs_tile"), []).append(it)
    out = []
    for tile, its in by_tile.items():  # London spans 30UXC (+ 31UCT, 30UYC in the east)
        for it in its[:n]:
            off = 1000 if float(it.properties.get("s2:processing_baseline", "0")) >= 4.0 else 0
            out.append(({"id": it.id, **{b: it.assets[b].href for b in ("B04", "B08", "B11", "SCL")}}, off))
    print(year, "scenes:", len(out), "tiles:", list(by_tile))
    return out


@app.function(image=image, timeout=1800, volumes={"/data": vol}, cpu=4.0, memory=16384)
def build(force: bool = False) -> dict:
    import os

    import h3
    import numpy as np
    from shapely.geometry import Point, shape
    from shapely.strtree import STRtree

    out_path = "/data/built/rent/hex.json"
    if os.path.exists(out_path) and not force:
        print("cached:", out_path)
        return json.load(open("/data/built/rent/_hex_stats.json"))
    boroughs = json.load(open("/data/built/rent/london.json"))["features"]
    t0 = time.time()

    # 1) per-year median composites, one container per scene
    comps, years = {}, {}
    for key, ys in (("base", (BASE_YEAR,)), ("latest", LATEST_YEARS)):
        for y in ys:
            jobs = _scenes(y)
            if not jobs:
                continue
            res = [r for r in scene_mosaic.starmap(jobs, return_exceptions=True) if isinstance(r, dict) and r["valid"] > 0.05]
            if not res:
                continue
            hgt, wid = res[0]["shape"]
            stack = {k: np.stack([np.frombuffer(r[k], dtype="f2").reshape(hgt, wid).astype("f4") for r in res]) for k in ("ndbi", "ndvi")}
            with np.errstate(all="ignore"):
                # Greenest-pixel composite: drought-browned fields were green at some point in the season,
                # roofs and roads never are -> "built" = max NDVI below 0.35 (and not water).
                mx = np.nanmax(stack["ndvi"], axis=0)
                comps[key] = {"ndbi": np.nanmedian(stack["ndbi"], axis=0), "ndvi": mx,
                              "built": np.where(np.isfinite(mx), ((mx >= 0.0) & (mx < 0.35)).astype("f4"), np.nan)}
            years[key] = {"year": y, "scenes": len(res)}
            break
    n_scenes = sum(v["scenes"] for v in years.values())
    sat_seconds = round(time.time() - t0, 1)

    # 2) hexagons over each borough
    cell_borough = {}
    for f in boroughs:
        g = shape(f["geometry"])
        for c in h3.geo_to_cells(f["geometry"], RES):
            cell_borough.setdefault(c, f["properties"]["name"])
        # also cover cells whose centre is inside but polyfill missed (tiny boroughs)
        if g.area < 1e-4:
            cell_borough.setdefault(h3.latlng_to_cell(g.centroid.y, g.centroid.x, RES), f["properties"]["name"])
    bprops = {f["properties"]["name"]: f["properties"] for f in boroughs}

    # 3) pixels -> cells
    agg = {}
    if "base" in comps and "latest" in comps:
        hgt, wid = comps["base"]["ndbi"].shape
        lats = BBOX[3] - (np.arange(hgt) + 0.5) * DLAT
        lons = BBOX[0] + (np.arange(wid) + 0.5) * DLON
        d_ndbi = comps["latest"]["built"] - comps["base"]["built"]  # change in built-up share (0..1)
        d_ndvi = comps["latest"]["ndvi"] - comps["base"]["ndvi"]
        ndbi_l = comps["latest"]["built"]
        ndbi_b = comps["base"]["built"]
        step = 2  # every 2nd pixel (~70 m) is plenty for 0.7 km2 cells
        for i in range(0, hgt, step):
            lat = float(lats[i])
            for j in range(0, wid, step):
                v = d_ndbi[i, j]
                if not np.isfinite(v):
                    continue
                c = h3.latlng_to_cell(lat, float(lons[j]), RES)
                if c not in cell_borough:
                    continue
                a = agg.setdefault(c, [0.0, 0.0, 0.0, 0.0, 0])
                a[0] += float(v); a[1] += float(d_ndvi[i, j]) if np.isfinite(d_ndvi[i, j]) else 0.0
                a[2] += float(ndbi_b[i, j]); a[3] += float(ndbi_l[i, j]); a[4] += 1
    deltas = {c: a[0] / a[4] for c, a in agg.items() if a[4] >= 20}
    gdeltas = {c: agg[c][1] / agg[c][4] for c in deltas}
    med = float(np.median(list(deltas.values()))) if deltas else 0.0
    gmed = float(np.median(list(gdeltas.values()))) if gdeltas else 0.0

    # 4) synthetic rents per cell: borough rent x local factor (centrality, river, noise)
    rng = np.random.default_rng(42)
    names = list(PLACES)
    ptree = STRtree([Point(*PLACES[n]) for n in names])
    raw = {}
    for c, b in cell_borough.items():
        lat, lon = h3.cell_to_latlng(c)
        p = (lon, lat)
        f = math.exp(-0.022 * _km(p, CENTRE)) * (1 + 0.10 * math.exp(-_thames_km(p) / 0.6)) * (1 + rng.normal(0, 0.035))
        raw[c] = f
    bmean = {}
    for c, b in cell_borough.items():
        bmean.setdefault(b, []).append(raw[c])
    bmean = {b: sum(v) / len(v) for b, v in bmean.items()}
    feats = []
    for c, b in cell_borough.items():
        bp = bprops[b]
        lat, lon = h3.cell_to_latlng(c)
        rent_now = int(round(bp["rent_now"] * raw[c] / bmean[b] / 25) * 25)
        # built-up share change vs London median, in percentage points of the cell's area
        built = round(max(-25.0, min(35.0, (deltas[c] - med) * 100)), 1) if c in deltas else None
        green = round(max(-30.0, min(30.0, (gdeltas[c] - gmed) * 100)), 1) if c in gdeltas else None
        g = bp["change_pct"] / 100 - (built or 0.0) * 0.08 / 100 + 0.004 * math.exp(-_km((lon, lat), CENTRE) / 8) + rng.normal(0, 0.003)
        g = max(0.005, min(0.12, g))
        near = names[int(ptree.nearest(Point(lon, lat)))]
        ring = [[round(x, 5), round(y, 5)] for y, x in h3.cell_to_boundary(c)]
        ring.append(ring[0])
        a = agg.get(c)
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": {
            "id": c, "name": near, "borough": b, "rent_now": rent_now, "rent_12m": int(round(rent_now * (1 + g))),
            "change_pct": round(g * 100, 1), "built_change_pct": built, "green_change_pct": green, "pressure": 0,
            "built_share_2019": round(a[2] / a[4] * 100, 1) if a and a[4] else None,
            "built_share_latest": round(a[3] / a[4] * 100, 1) if a and a[4] else None,
            "centroid": [round(lon, 5), round(lat, 5)],
        }})
    gs = [f["properties"]["change_pct"] for f in feats]
    lo, hi = min(gs), max(gs)
    for f in feats:
        f["properties"]["pressure"] = int(round(5 + 93 * (f["properties"]["change_pct"] - lo) / max(hi - lo, 1e-6)))
    fc = {"type": "FeatureCollection", "features": feats,
          "meta": {"resolution": RES, "base": years.get("base"), "latest": years.get("latest"), "cells": len(feats),
                   "cells_with_satellite": len(deltas)}}
    os.makedirs("/data/built/rent", exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(fc, fh, separators=(",", ":"))
    stats = {"cells": len(feats), "cells_with_satellite": len(deltas), "scenes": n_scenes, "containers": n_scenes,
             "satellite_seconds": sat_seconds, "seconds": round(time.time() - t0, 1), "years": years}
    with open("/data/built/rent/_hex_stats.json", "w") as fh:
        json.dump(stats, fh)
    vol.commit()
    print("wrote", out_path, os.path.getsize(out_path), "bytes", stats)
    return stats


@app.local_entrypoint()
def main(force: bool = False):
    print(build.remote(force=force))
