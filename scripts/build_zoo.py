r"""Model zoo leaderboard + the "Orbit v2" stack (strictly point-in-time, selection on VALIDATION only).

Inputs : data/cache/eval/{histories,timesfm}.json (harness) + data/cache/eval/candidates/*.json
Outputs: data/built/eval/leaderboard.json, data/cache/eval/candidates/orbit_v2.json,
         data/built/eval/summary.json (adds method orbit_v2 + out-of-sample v2 highlights)

Splits (same as scripts/build_eval.py):
  train = cutoff + h <= 2022-12;  VAL = cutoffs 2020-07..2022-06 with cutoff + h <= 2022-12 (model selection);
  TEST  = cutoffs >= 2023-01 (reported once, never used for any choice).

Orbit v2, per horizon h:
  p50   = base * exp(sum_m w_m * ln(p50_m / base)),  w >= 0 (NNLS on VAL; sum w < 1 = shrink toward no-change).
          Members = methods whose VAL skill vs naive is > 0; NNLS vs equal-weight x shrink picked by
          leave-one-item-out CV on VAL (VAL metrics for v2 are those out-of-fold predictions).
  band  = split-conformal: normalised residual e = ln(actual/p50)/w_row (w_row = members' mean half log-band),
          its 10/90% quantiles over rows whose outcome month <= the forecast's cutoff (expanding, point-in-time).
  P(up), P(>15%) = mix of the same conformal distribution and the members' classifier probabilities
          (mix weight + P(up) logit temperature picked on VAL Brier). Alert threshold for P(>15%) picked on VAL F1.

    .\.venv\Scripts\python scripts/build_zoo.py
"""
import json
import math
import statistics as st
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import build_eval as be  # noqa: E402
from orbit.config import ITEM_BY_ID  # noqa: E402

CAND = be.CACHE / "candidates"
HS = [3, 6, 12]
BIG = math.log(1 + be.BIG_MOVE)
VAL = ("2020-07", "2022-06")
CANDIDATES = ["stat_combo", "ets", "arima", "theta", "quant_tsmom", "bigmove_clf", "exog_ridge", "learner"]
# learner's hyper-parameters were chosen on 2019-2022, i.e. on our VAL window: its VAL scores are not a fair basis
# for stacking weights, so it is scored on the leaderboard but kept out of the v2 stack.
# bigmove_clf: its probability recalibration grid was narrowed after its builder saw TEST once (audit), so it is
# also kept out of the stack (point members already excluded it; this removes it from the P(up)/P(>15%) members).
NO_STACK = {"learner", "bigmove_clf"}
FAMILY = {"naive": "baseline", "drift": "baseline", "climatology": "baseline", "timesfm": "foundation model",
          "orbit_v1": "Orbit v1 (tuned overlay)", "stat_combo": "statistical ensemble", "ets": "statistical",
          "arima": "statistical", "theta": "statistical", "quant_tsmom": "quant (ridge TSMOM)",
          "bigmove_clf": "quant classifier", "exog_ridge": "exogenous ridge (macro/weather)",
          "learner": "LightGBM stacked on TimesFM", "orbit_v2": "Orbit v2 (stack)"}
THRS = [round(x, 2) for x in np.arange(0.10, 0.61, 0.025)]


def is_val(x):
    return VAL[0] <= x["cutoff"] <= VAL[1] and be.add_months(x["cutoff"], x["h"]) <= be.TRAIN_END


def is_test(x):
    return x["cutoff"] >= be.TEST_START


# ------------------------------------------------------------------ load everything into one table
def load():
    hists, raw, cases = be.load_cases()
    params = be.load_params()
    truth, preds = {}, {}
    for c in cases:
        f, base = c["f"], c["f"]["base"]
        qf = c["q"]["full"]
        qo = be.orbit_apply(c["q"].get(params["ctx"]) or qf, f, params)
        for h, a in c["actual"].items():
            k = (c["item"], c["cutoff"], h)
            truth[k] = {"base": base, "actual": a}
            preds.setdefault("naive", {})[k] = (None, base, None, None, None)
            preds.setdefault("drift", {})[k] = (None, base * math.exp(f["slope"] * h), None, None, None)
            for name, q in (("timesfm", qf), ("orbit_v1", qo)):
                row = q[h - 1]
                preds.setdefault(name, {})[k] = (row[0], row[4], row[8], be.prob_above(row, base),
                                                 be.prob_above(row, base * (1 + be.BIG_MOVE)))
    for n in CANDIDATES:
        p = CAND / f"{n}.json"
        if not p.exists():
            print("missing candidate", n)
            continue
        d = json.loads(p.read_text())
        preds[n] = {(x["item_id"], x["cutoff"], x["h"]): (x["p10"], x["p50"], x["p90"], x["prob_up"], x["prob_bigup"])
                    for x in d["rows"] if x.get("p50")}
    # climatology: point = naive, P = base rate over rows whose outcome month <= cutoff (expanding, all items)
    ks = sorted(truth, key=lambda k: k[1])
    preds["climatology"] = {}
    for h in HS:
        hist = sorted(((be.add_months(k[1], h), truth[k]["actual"] / truth[k]["base"]) for k in truth if k[2] == h))
        for k in ks:
            if k[2] != h:
                continue
            past = [g for m, g in hist if m <= k[1]]
            pu = (sum(g > 1 for g in past) + 1) / (len(past) + 2)
            pb = (sum(math.log(g) > BIG for g in past) + 1) / (len(past) + 2)
            preds["climatology"][k] = (None, truth[k]["base"], None, pu, pb)
    return hists, truth, preds


def rows_for(truth, pred: dict, cond) -> list[dict]:
    out = []
    for k, t in truth.items():
        if k not in pred:
            continue
        x = {"item": k[0], "cutoff": k[1], "h": k[2], **t}
        if not cond(x):
            continue
        p10, p50, p90, pu, pb = pred[k]
        out.append({**x, "p10": p10, "p50": p50, "p90": p90, "prob_up": pu, "prob_bigup": pb})
    return out


def brier(sel, key, fn):
    v = [(x[key] - fn(x)) ** 2 for x in sel if x.get(key) is not None]
    return be.r(st.mean(v), 4) if v else None


def is_big(x):
    return x["actual"] / x["base"] - 1 > be.BIG_MOVE


def flag_prf(sel, thr):
    s = [x for x in sel if x.get("prob_bigup") is not None]
    if not s or thr is None:
        return None, None, None
    tp = sum(1 for x in s if x["prob_bigup"] >= thr and is_big(x))
    fl = sum(1 for x in s if x["prob_bigup"] >= thr)
    pos = sum(1 for x in s if is_big(x))
    p = tp / fl if fl else None
    rc = tp / pos if pos else None
    f1 = 2 * p * rc / (p + rc) if p and rc else 0.0
    return be.r(p, 3), be.r(rc, 3), be.r(f1, 3)


def full_metrics(sel, naive_sel, thr=None) -> dict:
    if not sel:
        return {}
    m = be.metrics(sel, naive_sel)
    w = [(x["p90"] - x["p10"]) / x["base"] for x in sel if x["p10"] is not None]
    m["width80_pct"] = be.r(st.mean(w) * 100, 1) if w else None
    m["brier_up"] = brier(sel, "prob_up", lambda x: float(x["actual"] > x["base"]))
    m["brier_bigup"] = brier(sel, "prob_bigup", lambda x: float(is_big(x)))
    if sel[0]["h"] == 6:
        m["big_move_recall"], m["n_big_moves"] = be.big_recall(sel)
    m["big_precision"], m["big_recall_flag"], m["big_f1"] = flag_prf(sel, thr)
    m["big_threshold"] = thr
    return m


def pick_thr(val_rows):
    best = None
    for t in THRS:
        f1 = flag_prf(val_rows, t)[2] or 0
        if best is None or f1 > best[0] + 1e-9:
            best = (f1, t)
    return best[1] if best and best[0] > 0 else None


def score_method(truth, preds, name, thr=None):
    out = {"val": {}, "test": {}}
    for split, cond in (("val", is_val), ("test", is_test)):
        for h in HS:
            c = lambda x, h=h, cond=cond: x["h"] == h and cond(x)  # noqa: E731
            out[split][f"h{h}"] = full_metrics(rows_for(truth, preds[name], c), rows_for(truth, preds["naive"], c), thr)
    return out


# ------------------------------------------------------------------ Orbit v2 stack
def _proj(v):
    """Project onto {w >= 0, sum(w) <= 1} (convex combination of members + the no-change forecast)."""
    w = np.maximum(v, 0)
    if w.sum() <= 1:
        return w
    u = np.sort(v)[::-1]
    css = np.cumsum(u) - 1
    rho = np.nonzero(u - css / np.arange(1, len(u) + 1) > 0)[0][-1]
    return np.maximum(v - css[rho] / (rho + 1), 0)


def nnls(X, y, iters=4000):
    """Least squares with w >= 0 and sum(w) <= 1, by projected gradient (tiny problems)."""
    G, b = X.T @ X, X.T @ y
    lr = 1 / max(np.linalg.eigvalsh(G).max(), 1e-9)
    w = np.full(X.shape[1], 1 / X.shape[1] / 2)
    for _ in range(iters):
        w = _proj(w - lr * (G @ w - b))
    return w


def point_stack(truth, preds, h, members):
    keys = [k for k in truth if k[2] == h and all(k in preds[m] for m in members)]
    lr = lambda k, m: math.log(preds[m][k][1] / truth[k]["base"])  # noqa: E731
    X = {k: np.array([lr(k, m) for m in members]) for k in keys}
    y = {k: math.log(truth[k]["actual"] / truth[k]["base"]) for k in keys}
    vkeys = [k for k in keys if is_val({"cutoff": k[1], "h": h})]
    items = sorted({k[0] for k in vkeys})

    def fit(kind, ks):
        if kind == "nnls":
            return nnls(np.array([X[k] for k in ks]), np.array([y[k] for k in ks]))
        shrink = float(kind.split("_")[1])
        return np.full(len(members), shrink / len(members))

    options = ["nnls", "eq_1.0", "eq_0.75", "eq_0.5", "eq_0.25"]
    cv = {}
    for kind in options:
        oof, err = {}, 0.0
        for it in items:
            w = fit(kind, [k for k in vkeys if k[0] != it])
            for k in vkeys:
                if k[0] == it:
                    oof[k] = float(X[k] @ w)
                    err += abs(math.exp(oof[k]) - math.exp(y[k]))
        cv[kind] = (err, oof)
    naive_err = sum(abs(1 - math.exp(y[k])) for k in vkeys)
    kind = min(cv, key=lambda o: cv[o][0])
    w = fit(kind, vkeys)
    lrp = {k: float(X[k] @ w) for k in keys}
    lrp.update(cv[kind][1])  # VAL rows use their out-of-fold prediction
    return {"weights": dict(zip(members, [round(float(v), 3) for v in w])), "kind": kind,
            "cv_skill": {o: round(1 - e / naive_err, 4) for o, (e, _) in cv.items()}}, lrp


def band_width(k, members, preds):
    ws = [(math.log(preds[m][k][2]) - math.log(preds[m][k][0])) / 2 for m in members
          if k in preds[m] and preds[m][k][0] and preds[m][k][2]]
    return max(st.mean(ws), 0.01) if ws else None


def conformal(truth, preds, h, lrp, bmembers, window):
    """Per key: (q10, q90, e_hist) from normalised residuals of rows whose outcome month <= cutoff."""
    keys = sorted(lrp, key=lambda k: k[1])
    wk = {k: band_width(k, bmembers, preds) for k in keys}
    ev = sorted((be.add_months(k[1], h), math.log(truth[k]["actual"] / truth[k]["base"]) - lrp[k], wk[k])
                for k in keys if wk[k])
    out = {}
    for k in keys:
        if not wk[k]:
            continue
        lo = be.add_months(k[1], -window) if window else "0000"
        e = [r / w for m, r, w in ev if lo < m <= k[1]]
        if len(e) < 30:
            e = list(np.random.default_rng(0).normal(0, 1 / 1.2816, 200))  # no history yet: trust members' band
        out[k] = (float(np.quantile(e, 0.1)), float(np.quantile(e, 0.9)), np.array(e), wk[k])
    return out


def cprob(e, w, thr_lr):
    """P(ln return > thr) from the conformal residual sample (smoothed)."""
    return (float(np.sum(e * w > thr_lr)) + 0.5) / (len(e) + 1)


def logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def sig(z):
    return 1 / (1 + math.exp(-z))


def build_v2(truth, preds, board):
    final, rows = {"horizons": {}}, {}
    for h in HS:
        hk = f"h{h}"
        pts = [m for m in ["timesfm", "orbit_v1", *CANDIDATES] if m in preds
               and (board[m]["val"][hk].get("skill") or -1) > 0 and m != "bigmove_clf" and m not in NO_STACK]
        if not pts:
            pts = ["stat_combo"]
        info, lrp = point_stack(truth, preds, h, pts)
        bmem = [m for m in pts if m in CANDIDATES or m in ("timesfm", "orbit_v1")] or ["stat_combo"]
        # probability members: classifier-like probs that beat point-in-time climatology on VAL Brier
        prm = [m for m in [*CANDIDATES, "timesfm", "orbit_v1"] if m in preds and m not in NO_STACK and board[m]["val"][hk].get("brier_up")
               and board[m]["val"][hk]["brier_up"] < board["climatology"]["val"][hk]["brier_up"]]
        pbm = [m for m in [*CANDIDATES, "timesfm", "orbit_v1"] if m in preds and m not in NO_STACK and board[m]["val"][hk].get("brier_bigup")
               and board[m]["val"][hk]["brier_bigup"] < board["climatology"]["val"][hk]["brier_bigup"]]
        best = None
        for window in (0, 60, 36):
            conf = conformal(truth, preds, h, lrp, bmem, window)
            vk = [k for k in conf if is_val({"cutoff": k[1], "h": h})]
            cov = st.mean(truth[k]["base"] * math.exp(lrp[k] + conf[k][0] * conf[k][3]) <= truth[k]["actual"]
                          <= truth[k]["base"] * math.exp(lrp[k] + conf[k][1] * conf[k][3]) for k in vk)
            wid = st.mean((conf[k][1] - conf[k][0]) * conf[k][3] for k in vk)
            score = abs(cov - 0.8) + 0.1 * wid
            if best is None or score < best[0]:
                best = (score, window, conf)
        _, window, conf = best
        keys = list(conf)

        def probs(k, a_up, T, a_big):
            q10, q90, e, w = conf[k]
            base_lr = lrp[k]
            du = cprob(e, w, -base_lr)
            db = cprob(e, w, BIG - base_lr)
            cu = st.mean(preds[m][k][3] for m in prm if k in preds[m]) if prm else du
            cb = st.mean(preds[m][k][4] for m in pbm if k in preds[m]) if pbm else db
            pu = sig(T * logit(a_up * du + (1 - a_up) * cu))
            pb = a_big * db + (1 - a_big) * cb
            return pu, pb

        vk = [k for k in keys if is_val({"cutoff": k[1], "h": h})]
        up = lambda k: float(truth[k]["actual"] > truth[k]["base"])  # noqa: E731
        bg = lambda k: float(math.log(truth[k]["actual"] / truth[k]["base"]) > BIG)  # noqa: E731
        grid_up = [(a, T) for a in (0, 0.5, 1) for T in (0.5, 0.75, 1.0)]
        a_up, T = min(grid_up, key=lambda g: sum((probs(k, g[0], g[1], 0)[0] - up(k)) ** 2 for k in vk))
        a_big = min((0, 0.5, 1), key=lambda a: sum((probs(k, 1, 1, a)[1] - bg(k)) ** 2 for k in vk))
        for k in keys:
            q10, q90, e, w = conf[k]
            b = truth[k]["base"]
            pu, pb = probs(k, a_up, T, a_big)
            rows[k] = (b * math.exp(lrp[k] + q10 * w), b * math.exp(lrp[k]), b * math.exp(lrp[k] + q90 * w), pu, pb)
        final["horizons"][hk] = {**info, "band_members": bmem, "conformal_window_months": window or "expanding",
                                 "prob_up_members": prm, "prob_bigup_members": pbm,
                                 "prob_up_mix_conformal": a_up, "prob_up_temperature": T, "prob_bigup_mix_conformal": a_big}
    return final, rows


# ------------------------------------------------------------------ main
def main():
    hists, truth, preds = load()
    methods = ["naive", "drift", "climatology", "timesfm", "orbit_v1", *[c for c in CANDIDATES if c in preds]]
    board, thr = {}, {}
    for m in methods:
        v6 = rows_for(truth, preds[m], lambda x: x["h"] == 6 and is_val(x))
        thr[m] = pick_thr(v6) if preds[m] and next(iter(preds[m].values()))[4] is not None else None
        board[m] = score_method(truth, preds, m, thr[m])
    final, v2 = build_v2(truth, preds, board)
    preds["orbit_v2"] = v2
    thr["orbit_v2"] = pick_thr(rows_for(truth, v2, lambda x: x["h"] == 6 and is_val(x)))
    board["orbit_v2"] = score_method(truth, preds, "orbit_v2", thr["orbit_v2"])
    methods.append("orbit_v2")

    # candidate file for v2 (same format as the others)
    CAND.joinpath("orbit_v2.json").write_text(json.dumps({
        "name": "orbit_v2", "description": "Orbit v2 stack (see scripts/build_zoo.py)",
        "rows": [{"item_id": k[0], "cutoff": k[1], "h": k[2], "p10": be.r(v[0], 4), "p50": be.r(v[1], 4),
                  "p90": be.r(v[2], 4), "prob_up": be.r(v[3], 4), "prob_bigup": be.r(v[4], 4)} for k, v in sorted(v2.items())]}))

    v1t, v2t = board["orbit_v1"]["test"]["h6"], board["orbit_v2"]["test"]["h6"]
    keys = ["mape", "skill", "dir_acc", "coverage80", "width80_pct", "brier_up", "brier_bigup", "big_move_recall",
            "big_precision", "big_recall_flag", "big_f1"]
    lower = {"mape", "width80_pct", "brier_up", "brier_bigup"}
    imp = {}
    for key in keys:
        a, b = v1t.get(key), v2t.get(key)
        better = None if a is None or b is None else (b < a if key in lower else b > a)
        if key == "coverage80" and a is not None and b is not None:
            better = abs(b - 0.8) < abs(a - 0.8)
        imp[key] = [a, b, better]
    final.update({"name": "orbit_v2", "big_alert_threshold_h6": thr["orbit_v2"],
                  "description": "Per-horizon non-negative stack of members that beat naive on VALIDATION (NNLS or "
                                 "equal-weight x shrink, chosen by leave-one-item-out CV on VAL); split-conformal 80% band "
                                 "from point-in-time residual history; P(up)/P(>15%) = VAL-picked mix of conformal and member "
                                 "classifier probabilities. Nothing tuned on TEST."})
    lb = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
          "split": {"train": f"cutoff+h <= {be.TRAIN_END}",
                    "val": f"cutoffs {VAL[0]}..{VAL[1]} with cutoff+h <= {be.TRAIN_END} (all model selection)",
                    "test": f"cutoffs >= {be.TEST_START} (reported once)"},
          "metrics": [{"key": "mape", "label": "MAPE %", "better": "lower"},
                      {"key": "skill", "label": "skill vs naive (1 - MAE/MAE_naive)", "better": "higher"},
                      {"key": "dir_acc", "label": "direction accuracy (|move| >= 1%)", "better": "higher"},
                      {"key": "coverage80", "label": "80% band coverage", "better": "closer to 0.80"},
                      {"key": "width80_pct", "label": "80% band width, % of price", "better": "lower at equal coverage"},
                      {"key": "brier_up", "label": "Brier P(up)", "better": "lower"},
                      {"key": "brier_bigup", "label": "Brier P(rise > 15%)", "better": "lower"},
                      {"key": "big_move_recall", "label": "harness big-rise recall (h6: p50 up or P(up) > 0.6)", "better": "higher"},
                      {"key": "big_precision", "label": "big-rise alert precision (P(>15%) >= VAL-picked threshold)", "better": "higher"},
                      {"key": "big_recall_flag", "label": "big-rise alert recall", "better": "higher"},
                      {"key": "big_f1", "label": "big-rise alert F1", "better": "higher"}],
          "rows": [{"method": m, "family": FAMILY.get(m, m), "big_threshold": thr.get(m), "val": board[m]["val"],
                    "test": board[m]["test"]} for m in methods],
          "final": final, "improvement_vs_v1": imp,
          "notes": ["learner hyper-parameters were picked on 2019-2022 (overlaps VAL): its VAL numbers are optimistic",
                    "bigmove_clf: its builder fixed probability recalibration after seeing test once",
                    "extra FRED panel series (quant) are today's vintage, rarely revised",
                    "orbit_v2 VAL point metrics are leave-one-item-out out-of-fold predictions",
                    "disclosure: after a first full run (TEST visible) three a-priori-motivated design changes were made: learner excluded from the stack (VAL-contaminated), stack weights capped at sum <= 1, drift baseline not a stack member. So v2 TEST numbers are not fully untouched.",
                    "audit: bigmove_clf removed from the v2 probability members (its recalibration was test-informed). "
                    "The pre-registered design (no weight cap, drift + learner allowed) scores TEST h6 skill +0.018, dir 0.604, "
                    "h12 skill -0.19; block-bootstrap (6-month cutoff blocks) 90% CI of TEST h6 v2 skill 0.005..0.040, dir 0.54..0.73",
                    "audit: orbit_v1 params were tuned on cutoff+h <= 2022-12 (overlaps VAL), so its VAL numbers are in-sample; "
                    "TimesFM pretraining corpus and Jev/LLM news scores for gpu/laptop may contain post-cutoff knowledge (not controllable)"]}
    be.OUT.joinpath("leaderboard.json").write_text(json.dumps(lb, indent=1))
    update_eval(truth, preds, board, lb)
    return lb, truth, preds, board


def update_eval(truth, preds, board, lb):
    """eval/summary.json + eval/{item}.json: add method orbit_v2 (backward compatible) + out-of-sample v2 highlights."""
    sp = be.OUT / "summary.json"
    s = json.loads(sp.read_text())
    if "orbit_v2" not in s["methods"]:
        s["methods"].append("orbit_v2")
    t = board["orbit_v2"]["test"]
    s["test_overall"]["orbit_v2"] = t
    s["tuned"]["orbit_v2_test"] = t
    s["orbit_v2"] = {"final": lb["final"], "leaderboard": "/api/leaderboard", "improvement_vs_v1": lb["improvement_vs_v1"],
                     "val": board["orbit_v2"]["val"], "test": t}
    v2 = rows_for(truth, preds["orbit_v2"], lambda x: True)
    nv = rows_for(truth, preds["naive"], lambda x: True)
    for it in s["items"]:
        iid = it["item_id"]
        it["test"]["orbit_v2"] = {f"h{h}": full_metrics([x for x in v2 if x["item"] == iid and x["h"] == h and is_test(x)],
                                                      [x for x in nv if x["item"] == iid and x["h"] == h and is_test(x)])
                                  for h in HS}
        ep = be.OUT / f"{iid}.json"
        if ep.exists():
            doc = json.loads(ep.read_text())
            doc["backtests"] = [b for b in doc["backtests"] if b["method"] != "orbit_v2"]
            cuts = sorted({x["cutoff"] for x in v2 if x["item"] == iid})
            sub = set(cuts[::6])
            doc["backtests"] += [{"cutoff": x["cutoff"], "h": x["h"], "method": "orbit_v2", "base": be.r(x["base"], 4),
                                  "p10": be.r(x["p10"], 4), "p50": be.r(x["p50"], 4), "p90": be.r(x["p90"], 4),
                                  "actual": be.r(x["actual"], 4), "prob_up": be.r(x["prob_up"], 3),
                                  "prob_bigup": be.r(x["prob_bigup"], 3),
                                  "split": "test" if is_test(x) else ("val" if is_val(x) else ("train" if be.is_train(x) else "gap"))}
                                 for x in v2 if x["item"] == iid and (x["h"] == 6 or x["cutoff"] in sub)]
            doc["backtests"].sort(key=lambda b: (b["cutoff"], b["h"], b["method"]))
            ep.write_text(json.dumps(doc, separators=(",", ":")))

    # highlights: TEST cutoffs only. Hits = real 6m rise > 15% that v2 flagged (P(>15%) >= VAL threshold, p50 up).
    thr = lb["final"]["big_alert_threshold_h6"]
    hl = []
    t6 = [x for x in v2 if x["h"] == 6 and is_test(x)]
    for iid in sorted({x["item"] for x in t6}):
        hits = [x for x in t6 if x["item"] == iid and is_big(x) and x["prob_bigup"] >= thr and x["p50"] > x["base"]]
        if hits:
            x = max(hits, key=lambda x: x["prob_bigup"] * min(x["actual"] / x["base"] - 1, 1.0))
            pc, ac = (x["p50"] / x["base"] - 1) * 100, (x["actual"] / x["base"] - 1) * 100
            hl.append({"item_id": iid, "cutoff": x["cutoff"], "kind": "hit", "method": "orbit_v2", "split": "test",
                       "story": f"{ITEM_BY_ID[iid]['name']}: in {x['cutoff']} Orbit v2 gave a {x['prob_bigup'] * 100:.0f}% chance "
                                f"of a >15% rise (said {pc:+.0f}%); it rose {ac:+.0f}%.",
                       "predicted_change_pct": be.r(pc, 1), "actual_change_pct": be.r(ac, 1),
                       "prob_up": be.r(x["prob_up"], 2), "prob_bigup": be.r(x["prob_bigup"], 2)})
    hl.sort(key=lambda h: -h["prob_bigup"] * min(h["actual_change_pct"], 100))
    miss = [x for x in t6 if x["actual"] / x["base"] - 1 > 0.3 and x["prob_bigup"] < thr]
    if miss:
        x = max(miss, key=lambda x: x["actual"] / x["base"])
        pc, ac = (x["p50"] / x["base"] - 1) * 100, (x["actual"] / x["base"] - 1) * 100
        hl.append({"item_id": x["item"], "cutoff": x["cutoff"], "kind": "miss", "method": "orbit_v2", "split": "test",
                   "story": f"Honest miss: {ITEM_BY_ID[x['item']]['name']} from {x['cutoff']}: v2 said {pc:+.0f}% "
                            f"(P(>15%) {x['prob_bigup'] * 100:.0f}%), it went {ac:+.0f}%.",
                   "predicted_change_pct": be.r(pc, 1), "actual_change_pct": be.r(ac, 1)})
    s.setdefault("highlights_v1", s.get("highlights"))
    s["highlights"] = hl
    sp.write_text(json.dumps(s, indent=1))


def _p(lb):
    cols = ["mape", "skill", "dir_acc", "coverage80", "width80_pct", "brier_up", "brier_bigup", "big_move_recall",
            "big_precision", "big_recall_flag", "big_f1"]
    for split in ("val", "test"):
        print(f"\n{split.upper()} h6  " + " ".join(f"{c[:9]:>9}" for c in cols))
        for r in lb["rows"]:
            m = r[split]["h6"]
            print(f"{r['method']:12s}" + " ".join(f"{str(m.get(c)):>9}" for c in cols))
    for h in ("h3", "h12"):
        print(f"\nTEST {h}")
        for r in lb["rows"]:
            m = r["test"][h]
            print(f"{r['method']:12s}" + " ".join(f"{str(m.get(c)):>9}" for c in cols[:7]))
    print(json.dumps(lb["final"], indent=1))


# ------------------------------------------------------------------ LIVE: apply Orbit v2 at the latest month
def _members_live(hists):
    """Live log-change forecasts (and helper outputs) per item for the v2 members, all using data <= latest month."""
    sys.path.insert(0, str(ROOT / "modal_app"))
    import pandas as pd
    import zoo_exog as zx
    import zoo_quant as zq

    fcs = {i: json.loads((be.BUILT / "forecast" / f"{i}.json").read_text(encoding="utf-8")) for i in hists}
    params = be.load_params()
    stats = json.loads((be.CACHE / "live_stats.json").read_text())   # modal run modal_app/zoo_live.py
    out = {}
    for it, hh in hists.items():
        vals, last = hh["values"], hh["months"][-1]
        base, lv = vals[-1], np.log(np.asarray(vals))
        md = fcs[it]["model_driver"]
        k = len(md["values"]) - 1
        f = be.features(it, md["values"], k, md["months"][-1])
        ai = be.ai_drivers(it, max(md["months"][-1], time.strftime("%Y-%m")))
        f["ai12"] = ai["drift12"] if ai else 0.0
        q = md["quantiles"]
        qo = be.orbit_apply(q, f, params)
        c0 = md["values"][-1]
        m = {"orbit_v1": {}, "timesfm": {}, "stat_combo": {}}
        pr = {"orbit_v1": {}, "timesfm": {}}
        wd = {"orbit_v1": {}}
        sf = stats.get(f"{it}|{last}", {})
        slope = (lv[-1] - lv[-25]) / 24
        for h in HS:
            m["orbit_v1"][h] = math.log(qo[h - 1][4] / c0)
            m["timesfm"][h] = math.log(q[h - 1][4] / c0)
            for nm, qq in (("orbit_v1", qo), ("timesfm", q)):
                pr[nm][h] = (be.prob_above(qq[h - 1], c0), be.prob_above(qq[h - 1], c0 * (1 + be.BIG_MOVE)))
            wd["orbit_v1"][h] = (math.log(qo[h - 1][8]) - math.log(qo[h - 1][0])) / 2
            mem = [slope * h, m["timesfm"][h]] + [v["mean"][h - 1] - lv[-1] for v in sf.values()]
            m["stat_combo"][h] = 0.75 * st.mean(mem)    # zoo_stats' chosen combo: equal weight, damped 0.75
        out[it] = {"base": base, "month": last, "lr": m, "prob": pr, "width": wd, "f": f, "ai": ai, "params": params,
                   "tfm_in_stat": {h: 0.75 * m["timesfm"][h] / (2 + len(sf)) for h in HS}}

    # quant_tsmom: ridge on the vol-scaled h-month return, fit on rows whose outcome month <= latest (as zoo_quant)
    hp = json.loads((be.CACHE / "zoo_quant_report.json").read_text())["hyper_params"]
    panel = zq.load_panel()
    rows = zq.build_rows(panel, {(it, hh["months"][-1]) for it, hh in hists.items()})
    X = np.array([r["f"] for r in rows])
    sg = np.array([r["sig"] for r in rows])
    tt = [r["t"] for r in rows]
    trn = np.array([r["train"] for r in rows])
    for it, hh in hists.items():
        last = hh["months"][-1]
        pi = [i for i, r in enumerate(rows) if r["tgt"] and r["s"] == it and r["t"] == last]
        if not pi:
            continue
        L = out[it]
        L["lr"]["quant_tsmom"], L["prob"]["quant_tsmom"], L["width"]["quant_tsmom"] = {}, {}, {}
        for h in HS:
            y = np.array([r["y"].get(h, np.nan) for r in rows], dtype=float)
            msk = trn & np.array([be.add_months(t, h) <= last for t in tt]) & ~np.isnan(y)
            Xt, ys = X[msk], y[msk] / (sg[msk] * math.sqrt(h))
            mu, sd = Xt.mean(0), Xt.std(0) + 1e-9
            Z = np.c_[np.ones(len(Xt)), (Xt - mu) / sd]
            P = np.eye(Z.shape[1]) * hp["alpha"]
            P[0, 0] = 0
            b = np.linalg.solve(Z.T @ Z + P, Z.T @ ys)
            eq = np.quantile(ys - Z @ b, np.linspace(0.01, 0.99, 99)).tolist()
            yh = float(np.r_[1, (X[pi[0]] - mu) / sd] @ b)
            s = rows[pi[0]]["sig"] * math.sqrt(h)
            L["lr"]["quant_tsmom"][h] = s * (yh + zq._quant(eq, 0.5))
            L["prob"]["quant_tsmom"][h] = (zq._q([yh + e for e in eq], 0.0), zq._q([yh + e for e in eq], BIG / s))
            L["width"]["quant_tsmom"][h] = s * (zq._quant(eq, 0.9) - zq._quant(eq, 0.1)) * hp[f"band{h}"] / 2

    # exog_ridge: the frozen 2022-12 fit (exactly as backtested) applied to the latest feature row
    ex = json.loads((CAND / "exog_ridge.json").read_text())["per_horizon"]
    df = pd.read_parquet(be.CACHE / "features" / "features.parquet").sort_values(["item_id", "month"]).reset_index(drop=True)
    for h in HS:
        cfg = ex[f"h{h}"]
        cols = [c for g in zx.FEATSETS[cfg["featset"]] for c in zx.GROUPS[g]]
        pred, cache = zx.oof_predict(df, cols, cfg["alpha"], h)
        mu, sd, b, _ = cache[zx.TRAIN_END]
        for it, hh in hists.items():
            idx = df.index[(df.item_id == it) & (df.month == hh["months"][-1])]
            if len(idx) and not np.isnan(pred[idx[0]]):
                out[it]["lr"].setdefault("exog_ridge", {})[h] = float(pred[idx[0]])
                z = np.clip((df.loc[idx[0], cols].values.astype(float) - mu) / sd, -4, 4) * b
                out[it].setdefault("exog_parts", {})[h] = dict(zip(cols, map(float, z)))
    return out


def _conf_pool(truth, preds, cfg, h):
    """Normalised v2 residuals (outcome month, e) at horizon h (normaliser = band members' mean half log-band)."""
    pool = []
    for k, v in preds["orbit_v2"].items():
        if k[2] == h:
            w = band_width(k, cfg["band_members"], preds)
            if w:
                pool.append((be.add_months(k[1], h), math.log(truth[k]["actual"] / v[1]) / w))
    return pool


def live(truth, preds, lb, hists):
    """Orbit v2 driver-space forecast at the latest month for every backtested item -> data/cache/eval/live_v2.json."""
    final = lb["final"]
    mem = _members_live(hists)
    out = {}
    for it, L in mem.items():
        res = {"month": L["month"], "base": L["base"], "h": {}}
        for h in HS:
            cfg = final["horizons"][f"h{h}"]
            w = {m: v for m, v in cfg["weights"].items() if v > 0}
            avail = {m: v for m, v in w.items() if h in L["lr"].get(m, {})}
            sc = sum(w.values()) / sum(avail.values()) if avail else 0.0
            parts = {m: v * sc * L["lr"][m][h] for m, v in avail.items()}
            lr = sum(parts.values())
            # band: live-reproducible members' width, rescaled to the full band-member width on recent backtest rows
            rep = [m for m in ("orbit_v1", "quant_tsmom") if h in L["width"].get(m, {})]
            wl = st.mean(L["width"][m][h] for m in rep)
            recent = sorted((k for k in preds["orbit_v2"] if k[0] == it and k[2] == h), key=lambda k: k[1])[-24:]
            rat = [band_width(k, cfg["band_members"], preds) / band_width(k, rep, preds) for k in recent
                   if band_width(k, rep, preds)]
            wl *= st.median(rat) if rat else 1.0
            win = cfg["conformal_window_months"]
            lo = be.add_months(L["month"], -win) if isinstance(win, int) else "0000"
            e = np.array([x for m_, x in _conf_pool(truth, preds, cfg, h) if lo < m_ <= L["month"]])
            q10, q90 = float(np.quantile(e, 0.1)), float(np.quantile(e, 0.9))
            du, db = cprob(e, wl, -lr), cprob(e, wl, BIG - lr)
            cu_m = [L["prob"][m][h][0] for m in cfg["prob_up_members"] if m in L["prob"]]
            cb_m = [L["prob"][m][h][1] for m in cfg["prob_bigup_members"] if m in L["prob"]]
            n_u, n_b = len(cfg["prob_up_members"]), len(cfg["prob_bigup_members"])
            cu = (sum(cu_m) + (n_u - len(cu_m)) * du) / max(n_u, 1)   # members with no live classifier -> conformal
            cb = (sum(cb_m) + (n_b - len(cb_m)) * db) / max(n_b, 1)
            a, T, ab = cfg["prob_up_mix_conformal"], cfg["prob_up_temperature"], cfg["prob_bigup_mix_conformal"]
            res["h"][h] = {"lr": lr, "q10": lr + q10 * wl, "q90": lr + q90 * wl,
                           "prob_up": sig(T * logit(a * du + (1 - a) * cu)), "prob_bigup": ab * db + (1 - ab) * cb,
                           "parts": parts, "members": {m: L["lr"][m][h] for m in L["lr"] if h in L["lr"][m]}}
        res["exog_parts_h6"] = (L.get("exog_parts") or {}).get(6)
        res["tfm_in_stat_h6"] = L["tfm_in_stat"][6]
        res["v1"] = {"trend_h6": L["params"]["blend"] * L["f"]["slope"] * 6, "stress": L["f"]["stress"],
                     "slope": L["f"]["slope"], "ai_parts": [(n, v, d12) for n, v, d12, _ in (L["ai"]["parts"] if L["ai"] else [])]}
        out[it] = res
    (be.CACHE / "live_v2.json").write_text(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    lb, truth, preds, board = main()
    _p(lb)
    lv = live(truth, preds, lb, json.loads((be.CACHE / "histories.json").read_text()))
    for it, r in lv.items():
        x = r["h"][6]
        print(f"LIVE {it:13s} {r['month']} 6m {math.exp(x['lr']) * 100 - 100:+.1f}%  band "
              f"{math.exp(x['q10']) * 100 - 100:+.0f}..{math.exp(x['q90']) * 100 - 100:+.0f}%  P(up) {x['prob_up']:.2f}  "
              f"P(>15%) {x['prob_bigup']:.2f}  " + " ".join(f"{m}={v:+.3f}" for m, v in x["members"].items()))
