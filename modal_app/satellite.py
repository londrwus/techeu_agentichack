"""Orbit satellite pipeline: Sentinel-2 L2A (Microsoft Planetary Computer) -> indices + RGB thumbnails.

    modal run modal_app/satellite.py                 # full fan-out: all regions x months
    modal run modal_app/satellite.py --force         # recompute everything
    modal run modal_app/satellite.py::one --region-id jaen_olives --month 2023-06
    modal deploy modal_app/satellite.py              # so the backend can call process_tile live

Backend usage:  modal.Function.from_name("orbit-satellite", "process_tile").remote.aio(region_id, month)
"""
import io
import json
import os
import time
from datetime import date
from pathlib import Path

import modal

APP_NAME = "orbit-satellite"
DATA = Path("/data/built")
PX = 256

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("pystac-client", "planetary-computer", "rasterio", "numpy", "pillow", "shapely")
    .env({
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.TIF,.tiff",
        "GDAL_HTTP_MAX_RETRY": "4",
        "GDAL_HTTP_RETRY_DELAY": "1",
        "GDAL_HTTP_TIMEOUT": "20",
        "GDAL_HTTP_CONNECTTIMEOUT": "10",
        "VSI_CACHE": "TRUE",
    })
    .add_local_python_source("orbit")
)

app = modal.App(APP_NAME, image=image)
vol = modal.Volume.from_name("orbit-data", create_if_missing=True)


def _month_range(start: str, end: str) -> list[str]:
    y, m = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _latest_complete_month() -> str:
    t = date.today()
    y, m = (t.year - 1, 12) if t.month == 1 else (t.year, t.month - 1)
    return f"{y:04d}-{m:02d}"


def _month_bounds(month: str) -> str:
    y, m = map(int, month.split("-"))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    last = date.fromordinal(date(ny, nm, 1).toordinal() - 1)
    return f"{y:04d}-{m:02d}-01/{last.isoformat()}"


def _search(bbox, month):
    import planetary_computer
    import pystac_client
    from shapely.geometry import box, shape

    for attempt in range(5):
        try:
            cat = pystac_client.Client.open(
                "https://planetarycomputer.microsoft.com/api/stac/v1",
                modifier=planetary_computer.sign_inplace,
            )
            items = list(cat.search(collections=["sentinel-2-l2a"], bbox=bbox,
                                    datetime=_month_bounds(month), max_items=100).items())
            break
        except Exception as e:  # rate limits / transient errors
            if attempt == 4:
                raise
            time.sleep(2 * (attempt + 1))
    if not items:
        return None
    area = box(*bbox)
    full = [it for it in items if shape(it.geometry).contains(area)]
    pool = full or items
    low = [it for it in pool if (it.properties.get("eo:cloud_cover") or 100) < 40]
    pool = low or pool
    return min(pool, key=lambda it: it.properties.get("eo:cloud_cover") or 100)


def _read_band(href, bbox, resampling):
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds

    with rasterio.open(href) as src:
        b = transform_bounds("EPSG:4326", src.crs, *bbox, densify_pts=21)
        win = from_bounds(*b, transform=src.transform)
        return src.read(1, window=win, out_shape=(PX, PX), resampling=resampling,
                        boundless=True, fill_value=0)


@app.function(volumes={"/data": vol}, timeout=120, max_containers=100, cpu=1.0, memory=1024,
              retries=1)
def process_tile(region_id: str, month: str, force: bool = False, include_png: bool = False) -> dict:
    import base64

    import numpy as np
    from PIL import Image
    from rasterio.enums import Resampling

    from orbit.config import REGION_BY_ID

    t0 = time.time()
    region = REGION_BY_ID[region_id]
    thumb = f"tiles/{region_id}/{month}.png"
    png_path = DATA / thumb
    meta_path = DATA / f"tiles/{region_id}/{month}.json"
    task = os.environ.get("MODAL_TASK_ID", "local")

    def _ret(res):
        res["task_id"] = task
        if include_png and res.get("thumb") and png_path.exists():
            res["png_b64"] = base64.b64encode(png_path.read_bytes()).decode()
        return res

    if not force and meta_path.exists():
        res = json.loads(meta_path.read_text())
        res["cached"] = True
        return _ret(res)

    res = {"region_id": region_id, "month": month, "ndvi": None, "ndwi": None, "ndbi": None,
           "cloud_pct": None, "thumb": None, "scene": None, "cached": False}
    try:
        item = _search(region["bbox"], month)
    except Exception as e:
        res["error"] = f"search: {e}"[:200]
        return _ret(res)  # don't cache transient errors
    if item is None:
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(res))
        vol.commit()
        return _ret(res)

    try:
        bbox = region["bbox"]
        bands = {}
        for b in ["B02", "B03", "B04", "B08", "B11"]:
            bands[b] = _read_band(item.assets[b].href, bbox, Resampling.average).astype("float32")
        scl = _read_band(item.assets["SCL"].href, bbox, Resampling.nearest)
    except Exception as e:
        res["error"] = f"read: {e}"[:200]
        return _ret(res)

    # Processing baseline >= 04.00 (2022-01-25+) adds a +1000 offset to L2A reflectances.
    offset = 1000.0 if str(item.properties.get("s2:processing_baseline", "0")) >= "04.00" else 0.0
    nodata = (scl == 0) | (bands["B04"] == 0)
    for b in bands:
        bands[b] = np.clip((bands[b] - offset) / 10000.0, 0, 1.5)
    valid = ~nodata
    cloud = np.isin(scl, [3, 8, 9, 10]) & valid
    clear = valid & ~cloud & (scl != 1)
    n_valid = int(valid.sum())
    if n_valid == 0:
        res["error"] = "no valid pixels"
        return _ret(res)
    cloud_pct = 100.0 * cloud.sum() / n_valid

    def nd(a, b):
        a, b = bands[a], bands[b]
        with np.errstate(divide="ignore", invalid="ignore"):
            v = (a - b) / (a + b)
        v = v[clear & np.isfinite(v)]
        return round(float(v.mean()), 4) if v.size > 50 else None

    res.update({
        "ndvi": nd("B08", "B04"),
        "ndwi": nd("B03", "B08"),
        "ndbi": nd("B11", "B08"),
        "cloud_pct": round(float(cloud_pct), 1),
        "scene": item.id,
        "scene_cloud_cover": item.properties.get("eo:cloud_cover"),
        "datetime": item.properties.get("datetime"),
    })

    # True-colour thumbnail with a joint percentile stretch on clear pixels + mild gamma.
    rgb = np.stack([bands["B04"], bands["B03"], bands["B02"]], axis=-1)
    ref = rgb[clear] if clear.sum() > 100 else rgb[valid]
    lo, hi = np.percentile(ref, 1), np.percentile(ref, 99)
    img = np.clip((rgb - lo) / max(hi - lo, 1e-4), 0, 1) ** (1 / 1.25)
    img = (img * 255).astype("uint8")
    img[nodata] = 0
    png_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.fromarray(img, "RGB").save(buf, "PNG", optimize=True)
    png_path.write_bytes(buf.getvalue())
    res["thumb"] = thumb
    res["seconds"] = round(time.time() - t0, 2)
    meta_path.write_text(json.dumps(res))
    vol.commit()
    return _ret(res)


def _anomaly(series: list[dict], key: str):
    """Mean of latest 3 valid months vs mean of the same calendar months over the prior 5 years (%)."""
    good = [s for s in series if s.get(key) is not None and (s.get("cloud_pct") or 0) <= 60]
    if len(good) < 6:
        return None
    latest = good[-3:]
    cal = {s["month"][5:] for s in latest}
    last_year = int(latest[-1]["month"][:4])
    recent = {s["month"] for s in latest}
    base = [s[key] for s in good if s["month"][5:] in cal and s["month"] not in recent
            and last_year - 5 <= int(s["month"][:4]) < last_year + 1]
    if not base:
        return None
    now = sum(s[key] for s in latest) / 3
    b = sum(base) / len(base)
    if abs(b) < 1e-6:
        return None
    return round(max(-100.0, min(100.0, 100.0 * (now - b) / abs(b))), 1)  # clamp: indices near 0 explode


@app.function(volumes={"/data": vol}, timeout=300)
def write_outputs(results: list[dict], stats: dict) -> list[str]:
    from orbit.config import REGIONS

    vol.reload()
    out_dir = DATA / "satellite"
    out_dir.mkdir(parents=True, exist_ok=True)
    by_region: dict[str, list] = {}
    for r in results:
        by_region.setdefault(r["region_id"], []).append(r)
    written = []
    for reg in REGIONS:
        rows = sorted(by_region.get(reg["id"], []), key=lambda r: r["month"])
        series = [{k: r.get(k) for k in ("month", "ndvi", "ndwi", "ndbi", "cloud_pct", "thumb")} for r in rows]
        doc = {
            "region_id": reg["id"], "module": reg["module"], "item": reg.get("item"),
            "name": reg["name"], "lat": reg["lat"], "lon": reg["lon"], "bbox": reg["bbox"],
            "signal": reg.get("signal"),
            "series": series,
            "anomaly": {"ndvi_vs_5yr_pct": _anomaly(series, "ndvi"),
                        "ndwi_vs_5yr_pct": _anomaly(series, "ndwi"),
                        "ndbi_vs_5yr_pct": _anomaly(series, "ndbi")},
        }
        (out_dir / f"{reg['id']}.json").write_text(json.dumps(doc))
        written.append(reg["id"])
    stats_path = out_dir / "_stats.json"
    if stats.get("fresh", 0) > 0 or not stats_path.exists():  # an all-cached rerun keeps the real run's stats
        stats_path.write_text(json.dumps(stats))
    vol.commit()
    return written


@app.local_entrypoint()
def main(force: bool = False, start: str = "", end: str = ""):
    from orbit.config import HISTORY_START, REGIONS

    months = _month_range(start or HISTORY_START, end or _latest_complete_month())
    jobs = [(r["id"], m) for r in REGIONS for m in months]
    print(f"Fanning out {len(jobs)} tiles ({len(REGIONS)} regions x {len(months)} months) ...")
    t0 = time.time()
    results, tasks = [], set()
    for i, res in enumerate(process_tile.starmap(jobs, kwargs={"force": force},
                                                  return_exceptions=True)):
        if isinstance(res, BaseException) or not isinstance(res, dict):
            rid, m = jobs[i]
            res = {"region_id": rid, "month": m, "ndvi": None, "ndwi": None, "ndbi": None,
                   "cloud_pct": None, "thumb": None, "error": repr(res)[:200]}
        results.append(res)
        if res.get("task_id"):
            tasks.add(res["task_id"])
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(jobs)} done, {len(tasks)} containers, {time.time() - t0:.0f}s")
    secs = round(time.time() - t0, 1)
    ok = sum(1 for r in results if r.get("thumb"))
    errs = [r for r in results if r.get("error")]
    stats = {"tiles_processed": ok, "tiles_total": len(jobs), "containers_peak": len(tasks),
             "seconds": secs, "errors": len(errs),
             "fresh": sum(1 for r in results if r.get("thumb") and not r.get("cached"))}
    written = write_outputs.remote(results, stats)
    print(f"Tiles with imagery: {ok}/{len(jobs)} | containers used: {len(tasks)} | {secs}s | errors: {len(errs)}")
    for e in errs[:5]:
        print("  err:", e["region_id"], e["month"], e["error"])
    print(f"Wrote satellite JSON for {len(written)} regions")


@app.local_entrypoint()
def one(region_id: str = "jaen_olives", month: str = "2023-06", force: bool = True):
    print(process_tile.remote(region_id, month, force=force))
