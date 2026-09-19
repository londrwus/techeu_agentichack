r"""orbit-zoo-stats: classical forecasters (AutoETS / AutoARIMA / AutoTheta) + an M4-style forecast
combination with online split-conformal intervals. Strictly point-in-time.

    .\.venv\Scripts\modal run modal_app/zoo_stats.py           # fit missing contexts on Modal CPU, then combine
    .\.venv\Scripts\python modal_app/zoo_stats.py              # combine only (uses cached fits)

1. Per (item, cutoff) the log-price series truncated at the cutoff is fitted with Nixtla statsforecast
   (AutoETS, AutoARIMA, AutoTheta; 12-month horizon) on up to 100 Modal CPU containers. Cutoffs = the
   build_eval backtest cutoffs plus "warm-up" cutoffs 2012-01..2017-12 that only feed the error history
   (for the inverse-error weights and the conformal residual pool). Cached in data/cache/eval/zoo_stats_raw.json.
2. Locally: members {naive, drift, ETS, ARIMA, Theta, TimesFM}. Every forecast at cutoff c only uses
   errors of forecasts whose outcome month (cutoff+h) <= c:
     - inverse-MAE combination weights (expanding window, pooled over items, per horizon)
     - split-conformal predictive distribution: z = ln(actual/p50) / sigma_h, sigma_h = std of past h-month
       log changes (5y, <= cutoff); p10/p90/P(up)/P(+15%) from the kernel-smoothed empirical z of the past.
3. Variants (equal / inverse-error / median / stats-only, damping d) are chosen on VALIDATION
   (cutoffs 2020-07..2022-06, cutoff+h <= 2022-12); TEST (cutoffs >= 2023-01) is only reported.
   Writes data/cache/eval/candidates/{ets,arima,theta,stat_combo}.json.
"""
import json
import math
import sys
import time
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache" / "eval"
RAW = CACHE / "zoo_stats_raw.json"
CAND = CACHE / "candidates"
H = 12
WARM_START = "2012-01"
MODELS = ["ets", "arima", "theta"]

app = modal.App("orbit-zoo-stats")
image = modal.Image.debian_slim(python_version="3.12").uv_pip_install("statsforecast>=2.0", "numpy", "pandas")


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


@app.function(image=image, cpu=2, memory=2048, timeout=900, max_containers=100, retries=1)
def fit_batch(batch: list[dict]) -> dict:
    """batch: [{key, months, values}] -> {key: {model: {"mean":[H], "lo":[H], "hi":[H]}}} in log space (80% level)."""
    import warnings

    import numpy as np
    import pandas as pd
    from statsforecast import StatsForecast
    from statsforecast.models import AutoARIMA, AutoETS, AutoTheta

    warnings.filterwarnings("ignore")
    out = {}
    for b in batch:
        df = pd.DataFrame({"unique_id": b["key"], "ds": pd.to_datetime([m + "-01" for m in b["months"]]),
                           "y": np.log(np.asarray(b["values"], dtype=float))})
        res = {}
        for name, mdl in (("ets", AutoETS(season_length=1, alias="ets")),
                          ("arima", AutoARIMA(season_length=1, alias="arima")),
                          ("theta", AutoTheta(season_length=1, alias="theta"))):
            try:
                fc = StatsForecast(models=[mdl], freq="MS", n_jobs=1).forecast(df=df, h=H, level=[80])
                res[name] = {"mean": fc[name].tolist(), "lo": fc[f"{name}-lo-80"].tolist(),
                             "hi": fc[f"{name}-hi-80"].tolist()}
            except Exception as e:  # a failed fit simply drops out of the combination
                print(b["key"], name, repr(e)[:200])
        out[b["key"]] = res
    return out


def eval_cutoffs() -> dict:
    """item -> sorted cutoffs used by build_eval (timesfm 'full' keys) + warm-up cutoffs."""
    hists = json.loads((CACHE / "histories.json").read_text())
    tf = json.loads((CACHE / "timesfm.json").read_text())["results"]
    cuts = {}
    for key in tf:
        it, cut, ctx = (key.split("|") + ["full"])[:3]
        if ctx == "full" and it in hists:
            cuts.setdefault(it, set()).add(cut)
    for it, h in hists.items():
        if h.get("cutoff_months"):
            continue  # gpu: anchor months only (interpolated series)
        for k, ym in enumerate(h["months"]):
            if WARM_START <= ym < "2018-01" and k >= 36:
                cuts.setdefault(it, set()).add(ym)
    return {it: sorted(c) for it, c in cuts.items()}


@app.local_entrypoint()
def main(force: bool = False):
    hists = json.loads((CACHE / "histories.json").read_text())
    raw = json.loads(RAW.read_text()) if RAW.exists() and not force else {}
    jobs = []
    for it, cuts in eval_cutoffs().items():
        months, vals = hists[it]["months"], hists[it]["values"]
        for cut in cuts:
            key = f"{it}|{cut}"
            if key not in raw:
                k = months.index(cut)
                jobs.append({"key": key, "months": months[: k + 1], "values": vals[: k + 1]})  # <= cutoff only
    print(f"{len(jobs)} contexts to fit ({len(raw)} cached)")
    if jobs:
        n = min(100, len(jobs))
        t0 = time.time()
        for r in fit_batch.map([jobs[i::n] for i in range(n)]):
            raw.update(r)
        print(f"fitted on {n} CPU containers in {time.time() - t0:.0f}s")
        RAW.write_text(json.dumps(raw))
    combine()


# ====================================================================== local combination + conformal
def combine():
    import numpy as np

    sys.path.insert(0, str(ROOT))
    import scripts.build_eval as be

    hists = json.loads((CACHE / "histories.json").read_text())
    tf = json.loads((CACHE / "timesfm.json").read_text())["results"]
    raw = json.loads(RAW.read_text())
    cuts = eval_cutoffs()
    eval_keys = {k.rsplit("|", 1)[0] for k in tf if k.endswith("|full")}

    # ---- member log-change forecasts per case: F[(item,cut)][member] = array(H) of ln(p/base)
    cases = []
    for it, cl in cuts.items():
        months, vals = hists[it]["months"], hists[it]["values"]
        lv = np.log(np.asarray(vals))
        for cut in cl:
            k = months.index(cut)
            base = vals[k]
            f = {"naive": np.zeros(H)}
            past = lv[max(0, k - 24): k + 1]
            f["drift"] = (past[-1] - past[0]) / max(len(past) - 1, 1) * np.arange(1, H + 1)
            for m, v in raw.get(f"{it}|{cut}", {}).items():
                arr = np.asarray(v["mean"]) - lv[k]
                if np.all(np.isfinite(arr)) and np.max(np.abs(arr)) < 3:
                    f[m] = arr
            q = tf.get(f"{it}|{cut}|full")
            if q:
                f["timesfm"] = np.log(np.maximum(np.asarray(q)[:, 4], 1e-9) / base)
            sig = {"5y": {}, "ewma": {}, "mix": {}}
            r1 = np.diff(lv[max(0, k - 120): k + 1])
            wts = 0.94 ** np.arange(len(r1))[::-1]                        # RiskMetrics EWMA, <= cutoff
            ew = math.sqrt(float(np.sum(wts * r1 ** 2) / np.sum(wts))) if len(r1) else 0.03
            for h in range(1, H + 1):
                ch = lv[max(h, k - 60 + 1): k + 1] - lv[max(0, k - 60 + 1 - h): k + 1 - h]
                s5 = max(float(np.std(ch)), 0.01) if len(ch) > 6 else 0.1
                se = max(ew * math.sqrt(h), 0.01)
                sig["5y"][h], sig["ewma"][h], sig["mix"][h] = s5, se, math.sqrt((s5 ** 2 + se ** 2) / 2)
            acts = {h: vals[k + h] for h in range(1, H + 1) if k + h < len(vals)}
            cases.append({"item": it, "cutoff": cut, "base": base, "f": f, "sig": sig, "act": acts,
                          "eval": f"{it}|{cut}" in eval_keys})
    cases.sort(key=lambda c: c["cutoff"])
    print(f"{len(cases)} cases ({sum(c['eval'] for c in cases)} eval)")

    MEMBERS = ["naive", "drift", "ets", "arima", "theta", "timesfm"]

    import bisect

    ERR = {}   # ERR[h][m] = (outcome months, cumulative sum of normalised |error|): sorted since cases are in cutoff order
    for h in (3, 6, 12):
        for m in MEMBERS:
            oms, es = [], []
            for c in cases:
                if h in c["act"] and m in c["f"]:
                    oms.append(add_months(c["cutoff"], h))
                    es.append(abs(math.log(c["act"][h] / c["base"]) - c["f"][m][h - 1]) / c["sig"]["5y"][h])
            ERR.setdefault(h, {})[m] = (oms, np.concatenate([[0.0], np.cumsum(es)]))

    def forecasts(cfg):
        """Online (point-in-time) combined log-change p50 per case: {(item,cut): {h: x}}. Inverse-MAE weights use
        only errors whose outcome month <= cutoff."""
        out = {}
        for c in cases:
            res = {}
            for h in (3, 6, 12):
                mem = [m for m in cfg["members"] if m in c["f"]]
                xs = np.array([c["f"][m][h - 1] for m in mem])
                if cfg["w"] == "inv":
                    w = []
                    for m in mem:
                        oms, cs = ERR[h][m]
                        n = bisect.bisect_right(oms, c["cutoff"])
                        w.append(1 / max(cs[n] / n, 1e-4) if n >= 24 else np.nan)
                    w = np.array(w)
                    w = np.where(np.isnan(w), np.nanmean(w) if np.any(~np.isnan(w)) else 1.0, w)
                    x = float(np.sum(w * xs) / np.sum(w))
                elif cfg["w"] == "median":
                    x = float(np.median(xs))
                else:
                    x = float(np.mean(xs))
                res[h] = x * cfg["d"]
            out[(c["item"], c["cutoff"])] = res
        return out

    def ncdf(x):  # vectorised normal CDF (Abramowitz-Stegun 7.1.26)
        y = np.abs(x) / math.sqrt(2)
        t = 1 / (1 + 0.3275911 * y)
        e = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * np.exp(-y * y)
        return 0.5 * (1 + np.sign(x) * e)

    def fit_platt(x, y, l2=1.0):
        """logistic y ~ sigmoid(a + b x) by Newton, ridge towards (0, 1)."""
        a, b = 0.0, 1.0
        for _ in range(15):
            p = 1 / (1 + np.exp(-(a + b * x)))
            w = p * (1 - p)
            g = np.array([np.sum(p - y) + l2 * a, np.sum((p - y) * x) + l2 * (b - 1)])
            Hm = np.array([[np.sum(w) + l2, np.sum(w * x)], [np.sum(w * x), np.sum(w * x * x) + l2]])
            a, b = np.array([a, b]) - np.linalg.solve(Hm, g)
        return float(a), float(min(max(b, 0.0), 2.0))

    def conformal(p50s, cfg):
        """Online split-conformal with adaptive miss-rate control (ACI, Gibbs & Candes 2021).
        z pool = normalised residuals of past rows whose outcome month <= cutoff (pool is sorted by outcome
        month because cases run in cutoff order). Returns rows with p10/p50/p90/P(up)/P(bigup)."""

        pool = {h: ([], []) for h in (3, 6, 12)}           # (outcome months, z)
        pend = {h: [] for h in (3, 6, 12)}                  # (outcome month, z, zlo, zhi) awaiting ACI update
        alpha = {h: [0.1, 0.1] for h in (3, 6, 12)}         # lower / upper tail levels (target 0.1 each)
        gam, bw, sv = cfg.get("gamma", 0.0), cfg.get("bw", 0.3), cfg.get("sig", "5y")
        cal = {(h, k): ([], [], []) for h in (3, 6, 12) for k in ("up", "big")}   # (outcome month, logit p, outcome)
        platt, last_cut = {}, None
        rows = []
        for c in cases:
            if cfg.get("platt") and c["cutoff"] != last_cut:   # online Platt recalibration on past outcomes only
                last_cut = c["cutoff"]
                for key, (om_, lp_, y_) in cal.items():
                    n = bisect.bisect_right(om_, last_cut)
                    platt[key] = fit_platt(np.asarray(lp_[:n]), np.asarray(y_[:n])) if n >= 150 else (0.0, 1.0)
            for h in (3, 6, 12):
                x, s = p50s[(c["item"], c["cutoff"])][h], c["sig"][sv][h]
                oms, zs = pool[h]
                z = np.asarray(zs[: bisect.bisect_right(oms, c["cutoff"])])
                if cfg.get("recent") and len(z) > cfg["recent"]:
                    z = z[-cfg["recent"]:]
                while pend[h] and pend[h][0][0] <= c["cutoff"]:     # ACI: outcomes that became known
                    _, zr, zl, zh = pend[h].pop(0)
                    alpha[h][0] = min(max(alpha[h][0] + gam * (0.1 - (zr < zl)), 0.01), 0.3)
                    alpha[h][1] = min(max(alpha[h][1] + gam * (0.1 - (zr > zh)), 0.01), 0.3)
                if len(z) < 40:
                    z = np.random.default_rng(0).normal(0, 1, 400)
                zl, zm, zh = np.quantile(z, [alpha[h][0], 0.5, 1 - alpha[h][1]])
                med = x + s * (zm if cfg.get("bias") else 0.0)
                # smoothed predictive CDF: mixture of N(x + s*z_i, (s*bw)^2), tails stretched like the ACI band
                zz = np.where(z < zm, zm + (z - zm) * (zl - zm) / min(np.quantile(z, 0.1) - zm, -1e-6),
                              zm + (z - zm) * (zh - zm) / max(np.quantile(z, 0.9) - zm, 1e-6))
                pu = float(np.mean(1 - ncdf((0 - x - s * zz) / (s * bw))))
                pb = float(np.mean(1 - ncdf((math.log(1 + be.BIG_MOVE) - x - s * zz) / (s * bw))))
                b = c["base"]
                pu, pb = min(max(pu, 0.01), 0.99), min(max(pb, 0.002), 0.99)
                lu, lb = math.log(pu / (1 - pu)), math.log(pb / (1 - pb))
                if cfg.get("platt"):
                    (au, bu), (ab, bb) = platt[(h, "up")], platt[(h, "big")]
                    pu, pb = 1 / (1 + math.exp(-(au + bu * lu))), 1 / (1 + math.exp(-(ab + bb * lb)))
                rows.append({"item": c["item"], "item_id": c["item"], "cutoff": c["cutoff"], "h": h, "base": b,
                             "p10": b * math.exp(x + s * zl), "p50": b * math.exp(med), "p90": b * math.exp(x + s * zh),
                             "prob_up": min(max(pu, 0.02), 0.98), "prob_bigup": min(max(pb, 0.005), 0.98),
                             "actual": c["act"].get(h), "eval": c["eval"]})
                if h in c["act"]:
                    om, zr = add_months(c["cutoff"], h), (math.log(c["act"][h] / b) - x) / s
                    oms.append(om)
                    zs.append(zr)
                    pend[h].append((om, zr, zl, zh))
                    for key, lp, y in (((h, "up"), lu, c["act"][h] > b), ((h, "big"), lb, c["act"][h] / b - 1 > be.BIG_MOVE)):
                        cal[key][0].append(om)
                        cal[key][1].append(lp)
                        cal[key][2].append(float(y))
        return rows

    def is_val(x):
        return "2020-07" <= x["cutoff"] <= "2022-06" and be.is_train(x)

    def score(rows, cond):
        naive = {(x["item"], x["cutoff"], x["h"]): x["base"] for x in rows}
        out = {}
        for h in (3, 6, 12):
            sel = [x for x in rows if x["eval"] and x["actual"] is not None and x["h"] == h and cond(x)]
            nv = [{**x, "p50": x["base"]} for x in sel]
            m = be.metrics(sel, nv)
            if sel:
                up = [x["actual"] > x["base"] for x in sel]
                bg = [x["actual"] / x["base"] - 1 > be.BIG_MOVE for x in sel]
                m["brier_up"] = round(float(np.mean([(x["prob_up"] - u) ** 2 for x, u in zip(sel, up)])), 4)
                m["brier_big"] = round(float(np.mean([(x["prob_bigup"] - g) ** 2 for x, g in zip(sel, bg)])), 4)
                m["brier_big_clim"] = None
                if h == 6:
                    m["big_recall"], m["n_big"] = be.big_recall(sel)
                    flag = [x["prob_bigup"] > 0.25 for x in sel]
                    tp = sum(f and g for f, g in zip(flag, bg))
                    m["big_prec@.25"] = round(tp / max(sum(flag), 1), 3)
                    m["big_rec@.25"] = round(tp / max(sum(bg), 1), 3)
            out[f"h{h}"] = m
        return out

    def point_obj(sc):   # stage 1 (validation): mean skill over h3/h6/h12 + a little direction credit
        return np.mean([sc[f"h{h}"]["skill"] for h in (3, 6, 12)]) + 0.02 * ((sc["h6"]["dir_acc"] or 0.5) - 0.5)

    def prob_obj(sc):    # stage 2 (validation): 80% band calibration + Brier of P(up) and P(bigup)
        cov = np.mean([abs(sc[f"h{h}"]["coverage80"] - 0.8) for h in (3, 6, 12)])
        return -(cov + np.mean([sc[f"h{h}"]["brier_up"] + sc[f"h{h}"]["brier_big"] for h in (3, 6, 12)]))

    cfgs = {m: {"members": [m], "w": "eq", "d": 1.0} for m in MEMBERS}
    for name, mem in (("all", MEMBERS), ("stats", ["ets", "arima", "theta"]), ("stats_tfm", ["ets", "arima", "theta", "timesfm"]),
                      ("stats_tfm_drift", ["drift", "ets", "arima", "theta", "timesfm"])):
        for w in ("eq", "inv", "median"):
            for d in (1.0, 0.75, 0.5):
                cfgs[f"{name}_{w}_d{d}"] = {"members": mem, "w": w, "d": d}
    base_cc = {"sig": "5y", "bw": 0.3}
    p50 = {n: forecasts(c) for n, c in cfgs.items()}
    stage1 = {n: score(conformal(p50[n], base_cc), is_val) for n in cfgs}
    ranked = sorted(stage1, key=lambda n: -point_obj(stage1[n]))
    print("STAGE 1 validation (point forecast): h6 skill / dir, h3 h12 skill")
    for n in ranked[:10]:
        v = stage1[n]
        print(f"  {n:26s} obj {point_obj(v):+.4f} sk6 {v['h6']['skill']:+.3f} dir {v['h6']['dir_acc']} "
              f"sk3 {v['h3']['skill']:+.3f} sk12 {v['h12']['skill']:+.3f}")
    best = ranked[0]
    ccfgs = {}
    for sv in ("5y", "ewma", "mix"):
        for g in (0.0, 0.02, 0.05):
            for pl in (False, True):
                ccfgs[f"{sv}_g{g}_platt{int(pl)}"] = {"sig": sv, "gamma": g, "bw": 0.3, "platt": pl}
    stage2 = {cn: score(conformal(p50[best], cc), is_val) for cn, cc in ccfgs.items()}
    cranked = sorted(stage2, key=lambda n: -prob_obj(stage2[n]))
    print("STAGE 2 validation (intervals/probabilities) for", best)
    for cn in cranked[:8]:
        v = stage2[cn]
        print(f"  {cn:18s} obj {prob_obj(v):+.4f} cov3/6/12 {v['h3']['coverage80']}/{v['h6']['coverage80']}/"
              f"{v['h12']['coverage80']} bu6 {v['h6']['brier_up']} bb6 {v['h6']['brier_big']}")
    bestc = cranked[0]
    results = {n: (None, None, conformal(p50[n], ccfgs[bestc])) for n in ("ets", "arima", "theta", "naive", "timesfm", best)}
    best = (best, bestc)

    CAND.mkdir(parents=True, exist_ok=True)
    report = {}
    for out_name, key, desc in (
            ("ets", ("ets",), "Nixtla AutoETS on log price (per item x cutoff, Modal CPU) + online split-conformal band"),
            ("arima", ("arima",), "Nixtla AutoARIMA on log price + online split-conformal band"),
            ("theta", ("theta",), "Nixtla AutoTheta on log price + online split-conformal band"),
            ("stat_combo", best, f"M4-style combination '{best[0]}' (conformal '{best[1]}') of naive/drift/ETS/ARIMA/Theta/TimesFM, "
                                 "chosen on validation 2020-07..2022-06; point-in-time inverse-error weights and conformal intervals")):
        rows = results[key[0]][2]
        emit = [{"item_id": x["item_id"], "cutoff": x["cutoff"], "h": x["h"], "p10": round(x["p10"], 5),
                 "p50": round(x["p50"], 5), "p90": round(x["p90"], 5), "prob_up": round(x["prob_up"], 4),
                 "prob_bigup": round(x["prob_bigup"], 4)} for x in rows if x["eval"]]
        (CAND / f"{out_name}.json").write_text(json.dumps({"name": out_name, "description": desc,
                                                           "config": {"combo": key[0], "conformal": best[1], "combo_cfg": cfgs[key[0]], "conformal_cfg": ccfgs[best[1]]}, "rows": emit}))
        report[out_name] = {"val": score(rows, is_val), "test": score(rows, be.is_test)}
    for ref in ("naive",):
        rows = results[ref][2]
        if rows:
            report[f"ref:{ref}"] = {"val": score(rows, is_val), "test": score(rows, be.is_test)}
    print("\nFINAL (h6)  split  mape skill dir cov80 brier_up brier_big big_recall prec@.25/rec@.25")
    for n, d in report.items():
        for sp in ("val", "test"):
            m = d[sp]["h6"]
            print(f"  {n:24s} {sp:4s} {m['mape']:5} {m['skill']:+.3f} {m['dir_acc']} {m['coverage80']} {m['brier_up']} "
                  f"{m['brier_big']} {m.get('big_recall')} {m.get('big_prec@.25')}/{m.get('big_rec@.25')}")
        print(f"  {'':24s} test h3/h12 skill {d['test']['h3']['skill']}/{d['test']['h12']['skill']} "
              f"cov {d['test']['h3']['coverage80']}/{d['test']['h12']['coverage80']}")
    (CACHE / "zoo_stats_report.json").write_text(json.dumps({"best": best, "report": report}, indent=1))


if __name__ == "__main__":
    combine()
