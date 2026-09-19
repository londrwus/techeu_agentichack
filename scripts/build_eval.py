r"""Score + tune the rolling-origin backtest: naive / drift / TimesFM / Orbit.

Inputs (written by `modal run modal_app/evaluate.py`):
    data/cache/eval/histories.json   price series per item (FRED benchmarks; gpu = curated street index)
    data/cache/eval/timesfm.json     TimesFM quantiles per "item|cutoff|ctx" (point-in-time contexts)
Outputs:
    data/built/eval/summary.json, data/built/eval/{item_id}.json

Everything is evaluated on each item's driver series (FRED commodity benchmark / CPI / GPU street index).
Nothing after a cutoff is used for that cutoff's forecast: the TimesFM context, drift slope, momentum,
volatility, satellite anomaly and the AI-era drivers (Jev news index, Sentinel-2 build-out / reservoirs)
all stop at the cutoff month.

Orbit = TimesFM quantiles shifted by one log-factor per horizon h:
    f(h) = (damp-1)*ln(q50/base) + blend*slope24*h + tilt*min(h,6)/6 + ai*drift12_ai*h/12
    tilt = sigma6 * clip(sat*stress + mom*mom3/sigma6, -cap, cap)
The few parameters are fitted on a TRAIN split (cutoff+h <= 2022-12) and reported on the TEST split
(cutoff >= 2023-01), which the fit never sees. `ai` is not fitted (the Jev AI index starts 2022-09).

    .\.venv\Scripts\python scripts/build_eval.py            # tune on train, score, write
    .\.venv\Scripts\python scripts/build_eval.py --no-tune  # score with the stored params
"""
import itertools
import json
import math
import statistics as st
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from orbit.config import ITEM_BY_ID, REGIONS  # noqa: E402

CACHE = ROOT / "data" / "cache" / "eval"
BUILT = ROOT / "data" / "built"
OUT = BUILT / "eval"
HORIZONS = [3, 6, 12]
METHODS = ["naive", "drift", "timesfm", "orbit"]
HIST_START = "2010-01"
QLEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
DIR_MIN = 0.01        # ignore |actual change| < 1% for directional accuracy
BIG_MOVE = 0.15       # big move = actual 6m change > +15%
DRIFT_WINDOW = 24     # months of trailing log-slope for the drift baseline
TEST_START = "2023-01"
TRAIN_END = "2022-12"  # train rows need cutoff + h <= TRAIN_END (no overlap with test outcomes)

# Untuned Orbit as shipped before this tuning pass (satellite tilt 1.0, full context, AI drivers on).
BEFORE = {"ctx": "full", "damp": 1.0, "blend": 0.0, "sat": 1.0, "mom": 0.0, "cap": 0.5, "ai": 1.0}
GRID = {"ctx": ["full", "c96"], "damp": [0.0, 0.5, 0.75, 1.0], "blend": [0.0, 0.25, 0.5],
        "sat": [0.0, 0.5, 1.0, 2.0], "mom": [0.0, 0.5, 1.0], "cap": [0.5, 1.0], "ai": [1.0]}
N_PARAMS = 5  # damp, blend, sat, mom, cap (+ the ctx choice); ai fixed a priori


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


# ------------------------------------------------------------------ satellite (point-in-time)
_SAT: dict = {}


def _sat_series(region_id: str) -> dict:
    if region_id not in _SAT:
        p = BUILT / "satellite" / f"{region_id}.json"
        _SAT[region_id] = {x["month"]: x for x in json.loads(p.read_text(encoding="utf-8")).get("series", [])} if p.exists() else {}
    return _SAT[region_id]


def region_anomaly(region: dict, cutoff: str, window: int = 6) -> float | None:
    """Fractional anomaly of the region's index over `window` months up to cutoff vs earlier years (<= cutoff)."""
    s = _sat_series(region["id"])
    key = "ndwi" if region.get("signal") == "water" else "ndvi"

    def mean(end):
        v = [s[m][key] for m in (add_months(end, -i) for i in range(window))
             if m in s and s[m].get(key) is not None and (s[m].get("cloud_pct") or 0) <= 60]
        return st.mean(v) if len(v) >= 2 else None

    cur = mean(cutoff)
    base = [b for b in (mean(add_months(cutoff, -12 * j)) for j in range(1, 6)) if b is not None]
    if cur is None or not base:
        return None
    b = st.mean(base)
    return (cur - b) / max(abs(b), 0.05)


def satellite_stress(item_id: str, cutoff: str) -> float:
    regs = [r for r in REGIONS if r.get("item") == item_id and r.get("signal") == "crop"]
    an = [a for a in (region_anomaly(r, cutoff) for r in regs) if a is not None]
    return max(-0.5, min(0.5, -st.mean(an))) if an else 0.0


# ------------------------------------------------------------------ AI-era drivers (point-in-time)
# 12-month price drift per unit of each driver (Jev scores are -1..1; build-out / water are scaled below).
# Priors set from the 2025-26 memory crunch narrative, NOT fitted (no AI-index data before 2022-09).
AI_COEF = {
    "gpu":    {"ai_demand": 0.12, "supply": 0.14, "export": 0.04, "buildout": 0.06, "water": 0.03, "cpi": 0.0},
    "laptop": {"ai_demand": 0.04, "supply": 0.10, "export": 0.01, "buildout": 0.02, "water": 0.01, "cpi": 0.03},
}
_AI: dict = {}


def _ai_timeline() -> dict:
    if "t" not in _AI:
        p = BUILT / "signals" / "gpu.json"
        sig = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        _AI["t"] = {t["month"]: t for t in (sig.get("ai_index") or {}).get("timeline", [])}
    return _AI["t"]


def buildout_sites(cutoff: str) -> list[dict]:
    """Share of AI data-centre / fab land transformed (Sentinel-2 change_frac): last 6 months <= cutoff
    vs the same 6 months two years earlier."""
    out = []
    for r in REGIONS:
        if r.get("signal") not in ("datacenter", "fab"):
            continue
        ser = {m: x["change_frac"] for m, x in _sat_series(r["id"]).items()
               if x.get("change_frac") is not None and m <= cutoff}
        now = [m for m in (add_months(cutoff, -i) for i in range(6)) if m in ser]
        then = [add_months(m, -24) for m in now if add_months(m, -24) in ser]
        if len(now) < 3 or len(then) < 3:
            continue
        f = lambda ms: st.mean(ser[m] for m in ms)  # noqa: E731
        first = sorted(ser)[:12]
        out.append({"region_id": r["id"], "name": r["name"], "signal": r["signal"],
                    "transformed_pct_now": round(f(now) * 100, 1), "transformed_pct_2y_ago": round(f(then) * 100, 1),
                    "transformed_pct_first_year": round(f(first) * 100, 1), "now_month": max(now),
                    "growth_2y_pts": round((f(now) - f(then)) * 100, 1)})
    return out


def water_sites(cutoff: str) -> list[dict]:
    """Reservoir water extent (water_frac): latest clear month <= cutoff vs the same calendar month in earlier years."""
    out = []
    for r in REGIONS:
        if r.get("signal") != "water":
            continue
        good = [x for m, x in sorted(_sat_series(r["id"]).items())
                if m <= cutoff and x.get("water_frac") is not None and (x.get("cloud_pct") or 0) <= 40]
        if len(good) < 12:
            continue
        last = good[-1]
        base = [x["water_frac"] for x in good[:-1] if x["month"][5:] == last["month"][5:]]
        if not base:
            continue
        cur, b = last["water_frac"], st.mean(base)
        out.append({"region_id": r["id"], "name": r["name"], "month": last["month"],
                    "water_pct_now": round(cur * 100, 1), "water_pct_normal": round(b * 100, 1),
                    "anomaly_pct": round((cur - b) / max(b, 1e-3) * 100, 1)})
    return out


def ai_drivers(item_id: str, cutoff: str) -> dict | None:
    """Transparent AI-era driver parts for gpu/laptop at `cutoff`: [(name, value, drift12, source)] + inputs."""
    coef = AI_COEF.get(item_id)
    if not coef:
        return None
    tl = _ai_timeline()
    last3 = [tl[m] for m in (add_months(cutoff, -i) for i in range(3)) if m in tl]
    avg = lambda k: round(st.mean(t[k] for t in last3), 3) if last3 else 0.0  # noqa: E731
    dem, sup, exp = avg("ai_demand"), avg("supply_constraint"), avg("export_controls")
    sites = buildout_sites(cutoff)
    dc = [s for s in sites if s["signal"] == "datacenter"] or sites
    growth = st.mean(s["growth_2y_pts"] for s in dc) if dc else 0.0
    build = max(-1.0, min(1.0, growth / 30))                   # +30 pts of site transformed in 2y = full effect
    waters = water_sites(cutoff)
    wanom = st.mean(w["anomaly_pct"] for w in waters) if waters else 0.0
    water = max(-0.25, min(1.0, -wanom / 40))                   # -40% water extent = full stress
    parts = [
        ("AI data-centre demand", dem, coef["ai_demand"] * dem, "Jev: AI compute demand in GPU/AI headlines (-1..1), last 3 months"),
        ("HBM / memory & CoWoS supply squeeze", sup, coef["supply"] * sup, "Jev: GPU/memory supply constraint (-1..1), last 3 months"),
        ("Export controls & tariffs", exp, coef["export"] * exp, "Jev: export-control tightening (-1..1), last 3 months"),
        ("Data-centre build-out (satellite)", round(growth, 1), coef["buildout"] * build,
         "Sentinel-2: share of AI-campus land transformed, change over 2 years (pts)"),
        ("Taiwan fab water stress (satellite)", round(wanom, 1), coef["water"] * water,
         "Sentinel-2 reservoir water extent vs normal, %"),
    ]
    if coef["cpi"]:
        parts.append(("UK inflation (non-memory costs)", 3.0,
                      (1 - ITEM_BY_ID[item_id]["commodity_share"]) * coef["cpi"], "3% CPI"))
    return {"parts": parts, "drift12": sum(p[2] for p in parts), "ai_demand": dem, "supply_constraint": sup,
            "export_controls": exp, "buildout_growth_pts": round(growth, 1), "water_anomaly_pct": round(wanom, 1),
            "buildout_sites": sites, "water_sites": waters, "has_news": bool(last3)}


# ------------------------------------------------------------------ Orbit transform
def sigma6(vals: list[float], k: int, years: int = 5) -> float:
    """Std of 6-month log changes over the `years` before index k (point-in-time)."""
    ch = [math.log(vals[i] / vals[i - 6]) for i in range(max(6, k - 12 * years), k + 1)]
    return max(st.pstdev(ch), 0.01) if len(ch) > 6 else 0.1


def features(item_id: str, vals: list[float], k: int, cutoff: str) -> dict:
    past = vals[max(0, k - DRIFT_WINDOW): k + 1]
    ai = ai_drivers(item_id, cutoff)
    return {"base": vals[k],
            "slope": (math.log(past[-1]) - math.log(past[0])) / max(len(past) - 1, 1),
            "mom3": math.log(vals[k] / vals[k - 3]) if k >= 3 else 0.0,
            "sig": sigma6(vals, k), "stress": satellite_stress(item_id, cutoff),
            "ai12": ai["drift12"] if ai else 0.0}


def orbit_apply(q: list[list[float]], f: dict, p: dict) -> list[list[float]]:
    """Shift TimesFM quantile rows q[h-1] = [q10..q90] by the Orbit log-factor (see module doc)."""
    tilt = f["sig"] * max(-p["cap"], min(p["cap"], p["sat"] * f["stress"] + p["mom"] * f["mom3"] / f["sig"]))
    out = []
    for h, row in enumerate(q, 1):
        lf = ((p["damp"] - 1) * math.log(max(row[4], 1e-9) / f["base"]) + p["blend"] * f["slope"] * h
              + tilt * min(h, 6) / 6 + math.log(max(1 + p["ai"] * f["ai12"] * h / 12, 0.05)))
        out.append([v * math.exp(lf) for v in row])
    return out


def load_params() -> dict:
    p = OUT / "summary.json"
    try:
        return {**BEFORE, **json.loads(p.read_text())["tuned"]["params"]}
    except Exception:
        return dict(BEFORE)


# ------------------------------------------------------------------ helpers
def prob_above(qs: list[float], x: float) -> float:
    qs = sorted(qs)
    if x <= qs[0]:
        return 0.95
    if x >= qs[-1]:
        return 0.05
    for i in range(8):
        if qs[i] <= x <= qs[i + 1]:
            f = (x - qs[i]) / max(qs[i + 1] - qs[i], 1e-12)
            return 1 - (QLEVELS[i] + f * 0.1)
    return 0.5


def r(x, n=3):
    return None if x is None else round(x, n)


def load_cases() -> tuple[dict, dict, list[dict]]:
    """cases: one per (item, cutoff) with features, quantiles per context variant, and actuals per horizon."""
    hists = json.loads((CACHE / "histories.json").read_text())
    raw = json.loads((CACHE / "timesfm.json").read_text())
    res = raw["results"]
    by = {}
    for key, q in res.items():
        parts = key.split("|")
        it, cut, ctx = parts[0], parts[1], parts[2] if len(parts) > 2 else "full"
        by.setdefault((it, cut), {})[ctx] = q
    cases = []
    for (iid, cut), qs in sorted(by.items()):
        h = hists.get(iid)
        if not h or cut not in h["months"] or "full" not in qs:
            continue
        months, vals = h["months"], h["values"]
        k = months.index(cut)
        acts = {hh: vals[k + hh] for hh in HORIZONS if k + hh < len(vals)}
        if not acts:
            continue
        cases.append({"item": iid, "cutoff": cut, "q": qs, "f": features(iid, vals, k, cut), "actual": acts})
    return hists, raw, cases


def score_rows(cases: list[dict], p: dict) -> list[dict]:
    rows = []
    for c in cases:
        f, base = c["f"], c["f"]["base"]
        q = c["q"].get(p["ctx"]) or c["q"]["full"]
        qf = c["q"]["full"]
        qo = orbit_apply(q, f, p)
        for h, actual in c["actual"].items():
            preds = {"naive": (None, base, None, None),
                     "drift": (None, base * math.exp(f["slope"] * h), None, None),
                     "timesfm": (qf[h - 1][0], qf[h - 1][4], qf[h - 1][8], prob_above(qf[h - 1], base)),
                     "orbit": (qo[h - 1][0], qo[h - 1][4], qo[h - 1][8], prob_above(qo[h - 1], base))}
            for meth, (p10, p50, p90, pu) in preds.items():
                rows.append({"item": c["item"], "cutoff": c["cutoff"], "h": h, "method": meth, "base": base,
                             "p10": p10, "p50": p50, "p90": p90, "prob_up": pu, "actual": actual,
                             "stress": f["stress"], "ai12": f["ai12"]})
    return rows


def is_train(x) -> bool:
    return add_months(x["cutoff"], x["h"]) <= TRAIN_END


def is_test(x) -> bool:
    return x["cutoff"] >= TEST_START


def metrics(sel: list[dict], naive_sel: list[dict]) -> dict:
    if not sel:
        return {}
    ape = [abs(x["p50"] - x["actual"]) / x["actual"] for x in sel]
    ae = [abs(x["p50"] - x["actual"]) / x["base"] for x in sel]            # scale-free, pools across items
    ae_n = [abs(x["p50"] - x["actual"]) / x["base"] for x in naive_sel]
    dirs = [(x["p50"] - x["base"]) * (x["actual"] - x["base"]) > 0 for x in sel
            if abs(x["actual"] / x["base"] - 1) >= DIR_MIN and abs(x["p50"] / x["base"] - 1) > 1e-6]
    cov = [x["p10"] <= x["actual"] <= x["p90"] for x in sel if x["p10"] is not None]
    return {"mape": r(st.mean(ape) * 100, 1),
            "dir_acc": r(sum(dirs) / len(dirs), 3) if dirs else None,
            "coverage80": r(sum(cov) / len(cov), 3) if cov else None,
            "skill": r(1 - sum(ae) / sum(ae_n), 3) if sum(ae_n) > 0 else None,
            "n": len(sel)}


def big_recall(sel: list[dict]) -> tuple[float | None, int]:
    big = [x for x in sel if x["h"] == 6 and x["actual"] / x["base"] - 1 > BIG_MOVE]
    if not big:
        return None, 0
    hit = [x for x in big if x["p50"] > x["base"] * 1.005 or (x["prob_up"] or 0) > 0.6]
    return r(len(hit) / len(big), 3), len(big)


def block(rows: list[dict], cond=lambda x: True, item=None) -> dict:
    """{method: {h3, h6, h12}} metrics over rows matching cond (and item)."""
    sel = [x for x in rows if cond(x) and (item is None or x["item"] == item)]
    out = {}
    for meth in METHODS:
        out[meth] = {}
        for h in HORIZONS:
            out[meth][f"h{h}"] = metrics([x for x in sel if x["h"] == h and x["method"] == meth],
                                         [x for x in sel if x["h"] == h and x["method"] == "naive"])
        out[meth]["h6"]["big_move_recall"], out[meth]["h6"]["n_big_moves"] = \
            big_recall([x for x in sel if x["method"] == meth])
    return out


RISE_WEIGHT = 0.05  # objective credit per unit of train big-rise recall (a missed +15% rise costs shoppers most)


def train_loss(cases: list[dict], p: dict) -> tuple[float, float, float]:
    """(objective, mean error ratio vs naive over h3/h6/h12, big-rise recall at h6) on the TRAIN split.
    objective = error ratio - RISE_WEIGHT x recall. With RISE_WEIGHT = 0 the fit picks "no change" (damp 0):
    commodity prices are close to a random walk, so the error term alone rewards never making a call."""
    tot = 0.0
    big = hit = 0
    for h in HORIZONS:
        e = en = 0.0
        for c in cases:
            if h not in c["actual"] or add_months(c["cutoff"], h) > TRAIN_END:
                continue
            f, a = c["f"], c["actual"][h]
            q = c["q"].get(p["ctx"]) or c["q"]["full"]
            row = orbit_apply(q[:h], f, p)[h - 1]
            e += abs(row[4] - a) / f["base"]
            en += abs(f["base"] - a) / f["base"]
            if h == 6 and a / f["base"] - 1 > BIG_MOVE:
                big += 1
                hit += row[4] > f["base"] * 1.005 or prob_above(row, f["base"]) > 0.6
        tot += e / max(en, 1e-9)
    ratio, rec = tot / len(HORIZONS), hit / max(big, 1)
    return ratio - RISE_WEIGHT * rec, ratio, rec


def tune(cases: list[dict]) -> tuple[dict, list[dict]]:
    keys = list(GRID)
    trials = []
    for combo in itertools.product(*(GRID[k] for k in keys)):
        p = dict(zip(keys, combo))
        if p["sat"] == 0 and p["mom"] == 0 and p["cap"] != GRID["cap"][0]:
            continue  # cap is irrelevant without a tilt
        trials.append((train_loss(cases, p), p))
    trials.sort(key=lambda t: t[0][0])
    best_loss = trials[0][0][0]
    # parsimony: among fits within 0.002 of the best objective, take the one closest to plain TimesFM
    near = [t for t in trials if t[0][0] <= best_loss + 0.002]
    simple = lambda p: (abs(p["damp"] - 1) + p["blend"] + p["sat"] / 2 + p["mom"] + (p["ctx"] != "full") * 0.25)  # noqa: E731
    best = min(near, key=lambda t: (simple(t[1]), t[0][0]))[1]
    top = [{"train_objective": r(l[0], 4), "train_error_ratio": r(l[1], 4), "train_big_recall": r(l[2], 3), **p}
           for l, p in trials[:8]]
    pure = min(trials, key=lambda t: t[0][1])  # what the error term alone would choose
    top.append({"note": "best on error alone", "train_error_ratio": r(pure[0][1], 4),
                "train_big_recall": r(pure[0][2], 3), **pure[1]})
    return best, top


def summarize_test(rows: list[dict], meth: str) -> dict:
    sel = [x for x in rows if is_test(x) and x["method"] == meth]
    naive = [x for x in rows if is_test(x) and x["method"] == "naive"]
    m6 = metrics([x for x in sel if x["h"] == 6], [x for x in naive if x["h"] == 6])
    m6["big_move_recall"], m6["n_big_moves"] = big_recall(sel)
    m12 = metrics([x for x in sel if x["h"] == 12], [x for x in naive if x["h"] == 12])
    m3 = metrics([x for x in sel if x["h"] == 3], [x for x in naive if x["h"] == 3])
    return {"h6": m6, "h3": m3, "h12": m12}


def reliability(rows: list[dict]) -> list[dict]:
    """Calibration of P(up in 6 months) on the test period: predicted bin vs observed frequency."""
    sel = [x for x in rows if is_test(x) and x["method"] == "orbit" and x["h"] == 6 and x["prob_up"] is not None]
    bins = [(0.0, 0.3), (0.3, 0.45), (0.45, 0.55), (0.55, 0.7), (0.7, 1.01)]
    out = []
    for lo, hi in bins:
        b = [x for x in sel if lo <= x["prob_up"] < hi]
        if b:
            out.append({"bin": f"{lo:.2f}-{min(hi, 1):.2f}", "n": len(b),
                        "predicted": r(st.mean(x["prob_up"] for x in b), 3),
                        "observed": r(sum(x["actual"] > x["base"] for x in b) / len(b), 3)})
    return out


def main(do_tune: bool = True, write: bool = True) -> dict:
    hists, raw, cases = load_cases()
    OUT.mkdir(parents=True, exist_ok=True)
    if do_tune:
        params, top = tune(cases)
    else:
        params, top = load_params(), []
    rows_before = score_rows(cases, BEFORE)
    rows = score_rows(cases, params)

    def pick(item=None, h=None, method=None):
        return [x for x in rows if (item is None or x["item"] == item) and (h is None or x["h"] == h)
                and (method is None or x["method"] == method)]

    items_out = []
    for iid in hists:
        it = ITEM_BY_ID[iid]
        if not pick(iid):
            continue
        by = block(rows, item=iid)
        test = block(rows, is_test, iid)
        s = it.get("commodity_share", 1.0)
        items_out.append({"item_id": iid, "name": it["name"], "series": hists[iid]["series"],
                          "proxy": hists[iid].get("proxy", False), "cleaned_points": hists[iid].get("cleaned_points", 0),
                          "commodity_share": s, "cutoffs": "anchor months only" if hists[iid].get("cutoff_months") else "monthly",
                          "retail_mape_h6_orbit": r((by["orbit"]["h6"].get("mape") or 0) * s, 1),
                          "by_method": by, "test": test})

        months, vals = hists[iid]["months"], hists[iid]["values"]
        cuts = sorted({x["cutoff"] for x in pick(iid)})
        sub = set(cuts[::6])
        bts = [{"cutoff": x["cutoff"], "h": x["h"], "method": x["method"], "base": r(x["base"], 4),
                "p10": r(x["p10"], 4), "p50": r(x["p50"], 4), "p90": r(x["p90"], 4), "actual": r(x["actual"], 4),
                "prob_up": r(x["prob_up"], 3), "split": "test" if is_test(x) else ("train" if is_train(x) else "gap")}
               for x in pick(iid) if x["h"] == 6 or x["cutoff"] in sub]
        bts.sort(key=lambda b: (b["cutoff"], b["h"], b["method"]))
        st6 = {x["cutoff"]: x for x in pick(iid, 6, "orbit")}
        doc = {"item_id": iid, "name": it["name"], "series": hists[iid]["series"],
               "unit": "GBP street price" if iid == "gpu" else "FRED index/USD",
               "history": [{"month": m, "price": r(v, 4)} for m, v in zip(months, vals) if m >= HIST_START],
               "satellite_stress": [{"cutoff": c, "stress": r(st6[c]["stress"], 3)} for c in cuts if c in st6],
               "backtests": bts}
        if iid in AI_COEF:
            doc["ai_drift_12m"] = [{"cutoff": c, "drift12_pct": r(st6[c]["ai12"] * 100, 2)} for c in cuts if c in st6]
        if write:
            (OUT / f"{iid}.json").write_text(json.dumps(doc, separators=(",", ":")))

    overall = block(rows)
    test_overall = block(rows, is_test)

    # highlights: OUT-OF-SAMPLE only (test cutoffs); biggest real 6m rise (>15%) where Orbit called "up" (>= +3%)
    hl = []
    for iid in hists:
        hits = [x for x in pick(iid, 6, "orbit") if is_test(x)
                and x["actual"] / x["base"] - 1 > BIG_MOVE and x["p50"] / x["base"] - 1 >= 0.03]
        if hits:
            x = max(hits, key=lambda x: min(x["actual"] / x["base"] - 1, 1.0) * (x["p50"] / x["base"] - 1))
            pc, ac = (x["p50"] / x["base"] - 1) * 100, (x["actual"] / x["base"] - 1) * 100
            hl.append({"item_id": iid, "cutoff": x["cutoff"], "kind": "hit", "method": "orbit", "split": "test",
                       "story": f"{ITEM_BY_ID[iid]['name']}: in {x['cutoff']} Orbit said up {pc:+.0f}% in 6 months; it rose {ac:+.0f}%.",
                       "predicted_change_pct": r(pc, 1), "actual_change_pct": r(ac, 1),
                       "prob_up": r(x["prob_up"], 2)})
    hl.sort(key=lambda h: -min(h["actual_change_pct"], 100) * h["predicted_change_pct"])
    misses = [x for x in pick(None, 6, "orbit") if is_test(x) and x["actual"] / x["base"] - 1 > 0.3
              and x["p50"] <= x["base"] * 1.01]
    if misses:
        x = max(misses, key=lambda x: x["actual"] / x["base"])
        pc, ac = (x["p50"] / x["base"] - 1) * 100, (x["actual"] / x["base"] - 1) * 100
        hl.append({"item_id": x["item"], "cutoff": x["cutoff"], "kind": "miss", "method": "orbit", "split": "test",
                   "story": f"Honest miss: {ITEM_BY_ID[x['item']]['name']} from {x['cutoff']}: we said {pc:+.0f}%, it went {ac:+.0f}%.",
                   "predicted_change_pct": r(pc, 1), "actual_change_pct": r(ac, 1)})

    before_t, after_t = summarize_test(rows_before, "orbit"), summarize_test(rows, "orbit")
    tuned = {"train_period": f"cutoff+h <= {TRAIN_END} (cutoffs {min(c['cutoff'] for c in cases)}..)",
             "test_period": f"cutoffs >= {TEST_START} (to {max(c['cutoff'] for c in cases)})",
             "objective": f"train: mean over h3/h6/h12 of pooled |error| / naive |error| - {RISE_WEIGHT} x big-rise recall (h6); "
                          "parsimony tie-break within 0.002",
             "params": params, "before_params": BEFORE, "n_fitted_params": N_PARAMS,
             "before": before_t, "after": after_t,
             "timesfm_test": summarize_test(rows, "timesfm"), "naive_test": summarize_test(rows, "naive"),
             "drift_test": summarize_test(rows, "drift"), "top_train_trials": top,
             "n_train_rows_h6": sum(1 for x in rows if x["method"] == "naive" and x["h"] == 6 and is_train(x)),
             "n_test_rows_h6": sum(1 for x in rows if x["method"] == "naive" and x["h"] == 6 and is_test(x))}
    ai_rows = [x for x in rows if is_test(x) and x["method"] == "orbit" and x["item"] in AI_COEF]
    if ai_rows:  # ablation: AI-era drivers on vs off, test period, gpu+laptop
        noai = score_rows([c for c in cases if c["item"] in AI_COEF], {**params, "ai": 0.0})
        tuned["ai_ablation_test"] = {
            "with_ai": summarize_test([x for x in rows if x["item"] in AI_COEF], "orbit"),
            "without_ai": summarize_test(noai, "orbit"),
            "note": "AI-driver coefficients are priors (not fitted); gpu cutoffs are anchor months only, so n is small"}

    summary = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "n_forecasts": raw["n_forecasts"], "model": raw.get("model"), "gpu": raw["gpu"],
               "n_scored": len(rows), "methods": METHODS, "horizons": HORIZONS,
               "cutoffs": {"from": min(x["cutoff"] for x in rows), "to": max(x["cutoff"] for x in rows)},
               "target": "driver series per item: FRED commodity benchmark / CPI computers / curated GPU street index",
               "orbit_weights": params, "in_sample": False,
               "items": items_out, "overall": overall, "test_overall": test_overall, "tuned": tuned,
               "reliability_test_h6": reliability(rows), "highlights": hl}
    if write:
        (OUT / "summary.json").write_text(json.dumps(summary, indent=1))
    return summary


def _fmt(m: dict) -> str:
    return (f"mape {m.get('mape')}  dir {m.get('dir_acc')}  cov80 {m.get('coverage80')}  skill {m.get('skill')}  "
            f"big {m.get('big_move_recall')}/{m.get('n_big_moves')}  n {m.get('n')}")


if __name__ == "__main__":
    s = main(do_tune="--no-tune" not in sys.argv)
    t = s["tuned"]
    print(f"forecasts {s['n_forecasts']}  scored rows {s['n_scored']}  gpu {s['gpu']}")
    print("tuned params:", t["params"], " train rows h6", t["n_train_rows_h6"], " test rows h6", t["n_test_rows_h6"])
    for tr in t["top_train_trials"][:5]:
        print("   ", tr)
    print("TEST h6:")
    for name, key in (("naive", "naive_test"), ("drift", "drift_test"), ("timesfm", "timesfm_test"),
                      ("orbit before", "before"), ("orbit after", "after")):
        print(f"  {name:13s}", _fmt(t[key]["h6"]))
    print("TEST h3/h12 skill: before", t["before"]["h3"].get("skill"), t["before"]["h12"].get("skill"),
          " after", t["after"]["h3"].get("skill"), t["after"]["h12"].get("skill"))
    if "ai_ablation_test" in t:
        print("AI ablation (gpu+laptop test h6): with", _fmt(t["ai_ablation_test"]["with_ai"]["h6"]))
        print("                                  w/o ", _fmt(t["ai_ablation_test"]["without_ai"]["h6"]))
    print("PER ITEM test h6: timesfm skill / orbit skill / orbit dir / cov80 / n")
    for it in s["items"]:
        tt = it["test"]
        print(f"  {it['item_id']:13s} {tt['timesfm']['h6'].get('skill')} / {tt['orbit']['h6'].get('skill')} / "
              f"{tt['orbit']['h6'].get('dir_acc')} / {tt['orbit']['h6'].get('coverage80')} / {tt['orbit']['h6'].get('n')}")
    print("reliability:", s["reliability_test_h6"])
    for h in s["highlights"]:
        print(" *", h["story"])
