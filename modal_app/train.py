r"""orbit-train: the "Orbit learner", a LightGBM model stacked on Google TimesFM 3.0.

TimesFM gives a zero-shot 6-month baseline; LightGBM, trained on ~25 years x ~70 World Bank commodity
series (+ our FRED items), learns when to correct it. Honest time split: train < 2019, validation
2019-2022 (hyperparameter search fanned out on CPU containers), test >= 2023 untouched.

    $env:PYTHONIOENCODING="utf-8"; .\.venv\Scripts\modal run modal_app/train.py            # cached TimesFM features reused
    .\.venv\Scripts\modal run modal_app/train.py --force                                    # recompute TimesFM features

Writes /data/built/model/{summary,predictions}.json on Volume "orbit-data" and data/built/model/ locally.
"""
import json
import math
import sys
import time
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from orbit.config import ITEMS, REGIONS  # noqa: E402

APP_NAME = "orbit-train"
PINK_URLS = [
    "https://thedocs.worldbank.org/en/doc/18675f1d1639c7a34d463f59263ba0a2-0050012025/related/CMO-Historical-Data-Monthly.xlsx",
    "https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Monthly.xlsx",
]
H = 6                    # target horizon (months)
FIRST_CUTOFF = "2005-01"
STEP = 3                 # cutoff every 3 months
TRAIN_END, VAL_END = "2019-01", "2023-01"   # train < 2019-01 <= val < 2023-01 <= test
GPU_CONTAINERS = 6
FEATURES = ["tfm_p50_pct", "tfm_width", "mom_3", "mom_6", "mom_12", "vol_12", "dist_5y", "month", "sat_anom"]

app = modal.App(APP_NAME)
data_vol = modal.Volume.from_name("orbit-data", create_if_missing=True)
model_vol = modal.Volume.from_name("orbit-models", create_if_missing=True)

cpu_image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
    "numpy", "pandas", "openpyxl", "lightgbm", "scikit-learn")
gpu_image = (modal.Image.debian_slim(python_version="3.12")
             .uv_pip_install("timesfm[torch]==3.0.2", "numpy").env({"HF_HOME": "/models/hf"}))


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


# ---------------------------------------------------------------- data (CPU)
@app.function(image=cpu_image, volumes={"/data": data_vol}, timeout=600)
def load_pink_sheet() -> dict:
    """World Bank CMO 'Pink Sheet' monthly prices -> {series_name: {months, values}} (monthly since 1960)."""
    import io
    import re
    import urllib.request

    import pandas as pd

    cache = Path("/data/raw/worldbank/CMO-Historical-Data-Monthly.xlsx")
    if not cache.exists() or time.time() - cache.stat().st_mtime > 7 * 86400:
        for url in PINK_URLS:
            try:
                raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8.0"}),
                                             timeout=60).read()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(raw)
                data_vol.commit()
                print(f"downloaded {url} ({len(raw)} bytes)")
                break
            except Exception as e:
                print(f"pink sheet fetch failed {url}: {e}")
    df = pd.read_excel(io.BytesIO(cache.read_bytes()), sheet_name="Monthly Prices", header=None)
    first_col = df.iloc[:, 0].astype(str)
    data_rows = first_col.str.match(r"^\d{4}M\d{2}$")
    first = int(data_rows.idxmax())
    names = None                             # header: nearest row above the data with many names (not "(units)")
    for r in range(first - 1, -1, -1):
        row = [str(x).strip() for x in df.iloc[r].tolist()]
        if sum(1 for x in row[1:] if x and x != "nan" and not x.startswith("(")) > 20:
            names = row
            break
    out = {}
    for j in range(1, df.shape[1]):
        name = str(names[j]).strip()
        if not name or name == "nan":
            continue
        s = pd.to_numeric(df.loc[data_rows, j], errors="coerce")
        months = [f"{v[:4]}-{v[5:7]}" for v in first_col[data_rows]]
        pts = [(m, float(v)) for m, v in zip(months, s) if pd.notna(v) and v > 0 and m >= "1995-01"]
        if len(pts) < 240:                   # need >= 20 years of history
            continue
        key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        out[f"wb_{key}"] = {"months": [p[0] for p in pts], "values": [p[1] for p in pts]}
    print(f"pink sheet: {len(out)} series, last month {max(v['months'][-1] for v in out.values())}")
    return out


# ---------------------------------------------------------------- TimesFM (GPU)
@app.function(image=gpu_image, gpu="L4", memory=16384, volumes={"/models": model_vol}, timeout=1200,
              max_containers=GPU_CONTAINERS)
def tfm_batch(contexts: list[list[float]]) -> dict:
    """TimesFM 3.0 on one chunk of contexts -> 6-month p10/p50/p90 per context."""
    import numpy as np
    import torch
    from timesfm3 import TimesFM3Forecaster

    t0 = time.time()
    m = TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch", device="cuda",
                                           per_core_batch_size=64, cache_dir="/models/hf")
    arrs = [np.asarray(c, dtype=np.float32)[-512:] for c in contexts]
    res = list(m.predict_batch(arrs, horizon=H, return_quantiles=True, use_symmetric_averaging=True,
                               make_positive=True, sort_quantiles=True))
    out = []
    for r in res:
        q = np.asarray(r.quantiles, dtype=float).reshape(H, -1)[H - 1, :9]
        out.append([float(q[0]), float(q[4]), float(q[8])])
    return {"q": out, "seconds": round(time.time() - t0, 1), "gpu": torch.cuda.get_device_name(0)}


# ---------------------------------------------------------------- features
def sat_anomaly(sat: list[dict], t: str) -> float:
    """Point-in-time satellite anomaly: latest index value (<= t) vs trailing mean of earlier months, in %."""
    vals = []
    for s in sat:
        key = s["key"]
        pts = [(p["month"], p.get(key)) for p in s["series"] if p["month"] <= t and p.get(key) is not None]
        if len(pts) < 13:
            continue
        cur, hist = pts[-1][1], [v for _, v in pts[:-1]][-36:]
        base = sum(hist) / len(hist)
        if abs(base) > 1e-3:
            vals.append((cur - base) / abs(base) * 100)
    return float(sum(vals) / len(vals)) if vals else float("nan")


def feats(months: list[str], values: list[float], k: int, sat: list[dict] | None) -> dict:
    import numpy as np

    v = np.asarray(values[: k + 1], dtype=float)
    lr = np.diff(np.log(v))
    return {
        "mom_3": (v[-1] / v[-4] - 1) * 100, "mom_6": (v[-1] / v[-7] - 1) * 100, "mom_12": (v[-1] / v[-13] - 1) * 100,
        "vol_12": float(lr[-12:].std() * math.sqrt(12) * 100),
        "dist_5y": (v[-1] / v[-60:].mean() - 1) * 100,
        "month": int(months[k][5:7]),
        "sat_anom": sat_anomaly(sat, months[k]) if sat else float("nan"),
    }


# ---------------------------------------------------------------- training (CPU fan-out)
PARAMS = dict(objective="huber", alpha=15.0, verbose=-1, seed=7, feature_fraction=0.9, bagging_fraction=0.8,
              bagging_freq=1)


def configs() -> list[dict]:
    out = []
    for leaves in (4, 8):
        for min_leaf in (40, 150):
            for lr, n in ((0.03, 150), (0.03, 400)):
                for target in ("residual", "direct"):
                    out.append({"num_leaves": leaves, "min_data_in_leaf": min_leaf, "learning_rate": lr,
                                "n_estimators": n, "target": target})
    return out[:20] + [{"num_leaves": 3, "min_data_in_leaf": 200, "learning_rate": 0.05, "n_estimators": 100,
                        "target": "residual"}]


def fit_predict(cfg: dict, Xtr, ytr, tfm_tr, Xte, tfm_te):
    import lightgbm as lgb
    import numpy as np

    p = {**PARAMS, **{k: v for k, v in cfg.items() if k not in ("target", "n_estimators")}}
    y = ytr - tfm_tr if cfg["target"] == "residual" else ytr
    m = lgb.train(p, lgb.Dataset(Xtr, y), num_boost_round=cfg["n_estimators"])
    pred = m.predict(Xte)
    return (pred + tfm_te if cfg["target"] == "residual" else pred), m


@app.function(image=cpu_image, timeout=300, max_containers=30)
def eval_config(cfg: dict, rows: list[dict]) -> dict:
    import numpy as np

    tr = [r for r in rows if r["month_t"] < TRAIN_END]
    va = [r for r in rows if TRAIN_END <= r["month_t"] < VAL_END]
    X = lambda rs: np.array([[r[f] for f in FEATURES] for r in rs], dtype=float)  # noqa: E731
    pred, _ = fit_predict(cfg, X(tr), np.array([r["y"] for r in tr]), np.array([r["tfm_p50_pct"] for r in tr]),
                          X(va), np.array([r["tfm_p50_pct"] for r in va]))
    y = np.array([r["y"] for r in va])
    return {"cfg": cfg, "val_mae": float(np.abs(pred - y).mean()),
            "val_mae_tfm": float(np.abs(np.array([r["tfm_p50_pct"] for r in va]) - y).mean())}


def metrics(pred, y) -> dict:
    import numpy as np

    big = np.abs(y) > 15
    nz = y != 0
    return {"mae_pct": round(float(np.abs(pred - y).mean()), 2),
            "directional_acc": round(float((np.sign(pred[nz]) == np.sign(y[nz])).mean()), 3),
            # share of >15% moves where the model called the right direction with a >5% move
            "big_move_recall": round(float(((np.sign(pred[big]) == np.sign(y[big])) & (np.abs(pred[big]) > 5)).mean())
                                     if big.any() else 0.0, 3),
            "n": int(len(y)), "n_big_moves": int(big.sum())}


# ---------------------------------------------------------------- orchestration
@app.function(image=cpu_image, volumes={"/data": data_vol}, timeout=3600)
def run(local_series: dict, sat_by_item: dict, force: bool = False) -> dict:
    import numpy as np

    t0 = time.time()
    series = load_pink_sheet.remote()
    series.update(local_series)              # our items: FRED drivers / curated / synthetic retail series
    ours = set(local_series)

    # contexts: (series, cutoff t) with >= 60 months of history; live context = full series
    jobs = []
    for sid, s in series.items():
        months, vals = s["months"], s["values"]
        idx = {m: i for i, m in enumerate(months)}
        t = FIRST_CUTOFF if sid not in ours else add_months(months[0], 60)
        while t <= months[-1]:
            k = idx.get(t)
            if k is not None and k >= 59:
                jobs.append((sid, k))
            t = add_months(t, STEP)
        if sid in ours and (sid, len(months) - 1) not in jobs:
            jobs.append((sid, len(months) - 1))
    print(f"{len(series)} series, {len(jobs)} TimesFM contexts")

    cache = Path("/data/built/model/_tfm_cache.json")
    tfm = json.loads(cache.read_text()) if cache.exists() and not force else {}
    todo = [j for j in jobs if f"{j[0]}|{series[j[0]]['months'][j[1]]}" not in tfm]
    gpu_info = {"type": "NVIDIA L4", "seconds": 0.0, "containers": 0, "contexts": len(todo)}
    if todo:
        n = max(1, min(GPU_CONTAINERS, math.ceil(len(todo) / 500)))
        chunks = [todo[i::n] for i in range(n)]
        payload = [[series[s]["values"][: k + 1] for s, k in ch] for ch in chunks]
        g0 = time.time()
        for ch, res in zip(chunks, tfm_batch.map(payload)):
            gpu_info["seconds"] += res["seconds"]
            gpu_info["type"] = res["gpu"]
            for (s, k), q in zip(ch, res["q"]):
                tfm[f"{s}|{series[s]['months'][k]}"] = q
        gpu_info.update(containers=n, seconds=round(gpu_info["seconds"], 1), wall_seconds=round(time.time() - g0, 1))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(tfm))
        data_vol.commit()
    elif (Path("/data/built/model/summary.json")).exists():
        gpu_info = json.loads(Path("/data/built/model/summary.json").read_text()).get("gpu", gpu_info)

    # feature rows
    rows, live = [], {}
    for sid, k in jobs:
        s = series[sid]
        mt = s["months"][k]
        q10, q50, q90 = tfm[f"{sid}|{mt}"]
        last = s["values"][k]
        r = {"series": sid, "month_t": mt, "tfm_p50_pct": (q50 / last - 1) * 100,
             "tfm_width": (q90 - q10) / max(q50, 1e-9),
             **feats(s["months"], s["values"], k, sat_by_item.get(sid))}
        if k == len(s["months"]) - 1 and sid in ours:
            live[sid] = r
        if s.get("synthetic"):               # curated/synthetic series: live prediction only, never train/test
            continue
        if k + H < len(s["values"]) and s["months"][k + H] == add_months(mt, H):
            r["y"] = (s["values"][k + H] / last - 1) * 100
            rows.append(r)
    for r in rows:
        r["y"] = float(np.clip(r["y"], -80, 150))
    print(f"{len(rows)} labelled rows")

    # hyperparameter search on validation, fanned out
    cfgs = configs()
    results = list(eval_config.map(cfgs, kwargs={"rows": rows}))
    results.sort(key=lambda r: r["val_mae"])
    best = results[0]["cfg"]
    print("best", results[0])

    # final: train on train+val (< 2023-01), evaluate once on test
    X = lambda rs: np.array([[r[f] for f in FEATURES] for r in rs], dtype=float)  # noqa: E731
    tr = [r for r in rows if r["month_t"] < VAL_END]
    te = [r for r in rows if r["month_t"] >= VAL_END]
    tf_tr, tf_te = np.array([r["tfm_p50_pct"] for r in tr]), np.array([r["tfm_p50_pct"] for r in te])
    y_tr, y_te = np.array([r["y"] for r in tr]), np.array([r["y"] for r in te])
    pred, model = fit_predict(best, X(tr), y_tr, tf_tr, X(te), tf_te)
    test_metrics = {"naive": metrics(np.zeros_like(y_te), y_te), "timesfm": metrics(tf_te, y_te),
                    "orbit_learner": metrics(pred, y_te)}
    gains = model.feature_importance("gain")
    fi = sorted([{"feature": f, "gain_pct": round(float(g / gains.sum() * 100), 1)} for f, g in zip(FEATURES, gains)],
                key=lambda d: -d["gain_pct"])

    # current predictions for our items
    lv = [live[i] for i in sorted(live)]
    lpred, _ = fit_predict(best, X(tr), y_tr, tf_tr, X(lv), np.array([r["tfm_p50_pct"] for r in lv]))
    per_item = [{"item_id": r["series"], "as_of": r["month_t"], "timesfm_6m_pct": round(r["tfm_p50_pct"], 1),
                 "learner_6m_pct": round(float(p), 1), "correction_pct": round(float(p) - r["tfm_p50_pct"], 1)}
                for r, p in zip(lv, lpred)]
    ours_te = [i for i, r in enumerate(te) if r["series"] in ours]
    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": "LightGBM stacked on TimesFM 3.0",
        "target": "6-month % change of the underlying commodity/driver series",
        "n_series": len(series), "n_series_worldbank": len(series) - len(ours),
        "n_rows_train": len(tr), "n_rows_test": len(te),
        "train_period": f"{min(r['month_t'] for r in tr)}..{max(r['month_t'] for r in tr)}",
        "validation_period": f"{TRAIN_END}..2022-12 (hyperparameter search; final model refit on train+val)",
        "test_period": f"{min(r['month_t'] for r in te)}..{max(r['month_t'] for r in te)} (cutoffs; outcomes 6m later)",
        "features": FEATURES, "best_config": best,
        "gpu": gpu_info, "cpu_containers": len(cfgs) + 1,
        "search": [{"cfg": r["cfg"], "val_mae": round(r["val_mae"], 3)} for r in results],
        "val_mae_timesfm": round(results[0]["val_mae_tfm"], 3),
        "test_metrics": test_metrics,
        "test_metrics_our_items": {
            "timesfm": metrics(tf_te[ours_te], y_te[ours_te]),
            "orbit_learner": metrics(pred[ours_te], y_te[ours_te])} if ours_te else None,
        "feature_importance": fi, "per_item": per_item,
        "seconds": round(time.time() - t0, 1),
    }
    predictions = {"generated_at": summary["generated_at"], "model": summary["model"], "horizon_months": H,
                   "note": "6m % change of each item's driver series; blend into retail via commodity_share",
                   "items": {p["item_id"]: p for p in per_item}}
    out = Path("/data/built/model")
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    (out / "predictions.json").write_text(json.dumps(predictions, indent=1))
    data_vol.commit()
    return {"summary": summary, "predictions": predictions}


# ---------------------------------------------------------------- local entrypoint
def local_inputs() -> tuple[dict, dict]:
    """Our items' driver series (cached FRED CSVs, else forecast JSON history) + satellite series per item."""
    series = {}
    for it in ITEMS:
        sid, pts = it.get("fred_series"), []
        csv = ROOT / "data" / "cache" / "fred" / f"{sid}.csv"
        if sid and csv.exists():
            for line in csv.read_text().strip().splitlines()[1:]:
                d, v = (line.split(",") + [""])[:2]
                try:
                    if float(v) > 0:
                        pts.append((d[:7], float(v)))
                except ValueError:
                    pass
        else:
            f = ROOT / "data" / "built" / "forecast" / f"{it['id']}.json"
            if f.exists():
                pts = [(h["month"], h["price"]) for h in json.loads(f.read_text()).get("history", [])]
        if len(pts) >= 72:
            series[it["id"]] = {"months": [p[0] for p in pts], "values": [p[1] for p in pts],
                                "synthetic": not (sid and csv.exists())}
    sat = {}
    for r in REGIONS:
        f = ROOT / "data" / "built" / "satellite" / f"{r['id']}.json"
        if f.exists() and r.get("item"):
            key = {"water": "ndwi", "built": "ndbi", "datacenter": "ndbi", "fab": "ndbi"}.get(r["signal"], "ndvi")
            sat.setdefault(r["item"], []).append({"key": key, "series": json.loads(f.read_text()).get("series", [])})
    return series, sat


@app.local_entrypoint()
def main(force: bool = False):
    series, sat = local_inputs()
    print(f"local items: {sorted(series)}; satellite for {sorted(sat)}")
    res = run.remote(series, sat, force)
    out = ROOT / "data" / "built" / "model"
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(res["summary"], indent=1))
    (out / "predictions.json").write_text(json.dumps(res["predictions"], indent=1))
    s = res["summary"]
    print(json.dumps({k: s[k] for k in ("n_series", "n_rows_train", "n_rows_test", "gpu", "best_config",
                                        "test_metrics", "test_metrics_our_items", "feature_importance",
                                        "per_item")}, indent=1))
