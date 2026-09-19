r"""orbit-zoo-dir: a dedicated DIRECTION classifier P(price up in h months), pooled across a wide commodity panel.

    .\.venv\Scripts\modal run modal_app/zoo_dir.py        # walk-forward refits fanned out on Modal CPUs
    -> data/cache/eval/candidates/dir_clf.json (+ data/cache/eval/zoo_dir_report.json)

Panel  = the 8 Orbit items (gpu predict-only) + World Bank Pink Sheet (~70 monthly series since 1995,
         data/cache/pink/, pulled from Volume "orbit-data" raw/worldbank/) minus near-duplicates of the items.
Features at month t use prices <= t only:
  momentum 1/3/6/12/24m (vol-scaled), trend t-stat of the 12m/24m log-price slope, distance to 5y mean / max / min,
  vol level + vol-regime percentile, seasonality (calendar-month mean return over the next h months, from past
  years only), cross-sectional momentum rank + panel-mean momentum (same month t), and CFTC Commitments of Traders
  non-commercial net position (% of OI) z-score + 3m change for markets that have it (legacy futures-only files,
  data/cache/cftc/; last report with as-of date <= month end - 4 days, i.e. already published).
Walk-forward: refit every 3 months r on rows whose outcome month t+h <= r, predict months [r, r+3).
Models: L2 logistic (3 strengths) + 2 shallow LightGBMs. Calibration: isotonic fitted walk-forward on the model's
own out-of-sample panel predictions whose outcome month <= cutoff (point-in-time). Model, calibration and the
p50 step size are picked on VALIDATION (cutoffs 2020-07..2022-06, cutoff+h <= 2022-12) over the whole panel;
the confidence gate is picked on VALIDATION Orbit items. TEST (cutoffs >= 2023-01) is only scored at the end.
Candidate rows: prob_up (calibrated), prob_bigup (same machinery, target > +15%), p50 = base*exp(k*(2p-1)*sig*sqrt h),
p10/p90 = walk-forward split-conformal on vol-scaled residuals.
"""
import json
import math
import sys
import zipfile
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
EVAL = CACHE / "eval"
HS = [3, 6, 12]
BIG = math.log(1.15)
VAL = ("2020-07", "2022-06")
TRAIN_END, TEST_START = "2022-12", "2023-01"
FIRST_REFIT, STEP = "2004-01", 3
MODELS = [("logit", 1.0), ("logit", 10.0), ("logit", 100.0), ("lgbm", 4), ("lgbm", 8)]
GATES = [0.05, 0.10, 0.15]
# CFTC contract market codes -> panel series (Orbit items + Pink Sheet names)
COT = {"073732": ["chocolate", "wb_cocoa"], "083731": ["latte", "wb_coffee_arabica"],
       "040701": ["orange_juice", "wb_orange"], "001602": ["bread", "wb_wheat_us_srw"], "001612": ["wb_wheat_us_hrw"],
       "002602": ["wb_maize"], "005602": ["wb_soybeans"], "007601": ["wb_soybean_oil"], "026603": ["wb_soybean_meal"],
       "080732": ["wb_sugar_world"], "033661": ["wb_cotton_a_index"], "067651": ["wb_crude_oil_wti", "wb_crude_oil_average"],
       "023651": ["wb_natural_gas_us"], "085692": ["wb_copper"], "088691": ["wb_gold"], "084691": ["wb_silver"],
       "076651": ["wb_platinum"], "057642": ["wb_beef"], "039601": ["wb_rice_thai_5"]}

app = modal.App("orbit-zoo-dir")
image = modal.Image.debian_slim(python_version="3.12").uv_pip_install("numpy", "lightgbm")


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


# ------------------------------------------------------------------ data (local)
def load_pink() -> dict:
    import re

    import pandas as pd

    df = pd.read_excel(CACHE / "pink" / "CMO-Historical-Data-Monthly.xlsx", sheet_name="Monthly Prices", header=None)
    col = df.iloc[:, 0].astype(str)
    rows = col.str.match(r"^\d{4}M\d{2}$")
    first = int(rows.idxmax())
    for r in range(first - 1, -1, -1):
        names = [str(x).strip() for x in df.iloc[r].tolist()]
        if sum(1 for x in names[1:] if x and x != "nan" and not x.startswith("(")) > 20:
            break
    months = [f"{v[:4]}-{v[5:7]}" for v in col[rows]]
    out = {}
    for j in range(1, df.shape[1]):
        s = pd.to_numeric(df.loc[rows, j], errors="coerce")
        pts = [(m, float(v)) for m, v in zip(months, s) if pd.notna(v) and v > 0 and m >= "1990-01"]
        if len(pts) < 240 or names[j] in ("", "nan"):
            continue
        out["wb_" + re.sub(r"[^a-z0-9]+", "_", names[j].lower()).strip("_")] = {
            "months": [p[0] for p in pts], "values": [p[1] for p in pts]}
    return out


def load_panel() -> dict:
    import numpy as np

    hists = json.loads((EVAL / "histories.json").read_text())
    panel = {k: {**h, "target": True, "train": k != "gpu"} for k, h in hists.items()}
    for k, h in load_pink().items():
        # drop Pink Sheet series that are (near-)copies of an Orbit item: they would double-count its rows
        ok = True
        for it, t in hists.items():
            common = sorted(set(t["months"]) & set(h["months"]))
            if len(common) < 60:
                continue
            a = np.diff(np.log([t["values"][t["months"].index(m)] for m in common]))
            b = np.diff(np.log([h["values"][h["months"].index(m)] for m in common]))
            if np.corrcoef(a, b)[0, 1] > 0.95:
                ok = False
        if ok:
            panel[k] = {**h, "target": False, "train": True}
    return panel


def load_cot() -> dict:
    """{series: {month: (net_pct_oi z-score vs trailing 3y, 13-week change of net_pct_oi)}} from legacy COT files."""
    import pandas as pd

    frames = []
    for z in sorted((CACHE / "cftc").glob("deacot*.zip")):
        zf = zipfile.ZipFile(z)
        d = pd.read_csv(zf.open(zf.namelist()[0]), low_memory=False,
                        usecols=["CFTC Contract Market Code", "As of Date in Form YYYY-MM-DD", "Open Interest (All)",
                                 "Noncommercial Positions-Long (All)", "Noncommercial Positions-Short (All)"])
        frames.append(d)
    d = pd.concat(frames)[["CFTC Contract Market Code", "As of Date in Form YYYY-MM-DD", "Open Interest (All)",
                           "Noncommercial Positions-Long (All)", "Noncommercial Positions-Short (All)"]]
    d.columns = ["code", "date", "oi", "nl", "ns"]
    d["code"] = d["code"].astype(str).str.strip().str.zfill(6)
    d = d[d["code"].isin(COT)].copy()
    d["date"] = pd.to_datetime(d["date"])
    d["net"] = (d["nl"] - d["ns"]) / d["oi"].clip(lower=1)
    out = {}
    for code, g in d.groupby("code"):
        g = g.drop_duplicates("date").sort_values("date").set_index("date")["net"]
        mu, sd = g.rolling(156, min_periods=52).mean(), g.rolling(156, min_periods=52).std()
        z, ch = (g - mu) / sd, g - g.shift(13)
        res = {}
        for m in pd.period_range("1995-01", "2026-12", freq="M"):
            cut = m.to_timestamp(how="end").normalize() - pd.Timedelta(days=4)     # published by month end
            zz, cc = z[:cut].dropna(), ch[:cut].dropna()
            if len(zz) and (cut - zz.index[-1]).days < 21:
                res[str(m)] = (float(zz.iloc[-1]), float(cc.iloc[-1]) if len(cc) else 0.0)
        for s in COT[code]:
            out[s] = res
    return out


FEATS = ["m1", "m3", "m6", "m12", "m24", "t12", "t24", "z5", "dmax5", "dmin5", "lvol", "vreg", "seas",
         "xr3", "xr12", "xmkt", "cot_z", "cot_ch", "has_cot"]


def _tstat(y):
    import numpy as np

    x = np.arange(len(y)) - (len(y) - 1) / 2
    b = (x @ (y - y.mean())) / (x @ x)
    e = y - y.mean() - b * x
    se = math.sqrt(max(e @ e / (len(y) - 2), 1e-12) / (x @ x))
    return b / se


def build_rows(panel: dict, cot: dict) -> list[dict]:
    """One row per (series, month): per-horizon feature vectors (seasonality depends on h) + targets."""
    import numpy as np

    rows = []
    for s, p in panel.items():
        months, lp = p["months"], np.log(np.asarray(p["values"], dtype=float))
        r = np.diff(lp, prepend=np.nan)
        cal = np.array([int(m[5:7]) - 1 for m in months])
        for k, t in enumerate(months):
            if k < 25 or t < "2000-01":
                continue
            rr = r[max(1, k - 35): k + 1]
            sig = max(float(np.std(rr)), 0.005)
            vols = [float(np.std(r[j - 11: j + 1])) for j in range(max(13, k - 120), k + 1, 3)]
            w5 = lp[max(0, k - 59): k + 1]
            sd5 = float(np.std(w5))
            c = cot.get(s, {}).get(t)
            f = {"m1": r[k] / sig, "m3": (lp[k] - lp[k - 3]) / (sig * 3 ** .5), "m6": (lp[k] - lp[k - 6]) / (sig * 6 ** .5),
                 "m12": (lp[k] - lp[k - 12]) / (sig * 12 ** .5), "m24": (lp[k] - lp[k - 24]) / (sig * 24 ** .5),
                 "t12": _tstat(lp[k - 11: k + 1]) / 4, "t24": _tstat(lp[k - 23: k + 1]) / 6,
                 "z5": (lp[k] - w5.mean()) / sd5 if sd5 > 1e-6 else 0.0,
                 "dmax5": (lp[k] - w5.max()) / sig, "dmin5": (lp[k] - w5.min()) / sig,
                 "lvol": math.log(sig), "vreg": sum(v <= vols[-1] for v in vols) / len(vols),
                 "cot_z": c[0] if c else 0.0, "cot_ch": c[1] * 10 if c else 0.0, "has_cot": 1.0 if c else 0.0}
            # seasonality: mean return per calendar month over up to 15 past years (returns <= k only)
            lo = max(1, k - 179)
            mu = np.zeros(12)
            for cm in range(12):
                sel = r[lo: k + 1][cal[lo: k + 1] == cm]
                mu[cm] = sel.mean() if len(sel) >= 3 else 0.0
            seas = {h: sum(mu[(cal[k] + j) % 12] for j in range(1, h + 1)) / (sig * math.sqrt(h)) for h in HS}
            rows.append({"s": s, "t": t, "f": f, "seas": seas, "sig": sig, "tgt": p["target"], "train": p["train"],
                         "base": float(math.exp(lp[k])),
                         "y": {h: float(lp[k + h] - lp[k]) for h in HS if k + h < len(lp)}})
    # cross-sectional momentum rank and panel mean (same month only)
    by_t = {}
    for x in rows:
        by_t.setdefault(x["t"], []).append(x)
    for t, xs in by_t.items():
        for key, name in (("m3", "xr3"), ("m12", "xr12")):
            v = sorted(x["f"][key] for x in xs)
            for x in xs:
                x["f"][name] = (sum(u < x["f"][key] for u in v) + 0.5) / len(v) - 0.5 if len(v) > 5 else 0.0
        mk = sum(x["f"]["m12"] for x in xs) / len(xs)
        for x in xs:
            x["f"]["xmkt"] = mk
    for x in rows:
        x["f"] = [max(-6.0, min(6.0, float(x["f"][n]))) for n in FEATS if n != "seas"]
    return rows


# ------------------------------------------------------------------ fits (Modal)
def _logit(Z, y, Zp, lam):
    import numpy as np

    b = np.zeros(Z.shape[1])
    b[0] = math.log((y.mean() + 1e-3) / (1 - y.mean() + 1e-3))
    R = np.eye(Z.shape[1]) * lam
    R[0, 0] = 0
    for _ in range(30):
        p = 1 / (1 + np.exp(-np.clip(Z @ b, -30, 30)))
        step = np.linalg.solve((Z * (p * (1 - p))[:, None]).T @ Z + R, Z.T @ (p - y) + R @ b)
        b -= step
        if np.abs(step).max() < 1e-6:
            break
    return 1 / (1 + np.exp(-np.clip(Zp @ b, -30, 30)))


def _fit(job: dict) -> dict:
    """job: X (n,d), y {h: [...]} (nan = no outcome), end {h: [outcome month]}, t, train, refits [(r, pred_idx)]."""
    import numpy as np

    X = np.asarray(job["X"][0], dtype=float)
    out = {}
    for h in HS:
        Xh = np.c_[X, np.asarray(job["seas"][str(h)])]
        y = np.asarray(job["y"][str(h)], dtype=float)
        end = np.asarray(job["end"][str(h)])
        trn = np.asarray(job["train"], dtype=bool)
        for r, pidx in job["refits"]:
            m = trn & (end <= r) & ~np.isnan(y)
            if m.sum() < 500 or not pidx:
                continue
            Xt = Xh[m]
            mu, sd = Xt.mean(0), Xt.std(0) + 1e-9
            Z = np.c_[np.ones(len(Xt)), (Xt - mu) / sd]
            Zp = np.c_[np.ones(len(pidx)), (Xh[pidx] - mu) / sd]
            for tgt, lab in (("up", y[m] > 0), ("big", y[m] > BIG)):
                lab = lab.astype(float)
                for kind, lam in MODELS:
                    key = f"{h}|{tgt}|{kind}|{lam}"
                    if kind == "logit":
                        p = _logit(Z, lab, Zp, lam)
                    else:
                        import lightgbm as lgb

                        prm = {"objective": "binary", "learning_rate": 0.03, "num_leaves": lam, "min_data_in_leaf": 150,
                               "bagging_fraction": 0.7, "bagging_freq": 1, "feature_fraction": 0.7, "lambda_l2": 10.0,
                               "verbose": -1, "seed": 0, "num_threads": 2}
                        mdl = lgb.train(prm, lgb.Dataset(Z[:, 1:], lab), num_boost_round=200)
                        p = mdl.predict(Zp[:, 1:])
                    out.setdefault(key, {}).update({int(i): float(v) for i, v in zip(pidx, p)})
    return out


@app.function(image=image, cpu=2, memory=4096, timeout=1800, max_containers=60)
def fit_chunk(job: dict) -> dict:
    return _fit(job)


# ------------------------------------------------------------------ calibration + scoring (local)
def calibrate(rows, raw, h, tgt, how, min_n=400):
    """Walk-forward calibration: rows at month t use a calibrator fitted on OOS predictions whose outcome month <= t
    (isotonic = PAV over 40 quantile bins of the past predictions; platt = logistic on the logit)."""
    import bisect

    import numpy as np

    lab = (lambda y: y > 0) if tgt == "up" else (lambda y: y > BIG)
    ev = sorted((add_months(rows[i]["t"], h), p, float(lab(rows[i]["y"][h]))) for i, p in raw.items() if h in rows[i]["y"])
    ends = [e[0] for e in ev]
    P = np.array([e[1] for e in ev])
    Y = np.array([e[2] for e in ev])
    out, cache = {}, {}
    for i, p in raw.items():
        t = rows[i]["t"]
        n = bisect.bisect_right(ends, t)
        if how == "raw" or n < min_n:
            out[i] = p
            continue
        if n not in cache:
            pp, yy = P[:n], Y[:n]
            if how == "iso":
                edges = np.unique(np.quantile(pp, np.linspace(0, 1, 41)))
                bi = np.clip(np.searchsorted(edges, pp, side="right") - 1, 0, len(edges) - 2)
                cnt = np.bincount(bi, minlength=len(edges) - 1)
                sy = np.bincount(bi, yy, minlength=len(edges) - 1)
                sp = np.bincount(bi, pp, minlength=len(edges) - 1)
                keep = cnt > 0
                xs, ys = _pav_w(sp[keep] / cnt[keep], sy[keep] / cnt[keep], cnt[keep])
                cache[n] = ("iso", (xs, ys))
            else:
                z = np.log(np.clip(pp, 1e-4, 1 - 1e-4) / (1 - np.clip(pp, 1e-4, 1 - 1e-4)))
                cache[n] = ("platt", _platt(z, yy))
        kind, mdl = cache[n]
        if kind == "iso":
            out[i] = float(np.clip(np.interp(p, mdl[0], mdl[1]), 0.02, 0.98))
        else:
            z = math.log(min(max(p, 1e-4), 1 - 1e-4) / (1 - min(max(p, 1e-4), 1 - 1e-4)))
            out[i] = 1 / (1 + math.exp(-(mdl[0] + mdl[1] * z)))
    return out


def _pav_w(x, y, w):
    """Weighted pool-adjacent-violators on points already sorted by x -> (block mean x, block fitted y)."""
    import numpy as np

    bl = []  # [sum_wy, sum_w, sum_wx]
    for xi, yi, wi in zip(x, y, w):
        bl.append([yi * wi, wi, xi * wi])
        while len(bl) > 1 and bl[-2][0] / bl[-2][1] >= bl[-1][0] / bl[-1][1]:
            s0, s1, s2 = bl.pop()
            bl[-1][0] += s0
            bl[-1][1] += s1
            bl[-1][2] += s2
    return np.array([b[2] / b[1] for b in bl]), np.array([b[0] / b[1] for b in bl])


def _platt(z, y):
    import numpy as np

    b = np.array([0.0, 1.0])
    Z = np.c_[np.ones_like(z), z]
    for _ in range(30):
        p = 1 / (1 + np.exp(-np.clip(Z @ b, -30, 30)))
        step = np.linalg.solve((Z * (p * (1 - p))[:, None]).T @ Z + np.eye(2) * 1e-3, Z.T @ (p - y))
        b -= step
        if np.abs(step).max() < 1e-7:
            break
    return b


def is_val(t, h):
    return VAL[0] <= t <= VAL[1] and add_months(t, h) <= TRAIN_END


def dir_stats(rows, prob, idx, h, gate=0.0):
    """direction accuracy (|move| >= 1%) of sign(p - 0.5); rows with |p-0.5| < gate abstain."""
    ok = n = tot = 0
    for i in idx:
        y = rows[i]["y"][h]
        if abs(math.exp(y) - 1) < 0.01:
            continue
        tot += 1
        p = prob[i]
        if abs(p - 0.5) < gate or p == 0.5:
            continue
        n += 1
        ok += (p > 0.5) == (y > 0)
    return (ok / n if n else None), (n / tot if tot else None), n


def run_fits(rows, local=False):
    import numpy as np

    n = len(rows)
    X = [x["f"] for x in rows]
    seas = {str(h): [x["seas"][h] for x in rows] for h in HS}
    y = {str(h): [x["y"].get(h, float("nan")) for x in rows] for h in HS}
    end = {str(h): [add_months(x["t"], h) for x in rows] for h in HS}
    months = sorted({x["t"] for x in rows})
    refits, r = [], FIRST_REFIT
    while r <= months[-1]:
        nxt = add_months(r, STEP)
        refits.append((r, [i for i, x in enumerate(rows) if r <= x["t"] < nxt]))
        r = nxt
    base = {"X": [X], "seas": seas, "y": y, "end": end, "train": [x["train"] for x in rows]}
    jobs = [{**base, "refits": refits[j::40]} for j in range(40)]
    print(f"rows {n}, refits {len(refits)}, jobs {len(jobs)}")
    res = [_fit(j) for j in jobs] if local else list(fit_chunk.map(jobs))
    raw = {}
    for d in res:
        for k, v in d.items():
            raw.setdefault(k, {}).update(v)
    _ = np
    return raw


def main(local=False, force=False):
    import pickle

    import numpy as np

    pk = EVAL / "zoo_dir_fits.pkl"
    if pk.exists() and not force:
        rows, raw = pickle.loads(pk.read_bytes())
    else:
        panel = load_panel()
        print("panel series:", len(panel), sorted(panel))
        cot = load_cot()
        print("COT series:", sorted(cot))
        rows = build_rows(panel, cot)
        raw = run_fits(rows, local)
        pk.write_bytes(pickle.dumps((rows, raw)))
    for x in rows:   # json round trip turned int keys to str in some paths
        x["y"] = {int(k): v for k, v in x["y"].items()}

    report = {"panel_series": len({x["s"] for x in rows}), "rows": len(rows), "select": {}, "gates": {}}
    final = {}
    for h in HS:
        # VAL panel rows (all series) -> model + calibration choice by log-loss (point-in-time predictions)
        vp = [i for i, x in enumerate(rows) if is_val(x["t"], h) and h in x["y"]]
        vt = [i for i in vp if rows[i]["tgt"]]
        best = {}
        for tgt in ("up", "big"):
            lab = (lambda y: y > 0) if tgt == "up" else (lambda y: y > BIG)
            cands = []
            for kind, lam in MODELS:
                key = f"{h}|{tgt}|{kind}|{lam}"
                rawp = {int(i): v for i, v in raw.get(key, {}).items()}
                for how in ("raw", "platt", "iso"):
                    cp = calibrate(rows, rawp, h, tgt, how)
                    ll = -np.mean([math.log(max(1e-4, cp[i] if lab(rows[i]["y"][h]) else 1 - cp[i])) for i in vp if i in cp])
                    acc = dir_stats(rows, cp, [i for i in vp if i in cp], h)[0] if tgt == "up" else None
                    cands.append((ll, key, how, cp, acc))
            cands.sort(key=lambda c: c[0])
            best[tgt] = cands[0]
            report["select"][f"h{h}_{tgt}"] = [{"model": c[1], "calib": c[2], "val_panel_logloss": round(c[0], 4),
                                                "val_panel_dir": round(c[4], 3) if c[4] else None} for c in cands[:6]]
        pu, pb = best["up"][3], best["big"][3]
        # p50 step size k and conformal band on vol-scaled residuals, both point-in-time / VAL-picked
        def p50lr(i, k):
            return k * (2 * pu[i] - 1) * rows[i]["sig"] * math.sqrt(h)
        ks = [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]
        mae = {k: np.mean([abs(math.exp(p50lr(i, k)) - math.exp(rows[i]["y"][h])) for i in vp if i in pu]) for k in ks}
        kbest = min(mae, key=mae.get)
        ev = sorted((add_months(rows[i]["t"], h), (rows[i]["y"][h] - p50lr(i, kbest)) / (rows[i]["sig"] * math.sqrt(h)))
                    for i in pu if h in rows[i]["y"])
        ends = [e[0] for e in ev]
        import bisect

        final[h] = {"pu": pu, "pb": pb, "k": kbest, "lr": p50lr, "ev": ev, "ends": ends}
        report["select"][f"h{h}_p50_k"] = kbest
        # confidence gate: pick on VAL Orbit items (largest VAL accuracy with coverage >= 50%)
        gs = {g: dir_stats(rows, pu, [i for i in vt if i in pu], h, g) for g in [0.0] + GATES}
        ok = [g for g in GATES if gs[g][1] and gs[g][1] >= 0.5]
        report["gates"][f"h{h}"] = {"val_items": {str(g): v for g, v in gs.items()},
                                    "chosen": max(ok, key=lambda g: gs[g][0]) if ok else None}
        _ = bisect

    # candidate rows for the Orbit items
    import bisect

    cand = []
    for h in HS:
        F = final[h]
        for i, x in enumerate(rows):
            if not x["tgt"] or i not in F["pu"]:
                continue
            n = bisect.bisect_right(F["ends"], x["t"])
            e = [v for _, v in F["ev"][max(0, n - 3000): n]]
            if len(e) < 200:
                continue
            s = x["sig"] * math.sqrt(h)
            lr = F["lr"](i, F["k"])
            q10, q90 = float(np.quantile(e, 0.1)), float(np.quantile(e, 0.9))
            b = x["base"]
            cand.append({"item_id": x["s"], "cutoff": x["t"], "h": h, "p10": round(b * math.exp(lr + q10 * s), 4),
                         "p50": round(b * math.exp(lr), 4), "p90": round(b * math.exp(lr + q90 * s), 4),
                         "prob_up": round(F["pu"][i], 4), "prob_bigup": round(F["pb"].get(i, 0.1), 4)})
    (EVAL / "candidates" / "dir_clf.json").write_text(json.dumps({
        "name": "dir_clf", "description": "Pooled direction classifier (Pink Sheet panel + CFTC COT), walk-forward, "
                                          "calibrated point-in-time; see modal_app/zoo_dir.py", "report": report,
        "rows": cand}))
    (EVAL / "zoo_dir_report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1)[:6000])
    return report


@app.local_entrypoint()
def entry(force: bool = False):
    main(local=False, force=force)


if __name__ == "__main__":
    main(local="--modal" not in sys.argv, force="--force" in sys.argv)
