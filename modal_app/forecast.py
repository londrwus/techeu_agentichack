r"""orbit-forecast: price history -> GPU time-series foundation model -> 12-month retail forecasts.

    .\.venv\Scripts\modal run modal_app/forecast.py            # uses cache if present
    .\.venv\Scripts\modal run modal_app/forecast.py --force
    .\.venv\Scripts\modal deploy modal_app/forecast.py
    $env:ORBIT_GPU="L4"; ...   # run TimesFM on a GPU (needs a payment method on the Modal workspace)

Writes /data/built/forecast/{item_id}.json + _stats.json (see CLAUDE.md contracts).
Model: Google TimesFM 3.0 (fallback TimesFM 2.5) on an L4 GPU; weights cached in Volume "orbit-models".
"""
import json
import math
import sys
import time
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from orbit.config import BACKTESTS, FORECAST_MONTHS, ITEMS  # noqa: E402

APP_NAME = "orbit-forecast"
import os  # noqa: E402

# GPU is opt-in: the Modal workspace currently rejects GPU functions ("add a payment method"),
# and TimesFM (200M params) on 13 short series runs in seconds on 8 CPUs anyway.
GPU_TYPE = os.environ.get("ORBIT_GPU", "cpu")
USE_GPU = GPU_TYPE.lower() != "cpu"
HIST_MONTHS = 84          # ~7 years shown in the UI
FRED_START = "2000-01-01"  # longer context for the model

app = modal.App(APP_NAME)
data_vol = modal.Volume.from_name("orbit-data", create_if_missing=True)
model_vol = modal.Volume.from_name("orbit-models", create_if_missing=True)

base_image = modal.Image.debian_slim(python_version="3.12").uv_pip_install("numpy").add_local_python_source("orbit")
gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("timesfm[torch]==3.0.2", "numpy")
    .env({"HF_HOME": "/models/hf"})
    .add_local_python_source("orbit")
)


# ---------------------------------------------------------------- month helpers
def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


def month_range(start: str, end: str) -> list[str]:
    out, cur = [], start
    while cur <= end:
        out.append(cur)
        cur = add_months(cur, 1)
    return out


# ---------------------------------------------------------------- price history (CPU)
def synthetic_driver(item_id: str, months: list[str]) -> list[float]:
    """Plausible underlying driver index (=100 at start) for items without a FRED series."""
    import numpy as np

    rng = np.random.default_rng(sum(map(ord, item_id)))
    vals, level = [], 100.0
    for ym in months:
        y, m = map(int, ym.split("-"))
        t = y + (m - 1) / 12
        if item_id == "rent_1bed":
            g = 0.020 if t < 2020.2 else -0.08 if t < 2021.3 else 0.09 if t < 2023.9 else 0.055
            season = 0.012 * math.sin(2 * math.pi * (m - 4) / 12)   # summer peak
            noise = 0.004
        elif item_id == "laptop":
            g = -0.02 if t < 2020.5 else 0.10 if t < 2022.3 else -0.06 if t < 2024.5 else 0.08
            season = -0.02 * math.cos(2 * math.pi * (m - 11) / 12)  # Black-Friday dip
            noise = 0.010
        else:  # wine
            g = 0.02 if t < 2021.8 else 0.09 if t < 2023.8 else 0.035
            season = 0.015 * math.cos(2 * math.pi * (m - 12) / 12)  # Christmas bump
            noise = 0.006
        level *= math.exp(g / 12 + rng.normal(0, noise))
        vals.append(level * (1 + season))
    return vals


def parse_fred(text: str) -> tuple[list[str], list[float]]:
    months, vals = [], []
    for line in text.strip().splitlines()[1:]:
        d, v = (line.split(",") + [""])[:2]
        try:
            fv = float(v)
        except ValueError:
            continue
        if fv > 0:
            months.append(d[:7])
            vals.append(fv)
    return months, vals


@app.function(image=base_image, volumes={"/data": data_vol}, timeout=120, max_containers=20, retries=1)
def load_history(item: dict) -> dict:
    """Monthly driver series for one item: FRED commodity CSV (cached on the Volume) or synthetic."""
    import urllib.request

    series, source = item.get("fred_series"), "synthetic"
    months, vals = [], []
    if series:
        cache = Path(f"/data/raw/fred/{series}.csv")
        text = None
        if cache.exists() and time.time() - cache.stat().st_mtime < 3 * 86400:
            text = cache.read_text()
        else:  # FRED tarpits non-curl user agents / some cloud IPs; local entrypoint pre-uploads CSVs
            try:
                url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={FRED_START}"
                req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
                text = urllib.request.urlopen(req, timeout=10).read().decode()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(text)
                data_vol.commit()
            except Exception as e:
                print(f"[{item['id']}] FRED fetch failed ({e})")
                text = cache.read_text() if cache.exists() else None
        if text:
            months, vals = parse_fred(text)
            source = f"FRED:{series}"
    if not months:
        end = add_months(time.strftime("%Y-%m"), -1)
        months = month_range("2008-01", end)
        vals = synthetic_driver(item["id"], months)
        source = "synthetic"
    return {"item_id": item["id"], "months": months, "values": vals, "source": source}


# ---------------------------------------------------------------- GPU forecasting
@app.function(image=gpu_image, gpu=GPU_TYPE if USE_GPU else None, cpu=None if USE_GPU else 8.0,
              memory=16384, volumes={"/models": model_vol}, timeout=900, max_containers=2)
def gpu_forecast(contexts: list[list[float]], horizon: int) -> dict:
    """Forecast every context in one batch. Returns {model, quantiles: [N][H][9] for q=0.1..0.9, seconds}."""
    import numpy as np
    import torch

    t0 = time.time()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    torch.set_num_threads(8)
    arrs = [np.asarray(c, dtype=np.float32)[-1024:] for c in contexts]
    model_name, out = None, None
    try:
        from timesfm3 import TimesFM3Forecaster

        m = TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch", device=dev,
                                               per_core_batch_size=32, cache_dir="/models/hf")
        res = list(m.predict_batch(arrs, horizon=horizon, return_quantiles=True,
                                   use_symmetric_averaging=True, make_positive=True, sort_quantiles=True))
        out = [np.asarray(r.quantiles, dtype=float).reshape(horizon, -1)[:, :9].tolist() for r in res]
        model_name = "TimesFM 3.0 (google/timesfm-3.0-pytorch)"
    except Exception as e:
        print(f"TimesFM 3.0 failed: {e!r}; falling back to TimesFM 2.5")
        import timesfm

        m = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch", cache_dir="/models/hf")
        m.compile(timesfm.ForecastConfig(max_context=1024, max_horizon=max(128, horizon), normalize_inputs=True,
                                         use_continuous_quantile_head=True, force_flip_invariance=True,
                                         infer_is_positive=True, fix_quantile_crossing=True))
        _, q = m.forecast(horizon=horizon, inputs=arrs)
        out = np.asarray(q)[:, :horizon, 1:10].tolist()  # index 0 is the mean
        model_name = "TimesFM 2.5 (google/timesfm-2.5-200m-pytorch)"
    model_vol.commit()
    return {"model": model_name, "quantiles": out, "seconds": round(time.time() - t0, 1),
            "gpu": torch.cuda.get_device_name(0) if dev == "cuda" else "CPU x8 (TimesFM on Modal CPU)"}


# ---------------------------------------------------------------- assembly (CPU)
QLEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]


def prob_above(qs: list[float], x: float) -> float:
    """P(price > x) from 9 quantiles, linear interpolation, tails clamped."""
    qs = sorted(qs)
    if x <= qs[0]:
        return 0.95 if x < qs[0] - (qs[1] - qs[0]) else 0.9
    if x >= qs[-1]:
        return 0.05 if x > qs[-1] + (qs[-1] - qs[-2]) else 0.1
    for i in range(8):
        if qs[i] <= x <= qs[i + 1]:
            f = (x - qs[i]) / max(qs[i + 1] - qs[i], 1e-12)
            return 1 - (QLEVELS[i] + f * 0.1)
    return 0.5


def parse_fred(text: str) -> tuple[list[str], list[float]]:
    months, vals = [], []
    for line in text.strip().splitlines()[1:]:
        d, v = (line.split(",") + [""])[:2]
        try:
            fv = float(v)
        except ValueError:
            continue
        if fv > 0:
            months.append(d[:7])
            vals.append(fv)
    return months, vals


@app.function(image=base_image, volumes={"/data": data_vol}, timeout=1200)
def run(force: bool = False) -> dict:
    out_dir = Path("/data/built/forecast")
    stats_path = out_dir / "_stats.json"
    if stats_path.exists() and not force:
        print("cached; use --force to recompute")
        return json.loads(stats_path.read_text())

    t0 = time.time()
    hists = {h["item_id"]: h for h in load_history.map(ITEMS)}
    item_by_id = {i["id"]: i for i in ITEMS}
    bt_by_item = {b["item_id"]: b for b in BACKTESTS}

    # One GPU batch: live forecasts for every item + backtests from truncated history.
    jobs = [("live", i["id"], hists[i["id"]]["values"]) for i in ITEMS]
    for b in BACKTESTS:
        h = hists[b["item_id"]]
        if b["as_of"] in h["months"]:
            k = h["months"].index(b["as_of"])
            jobs.append(("bt", b["item_id"], h["values"][: k + 1]))
    res = gpu_forecast.remote([j[2] for j in jobs], FORECAST_MONTHS)
    qmap = {(j[0], j[1]): q for j, q in zip(jobs, res["quantiles"])}

    out_dir.mkdir(parents=True, exist_ok=True)
    summary = []
    for item in ITEMS:
        iid, h = item["id"], hists[item["id"]]
        R, s, c_last = item["retail_now"], item["commodity_share"], h["values"][-1]

        def retail(c: float) -> float:  # pass-through; latest point == retail_now
            return round(max(R * (1 + s * (c / c_last - 1)), 0.05 * R), 2)

        months, vals = h["months"], h["values"]
        history = [{"month": m, "price": retail(v)} for m, v in zip(months, vals)][-HIST_MONTHS:]
        q = qmap[("live", iid)]
        forecast = []
        for k, row in enumerate(q):
            forecast.append({"month": add_months(months[-1], k + 1),
                             "p10": retail(row[0]), "p50": retail(row[4]), "p90": retail(row[8])})
        q6 = [retail(v) for v in q[5]]
        prob_up = prob_above(q6, R) if s > 0 else 0.5
        change_6m = (forecast[5]["p50"] / R - 1) * 100

        backtest = None
        if ("bt", iid) in qmap:
            b = bt_by_item[iid]
            k = months.index(b["as_of"])
            base = retail(vals[k])
            bq = qmap[("bt", iid)]
            actual = retail(vals[k + 6]) if k + 6 < len(vals) else None
            backtest = {
                "as_of": b["as_of"], "story": b.get("story"),
                "predicted_change_pct": round((retail(bq[5][4]) / base - 1) * 100, 1),
                "actual_change_pct": round((actual / base - 1) * 100, 1) if actual else None,
                "prob_up_6m": round(prob_above([retail(v) for v in bq[5]], base), 3),
                "path": [{"month": add_months(b["as_of"], j + 1), "p10": retail(r[0]), "p50": retail(r[4]),
                          "p90": retail(r[8])} for j, r in enumerate(bq)],
            }
        doc = {"item_id": iid, "name": item["name"], "unit": item["unit"], "source": h["source"],
               "history": history, "forecast": forecast, "prob_up_6m": round(prob_up, 3),
               "change_6m_pct": round(change_6m, 1), "model": res["model"], "backtest": backtest}
        (out_dir / f"{iid}.json").write_text(json.dumps(doc))
        summary.append({"item_id": iid, "source": h["source"], "last": months[-1], "now": R,
                        "p50_6m": forecast[5]["p50"], "change_6m_pct": doc["change_6m_pct"],
                        "prob_up_6m": doc["prob_up_6m"],
                        "bt": backtest and (backtest["predicted_change_pct"], backtest["actual_change_pct"])})

    stats = {"gpu_model": res["model"], "gpu_type": res.get("gpu") or GPU_TYPE, "gpu_seconds": res["seconds"],
             "seconds": round(time.time() - t0, 1), "series": len(jobs), "items": summary,
             "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    stats_path.write_text(json.dumps(stats, indent=1))
    data_vol.commit()
    return stats


def upload_fred_local():
    """Fetch FRED CSVs from this machine (FRED blocks many cloud IPs) and push them to the Volume cache."""
    import urllib.request

    tmp = ROOT / "data" / "cache" / "fred"
    tmp.mkdir(parents=True, exist_ok=True)
    ok = []
    for item in ITEMS:
        sid = item.get("fred_series")
        if not sid:
            continue
        try:
            url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={FRED_START}"
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
            text = urllib.request.urlopen(req, timeout=30).read().decode()
            if len(parse_fred(text)[0]) > 24:
                (tmp / f"{sid}.csv").write_text(text)
                ok.append(sid)
        except Exception as e:
            print(f"local FRED fetch failed for {sid}: {e}")
    if ok:
        with data_vol.batch_upload(force=True) as batch:
            for sid in ok:
                batch.put_file(str(tmp / f"{sid}.csv"), f"/raw/fred/{sid}.csv")
    print(f"uploaded {len(ok)} FRED series: {ok}")


@app.local_entrypoint()
def main(force: bool = False):
    upload_fred_local()
    stats = run.remote(force)
    print(json.dumps(stats, indent=1))
