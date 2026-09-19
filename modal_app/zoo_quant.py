r"""orbit-zoo-quant: quant candidates for the point-in-time backtest (same items/cutoffs as scripts/build_eval.py).

    .\.venv\Scripts\modal run modal_app/zoo_quant.py          # walk-forward fits fanned out on Modal CPUs
    .\.venv\Scripts\python modal_app/zoo_quant.py             # same, in-process (needs numpy + lightgbm)

Panel = the 8 Orbit driver series + ~30 extra IMF/FRED commodity series (P*USDM, cached in data/cache/eval/fred)
to widen the cross-section. Features at month t use only prices <= t (and the satellite stress <= t):
  momentum r1/r3/r6/r12 (vol-scaled), MA3/MA12 crossover, breakout vs 12m high/low, 36m drawdown,
  z-score of log price vs its trailing 5y mean, vol level + vol-regime percentile (vs trailing 10y), sat stress.
Walk-forward: for every cutoff c the models are refit on rows whose outcome month t+h <= c (expanding window),
standardised on those rows only. Hyper-parameters are picked on VALIDATION cutoffs 2020-07..2022-06 with
c+h <= 2022-12; TEST (cutoffs >= 2023-01) is only scored at the end.

Candidates (data/cache/eval/candidates/):
  quant_tsmom  ridge on the vol-scaled h-month log return -> p50; bands/probabilities from the empirical
               distribution of standardised training residuals (x val-tuned band scale)
  bigmove_clf  pooled classifiers (L2 logistic or shallow LightGBM, val-picked, Platt temperature on val)
               for P(up) and P(rise > 15%); p50 = naive, bands = vol-scaled empirical quantiles
"""
import json
import math
import sys
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache" / "eval"
CAND = CACHE / "candidates"
HS = [3, 6, 12]
BIG = math.log(1.15)
VAL = ("2020-07", "2022-06")
EXTRA = ("PMAIZMTUSDM PSOYBUSDM PSUGAISAUSDM PRICENPQUSDM PBEEFUSDM PPORKUSDM PPOULTUSDM PCOFFROBUSDM PTEAUSDM "
         "PBANSOPUSDM PCOPPUSDM PALUMUSDM PNICKUSDM PZINCUSDM PIORECRUSDM POILBREUSDM PCOTTINDUSDM PRUBBUSDM "
         "PSUNOUSDM PROILUSDM PPOILUSDM PSOILUSDM PSALMUSDM PSHRIUSDM PLAMBUSDM PSMEAUSDM PTINUSDM PLEADUSDM "
         "PNGASEUUSDM PWOOLFUSDM PHIDEUSDM PGNUTSUSDM").split()
FEATS = ["m1", "m3", "m6", "m12", "ma", "brk_hi", "brk_lo", "dd36", "z5", "lvol", "vreg", "sat", "m12xv"]
ALPHAS = [3.0, 30.0, 300.0, 3000.0]
CLF = [("logit", 0.3), ("logit", 3.0), ("logit", 30.0), ("lgbm", 0)]

app = modal.App("orbit-zoo-quant")
image = modal.Image.debian_slim(python_version="3.12").uv_pip_install("numpy", "lightgbm")


def add_months(ym: str, n: int) -> str:
    y, m = map(int, ym.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


# ------------------------------------------------------------------ panel + features (local, point-in-time)
def load_panel() -> dict:
    sys.path.insert(0, str(ROOT / "modal_app"))
    import evaluate as ev

    hists = json.loads((CACHE / "histories.json").read_text())
    panel = {k: {"months": h["months"], "values": h["values"], "target": True,
                 "train": k != "gpu"} for k, h in hists.items()}   # gpu: interpolated anchors -> predict only
    for sid in EXTRA:
        p = CACHE / "fred" / f"{sid}.csv"
        if p.exists():
            m, v = ev.parse_fred(p.read_text())
            v, _ = ev.clean_glitches(v)
            if len(v) > 120:
                panel[sid] = {"months": m, "values": v, "target": False, "train": True}
    return panel


def feats_at(lp: list[float], k: int, sat: float) -> dict | None:
    """Features from log prices lp[0..k] only."""
    import statistics as st

    if k < 13:
        return None
    rets = [lp[i] - lp[i - 1] for i in range(max(1, k - 35), k + 1)]
    sig = max(st.pstdev(rets), 0.005)
    vols = []  # trailing 12m vol at each month over the last 10y (for the regime percentile)
    for j in range(max(13, k - 120), k + 1, 3):
        rr = [lp[i] - lp[i - 1] for i in range(j - 11, j + 1)]
        vols.append(st.pstdev(rr))
    v12 = vols[-1]
    w5 = lp[max(0, k - 59): k + 1]
    sd5 = st.pstdev(w5) if len(w5) >= 24 else 0.0
    ma3, ma12 = st.mean(lp[k - 2: k + 1]), st.mean(lp[k - 11: k + 1])
    f = {"m1": (lp[k] - lp[k - 1]) / sig, "m3": (lp[k] - lp[k - 3]) / (sig * 3 ** .5),
         "m6": (lp[k] - lp[k - 6]) / (sig * 6 ** .5), "m12": (lp[k] - lp[k - 12]) / (sig * 12 ** .5),
         "ma": (ma3 - ma12) / sig, "brk_hi": (lp[k] - max(lp[k - 11: k + 1])) / sig,
         "brk_lo": (lp[k] - min(lp[k - 11: k + 1])) / sig, "dd36": (lp[k] - max(lp[max(0, k - 35): k + 1])) / sig,
         "z5": (lp[k] - st.mean(w5)) / sd5 if sd5 > 1e-6 else 0.0, "lvol": math.log(sig),
         "vreg": sum(v <= v12 for v in vols) / len(vols), "sat": sat}
    f["m12xv"] = f["m12"] * (f["vreg"] - 0.5)
    return {"f": [max(-6.0, min(6.0, f[n])) for n in FEATS], "sig": sig}


def build_rows(panel: dict, targets: set) -> list[dict]:
    """rows: {s, t, f, sig, y:{h: log return}}; satellite stress only for Orbit items (0 elsewhere)."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import build_eval as be

    rows = []
    for s, p in panel.items():
        months, vals = p["months"], p["values"]
        lp = [math.log(v) for v in vals]
        for k, t in enumerate(months):
            is_tgt = (s, t) in targets
            if t < "2003-01" or not (p["train"] or is_tgt):
                continue
            sat = be.satellite_stress(s, t) if p["target"] and t >= "2019-01" else 0.0
            fx = feats_at(lp, k, sat)
            if fx is None:
                continue
            rows.append({"s": s, "t": t, **fx, "tgt": is_tgt, "train": p["train"],
                         "y": {h: lp[k + h] - lp[k] for h in HS if k + h < len(lp)}})
    return rows


# ------------------------------------------------------------------ models (run on Modal)
def _fit_cutoff(job: dict) -> list[dict]:
    import numpy as np

    rows, cuts = job["rows"], job["cutoffs"]
    X = np.array([r["f"] for r in rows])
    sig = np.array([r["sig"] for r in rows])
    t = np.array([r["t"] for r in rows])
    trn = np.array([r["train"] for r in rows])
    out = []
    for c in cuts:
        pred_idx = [i for i, r in enumerate(rows) if r["tgt"] and r["t"] == c]
        if not pred_idx:
            continue
        for h in HS:
            y = np.array([r["y"].get(str(h), r["y"].get(h, np.nan)) for r in rows], dtype=float)
            end = np.array([add_months(tt, h) for tt in t])
            m = trn & (end <= c) & ~np.isnan(y)
            if m.sum() < 300:
                continue
            Xt, yt, st_ = X[m], y[m], sig[m] * math.sqrt(h)
            mu, sd = Xt.mean(0), Xt.std(0) + 1e-9
            Z = np.c_[np.ones(len(Xt)), (Xt - mu) / sd]
            Zp = np.c_[np.ones(len(pred_idx)), (X[pred_idx] - mu) / sd]
            ys = yt / st_                                       # vol-scaled target (TSMOM convention)
            rec = {"cutoff": c, "h": h, "idx": pred_idx, "ridge": {}, "clf": {}}
            for a in ALPHAS:
                P = np.eye(Z.shape[1]) * a
                P[0, 0] = 0
                b = np.linalg.solve(Z.T @ Z + P, Z.T @ ys)
                e = ys - Z @ b
                rec["ridge"][str(a)] = {"yhat": (Zp @ b).tolist(),
                                        "eq": np.quantile(e, np.linspace(0.01, 0.99, 99)).tolist()}
            rec["ridge"]["eq_raw"] = np.quantile(ys, np.linspace(0.01, 0.99, 99)).tolist()   # for naive bands
            for tgt, lab in (("up", yt > 0), ("big", yt > BIG)):
                for kind, lam in CLF:
                    rec["clf"][f"{tgt}|{kind}|{lam}"] = _clf(kind, lam, Z, lab.astype(float), Zp)
            out.append(rec)
    return out


def _clf(kind, lam, Z, y, Zp):
    import numpy as np

    if y.sum() < 10:
        return [float(y.mean())] * len(Zp)
    if kind == "lgbm":
        import lightgbm as lgb

        prm = {"objective": "binary", "learning_rate": 0.03, "num_leaves": 4, "min_data_in_leaf": 80,
               "bagging_fraction": 0.8, "bagging_freq": 1, "feature_fraction": 0.8, "lambda_l2": 5.0,
               "verbose": -1, "seed": 0}
        m = lgb.train(prm, lgb.Dataset(Z[:, 1:], y), num_boost_round=150)
        return m.predict(Zp[:, 1:]).tolist()
    b = np.zeros(Z.shape[1])
    b[0] = math.log((y.mean() + 1e-3) / (1 - y.mean() + 1e-3))
    R = np.eye(Z.shape[1]) * lam
    R[0, 0] = 0
    for _ in range(25):                                   # IRLS / Newton with L2
        p = 1 / (1 + np.exp(-np.clip(Z @ b, -30, 30)))
        g = Z.T @ (p - y) + R @ b
        H = (Z * (p * (1 - p))[:, None]).T @ Z + R
        step = np.linalg.solve(H, g)
        b -= step
        if np.abs(step).max() < 1e-6:
            break
    return (1 / (1 + np.exp(-np.clip(Zp @ b, -30, 30)))).tolist()


@app.function(image=image, cpu=2, memory=2048, timeout=900, max_containers=100)
def fit_chunk(job: dict) -> list[dict]:
    return _fit_cutoff(job)


# ------------------------------------------------------------------ candidates + scoring (local)
def _q(eq, x):   # fraction of the empirical distribution (99 quantiles) above x
    import bisect

    return 1 - bisect.bisect_left(eq, x) / len(eq) if eq else 0.5


def _quant(eq, p):
    return eq[max(0, min(98, round(p * 100) - 1))]


def assemble(rows, fits, hp):
    """hp = {alpha, band, clf_up, clf_big, T_up, T_big} -> {name: rows}."""
    ts, bc = [], []
    for rec in fits:
        h, c = rec["h"], rec["cutoff"]
        rg = rec["ridge"][str(hp["alpha"])]
        for j, i in enumerate(rec["idx"]):
            r = rows[i]
            base = r["base"]
            s = r["sig"] * math.sqrt(h)
            yh, eq = rg["yhat"][j], rg["eq"]
            med = _quant(eq, 0.5)
            bw = hp[f"band{h}"]
            lo, hi = (_quant(eq, 0.1) - med) * bw, (_quant(eq, 0.9) - med) * bw
            mu = yh + med
            ts.append({"item_id": r["s"], "cutoff": c, "h": h, "p10": base * math.exp(s * (mu + lo)),
                       "p50": base * math.exp(s * mu), "p90": base * math.exp(s * (mu + hi)),
                       "prob_up": _q([yh + e for e in eq], 0.0),
                       "prob_bigup": _q([yh + e for e in eq], BIG / s)})
            er = rec["ridge"]["eq_raw"]
            pu = _platt(rec["clf"][f"up|{hp['clf_up']}"][j], hp["a_up"], hp["b_up"])
            pb = _platt(rec["clf"][f"big|{hp['clf_big']}"][j], hp["a_big"], hp["b_big"])
            bc.append({"item_id": r["s"], "cutoff": c, "h": h, "p10": base * math.exp(s * _quant(er, 0.1) * bw),
                       "p50": base, "p90": base * math.exp(s * _quant(er, 0.9) * bw),
                       "prob_up": pu, "prob_bigup": pb})
    return {"quant_tsmom": ts, "bigmove_clf": bc}


def _platt(p, a, b):
    """Platt recalibration logit' = a*logit + b (a, b picked on validation)."""
    p = min(max(p, 1e-4), 1 - 1e-4)
    return 1 / (1 + math.exp(-(a * math.log(p / (1 - p)) + b)))


def score(cand, split, thr_big=0.3):
    """Harness metrics (build_eval.metrics / big_recall) + Brier, AUC, precision/recall."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import build_eval as be

    hists = _hists()
    out = {}
    for h in HS:
        sel, nav, pr = [], [], []
        for x in cand:
            if x["h"] != h:
                continue
            hh = hists[x["item_id"]]
            k = hh["months"].index(x["cutoff"])
            if k + h >= len(hh["values"]):
                continue
            base, act = hh["values"][k], hh["values"][k + h]
            row = {"item": x["item_id"], "cutoff": x["cutoff"], "h": h, "base": base, "actual": act,
                   "p10": x["p10"], "p50": x["p50"], "p90": x["p90"], "prob_up": x["prob_up"]}
            if not (be.is_test(row) if split == "test" else
                    (be.is_train(row) and VAL[0] <= row["cutoff"] <= VAL[1])):
                continue
            sel.append(row)
            nav.append({**row, "p50": base})
            pr.append((x["prob_up"], x["prob_bigup"], act > base, act / base - 1 > 0.15,
                       x["prob_up"] >= 0.6 and x["p50"] / base - 1 >= 0.02))
        if not sel:
            continue
        m = be.metrics(sel, nav)
        if h == 6:
            m["big_move_recall"], m["n_big_moves"] = be.big_recall(sel)
        m["brier_up"] = round(sum((p - u) ** 2 for p, _, u, _, _ in pr) / len(pr), 4)
        m["brier_big"] = round(sum((b - g) ** 2 for _, b, _, g, _ in pr) / len(pr), 4)
        m["brier_big_clim"] = round(_clim_brier([g for *_, g, _ in pr]), 4)
        m["auc_big"] = _auc([b for _, b, *_ in pr], [g for *_, g, _ in pr])
        m["auc_up"] = _auc([p for p, *_ in pr], [u for _, _, u, _, _ in pr])
        flag = [b >= thr_big for _, b, *_ in pr]
        tp = sum(f and g for f, (*_, g, _) in zip(flag, pr))
        m["big_prec"] = round(tp / max(sum(flag), 1), 3)
        m["big_rec"] = round(tp / max(sum(g for *_, g, _ in pr), 1), 3)
        stock = [s for *_, s in pr]
        m["stockup_prec_up"] = round(sum(s and u for (_, _, u, _, s) in pr) / max(sum(stock), 1), 3)
        m["n_stockup"] = sum(stock)
        out[f"h{h}"] = m
    return out


_H = {}


def _hists():
    if not _H:
        _H.update(json.loads((CACHE / "histories.json").read_text()))
    return _H


def _clim_brier(g):
    p = sum(g) / max(len(g), 1)
    return p * (1 - p)


def _auc(p, y):
    pos = [a for a, b in zip(p, y) if b]
    neg = [a for a, b in zip(p, y) if not b]
    if not pos or not neg:
        return None
    s = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg)
    return round(s / (len(pos) * len(neg)), 3)


def val_objective(res):
    """Model selection on VALIDATION only: mean over h of (error ratio vs naive) + Brier terms + coverage gap."""
    tot = 0.0
    for h, m in res.items():
        tot += (1 - (m.get("skill") or 0)) + abs((m.get("coverage80") or 0) - 0.8) \
            + m["brier_up"] + m["brier_big"] * 2
    return tot / max(len(res), 1)


def run(mapper=None):
    panel = load_panel()
    tf = json.loads((CACHE / "timesfm.json").read_text())["results"]
    targets = {(k.split("|")[0], k.split("|")[1]) for k in tf}
    rows = build_rows(panel, targets)
    for r in rows:
        p = panel[r["s"]]
        r["base"] = p["values"][p["months"].index(r["t"])]
    print(f"panel {len(panel)} series, {len(rows)} feature rows, {len(targets)} target (item, cutoff)s")
    cuts = sorted({c for _, c in targets})
    slim = [{k: r[k] for k in ("f", "sig", "t", "tgt", "train", "y")} for r in rows]
    jobs = [{"rows": slim, "cutoffs": cuts[i::50]} for i in range(50)]
    import pickle

    fp = CACHE / "zoo_quant_fits.pkl"   # cache of the walk-forward fits (delete to refit)
    fits = pickle.loads(fp.read_bytes()) if fp.exists() else []
    if not fits:
        for res in (mapper or (lambda js: map(_fit_cutoff, js)))(jobs):
            fits += res
        fp.write_bytes(pickle.dumps(fits))
    for rec in fits:   # json round trip turns int h keys into str on Modal; normalise
        rec["h"] = int(rec["h"])
    print(f"walk-forward fits: {len(fits)} (cutoff, h) refits x {len(ALPHAS)} ridge + {2 * len(CLF)} classifiers")

    # ---- model selection on VALIDATION (coordinate search, cheap: everything is precomputed)
    hp = {"alpha": ALPHAS[1], "band3": 1.0, "band6": 1.0, "band12": 1.0, "clf_up": "logit|3.0",
          "clf_big": "logit|3.0", "a_up": 1.0, "b_up": 0.0, "a_big": 1.0, "b_big": 0.0}
    bands = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.45, 1.6]
    grid = {"alpha": ALPHAS, "band3": bands, "band6": bands, "band12": bands,
            "clf_up": [f"{k}|{l}" for k, l in CLF], "clf_big": [f"{k}|{l}" for k, l in CLF],
            "a_up": [0.5, 0.75, 1.0, 1.25], "b_up": [0.0],
            "a_big": [1.0], "b_big": [0.0]}  # raw: any Platt fitted on the 2020-22 boom inflates the base rate

    def vobj(p):
        c = assemble(rows, [f for f in fits if VAL[0] <= f["cutoff"] <= VAL[1]], p)
        return val_objective(score(c["quant_tsmom"], "val")) + val_objective(score(c["bigmove_clf"], "val"))

    for _ in range(2):
        for k, opts in grid.items():
            hp[k] = min(opts, key=lambda o: vobj({**hp, k: o}))
    cand = assemble(rows, fits, hp)
    # big-move alert threshold: best F1 on validation
    vb = [x for x in assemble(rows, [f for f in fits if VAL[0] <= f["cutoff"] <= VAL[1]], hp)["bigmove_clf"] if x["h"] == 6]
    thr = max([0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5], key=lambda t: _youden(vb, t))
    print("validation-picked hyper-params:", hp, " big-move threshold", thr)

    CAND.mkdir(parents=True, exist_ok=True)
    desc = {"quant_tsmom": "Pooled ridge (walk-forward, 39-series commodity panel) on vol-scaled TSMOM / MA / breakout / "
                           "5y z-score / vol-regime / satellite features -> expected h-month log return; bands and "
                           "P(up)/P(>15%) from empirical standardised residuals x val-tuned band scale",
            "bigmove_clf": "Pooled walk-forward classifiers (val-picked logistic / LightGBM + Platt temperature) for "
                           "P(up) and P(rise > 15%); p50 = naive, bands = vol-scaled empirical return quantiles"}
    report = {"hyper_params": hp, "big_threshold": thr}
    for name, rws in cand.items():
        rws.sort(key=lambda x: (x["item_id"], x["cutoff"], x["h"]))
        rr = [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in x.items()} for x in rws]
        (CAND / f"{name}.json").write_text(json.dumps({"name": name, "description": desc[name], "hyper_params": hp,
                                                       "big_threshold": thr, "rows": rr}))
        report[name] = {"val": score(rws, "val", thr), "test": score(rws, "test", thr)}
    (CACHE / "zoo_quant_report.json").write_text(json.dumps(report, indent=1))
    keys = ["mape", "skill", "dir_acc", "coverage80", "big_move_recall", "brier_up", "brier_big", "brier_big_clim",
            "auc_up", "auc_big", "big_prec", "big_rec", "stockup_prec_up", "n_stockup", "n"]
    for name in cand:
        for sp in ("val", "test"):
            for h in ("h3", "h6", "h12"):
                m = report[name][sp].get(h, {})
                print(f"{name:12s} {sp:4s} {h:3s} " + " ".join(f"{k}={m.get(k)}" for k in keys))


def _youden(rws, t):
    """TPR - FPR of the 'big rise' alert at threshold t on validation h6 rows (flag-everything scores 0)."""
    h = _hists()
    lab = []
    for x in rws:
        hh = h[x["item_id"]]
        k = hh["months"].index(x["cutoff"])
        if k + 6 < len(hh["values"]) and add_months(x["cutoff"], 6) <= "2022-12" and VAL[0] <= x["cutoff"] <= VAL[1]:
            lab.append((x["prob_bigup"] >= t, hh["values"][k + 6] / hh["values"][k] - 1 > 0.15))
    pos = [f for f, g in lab if g]
    neg = [f for f, g in lab if not g]
    return sum(pos) / max(len(pos), 1) - sum(neg) / max(len(neg), 1)


@app.local_entrypoint()
def main():
    run(fit_chunk.map)


if __name__ == "__main__":
    run()
