"""Orbit Rent Radar: London boroughs, Sentinel-2 built-up change + synthetic rents -> 3D radar GeoJSON.

    modal run modal_app/rent.py            # uses cache if /data/built/rent/london.json exists
    modal run modal_app/rent.py --force    # recompute
    modal deploy modal_app/rent.py

Writes /data/built/rent/london.json and /data/built/rent/_stats.json on Volume "orbit-data".
"""
import json
import time

import modal

BOROUGHS_URL = "https://raw.githubusercontent.com/radoi90/housequest-data/master/london_boroughs.geojson"
BASE_YEAR, LATEST_YEARS = 2019, (2026, 2025)

app = modal.App("orbit-rent")
vol = modal.Volume.from_name("orbit-data", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "numpy", "shapely", "rasterio", "pystac-client", "planetary-computer", "httpx"
)

# Synthetic 1-bed rents (GBP/month) + demand prior (pp of growth: central/transport/regeneration).
RENTS = {
    "Kensington and Chelsea": (3750, 1.0), "Westminster": (3500, 1.0), "City of London": (3150, 1.5),
    "Camden": (2925, 1.5), "Hammersmith and Fulham": (2675, 1.0), "Islington": (2775, 1.5),
    "Tower Hamlets": (2625, 2.5), "Southwark": (2575, 2.0), "Wandsworth": (2575, 1.0),
    "Lambeth": (2475, 1.5), "Hackney": (2525, 2.0), "Richmond upon Thames": (2425, 0.5),
    "Kingston upon Thames": (2025, 0.5), "Brent": (2175, 1.5), "Haringey": (2125, 1.5),
    "Ealing": (2125, 2.0), "Barnet": (2125, 0.5), "Greenwich": (2125, 2.0),
    "Newham": (2075, 3.0), "Lewisham": (1975, 2.0), "Merton": (2075, 1.0),
    "Waltham Forest": (1975, 2.0), "Hounslow": (1925, 1.5), "Harrow": (1875, 0.5),
    "Hillingdon": (1825, 1.5), "Redbridge": (1825, 1.5), "Enfield": (1775, 1.0),
    "Croydon": (1725, 1.0), "Sutton": (1675, 0.5), "Bromley": (1825, 0.5),
    "Barking and Dagenham": (1625, 2.5), "Havering": (1625, 1.5), "Bexley": (1575, 0.5),
}
WHY_DEMAND = {
    3.0: "the Elizabeth line and Stratford regeneration keep pulling renters in",
    2.5: "regeneration and fast transport links keep pulling renters in",
    2.0: "young-renter demand and new transport links keep rising",
    1.5: "commuter demand stays strong",
    1.0: "demand stays steady",
    0.5: "suburban demand stays steady",
}


def _index_stats(bbox, poly_geojson, year):
    """Mean NDVI/NDBI over the borough polygon for the least-cloudy summer scenes of `year`."""
    import numpy as np
    import planetary_computer
    import rasterio
    from pystac_client import Client
    from rasterio.features import geometry_mask
    from rasterio.warp import transform_bounds, transform_geom
    from rasterio.windows import from_bounds
    from shapely.geometry import box, shape

    cat = Client.open("https://planetarycomputer.microsoft.com/api/stac/v1", modifier=planetary_computer.sign_inplace)
    items = list(cat.search(collections=["sentinel-2-l2a"], bbox=bbox, datetime=f"{year}-06-01/{year}-08-31",
                            query={"eo:cloud_cover": {"lt": 15}}, max_items=60).items())
    bb = box(*bbox)
    # Prefer tiles covering most of the borough, then least cloud.
    items.sort(key=lambda it: (-round(shape(it.geometry).intersection(bb).area / bb.area, 1),
                               it.properties["eo:cloud_cover"]))
    ndvi_vals, ndbi_vals, used = [], [], []
    for it in items[:6]:
        if len(used) >= 3:
            break
        try:
            offset = 1000 if float(it.properties.get("s2:processing_baseline", "0")) >= 4.0 else 0
            bands = {}
            with rasterio.open(it.assets["B11"].href) as src:  # 20 m grid is our target grid
                crs = src.crs
                b = transform_bounds("EPSG:4326", crs, *bbox)
                win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
                scale = max(1, int(max(win.width, win.height) // 400))
                shape_out = (max(1, int(win.height // scale)), max(1, int(win.width // scale)))
                bands["B11"] = src.read(1, window=win, out_shape=shape_out, boundless=True, fill_value=0).astype("f4")
                tr = src.window_transform(win) * rasterio.Affine.scale(win.width / shape_out[1], win.height / shape_out[0])
            for name in ("B04", "B08", "SCL"):
                with rasterio.open(it.assets[name].href) as src:
                    b = transform_bounds("EPSG:4326", src.crs, *bbox)
                    w = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
                    bands[name] = src.read(1, window=w, out_shape=shape_out, boundless=True, fill_value=0,
                                           resampling=rasterio.enums.Resampling.nearest if name == "SCL"
                                           else rasterio.enums.Resampling.average).astype("f4")
            inside = ~geometry_mask([transform_geom("EPSG:4326", crs, poly_geojson)], out_shape=shape_out, transform=tr)
            scl = bands["SCL"]
            good = inside & (bands["B08"] > 0) & np.isin(scl, [2, 4, 5, 6, 7, 11])  # drop cloud/shadow/nodata
            if good.sum() < 0.3 * max(1, inside.sum()):
                continue
            r, n, s = (bands[k][good] - offset for k in ("B04", "B08", "B11"))
            ndvi = float(np.nanmedian((n - r) / np.maximum(n + r, 1)))
            ndbi = float(np.nanmedian((s - n) / np.maximum(s + n, 1)))
            if ndbi > 0.2 or ndvi < 0.0:  # haze / missed cloud: implausible for a London borough
                continue
            ndvi_vals.append(ndvi)
            ndbi_vals.append(ndbi)
            used.append(it.id)
        except Exception as e:  # noqa: BLE001 - one bad scene must not kill the borough
            print("scene failed", it.id, e)
    if not used:
        return None
    return {"ndvi": float(np.median(ndvi_vals)), "ndbi": float(np.median(ndbi_vals)), "scenes": used}


@app.function(image=image, timeout=600, max_containers=40, retries=1, cpu=1.0, memory=2048)
def borough_stats(feature: dict) -> dict:
    from shapely.geometry import mapping, shape

    geom = shape(feature["geometry"])
    name = feature["properties"]["name"]
    bbox = list(geom.bounds)
    t0 = time.time()
    base = _index_stats(bbox, mapping(geom), BASE_YEAR)
    latest, latest_year = None, None
    for y in LATEST_YEARS:
        latest = _index_stats(bbox, mapping(geom), y)
        if latest:
            latest_year = y
            break
    out = {"name": name, "base": base, "latest": latest, "latest_year": latest_year, "seconds": round(time.time() - t0, 1)}
    print(name, json.dumps(out)[:300])
    return out


def _anomalies(results, key):
    """Per-borough index change minus the London-wide median change (removes season/drought/sensor drift),
    mapped to a readable % (1 NDBI point ~ 2.5%), clipped to a plausible range."""
    import statistics
    deltas = {n: r["latest"][key] - r["base"][key] for n, r in results.items() if r.get("base") and r.get("latest")}
    if not deltas:
        return {}
    med = statistics.median(deltas.values())
    return {n: round(max(-15.0, min(25.0, (d - med) * 250)), 1) for n, d in deltas.items()}


@app.function(image=image, timeout=1200, volumes={"/data": vol})
def build(force: bool = False) -> dict:
    import httpx
    from shapely.geometry import mapping, shape

    out_path = "/data/built/rent/london.json"
    import os
    if os.path.exists(out_path) and not force:
        print("cached:", out_path)
        return json.load(open("/data/built/rent/_stats.json"))

    gj = httpx.get(BOROUGHS_URL, timeout=60, follow_redirects=True).json()
    feats = gj["features"]
    t0 = time.time()
    results = {r["name"]: r for r in borough_stats.map(feats, return_exceptions=True) if isinstance(r, dict)}
    seconds = round(time.time() - t0, 1)

    built_anom, green_anom = _anomalies(results, "ndbi"), _anomalies(results, "ndvi")
    out_feats = []
    for f in feats:
        name = f["properties"]["name"]
        geom = shape(f["geometry"])
        rent_now, demand = RENTS.get(name, (2000, 1.0))
        r = results.get(name) or {}
        base, latest = r.get("base"), r.get("latest")
        built, green = built_anom.get(name, 0.0), green_anom.get(name, 0.0)
        # Growth: base 4% + demand prior - supply relief from new construction (NDBI up => more homes).
        supply = built * 0.1  # built_change_pct in [-15, 25] -> -1.5..2.5 pp
        g = 0.04 + demand / 100 - supply / 100
        g = max(0.01, min(0.10, g))
        rent_12m = round(rent_now * (1 + g))
        if built > 3:
            why = f"Built-up area +{built:.0f}% vs London since 2019 adds supply, but {WHY_DEMAND[demand]}."
        elif built < -3:
            why = f"Little new building since 2019 ({built:.0f}% vs London) while {WHY_DEMAND[demand]}."
        else:
            why = f"Construction in line with London since 2019 and {WHY_DEMAND[demand]}."
        simp = geom.simplify(0.0003, preserve_topology=True)
        c = geom.representative_point()
        out_feats.append({
            "type": "Feature",
            "geometry": json.loads(json.dumps(mapping(simp), default=float), parse_float=lambda s: round(float(s), 5)),
            "properties": {
                "name": name, "rent_now": rent_now, "rent_12m": rent_12m, "change_pct": round(g * 100, 1),
                "built_change_pct": built, "green_change_pct": green, "pressure": 0,
                "centroid": [round(c.x, 5), round(c.y, 5)], "why": why,
                "ndbi_2019": round(base["ndbi"], 4) if base else None,
                "ndbi_latest": round(latest["ndbi"], 4) if latest else None,
                "latest_year": r.get("latest_year"), "scenes": len((base or {}).get("scenes", [])) + len((latest or {}).get("scenes", [])),
            },
        })
    gs = [f["properties"]["change_pct"] for f in out_feats]
    lo, hi = min(gs), max(gs)
    for f in out_feats:  # pressure 0..100: min-max scaled rent growth across London (5..98 for visual contrast)
        f["properties"]["pressure"] = int(round(5 + 93 * (f["properties"]["change_pct"] - lo) / max(hi - lo, 1e-6)))
    fc = {"type": "FeatureCollection", "features": out_feats}
    os.makedirs("/data/built/rent", exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(fc, fh, separators=(",", ":"))
    stats = {"boroughs": len(out_feats), "with_satellite": sum(1 for f in out_feats if f["properties"]["ndbi_latest"] is not None),
             "containers": len(feats), "seconds": seconds}
    with open("/data/built/rent/_stats.json", "w") as fh:
        json.dump(stats, fh)
    vol.commit()
    print("wrote", out_path, os.path.getsize(out_path), "bytes", stats)
    return stats


@app.local_entrypoint()
def main(force: bool = False):
    print(build.remote(force=force))
