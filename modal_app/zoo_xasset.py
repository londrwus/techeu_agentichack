r"""Cross-asset / macro ridge ("xasset"): FX, USD, oil, fertiliser, freight, producer FX, ENSO -> h-month log-return.

    .\.venv\Scripts\modal run modal_app/zoo_xasset.py          # missing raw series fetched on Modal (1 CPU container each)
    .\.venv\Scripts\python modal_app/zoo_xasset.py             # everything from this machine / cache

Signals (all point-in-time: value at month m is only used from month m + LAG):
  fx      GBP/USD (DEXUSUK), broad USD index (DTWEXBGS, spliced with TWEXB before 2006)    daily -> monthly mean, lag 0
  energy  Brent, EU gas (World Bank Pink Sheet)                                              lag 1
  fert    Urea, DAP (Pink Sheet)                                                             lag 1
  freight US deep-sea freight PPI (PCU483111483111; Baltic Dry is not free)                  lag 2 (PPI release + revisions)
  pfx     producer-country FX: BRL (DEXBZUS) for latte/orange_juice, EUR as the XOF peg for chocolate    lag 0
  enso    NOAA ONI (3-month centred) for tropical crops (latte, chocolate, orange_juice, olive_oil=0)   lag 2
  link    related commodity momentum (robusta->latte, sugar->chocolate, maize->bread, wheat->pint,
          semis PPI->gpu/laptop, orange none)                                                 lag 1
  price   own mom1/3/6/12, rev36, 5y vol (as in exog_ridge; value at the cutoff is known by construction)
Model: pooled ridge per horizon with unpenalised item fixed effects, walk-forward: refit at every cutoff on rows with
t + h <= cutoff (so TEST cutoffs also use TEST outcomes that were already observed, never later ones).
Feature groups, alpha, item-slope interactions and band scale are chosen on VALIDATION (cutoffs 2020-07..2022-06,
t + h <= 2022-12) only. p10/p50/p90 = point + quantiles of point-in-time standardized residuals; P(up), P(>15%) from
the same predictive distribution. Also reports "direction when confident": |P(up) - 0.5| >= g, g picked on VAL.
Writes data/cache/eval/candidates/xasset.json.
"""
import json
import math
import sys
import urllib.request
from pathlib import Path

import modal

app = modal.App("orbit-zoo-xasset")
image = modal.Image.debian_slim(python_version="3.12")

ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "data" / "cache" / "eval"
XRAW = EVAL / "features" / "xraw"
RAW0 = EVAL / "features" / "raw"
PINK = ROOT / "data" / "cache" / "pink" / "CMO-Historical-Data-Monthly.xlsx"
HS = [3, 6, 12]
TRAIN_END, VAL_FROM, VAL_TO, TEST_START = "2022-12", "2020-07", "2022-06", "2023-01"
FIRST_PRED = "2005-01"
FRED = ["DEXUSUK", "DEXUSEU", "DTWEXBGS", "TWEXB", "DEXBZUS", "PCU483111483111", "PCU334413334413"]
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
TROPICAL = {"latte", "chocolate", "orange_juice"}
PFX = {"latte": "brl", "orange_juice": "brl", "chocolate": "eur"}
LINK = {"latte": "robusta", "chocolate": "sugar", "bread": "maize", "pint": "wheat", "gpu": "semis", "laptop": "semis",
        "olive_oil": "soyoil"}


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


# ------------------------------------------------------------------ raw data
@app.function(image=image, timeout=300, retries=2, max_containers=20)
def fetch(name: str, url: str) -> tuple[str, str]:
    import time
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
            return name, urllib.request.urlopen(req, timeout=240).read().decode("utf-8", "replace")
        except Exception as e:  # FRED 503s under load -> back off
            err = f"{name}: {e}"
            time.sleep(15 * (attempt + 1))
    raise RuntimeError(err)


def ensure_raw(remote: bool):
    XRAW.mkdir(parents=True, exist_ok=True)
    todo = []
    for sid in FRED:
        if not (XRAW / f"{sid}.csv").exists() and not (RAW0 / f"{sid}.csv").exists() \
                and not (EVAL / "fred" / f"{sid}.csv").exists():
            todo.append((f"{sid}.csv", f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=1995-01-01"))
    if not (XRAW / "oni.txt").exists():
        todo.append(("oni.txt", ONI_URL))
    if todo:
        print("fetching", [t[0] for t in todo], "on Modal" if remote else "locally")
        res = fetch.starmap(todo, return_exceptions=True) if remote else (fetch.local(*t) for t in todo)
        for r in res:
            if isinstance(r, Exception):
                print("  fetch failed:", r)
                continue
            name, txt = r
            if name.endswith(".csv") and not txt.startswith("observation_date"):
                print("  not a series:", name)
                continue
            (XRAW / name).write_text(txt)


def fred_monthly(sid: str) -> dict:
    for d in (XRAW, RAW0, EVAL / "fred"):
        p = d / f"{sid}.csv"
        if p.exists():
            break
    else:
        return {}
    acc: dict = {}
    for line in p.read_text().strip().splitlines()[1:]:
        d, v = (line.split(",") + [""])[:2]
        try:
            acc.setdefault(d[:7], []).append(float(v))
        except ValueError:
            pass
    return {m: sum(v) / len(v) for m, v in acc.items() if v}


def pink() -> dict:
    import pandas as pd
    df = pd.read_excel(PINK, sheet_name="Monthly Prices", header=None)
    c0 = df.iloc[:, 0].astype(str)
    rows = c0.str.match(r"^\d{4}M\d{2}$")
    names = [str(x).strip() for x in df.iloc[4].tolist()]
    want = {"brent": "Crude oil, Brent", "gas": "Natural gas, Europe", "urea": "Urea", "dap": "DAP",
            "robusta": "Coffee, Robusta", "sugar": "Sugar, world", "maize": "Maize", "wheat": "Wheat, US HRW",
            "soyoil": "Soybean oil"}
    out = {}
    for k, nm in want.items():
        j = next(i for i, x in enumerate(names) if x.startswith(nm))
        s = pd.to_numeric(df.loc[rows, j], errors="coerce")
        out[k] = {f"{m[:4]}-{m[5:7]}": float(v) for m, v in zip(c0[rows], s) if pd.notna(v) and v > 0}
    return out


def oni() -> dict:
    p = XRAW / "oni.txt"
    if not p.exists():
        return {}
    seas = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
    out = {}
    for line in p.read_text().splitlines()[1:]:
        s = line.split()
        if len(s) >= 4 and s[0] in seas:
            out[f"{int(s[1]):04d}-{seas.index(s[0]) + 1:02d}"] = float(s[3])  # centred month
    return out


def load_signals() -> dict:
    sig = pink()
    sig["gbp"] = fred_monthly("DEXUSUK")
    sig["eur"] = fred_monthly("DEXUSEU")          # USD per EUR (XOF is pegged to EUR)
    b = fred_monthly("DEXBZUS")                    # BRL per USD -> USD per BRL so "up" = producer currency stronger
    sig["brl"] = {m: 1 / v for m, v in b.items()}
    usd, old = fred_monthly("DTWEXBGS"), fred_monthly("TWEXB")
    if not old:                                    # fallback pre-2006: geometric USD basket vs EUR, JPY, GBP
        jpy = fred_monthly("DEXJPUS")
        old = {m: (jpy[m] / sig["eur"][m] / sig["gbp"][m]) ** (1 / 3) for m in jpy if m in sig["eur"] and m in sig["gbp"]}
    if old and usd:                                # splice: scale the old index to the new one at the first overlap
        m0 = min(set(usd) & set(old))
        usd = {**{m: v * usd[m0] / old[m0] for m, v in old.items() if m < m0}, **usd}
    sig["usd"] = usd
    sig["freight"] = fred_monthly("PCU483111483111")
    sig["semis"] = fred_monthly("PCU334413334413")
    sig["oni"] = oni()
    print("signals:", {k: (min(v), max(v), len(v)) if v else None for k, v in sig.items()})
    return sig


LAG = {"gbp": 0, "eur": 0, "brl": 0, "usd": 0, "brent": 1, "gas": 1, "urea": 1, "dap": 1, "robusta": 1, "sugar": 1,
       "maize": 1, "wheat": 1, "soyoil": 1, "freight": 2, "semis": 2, "oni": 2}


# ------------------------------------------------------------------ point-in-time features
def build_features(sig: dict):
    import numpy as np
    import pandas as pd
    hists = json.loads((EVAL / "histories.json").read_text())

    def mom(key, t, n):
        s = sig.get(key) or {}
        a = add_months(t, -LAG[key])
        x, y = s.get(a), s.get(add_months(a, -n))
        return math.log(x / y) if x and y else 0.0

    rows = []
    for iid, h in hists.items():
        months, vals = h["months"], h["values"]
        lv = np.log(np.array(vals))
        anchors = set(h.get("cutoff_months") or months)
        for k, t in enumerate(months):
            if k < 12 or t < "2001-01":
                continue
            r = {"item_id": iid, "month": t, "anchor": t in anchors, "price": vals[k],
                 "mom1": lv[k] - lv[k - 1], "mom3": lv[k] - lv[k - 3], "mom6": lv[k] - lv[k - 6],
                 "mom12": lv[k] - lv[k - 12], "rev36": lv[k] - lv[max(0, k - 35):k + 1].mean(),
                 "vol": max(float(np.std([lv[i] - lv[i - 6] for i in range(max(6, k - 60), k + 1)])), 0.01)}
            for key in ("gbp", "usd", "brent", "gas", "urea", "dap", "freight"):
                for n in (3, 12):
                    r[f"x_{key}{n}"] = mom(key, t, n)
            pk = PFX.get(iid)
            r["x_pfx3"] = mom(pk, t, 3) if pk else 0.0
            r["x_pfx12"] = mom(pk, t, 12) if pk else 0.0
            lk = LINK.get(iid)
            r["x_link3"] = mom(lk, t, 3) if lk else 0.0
            r["x_link12"] = mom(lk, t, 12) if lk else 0.0
            o = sig["oni"]
            a = add_months(t, -LAG["oni"])
            trop = iid in TROPICAL
            r["x_oni"] = o.get(a, 0.0) if trop else 0.0
            r["x_oni_d6"] = (o.get(a, 0.0) - o.get(add_months(a, -6), 0.0)) if trop else 0.0
            for hh in HS:
                r[f"y{hh}"] = float(lv[k + hh] - lv[k]) if k + hh < len(vals) else np.nan
            rows.append(r)
    return pd.DataFrame(rows)


GROUPS = {
    "price": ["mom1", "mom3", "mom6", "mom12", "rev36", "vol"],
    "fx": ["x_gbp3", "x_gbp12", "x_usd3", "x_usd12"],
    "energy": ["x_brent3", "x_brent12", "x_gas3", "x_gas12"],
    "fert": ["x_urea3", "x_urea12", "x_dap3", "x_dap12"],
    "freight": ["x_freight3", "x_freight12"],
    "pfx": ["x_pfx3", "x_pfx12"],
    "enso": ["x_oni", "x_oni_d6"],
    "link": ["x_link3", "x_link12"],
}
FEATSETS = {
    "price": ["price"],
    "price+fx": ["price", "fx"],
    "price+fx+energy": ["price", "fx", "energy"],
    "price+fx+energy+fert": ["price", "fx", "energy", "fert"],
    "price+pfx+enso+link": ["price", "pfx", "enso", "link"],
    "price+fx+pfx+enso+link": ["price", "fx", "pfx", "enso", "link"],
    "all": list(GROUPS),
    "xasset_only": ["fx", "energy", "fert", "freight", "pfx", "enso", "link"],
}
ALPHAS = [3, 10, 30, 100, 300, 1000, 3000]
SLOPES = [False, True]  # item-specific momentum slopes (mom3/mom12 x item), ridge-penalised
BAND_SCALES = [0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.7]


def design(df, cols, slopes, items):
    import numpy as np
    X = df[cols].values.astype(float) if cols else np.zeros((len(df), 0))
    if slopes:
        inter = [((df.item_id == i).values * df[c].values) for i in items for c in ("mom3", "mom12")]
        X = np.concatenate([X, np.stack(inter, 1)], 1)
    fe = np.stack([(df.item_id == i).values.astype(float) for i in items], 1)
    return X, fe


def walk_forward(df, X, FE, h, alpha):
    """Prediction for every row at month t from a ridge fit on rows with t' + h <= t (anchors only)."""
    import numpy as np
    y = df[f"y{h}"].values
    end_m = df.month.map(lambda m: add_months(m, h)).values
    ok = (~np.isnan(y)) & df.anchor.values
    pred = np.full(len(df), np.nan)
    months = df.month.values
    for t in sorted(set(months)):
        if t < FIRST_PRED:
            continue
        m = ok & (end_m <= t)
        if m.sum() < 60:
            continue
        Xf, Ff, yf = X[m], FE[m], y[m]
        # item FE unpenalised: partial them out (within transform), ridge on the rest
        cnt = Ff.sum(0) + 1e-9
        ym = (Ff.T @ yf) / cnt
        Xm = (Ff.T @ Xf) / cnt[:, None]
        Xw, yw = Xf - Ff @ Xm, yf - Ff @ ym
        mu, sd = Xw.mean(0), Xw.std(0) + 1e-9
        Z = np.clip((Xw - mu) / sd, -4, 4)
        b = np.linalg.solve(Z.T @ Z + alpha * np.eye(Z.shape[1]), Z.T @ yw) if Z.shape[1] else np.zeros(0)
        rows = months == t
        Xr = X[rows] - FE[rows] @ Xm
        pred[rows] = FE[rows] @ ym + np.clip((Xr - mu) / sd, -4, 4) @ b
    return pred


# ------------------------------------------------------------------ scoring
def harness():
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "scripts"))
    import build_eval as be
    return be


def is_val(x):
    return VAL_FROM <= x["cutoff"] <= VAL_TO and add_months(x["cutoff"], x["h"]) <= TRAIN_END


def is_test(x):
    return x["cutoff"] >= TEST_START


def conf_dir(sel, g):
    """direction accuracy on rows with |P(up)-0.5| >= g (same |move| >= 1% rule as the harness), and coverage."""
    s = [x for x in sel if abs(x["actual"] / x["base"] - 1) >= 0.01]
    c = [x for x in s if abs(x["prob_up"] - 0.5) >= g]
    if not c:
        return None, 0.0
    acc = sum((x["prob_up"] > 0.5) == (x["actual"] > x["base"]) for x in c) / len(c)
    return round(acc, 3), round(len(c) / len(s), 3)


def score(rows, be, cond, gate=None, thr=None):
    out = {}
    for h in HS:
        s = [x for x in rows if x["h"] == h and cond(x) and x["actual"] is not None]
        if not s:
            continue
        m = be.metrics(s, [{**x, "p50": x["base"]} for x in s])
        m["brier_up"] = round(sum((x["prob_up"] - (x["actual"] > x["base"])) ** 2 for x in s) / len(s), 4)
        big = lambda x: x["actual"] / x["base"] - 1 > be.BIG_MOVE  # noqa: E731
        m["brier_bigup"] = round(sum((x["prob_bigup"] - big(x)) ** 2 for x in s) / len(s), 4)
        pu = [x for x in s if abs(x["actual"] / x["base"] - 1) >= 0.01]
        m["dir_acc_prob"] = round(sum((x["prob_up"] > 0.5) == (x["actual"] > x["base"]) for x in pu) / len(pu), 3)
        if h == 6:
            m["big_recall"], m["n_big"] = be.big_recall(s)
            if thr is not None:
                fl = [x for x in s if x["prob_bigup"] >= thr]
                tp = sum(big(x) for x in fl)
                m["alert_thr"] = thr
                m["alert_precision"] = round(tp / len(fl), 3) if fl else None
                m["alert_recall"] = round(tp / max(m["n_big"], 1), 3)
        if gate is not None:
            m["dir_confident"], m["confident_coverage"] = conf_dir(s, gate[h])
            m["gate"] = gate[h]
        out[f"h{h}"] = m
    return out


def run(remote: bool):
    import numpy as np
    be = harness()
    ensure_raw(remote)
    sig = load_signals()
    df = build_features(sig)
    print("features:", df.shape)
    hists = json.loads((EVAL / "histories.json").read_text())
    tfm = json.loads((EVAL / "timesfm.json").read_text())["results"]
    eval_keys = sorted({tuple(k.split("|")[:2]) for k in tfm})
    idx = {(r.item_id, r.month): i for i, r in enumerate(df.itertuples())}
    items = sorted(df.item_id.unique())
    endm = {h: df.month.map(lambda m: add_months(m, h)).values for h in HS}

    def zpools(preds):
        pools = {}
        for h in preds:
            y, p = df[f"y{h}"].values, preds[h]
            ok = ~np.isnan(y) & ~np.isnan(p) & df.anchor.values
            pools[h] = ((y - p)[ok] / (df.vol.values[ok] * math.sqrt(h / 6)), endm[h][ok])
        memo = {}

        def f(h, c):
            if (h, c) not in memo:
                z, e = pools[h]
                zz = z[e <= c]
                zz = zz - np.median(zz) if len(zz) >= 50 else np.random.default_rng(0).standard_normal(400)
                memo[(h, c)] = zz  # median-centred so P(up) > 0.5 <=> p50 above base (bands/probs agree with point)
            return memo[(h, c)]
        return f

    def make_rows(preds, scale=None, hs=HS):
        zp = zpools(preds)
        out = []
        for iid, cut in eval_keys:
            i = idx.get((iid, cut))
            if i is None:
                continue
            base, vol = df.price.iat[i], df.vol.iat[i]
            months, vals = hists[iid]["months"], hists[iid]["values"]
            k = months.index(cut)
            for h in hs:
                mu = preds[h][i]
                if np.isnan(mu):
                    continue
                s = vol * math.sqrt(h / 6) * (scale or {}).get(h, 1.0)
                z = zp(h, cut)
                q10, q90 = np.quantile(z, [0.1, 0.9])
                out.append({"item_id": iid, "item": iid, "cutoff": cut, "h": h, "base": base,
                            "actual": vals[k + h] if k + h < len(vals) else None,
                            "p10": base * math.exp(mu + q10 * s), "p50": base * math.exp(mu),
                            "p90": base * math.exp(mu + q90 * s),
                            "prob_up": float(np.clip((np.sum(z * s > -mu) + 0.5) / (len(z) + 1), 0.02, 0.98)),
                            "prob_bigup": float(np.clip((np.sum(z * s > math.log(1 + be.BIG_MOVE) - mu) + 0.5) / (len(z) + 1),
                                                        0.01, 0.98))})
        return out

    # --- selection on VALIDATION only
    store, trials = {}, {h: [] for h in HS}
    for fs, groups in FEATSETS.items():
        cols = [c for g in groups for c in GROUPS[g]]
        for sl in SLOPES:
            X, FE = design(df, cols, sl, items)
            for a in ALPHAS:
                for h in HS:
                    p = walk_forward(df, X, FE, h, a)
                    store[(fs, sl, a, h)] = p
                    v = score(make_rows({h: p}, hs=[h]), be, is_val)[f"h{h}"]
                    obj = v["skill"] + 0.5 * (v["dir_acc"] - 0.5) - (v["brier_up"] - 0.25)
                    trials[h].append((obj, fs, sl, a, v["skill"], v["dir_acc"], v["brier_up"]))
            print(f"  {fs:26s} slopes={sl!s:5s} best-h6 so far {max(trials[6])[:4]}")
    best = {h: max(trials[h]) for h in HS}
    for h in HS:
        print(f"BEST h{h}: featset={best[h][1]} slopes={best[h][2]} alpha={best[h][3]} "
              f"val skill {best[h][4]} dir {best[h][5]} brier_up {best[h][6]}")
    preds = {h: store[(best[h][1], best[h][2], best[h][3], h)] for h in HS}
    scale = {}
    for h in HS:
        opts = []
        for k in BAND_SCALES:
            v = score(make_rows(preds, {h: k}, hs=[h]), be, is_val)[f"h{h}"]
            opts.append((abs(v["coverage80"] - 0.8), v["brier_up"], k))
        scale[h] = min(opts)[2]
    rows = make_rows(preds, scale)

    # confidence gate + alert threshold on VAL
    gate = {}
    for h in HS:
        vs = [x for x in rows if x["h"] == h and is_val(x) and x["actual"] is not None]
        opts = []
        for g in np.arange(0.0, 0.31, 0.025):
            acc, cov = conf_dir(vs, g)
            if acc is not None and cov >= 0.5:
                opts.append((acc, cov, round(float(g), 3)))
        gate[h] = max(opts)[2] if opts else 0.0
    v6 = [x for x in rows if x["h"] == 6 and is_val(x) and x["actual"] is not None]
    best_thr = None
    for t in np.arange(0.10, 0.61, 0.025):
        fl = [x for x in v6 if x["prob_bigup"] >= t]
        tp = sum(x["actual"] / x["base"] - 1 > be.BIG_MOVE for x in fl)
        pos = sum(x["actual"] / x["base"] - 1 > be.BIG_MOVE for x in v6)
        f1 = 2 * tp / (len(fl) + pos) if (fl or pos) else 0
        if best_thr is None or f1 > best_thr[0] + 1e-9:
            best_thr = (f1, round(float(t), 3))
    thr = best_thr[1]
    val, test = score(rows, be, is_val, gate, thr), score(rows, be, is_test, gate, thr)

    # which signals matter on VAL (h6): permutation of each group in the chosen model's VAL predictions,
    # plus a leave-group-out refit (VAL skill drop) for groups of the best h6 set
    fs6, sl6, a6 = best[6][1], best[6][2], best[6][3]
    importance = {}
    base_v = score(make_rows({6: preds[6]}, hs=[6]), be, is_val)["h6"]
    for g in FEATSETS[fs6]:
        cols = [c for gg in FEATSETS[fs6] if gg != g for c in GROUPS[gg]]
        X, FE = design(df, cols, sl6, items)
        p = walk_forward(df, X, FE, 6, a6)
        v = score(make_rows({6: p}, hs=[6]), be, is_val)["h6"]
        importance[g] = {"val_skill_drop_if_removed": round(base_v["skill"] - v["skill"], 4),
                         "val_dir_drop_if_removed": round(base_v["dir_acc"] - v["dir_acc"], 3)}
    # all single-group additions on top of price (VAL skill/dir), for the report
    add_one = {}
    for g in [g for g in GROUPS if g != "price"]:
        cols = GROUPS["price"] + GROUPS[g]
        X, FE = design(df, cols, False, items)
        p = walk_forward(df, X, FE, 6, a6)
        v = score(make_rows({6: p}, hs=[6]), be, is_val)["h6"]
        add_one[g] = {"val_skill": v["skill"], "val_dir": v["dir_acc"], "val_brier_up": v["brier_up"]}
    Xp, FEp = design(df, GROUPS["price"], False, items)
    vp = score(make_rows({6: walk_forward(df, Xp, FEp, 6, a6)}, hs=[6]), be, is_val)["h6"]
    add_one["price_only"] = {"val_skill": vp["skill"], "val_dir": vp["dir_acc"], "val_brier_up": vp["brier_up"]}

    cand = {"name": "xasset",
            "description": "Pooled ridge per horizon on point-in-time cross-asset/macro signals (GBP/USD, broad USD, Brent, "
                           "EU gas, urea/DAP, freight PPI, producer FX, ENSO ONI, related-commodity momentum) + own price "
                           "features, item fixed effects, walk-forward refits at every cutoff; bands/probabilities from "
                           "point-in-time residual quantiles. All choices on VALIDATION.",
            "per_horizon": {f"h{h}": {"featset": best[h][1], "item_slopes": best[h][2], "alpha": best[h][3],
                                      "band_scale": scale[h], "confidence_gate": gate[h]} for h in HS},
            "big_alert_threshold_h6": thr,
            "signal_importance_val_h6": importance, "single_group_val_h6": add_one,
            "metrics": {"val": val, "test": test},
            "val_top_trials_h6": [{"obj": round(float(t[0]), 4), "featset": t[1], "slopes": t[2], "alpha": t[3],
                                   "skill": t[4], "dir": t[5], "brier_up": t[6]} for t in sorted(trials[6])[::-1][:10]],
            "rows": [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in x.items()
                      if k in ("item_id", "cutoff", "h", "p10", "p50", "p90", "prob_up", "prob_bigup")} for x in rows]}
    (EVAL / "candidates").mkdir(parents=True, exist_ok=True)
    (EVAL / "candidates" / "xasset.json").write_text(json.dumps(cand, indent=0))
    keys = ["n", "dir_acc", "dir_acc_prob", "dir_confident", "confident_coverage", "skill", "mape", "coverage80",
            "brier_up", "brier_bigup", "big_recall", "alert_precision", "alert_recall"]
    for name, blk in (("VAL", val), ("TEST", test)):
        for h in ("h6", "h3", "h12"):
            print(f"{name:5s} {h:3s}", {k: blk[h].get(k) for k in keys if k in blk[h]})
    print("importance (leave-group-out, VAL h6):", importance)
    print("single group on top of price (VAL h6):", add_one)


@app.local_entrypoint()
def main():
    run(remote=True)


if __name__ == "__main__":
    run(remote="--remote" in sys.argv)
