r"""Exogenous-signal ridge ("exog_ridge"): weather + satellite + macro -> h-month log-return, point-in-time.

    modal run modal_app/zoo_exog.py            # ERA5 weather fetched on Modal (1 CPU container per region x decade)
    .\.venv\Scripts\python modal_app/zoo_exog.py   # same, weather fetched from this machine (or cached)

Features (every one uses only data <= cutoff month):
  price   mom1/3/6/12, rev36 (log price vs 36m mean), vol (std of 6m log changes, 5y)
  macro   GBP/USD (FRED DEXUSUK), Brent (POILBREUSDM), EU gas (PNGASEUUSDM; fertiliser/energy proxy)
  weather Open-Meteo ERA5 archive per crop region: 3m/6m precip z, 3m temp z, heat days (>35C) anomaly,
          6m precip z lagged 6m; climatology = same calendar window in years before the cutoff year (from 1981)
  sat     Sentinel-2 NDVI/NDWI z-score vs same calendar month in earlier years, mean of lags 0-2 and 3-5
Model: pooled ridge per horizon with item fixed effects, refit at every cutoff on rows with t+h <= min(cutoff, 2022-12)
(expanding window, so every prediction is out-of-sample). Alpha + feature groups picked on validation cutoffs
2020-07..2022-06. Bands/probabilities = empirical quantiles of out-of-fold residuals scaled by vol*sqrt(h/6).
Writes data/cache/eval/features/features.parquet and data/cache/eval/candidates/exog_ridge.json.
"""
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

import modal

app = modal.App("orbit-zoo-exog")
image = modal.Image.debian_slim(python_version="3.12")

ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "data" / "cache" / "eval"
FEAT = EVAL / "features"
RAW = FEAT / "raw"
CHUNKS = [("1981-01-01", "1990-12-31"), ("1991-01-01", "2000-12-31"), ("2001-01-01", "2010-12-31"),
          ("2011-01-01", "2020-12-31"), ("2021-01-01", "2026-08-31")]
MACRO = {"fx": "DEXUSUK", "brent": "POILBREUSDM", "gas": "PNGASEUUSDM"}
HS = [3, 6, 12]
TRAIN_END, VAL_FROM, VAL_TO, TEST_START = "2022-12", "2020-07", "2022-06", "2023-01"
FIRST_PRED = "2005-01"


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


# ------------------------------------------------------------------ weather fetch (Modal fan-out)
@app.function(image=image, timeout=600, retries=3, max_containers=60)
def fetch_weather(rid: str, lat: float, lon: float, start: str, end: str) -> dict:
    """Daily ERA5 -> monthly {month: [precip_mm, tmean, tmax_mean, heat_days_gt35]}."""
    url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={start}"
           f"&end_date={end}&daily=precipitation_sum,temperature_2m_mean,temperature_2m_max&timezone=GMT")
    for attempt in range(6):
        try:
            d = json.loads(urllib.request.urlopen(url, timeout=120).read())["daily"]
            break
        except Exception as e:  # rate limit -> back off
            print(rid, start, "retry", e)
            time.sleep(10 * (attempt + 1))
    else:
        raise RuntimeError(f"open-meteo failed {rid} {start}")
    out: dict = {}
    for t, p, tm, tx in zip(d["time"], d["precipitation_sum"], d["temperature_2m_mean"], d["temperature_2m_max"]):
        if p is None or tm is None or tx is None:
            continue
        a = out.setdefault(t[:7], [0.0, 0.0, 0.0, 0, 0])
        a[0] += p; a[1] += tm; a[2] += tx; a[3] += tx > 35; a[4] += 1
    return {"rid": rid, "months": {m: [a[0], a[1] / a[4], a[2] / a[4], a[3]] for m, a in out.items() if a[4] >= 20}}


def crop_regions():
    from orbit.config import REGIONS
    return [r for r in REGIONS if r.get("signal") == "crop"]


def get_weather(remote: bool) -> dict:
    todo = [r for r in crop_regions() if not (RAW / f"weather_{r['id']}.json").exists()]
    if todo:
        args = [(r["id"], r["lat"], r["lon"], a, b) for r in todo for a, b in CHUNKS]
        res = fetch_weather.starmap(args) if remote else (fetch_weather.local(*a) for a in args)
        acc: dict = {}
        for x in res:
            acc.setdefault(x["rid"], {}).update(x["months"])
        RAW.mkdir(parents=True, exist_ok=True)
        for rid, m in acc.items():
            (RAW / f"weather_{rid}.json").write_text(json.dumps(dict(sorted(m.items()))))
    return {r["id"]: json.loads((RAW / f"weather_{r['id']}.json").read_text()) for r in crop_regions()}


def get_macro() -> dict:
    out = {}
    for k, sid in MACRO.items():
        p = RAW / f"{sid}.csv"
        if not p.exists():
            req = urllib.request.Request(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=1995-01-01",
                                         headers={"User-Agent": "curl/8.0"})
            RAW.mkdir(parents=True, exist_ok=True)
            p.write_text(urllib.request.urlopen(req, timeout=60).read().decode())
        acc: dict = {}
        for line in p.read_text().strip().splitlines()[1:]:
            d, v = (line.split(",") + [""])[:2]
            try:
                acc.setdefault(d[:7], []).append(float(v))
            except ValueError:
                pass
        out[k] = {m: sum(v) / len(v) for m, v in acc.items()}
    return out


# ------------------------------------------------------------------ point-in-time features
def weather_feats(w: dict, t: str) -> dict | None:
    """z-scores for windows ending at t vs same calendar window in years before year(t) (>= 10 years)."""
    def win(end, n, j):
        ms = [add_months(end, -i) for i in range(n)]
        if not all(m in w for m in ms):
            return None
        v = [w[m][j] for m in ms]
        return sum(v) if j in (0, 3) else sum(v) / n

    def z(end, n, j):
        cur = win(end, n, j)
        base = [b for b in (win(add_months(end, -12 * y), n, j) for y in range(1, 46)) if b is not None]
        if cur is None or len(base) < 10:
            return None
        mu = sum(base) / len(base)
        sd = max((sum((b - mu) ** 2 for b in base) / (len(base) - 1)) ** 0.5, 1e-6 if j != 3 else 0.5)
        return max(-4.0, min(4.0, (cur - mu) / sd)) if j != 3 else max(-3.0, min(10.0, (cur - mu) / max(sd, 1.0)))

    f = {"w_p3z": z(t, 3, 0), "w_p6z": z(t, 6, 0), "w_t3z": z(t, 3, 1), "w_tx3z": z(t, 3, 2),
         "w_heat3": z(t, 3, 3), "w_p6z_l6": z(add_months(t, -6), 6, 0), "w_p12z": z(t, 12, 0)}
    return None if any(v is None for v in f.values()) else f


def sat_feats(rid: str, t: str) -> dict:
    p = ROOT / "data" / "built" / "satellite" / f"{rid}.json"
    ser = {x["month"]: x for x in json.loads(p.read_text(encoding="utf-8")).get("series", [])
           if (x.get("cloud_pct") or 0) <= 60} if p.exists() else {}
    out = {}
    for key in ("ndvi", "ndwi"):
        def zm(m):
            if m not in ser or ser[m].get(key) is None:
                return None
            base = [ser[b][key] for b in (add_months(m, -12 * y) for y in range(1, 8)) if b in ser and ser[b].get(key) is not None]
            if len(base) < 2:
                return None
            mu = sum(base) / len(base)
            sd = max((sum((b - mu) ** 2 for b in base) / (len(base) - 1)) ** 0.5, 0.02)
            return max(-4.0, min(4.0, (ser[m][key] - mu) / sd))
        for tag, lags in (("a", range(0, 3)), ("b", range(3, 6))):
            v = [x for x in (zm(add_months(t, -l)) for l in lags) if x is not None]
            out[f"s_{key}_{tag}"] = sum(v) / len(v) if v else None
    return out


def build_features(weather: dict, macro: dict):
    import numpy as np
    import pandas as pd
    from orbit.config import REGIONS
    hists = json.loads((EVAL / "histories.json").read_text())
    regs = {iid: [r["id"] for r in REGIONS if r.get("item") == iid and r.get("signal") == "crop"] for iid in hists}
    wcache: dict = {}
    rows = []
    for iid, h in hists.items():
        months, vals = h["months"], h["values"]
        lv = np.log(np.array(vals))
        anchors = set(h.get("cutoff_months") or months)
        for k, t in enumerate(months):
            if k < 12 or t < "2001-01":
                continue
            row = {"item_id": iid, "month": t, "anchor": t in anchors, "price": vals[k],
                   "mom1": lv[k] - lv[k - 1], "mom3": lv[k] - lv[k - 3], "mom6": lv[k] - lv[k - 6],
                   "mom12": lv[k] - lv[k - 12], "rev36": lv[k] - lv[max(0, k - 35):k + 1].mean(),
                   "vol": max(float(np.std([lv[i] - lv[i - 6] for i in range(max(6, k - 60), k + 1)])), 0.01)}
            for key, ser in macro.items():
                for n in ((3, 12) if key != "gas" else (6,)):
                    a, b = ser.get(t), ser.get(add_months(t, -n))
                    row[f"m_{key}{n}"] = math.log(a / b) if a and b else 0.0
            ws = []
            for rid in regs[iid]:
                if (rid, t) not in wcache:
                    wcache[(rid, t)] = weather_feats(weather[rid], t)
                if wcache[(rid, t)]:
                    ws.append(wcache[(rid, t)])
            row["has_crop"] = float(bool(regs[iid]))
            for kf in ("w_p3z", "w_p6z", "w_t3z", "w_tx3z", "w_heat3", "w_p6z_l6", "w_p12z"):
                row[kf] = float(np.mean([w[kf] for w in ws])) if ws else 0.0
            ss = [sat_feats(rid, t) for rid in regs[iid]]
            for kf in ("s_ndvi_a", "s_ndvi_b", "s_ndwi_a", "s_ndwi_b"):
                v = [s[kf] for s in ss if s.get(kf) is not None]
                row[kf] = float(np.mean(v)) if v else 0.0
            for hh in HS:
                row[f"y{hh}"] = float(lv[k + hh] - lv[k]) if k + hh < len(vals) else np.nan
            rows.append(row)
    df = pd.DataFrame(rows)
    FEAT.mkdir(parents=True, exist_ok=True)
    df.to_parquet(FEAT / "features.parquet", index=False)
    return df


# ------------------------------------------------------------------ model
GROUPS = {
    "price": ["mom1", "mom3", "mom6", "mom12", "rev36", "vol"],
    "macro": ["m_fx3", "m_fx12", "m_brent3", "m_brent12", "m_gas6"],
    "weather": ["w_p3z", "w_p6z", "w_t3z", "w_tx3z", "w_heat3", "w_p6z_l6", "w_p12z"],
    "drought": ["w_p6z", "w_heat3", "w_t3z"],
    "sat": ["s_ndvi_a", "s_ndvi_b", "s_ndwi_a", "s_ndwi_b"],
}
FEATSETS = {"price": ["price"], "price+macro": ["price", "macro"], "price+macro+weather": ["price", "macro", "weather"],
            "price+macro+drought": ["price", "macro", "drought"], "all": ["price", "macro", "weather", "sat"], "macro+weather+sat": ["macro", "weather", "sat"]}
ALPHAS = [1, 3, 10, 30, 100, 300, 1000, 3000]
BAND_SCALES = [0.9, 1.0, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8]


def ridge_fit(X, y, alpha):
    import numpy as np
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.clip((X - mu) / sd, -4, 4)
    A = Z.T @ Z + alpha * np.eye(Z.shape[1])
    return mu, sd, np.linalg.solve(A, Z.T @ y)


def oof_predict(df, cols, alpha, h):
    """Expanding-window prediction for every row: model fit on rows with t+h <= min(t, TRAIN_END), refit per month."""
    import numpy as np
    items = sorted(df.item_id.unique())
    fe = np.stack([(df.item_id == i).values.astype(float) for i in items], 1)
    X = np.concatenate([df[cols].values.astype(float), fe], 1) if cols else fe
    y = df[f"y{h}"].values
    end_m = df.month.map(lambda m: add_months(m, h)).values
    trainable = (~np.isnan(y)) & df.anchor.values
    pred = np.full(len(df), np.nan)
    ncol = len(cols)
    cache: dict = {}
    for t in sorted(df.month.unique()):
        if t < FIRST_PRED:
            continue
        fit_end = min(t, TRAIN_END)
        if fit_end not in cache:
            m = trainable & (end_m <= fit_end)
            Xf, yf = X[m], y[m]
            if ncol:  # no penalty on item fixed effects: demean y per item, ridge on features
                mu, sd, b = ridge_fit(Xf[:, :ncol], yf - Xf[:, ncol:] @ (np.linalg.pinv(Xf[:, ncol:]) @ yf), alpha)
                resid = yf - np.clip((Xf[:, :ncol] - mu) / sd, -4, 4) @ b
            else:
                mu = sd = b = None
                resid = yf
            fe_coef = np.linalg.pinv(Xf[:, ncol:]) @ resid
            cache[fit_end] = (mu, sd, b, fe_coef)
        mu, sd, b, fe_coef = cache[fit_end]
        rows = (df.month == t).values
        p = X[rows, ncol:] @ fe_coef
        if ncol:
            p = p + np.clip((X[rows, :ncol] - mu) / sd, -4, 4) @ b
        pred[rows] = p
    return pred, cache


def final_model(cache):
    return cache[TRAIN_END]


# ------------------------------------------------------------------ scoring (harness metric functions)
def harness():
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "scripts"))
    import build_eval as be
    return be


def score(rows, be, cond):
    sel = [x for x in rows if cond(x)]
    out = {}
    for h in HS:
        s = [x for x in sel if x["h"] == h and x["actual"] is not None]
        nv = [{**x, "p50": x["base"]} for x in s]
        m = be.metrics(s, nv)
        up = [(x["prob_up"] - (x["actual"] > x["base"])) ** 2 for x in s]
        bu = [(x["prob_bigup"] - (x["actual"] / x["base"] - 1 > be.BIG_MOVE)) ** 2 for x in s]
        m["brier_up"] = round(sum(up) / len(up), 4) if up else None
        m["brier_bigup"] = round(sum(bu) / len(bu), 4) if bu else None
        if h == 6:
            m["big_recall"], m["n_big"] = be.big_recall(s)
            flag = [x for x in s if x["p50"] > x["base"] * 1.005 or (x["prob_up"] or 0) > 0.6]
            m["big_precision_flag"] = round(sum(x["actual"] / x["base"] - 1 > be.BIG_MOVE for x in flag) / max(len(flag), 1), 3)
            al = [x for x in s if x["prob_bigup"] > 0.3]
            m["bigup_p>0.3_prec"] = round(sum(x["actual"] / x["base"] - 1 > be.BIG_MOVE for x in al) / max(len(al), 1), 3)
            m["bigup_p>0.3_recall"] = round(sum(x["actual"] / x["base"] - 1 > be.BIG_MOVE for x in al) / max(m["n_big"], 1), 3)
        out[f"h{h}"] = m
    return out


def is_val(x):
    return VAL_FROM <= x["cutoff"] <= VAL_TO and add_months(x["cutoff"], x["h"]) <= TRAIN_END


def is_test(x):
    return x["cutoff"] >= TEST_START


def run(remote: bool):
    import numpy as np
    be = harness()
    weather, macro = get_weather(remote), get_macro()
    df = build_features(weather, macro)
    print("features:", df.shape, "rows", df.month.min(), "..", df.month.max())
    hists = json.loads((EVAL / "histories.json").read_text())
    tfm = json.loads((EVAL / "timesfm.json").read_text())["results"]
    eval_keys = sorted({tuple(k.split("|")[:2]) for k in tfm})
    idx = {(r.item_id, r.month): i for i, r in enumerate(df.itertuples())}

    def make_rows(preds, zpool_fn, scale=None):
        out = []
        for iid, cut in eval_keys:
            i = idx.get((iid, cut))
            if i is None:
                continue
            base = df.price.iat[i]
            vol = df.vol.iat[i]
            months, vals = hists[iid]["months"], hists[iid]["values"]
            k = months.index(cut)
            for h in HS:
                mu = preds[h][i]
                if np.isnan(mu):
                    continue
                s = vol * math.sqrt(h / 6)
                z = zpool_fn(h, cut) * (scale or {}).get(h, 1.0)
                q10, q50, q90 = np.quantile(z, [0.1, 0.5, 0.9])
                act = vals[k + h] if k + h < len(vals) else None
                out.append({"item_id": iid, "item": iid, "cutoff": cut, "h": h, "base": base, "actual": act,
                            "p10": base * math.exp(mu + q10 * s), "p50": base * math.exp(mu + 0 * q50 * s),
                            "p90": base * math.exp(mu + q90 * s),
                            "prob_up": float(np.clip((z > -mu / s).mean(), 0.02, 0.98)),
                            "prob_bigup": float(np.clip((z > (math.log(1 + be.BIG_MOVE) - mu) / s).mean(), 0.01, 0.98))})
        return out

    def zpool_factory(preds):
        """OOF standardized residuals usable at cutoff c: rows with t+h <= min(c, TRAIN_END)."""
        pools = {}
        for h in HS:
            y, p = df[f"y{h}"].values, preds[h]
            ok = ~np.isnan(y) & ~np.isnan(p) & df.anchor.values
            z = (y - p) / (df.vol.values * math.sqrt(h / 6))
            end = df.month.map(lambda m: add_months(m, h)).values
            pools[h] = (z[ok], end[ok])
        memo = {}

        def f(h, c):
            key = (h, min(c, TRAIN_END))
            if key not in memo:
                z, end = pools[h]
                zz = z[end <= key[1]]
                memo[key] = zz if len(zz) >= 50 else np.random.default_rng(0).standard_normal(400)
            return memo[key]
        return f

    # --- model selection on validation (cutoffs 2020-07..2022-06, outcomes <= 2022-12), per horizon
    trials, store = {h: [] for h in HS}, {}
    for fs, groups in FEATSETS.items():
        cols_ = [c for g in groups for c in GROUPS[g]]
        for a in ALPHAS:
            fits_ = {h: oof_predict(df, cols_, a, h) for h in HS}
            preds_ = {h: fits_[h][0] for h in HS}
            store[(fs, a)] = fits_
            v = score(make_rows(preds_, zpool_factory(preds_)), be, is_val)
            for h in HS:
                m = v[f"h{h}"]
                trials[h].append((m["skill"] - 0.5 * (m["brier_up"] - 0.25), fs, a))
            print(f"  val {fs:22s} a={a:5d} skill h3/6/12 {v['h3']['skill']}/{v['h6']['skill']}/{v['h12']['skill']} "
                  f"brier_up6 {v['h6']['brier_up']} dir6 {v['h6']['dir_acc']}")
    best = {h: max(trials[h])[1:] for h in HS}
    print("BEST per h:", best)
    fits = {h: store[best[h]][h] for h in HS}
    preds = {h: fits[h][0] for h in HS}
    zp = zpool_factory(preds)
    scale = {}
    for h in HS:  # band width multiplier: val coverage of the 80% band closest to 0.80
        opts = []
        for k in BAND_SCALES:
            v = score(make_rows({hh: preds[hh] for hh in HS}, zp, {h: k}), be, is_val)[f"h{h}"]
            opts.append((abs(v["coverage80"] - 0.8), v["brier_up"], k))
        scale[h] = min(opts)[2]
    print("band scale per h:", scale)
    rows = make_rows(preds, zp, scale)
    fs6, a6 = best[6]
    cols = [c for g in FEATSETS[fs6] for c in GROUPS[g]]
    best_fs, best_a = fs6, a6
    val, test = score(rows, be, is_val), score(rows, be, is_test)

    # baselines on the same rows: naive, tuned orbit (harness)
    hist_, raw, cases = be.load_cases()
    prm = be.load_params()
    keyset = {(x["item"], x["cutoff"], x["h"]) for x in rows}
    ob = []
    for c in cases:
        f = c["f"]
        qo = be.orbit_apply(c["q"].get(prm["ctx"]) or c["q"]["full"], f, prm)
        for h, a in c["actual"].items():
            if (c["item"], c["cutoff"], h) in keyset:
                q = qo[h - 1]
                ob.append({"item": c["item"], "cutoff": c["cutoff"], "h": h, "base": f["base"], "actual": a,
                           "p10": q[0], "p50": q[4], "p90": q[8], "prob_up": be.prob_above(q, f["base"]),
                           "prob_bigup": be.prob_above(q, f["base"] * (1 + be.BIG_MOVE))})
    ob_val, ob_test = score(ob, be, is_val), score(ob, be, is_test)

    # feature signal: standardized h6 coefficients of final model + permutation importance on validation
    mu, sd, b, fe = fits[6][1][TRAIN_END]
    coefs = {c: round(float(v), 4) for c, v in sorted(zip(cols, b), key=lambda t: -abs(t[1]))}
    mval = df.month.between(VAL_FROM, VAL_TO).values & ~np.isnan(df.y6.values) & \
        (df.month.map(lambda m: add_months(m, 6)) <= TRAIN_END).values & df.anchor.values
    vmu, vsd, vb, vfe = fits[6][1]["2020-12"]  # a model fit before the val window's outcomes (t+6 <= 2020-12)
    items = sorted(df.item_id.unique())
    Xv = df.loc[mval, cols].values.astype(float)
    FEv = np.stack([(df.item_id[mval] == i).values.astype(float) for i in items], 1)
    yv = df.y6.values[mval]

    def mae(X):
        return float(np.mean(np.abs(yv - (FEv @ vfe + np.clip((X - vmu) / vsd, -4, 4) @ vb))))
    base_mae, rng, perm = mae(Xv), np.random.default_rng(1), {}
    for g in FEATSETS[best_fs]:
        ds = []
        for _ in range(20):
            Xp = Xv.copy()
            ii = rng.permutation(len(Xp))
            for c in GROUPS[g]:
                j = cols.index(c)
                Xp[:, j] = Xp[ii, j]
            ds.append(mae(Xp) - base_mae)
        perm[g] = round(float(np.mean(ds)), 5)

    cand = {"name": "exog_ridge",
            "description": f"Pooled ridge per horizon on point-in-time exogenous features (h6: {best_fs}, alpha {best_a}) "
                           "with item fixed effects, expanding-window refits (frozen at 2022-12 for test), "
                           "bands/probabilities from out-of-fold residual quantiles scaled by trailing vol.",
            "feature_set": best_fs, "alpha": best_a, "features": cols,
            "per_horizon": {f"h{h}": {"featset": best[h][0], "alpha": best[h][1], "band_scale": scale[h]} for h in HS},
            "coef_h6_std": coefs, "perm_importance_val_h6_mae": perm,
            "metrics": {"val": val, "test": test, "orbit_val": ob_val, "orbit_test": ob_test},
            "val_top_trials_h6": [{"obj": round(float(o), 4), "featset": f, "alpha": a} for o, f, a in sorted(trials[6])[::-1][:8]],
            "rows": [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in x.items()
                      if k in ("item_id", "cutoff", "h", "p10", "p50", "p90", "prob_up", "prob_bigup")} for x in rows]}
    (EVAL / "candidates").mkdir(parents=True, exist_ok=True)
    (EVAL / "candidates" / "exog_ridge.json").write_text(json.dumps(cand, indent=0))
    keys = ["mape", "skill", "dir_acc", "coverage80", "brier_up", "brier_bigup", "big_recall", "big_precision_flag",
            "bigup_p>0.3_prec", "bigup_p>0.3_recall", "n"]
    for name, blk in (("VAL exog", val), ("VAL orbit", ob_val), ("TEST exog", test), ("TEST orbit", ob_test)):
        for h in ("h6", "h3", "h12"):
            print(f"{name:11s} {h:3s}", {k: blk[h].get(k) for k in keys if k in blk[h]})
    print("coef h6 (std):", coefs)
    print("perm importance (val h6 MAE increase):", perm)


@app.local_entrypoint()
def main():
    run(remote=True)


if __name__ == "__main__":
    run(remote="--remote" in sys.argv)
