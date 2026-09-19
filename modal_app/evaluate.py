r"""orbit-eval: "how right are we?" -- rolling-origin backtest of TimesFM on real FRED series, on Modal L4 GPUs.

    .\.venv\Scripts\modal run modal_app/evaluate.py            # reuses cached GPU forecasts if present
    .\.venv\Scripts\modal run modal_app/evaluate.py --force    # re-run all TimesFM backtests on GPU

1. Fetch FRED CSVs locally (FRED blocks many cloud IPs).
2. Build every point-in-time context: for each item and each monthly cutoff 2018-01..(latest-3)
   (gpu: curated anchor months only), the series truncated at the cutoff, in two context lengths
   (full / last 96 months). Nothing after the cutoff is ever passed to the model. Cached per key;
   only missing contexts are sent to the GPU.
3. Fan out over up to 10 L4 GPU containers with .map (TimesFM 3.0, fallback 2.5; weights cached in
   Volume "orbit-models"), 12-month horizon with 9 quantiles.
4. Cache raw quantiles in data/cache/eval/timesfm.json, then scripts/build_eval.py tunes Orbit on cutoffs < 2023,
   scores naive / drift / TimesFM / Orbit on the 2023+ test period and writes data/built/eval/*.json, which is uploaded to Volume "orbit-data" /built/eval.
"""
import json
import os
import sys
import time
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from orbit.config import ITEMS  # noqa: E402

APP_NAME = "orbit-eval"
GPU_TYPE = os.environ.get("ORBIT_GPU", "L4")
N_GPU = 10
HORIZON = 12
FRED_START = "2000-01-01"
CUTOFF_START = "2018-01"
CACHE = ROOT / "data" / "cache" / "eval"

app = modal.App(APP_NAME)
data_vol = modal.Volume.from_name("orbit-data", create_if_missing=True)
model_vol = modal.Volume.from_name("orbit-models", create_if_missing=True)

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("timesfm[torch]==3.0.2", "numpy")
    .env({"HF_HOME": "/models/hf"})
    .add_local_python_source("orbit")
)


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


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


def fetch_fred(series: str) -> str | None:
    """FRED CSV from this machine; falls back to a local cache (ours, then forecast.py's)."""
    import urllib.request

    own = CACHE / "fred" / f"{series}.csv"
    own.parent.mkdir(parents=True, exist_ok=True)
    try:
        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={FRED_START}"
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        text = urllib.request.urlopen(req, timeout=30).read().decode()
        if len(parse_fred(text)[0]) > 100:
            own.write_text(text)
            return text
    except Exception as e:
        print(f"FRED fetch failed for {series}: {e}")
    for p in (own, ROOT / "data" / "cache" / "fred" / f"{series}.csv"):
        if p.exists():
            return p.read_text()
    return None


CONTEXT_VARIANTS = {"full": 1024, "c96": 96}   # TimesFM context length is a tuned choice (full vs last 8 years)
CUTOFF_END_LAG = 3                               # last cutoff = latest month - 3 (h3/h6 reach into 2026)


def curated_gpu() -> tuple[list[str], list[float], list[str]]:
    """The live GPU series (UK x080-class street price, curated anchors in modal_app/forecast.py).
    Months between anchors are interpolated *towards the next anchor*, so only anchor months are used as
    cutoffs: the context then contains nothing that depends on a later anchor (point-in-time)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("orbit_forecast", ROOT / "modal_app" / "forecast.py")
    fc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fc)
    months, vals = fc.curated_series("gpu_street", None)
    return months, vals, [m for m, _ in fc.GPU_STREET_ANCHORS]


def clean_glitches(vals: list[float]) -> tuple[list[float], int]:
    """Replace isolated data errors (e.g. FRED olive oil Nov-Dec 2020 halves then snaps back):
    a point < 0.6x or > 1.67x the median of its +-3 neighbours is linearly interpolated."""
    import statistics as st

    out, n = list(vals), 0
    for i in range(len(vals)):
        nb = vals[max(0, i - 3): i] + vals[i + 1: i + 4]
        if len(nb) >= 4:
            med = st.median(nb)
            if not 0.6 < vals[i] / med < 1.67:
                out[i], n = med, n + 1
    return out, n


def load_histories() -> dict:
    out = {}
    for it in ITEMS:
        if it.get("curated") == "gpu_street":
            m, v, anchors = curated_gpu()
            out[it["id"]] = {"series": "curated:gpu_street", "months": m, "values": v, "cleaned_points": 0,
                             "proxy": False, "cutoff_months": anchors}
            continue
        sid = it.get("fred_series")
        if not sid:
            continue
        text = fetch_fred(sid)
        if text:
            m, v = parse_fred(text)
            v, n = clean_glitches(v)
            out[it["id"]] = {"series": sid, "months": m, "values": v, "cleaned_points": n,
                             "proxy": False}
    return out


@app.function(image=gpu_image, gpu=GPU_TYPE, memory=16384, volumes={"/models": model_vol},
              timeout=900, max_containers=N_GPU, retries=1)
def gpu_forecast(batch: list[dict]) -> dict:
    """batch: [{key, context}] -> {model, gpu, seconds, results: {key: [H][9] quantiles q0.1..q0.9}}."""
    import numpy as np
    import torch

    t0 = time.time()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    arrs = [np.asarray(b["context"], dtype=np.float32)[-b.get("ctx", 1024):] for b in batch]
    try:
        from timesfm3 import TimesFM3Forecaster

        m = TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch", device=dev,
                                               per_core_batch_size=64, cache_dir="/models/hf")
        res = list(m.predict_batch(arrs, horizon=HORIZON, return_quantiles=True,
                                   use_symmetric_averaging=True, make_positive=True, sort_quantiles=True))
        qs = [np.asarray(r.quantiles, dtype=float).reshape(HORIZON, -1)[:, :9].tolist() for r in res]
        model = "TimesFM 3.0 (google/timesfm-3.0-pytorch)"
    except Exception as e:
        print(f"TimesFM 3.0 failed: {e!r}; falling back to TimesFM 2.5")
        import timesfm

        m = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch", cache_dir="/models/hf")
        m.compile(timesfm.ForecastConfig(max_context=1024, max_horizon=128, normalize_inputs=True,
                                         use_continuous_quantile_head=True, force_flip_invariance=True,
                                         infer_is_positive=True, fix_quantile_crossing=True))
        _, q = m.forecast(horizon=HORIZON, inputs=arrs)
        qs = np.asarray(q)[:, :HORIZON, 1:10].tolist()
        model = "TimesFM 2.5 (google/timesfm-2.5-200m-pytorch)"
    try:
        model_vol.commit()
    except Exception:
        pass
    return {"model": model, "gpu": torch.cuda.get_device_name(0) if dev == "cuda" else "CPU",
            "seconds": round(time.time() - t0, 2),
            "results": {b["key"]: q for b, q in zip(batch, qs)}}


@app.local_entrypoint()
def main(force: bool = False):
    CACHE.mkdir(parents=True, exist_ok=True)
    raw_path = CACHE / "timesfm.json"
    hists = load_histories()
    (CACHE / "histories.json").write_text(json.dumps(hists))
    print(f"histories: { {k: (h['months'][0], h['months'][-1], len(h['months'])) for k, h in hists.items()} }")

    raw = json.loads(raw_path.read_text()) if raw_path.exists() and not force else {"results": {}}
    res = raw["results"]
    # migrate old 2-part keys ("item|cutoff") = full context; drop items whose series changed
    old_series = raw.get("series_of", {})
    for k in list(res):
        it = k.split("|")[0]
        if it not in hists or old_series.get(it, hists[it]["series"]) != hists[it]["series"] or (
                it == "gpu" and not old_series):   # pre-2026-09 cache scored gpu on the chip PPI proxy
            res.pop(k)
        elif k.count("|") == 1:
            res[f"{k}|full"] = res.pop(k)
    jobs = []
    for iid, h in hists.items():
        months, vals = h["months"], h["values"]
        last_cut = add_months(months[-1], -CUTOFF_END_LAG)
        allowed = set(h.get("cutoff_months") or months)
        for k, ym in enumerate(months):
            if CUTOFF_START <= ym <= last_cut and ym in allowed and k >= 12:
                for cv, n in CONTEXT_VARIANTS.items():
                    key = f"{iid}|{ym}|{cv}"
                    if key not in res:
                        jobs.append({"key": key, "context": vals[: k + 1], "ctx": n})  # point-in-time: <= cutoff
    if jobs:
        chunks = [c for c in (jobs[i::N_GPU] for i in range(N_GPU)) if c]
        t0 = time.time()
        secs, model, gpu = [], raw.get("model"), (raw.get("gpu") or {}).get("type")
        for r in gpu_forecast.map(chunks):
            res.update(r["results"])
            secs.append(r["seconds"])
            model, gpu = r["model"], r["gpu"]
        wall = round(time.time() - t0, 1)
        prev = raw.get("gpu") or {}
        raw.update(generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), model=model,
                   gpu={"type": gpu, "seconds": round(sum(secs) + (prev.get("seconds") or 0), 1),
                        "containers": len(chunks), "wall_seconds": wall,
                        "last_run": {"forecasts": len(jobs), "gpu_seconds": round(sum(secs), 1)}},
                   horizon=HORIZON)
        print(f"TimesFM forecasts: {len(jobs)} new contexts x {HORIZON} months on {len(chunks)} x {gpu}; "
              f"GPU seconds {sum(secs):.1f} (wall {wall}s); model {model}")
    else:
        print("all point-in-time forecasts cached; use --force to recompute")
    raw.update(n_forecasts=len(res), results=res, series_of={k: h["series"] for k, h in hists.items()},
               context_variants=CONTEXT_VARIANTS)
    raw_path.write_text(json.dumps(raw))

    import subprocess

    env = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONIOENCODING="utf-8")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_eval.py")], check=True, env=env)
    out = ROOT / "data" / "built" / "eval"
    with data_vol.batch_upload(force=True) as batch:
        for p in out.glob("*.json"):
            batch.put_file(str(p), f"/built/eval/{p.name}")
    print(f"uploaded {len(list(out.glob('*.json')))} files to orbit-data:/built/eval")
