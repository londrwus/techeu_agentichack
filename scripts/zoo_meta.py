r"""Orbit meta-vote: meta-learning on the EXISTING model-zoo candidates (no new raw data), strictly point-in-time.

Inputs : data/cache/eval/{histories,timesfm}.json + data/cache/eval/candidates/*.json (via build_zoo.load)
Output : data/cache/eval/candidates/meta_vote.json (same row format as the other candidates)
         data/cache/eval/meta_vote_report.json (VAL selection trace, confidence deciles, gate, VAL/TEST metrics)

Members (features only): drift, timesfm, stat_combo, ets, arima, theta, quant_tsmom, exog_ridge + point-in-time
climatology. Excluded as features: learner / bigmove_clf / orbit_v1 / orbit_v2 (each was fitted or tuned with
VALIDATION-era outcomes, so they would leak inside the walk-forward).

(a) Direction vote: L2 logistic meta-model on vol-scaled member forecasts, member P(up) logits, agreement (net share
    of members calling up), dispersion, climatology; pooled over horizons; refit at every cutoff on rows whose outcome
    month <= that cutoff (walk-forward).
(b) Regime: item's trailing 12m vol percentile vs its own past (point-in-time); interactions with the vote features.
(c) Confidence = member agreement with the vote (+ |P(up)-0.5| tie-break); gate threshold picked on VALIDATION only.
p50  = point-in-time inverse-MAE weighted median of member forecasts, sign-aligned with the vote (VAL-picked handling),
       times a VAL-picked damping. Bands = split-conformal on past normalised residuals (build_zoo.conformal).
P(>15%) = VAL-picked mix of a walk-forward logistic and the conformal residual probability.

Every choice is made on VAL (cutoffs 2020-07..2022-06, cutoff+h <= 2022-12). TEST (cutoffs >= 2023-01) is scored once.

    .\.venv\Scripts\python scripts/zoo_meta.py
"""
import itertools
import json
import math
import statistics as st
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import build_eval as be  # noqa: E402
import build_zoo as bz  # noqa: E402

HS = [3, 6, 12]
MEM = ["drift", "timesfm", "stat_combo", "ets", "arima", "theta", "quant_tsmom", "exog_ridge"]
PMEM = ["timesfm", "stat_combo", "ets", "arima", "theta", "quant_tsmom", "exog_ridge"]   # have prob_up / prob_bigup
BIG = bz.BIG


def logit(p):
    p = min(max(p, 1e-3), 1 - 1e-3)
    return math.log(p / (1 - p))


def outcome(k):
    return be.add_months(k[1], k[2])


# ------------------------------------------------------------------ point-in-time helpers from the price history
def vol_info(hists):
    """(item, month) -> (sigma: 36m std of monthly log returns, regime: 12m vol percentile vs own past 10y)."""
    out = {}
    for it, hh in hists.items():
        lv = np.log(np.asarray(hh["values"], float))
        r = np.diff(lv)
        v12 = [float(np.std(r[max(0, i - 12):i])) if i >= 6 else np.nan for i in range(1, len(r) + 1)]
        for i, m in enumerate(hh["months"]):
            if i < 13:
                continue
            sig = float(np.std(r[max(0, i - 36):i])) or 0.01
            past = [x for x in v12[max(0, i - 120):i] if not np.isnan(x)]
            cur = v12[i - 1]
            pct = sum(x <= cur for x in past) / len(past) if past else 0.5
            out[(it, m)] = (max(sig, 0.005), pct)
    return out


# ------------------------------------------------------------------ features
def build_features(truth, preds, vi):
    feats = {}
    for k, t in truth.items():
        if not all(k in preds[m] for m in MEM) or (k[0], k[1]) not in vi:
            continue
        b, h = t["base"], k[2]
        sig, pct = vi[(k[0], k[1])]
        s = sig * math.sqrt(h)
        lr = {m: math.log(preds[m][k][1] / b) for m in MEM}
        z = np.clip([lr[m] / s for m in MEM], -3, 3)
        pl = [logit(preds[m][k][3]) for m in PMEM if preds[m][k][3] is not None]
        agree = st.mean(np.sign([lr[m] for m in MEM]))
        disp = float(np.std(z))
        cl = logit(preds["climatology"][k][3])
        pb = [logit(preds[m][k][4]) for m in PMEM if preds[m][k][4] is not None]
        hv = 1.0 if pct > 0.6 else 0.0
        base_f = [float(np.mean(z)), float(np.median(z)), st.mean(pl), agree, disp, cl]
        reg_f = [hv, hv * float(np.mean(z)), hv * agree, hv * st.mean(pl)]
        vote_f = [agree, st.mean(pl), float(np.median(z))]
        per_m = list(z) + [logit(preds[m][k][3]) for m in PMEM]
        feats[k] = {"base": base_f, "reg": reg_f, "perm": per_m, "vote": vote_f, "hv": hv, "h": [h / 12],
                    "big": [st.mean(pb), logit(preds["climatology"][k][4]), float(np.mean(z)), s, hv],
                    "lr": lr, "s": s}
    return feats


def fit_logit(X, y, lam, w=None, iters=30, intercept=True):
    """L2 logistic regression by Newton (intercept unpenalised; intercept=False pins it at 0 = no regime base rate)."""
    n, d = X.shape
    X1 = np.c_[np.ones(n), X]
    w = np.ones(n) if w is None else w
    beta = np.zeros(d + 1)
    P = np.eye(d + 1) * lam
    P[0, 0] = 1e-6 if intercept else 1e9
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X1 @ beta))
        g = X1.T @ (w * (p - y)) + P @ beta
        H = (X1 * (w * p * (1 - p))[:, None]).T @ X1 + P
        step = np.linalg.solve(H, g)
        beta -= step
        if np.abs(step).max() < 1e-7:
            break
    return beta


def walk_forward(keys, xfn, yfn, lam, window, min_n=80, fallback=None, intercept=True):
    """P(y=1) for every key, fitted at its cutoff on rows whose outcome month <= cutoff (and within window)."""
    out = {}
    for c in sorted({k[1] for k in keys}):
        lo = be.add_months(c, -window) if window else "0000"
        tr = [k for k in keys if lo < outcome(k) <= c]
        te = [k for k in keys if k[1] == c]
        if len(tr) < min_n:
            for k in te:
                out[k] = fallback(k)
            continue
        X = np.array([xfn(k) for k in tr])
        mu, sd = (X.mean(0) if intercept else np.zeros(X.shape[1])), X.std(0) + 1e-9
        beta = fit_logit((X - mu) / sd, np.array([yfn(k) for k in tr], float), lam, intercept=intercept)
        for k in te:
            z = float(np.r_[1, (np.array(xfn(k)) - mu) / sd] @ beta)
            out[k] = 1 / (1 + math.exp(-z))
    return out


# ------------------------------------------------------------------ metrics helpers (VAL-side selection)
def is_val(k):
    return bz.is_val({"cutoff": k[1], "h": k[2]})


def is_test(k):
    return k[1] >= be.TEST_START


def dir_rows(truth, keys):
    return [k for k in keys if abs(truth[k]["actual"] / truth[k]["base"] - 1) >= be.DIR_MIN]


def acc(truth, keys, pu):
    ks = dir_rows(truth, keys)
    return sum((pu[k] > 0.5) == (truth[k]["actual"] > truth[k]["base"]) for k in ks) / len(ks) if ks else None


def brier_up(truth, keys, pu):
    return st.mean((pu[k] - float(truth[k]["actual"] > truth[k]["base"])) ** 2 for k in keys)


def wmedian(vals, ws):
    o = sorted(zip(vals, ws))
    tot, c = sum(ws), 0.0
    for v, w in o:
        c += w
        if c >= tot / 2:
            return v
    return o[-1][0]


# ------------------------------------------------------------------ main
def main():
    hists, truth, preds = bz.load()
    vi = vol_info(hists)
    F = build_features(truth, preds, vi)
    keys = sorted(F, key=lambda k: (k[1], k[0], k[2]))
    up = lambda k: float(truth[k]["actual"] > truth[k]["base"])  # noqa: E731
    bg = lambda k: float(math.log(truth[k]["actual"] / truth[k]["base"]) > BIG)  # noqa: E731
    mean_pu = lambda k: st.mean(preds[m][k][3] for m in PMEM)  # noqa: E731
    report = {"trials_up": []}

    # (a)+(b) direction meta-model: VAL grid on h6 Brier (tie-break: mean VAL Brier over horizons)
    fsets = {"base": lambda k: F[k]["base"] + F[k]["h"],
             "base+regime": lambda k: F[k]["base"] + F[k]["reg"] + F[k]["h"],
             "members": lambda k: F[k]["base"] + F[k]["perm"] + F[k]["h"],
             "members+regime": lambda k: F[k]["base"] + F[k]["reg"] + F[k]["perm"] + F[k]["h"],
             "vote": lambda k: F[k]["vote"],
             "vote+regime": lambda k: F[k]["vote"] + [F[k]["hv"] * v for v in F[k]["vote"]]}
    best = None
    for (fs, xfn), lam, win, pooled, icpt in itertools.product(fsets.items(), (1.0, 10.0, 50.0, 200.0), (0, 60, 36),
                                                              (True, False), (True, False)):
        pu = {}
        groups = [keys] if pooled else [[k for k in keys if k[2] == h] for h in HS]
        for g in groups:
            pu.update(walk_forward(g, xfn, up, lam, win, min_n=80 if pooled else 60, fallback=mean_pu, intercept=icpt))
        vb = {h: brier_up(truth, [k for k in keys if k[2] == h and is_val(k)], pu) for h in HS}
        va = acc(truth, [k for k in keys if k[2] == 6 and is_val(k)], pu)
        score = vb[6] + 0.25 * st.mean(vb.values())
        report["trials_up"].append({"fset": fs, "lam": lam, "window": win, "pooled": pooled, "intercept": icpt,
                                    "val_brier": {f"h{h}": round(v, 4) for h, v in vb.items()}, "val_dir_h6": round(va, 3)})
        if best is None or score < best[0]:
            best = (score, fs, lam, win, pooled, icpt, pu)
    _, fs, lam, win, pooled, icpt, PU = best
    report["chosen_up"] = {"fset": fs, "lam": lam, "window": win or "expanding", "pooled": pooled, "intercept": icpt}
    print("chosen P(up) model:", report["chosen_up"])
    report["trials_up"].sort(key=lambda t: t["val_brier"]["h6"])
    report["trials_up"] = report["trials_up"][:12]

    # p50: point-in-time inverse-MAE weighted median of members, aligned with the vote, damped (VAL-picked)
    past_err = {}
    for h in HS:
        hk = sorted((k for k in keys if k[2] == h), key=outcome)
        for k in keys:
            if k[2] != h:
                continue
            prev = [j for j in hk if outcome(j) <= k[1]][-120:]
            w = []
            for m in MEM:
                e = [abs(preds[m][j][1] - truth[j]["actual"]) / truth[j]["base"] for j in prev]
                w.append(1 / max(st.mean(e), 1e-3) if len(e) >= 12 else 1.0)
            past_err[k] = w
    wmed = {k: wmedian([F[k]["lr"][m] for m in MEM], past_err[k]) for k in keys}

    def p50_lr(k, mode, d):
        m, s = wmed[k], 1 if PU[k] > 0.5 else -1
        if mode == "raw":
            v = m
        elif np.sign(m) == s:
            v = m
        elif mode == "flip0":
            v = s * 0.003
        elif mode == "flip_half":
            v = s * 0.5 * abs(m)
        else:  # "prob": expected move from the vote strength
            v = s * max(abs(m), 0.003)
        return d * v

    def skill(ks, lrp):
        ae = sum(abs(truth[k]["base"] * math.exp(lrp[k]) - truth[k]["actual"]) for k in ks)
        an = sum(abs(truth[k]["base"] - truth[k]["actual"]) for k in ks)
        return 1 - ae / an

    p50_choice = {}
    for h in HS:
        vk = [k for k in keys if k[2] == h and is_val(k)]
        trial = {}
        for mode, d in itertools.product(("raw", "flip0", "flip_half", "prob"), (1.0, 0.75, 0.5)):
            trial[(mode, d)] = skill(vk, {k: p50_lr(k, mode, d) for k in vk})
        pick = max(trial, key=trial.get)
        p50_choice[h] = pick
        report.setdefault("p50_trials", {})[f"h{h}"] = {f"{m}_{d}": round(v, 4) for (m, d), v in trial.items()}
    report["p50_chosen"] = {f"h{h}": {"mode": v[0], "damp": v[1]} for h, v in p50_choice.items()}
    print("chosen p50:", report["p50_chosen"])
    LR = {k: p50_lr(k, *p50_choice[k[2]]) for k in keys}

    # bands: split-conformal (window picked on VAL as in build_zoo) + P(>15%)
    rows, prob_cfg = {}, {}
    for h in HS:
        hk = [k for k in keys if k[2] == h]
        lrp = {k: LR[k] for k in hk}
        bestc = None
        for window in (0, 60, 36):
            conf = bz.conformal(truth, preds, h, lrp, PMEM, window)
            vk = [k for k in conf if is_val(k)]
            cov = st.mean(truth[k]["base"] * math.exp(lrp[k] + conf[k][0] * conf[k][3]) <= truth[k]["actual"]
                          <= truth[k]["base"] * math.exp(lrp[k] + conf[k][1] * conf[k][3]) for k in vk)
            wid = st.mean((conf[k][1] - conf[k][0]) * conf[k][3] for k in vk)
            sc = abs(cov - 0.8) + 0.1 * wid
            if bestc is None or sc < bestc[0]:
                bestc = (sc, window, conf)
        _, cwin, conf = bestc
        hk = [k for k in hk if k in conf]
        cb = {k: bz.cprob(conf[k][2], conf[k][3], BIG - LR[k]) for k in hk}
        mb = {k: st.mean(preds[m][k][4] for m in PMEM) for k in hk}
        lb = walk_forward(hk, lambda k: F[k]["big"] + [LR[k] / F[k]["s"]], bg, 10.0, 0, min_n=60, fallback=lambda k: mb[k])
        vk = [k for k in hk if is_val(k)]
        opts = {}
        for a, b_ in itertools.product((0, 0.25, 0.5, 0.75, 1), (0, 0.5, 1)):
            # a: weight on walk-forward logistic; b_: within the rest, weight on conformal vs member mean
            f = lambda k, a=a, b_=b_: a * lb[k] + (1 - a) * (b_ * cb[k] + (1 - b_) * mb[k])  # noqa: E731
            opts[(a, b_)] = sum((f(k) - bg(k)) ** 2 for k in vk)
        a, b_ = min(opts, key=opts.get)
        prob_cfg[f"h{h}"] = {"conformal_window": cwin or "expanding", "big_mix_logistic": a, "big_mix_conformal": b_}
        for k in hk:
            b = truth[k]["base"]
            q10, q90, _, w = conf[k]
            pbig = a * lb[k] + (1 - a) * (b_ * cb[k] + (1 - b_) * mb[k])
            rows[k] = (b * math.exp(LR[k] + q10 * w), b * math.exp(LR[k]), b * math.exp(LR[k] + q90 * w), PU[k], pbig)
    report["prob_cfg"] = prob_cfg
    print("bands/P(>15%):", prob_cfg)

    # (c) confidence deciles on VAL (h6) -> gate: the lowest |P-0.5| threshold whose VAL confident-subset accuracy
    # >= 0.70 with coverage >= 30% (rule fixed before looking at TEST)
    v6 = dir_rows(truth, [k for k in rows if k[2] == 6 and is_val(k)])
    # confidence = member agreement (net share of members on the vote's side; 0 if the majority disagrees with the
    # vote), tie-broken by |P(up) - 0.5|. |P - 0.5| alone was not monotone in accuracy on VAL deciles.
    conf_ = {k: (abs(F[k]["vote"][0]) if np.sign(F[k]["vote"][0]) == np.sign(PU[k] - 0.5) else 0.0) + 0.01 * abs(PU[k] - 0.5)
             for k in rows}
    srt = sorted(v6, key=lambda k: -conf_[k])
    dec = []
    for i in range(10):
        part = srt[i * len(srt) // 10:(i + 1) * len(srt) // 10]
        dec.append({"decile": i + 1, "min_conf": round(min(conf_[k] for k in part), 4), "n": len(part),
                    "acc": round(sum((PU[k] > 0.5) == (truth[k]["actual"] > truth[k]["base"]) for k in part) / len(part), 3)})
    report["val_h6_confidence_deciles"] = dec
    gate = None
    for t in sorted({round(conf_[k], 4) for k in v6}):
        sub = [k for k in v6 if conf_[k] >= t]
        if len(sub) / len(v6) < 0.3:
            break
        a_ = sum((PU[k] > 0.5) == (truth[k]["actual"] > truth[k]["base"]) for k in sub) / len(sub)
        if a_ >= 0.70:
            gate = t
            break
    if gate is None:  # fall back to the top-half-confidence rule
        gate = round(sorted(conf_[k] for k in v6)[len(v6) // 2], 4)
    report["gate_conf"] = gate
    print("VAL h6 deciles:", [(d["decile"], d["acc"]) for d in dec], "gate |P-0.5| >=", gate)

    bz.CAND.joinpath("meta_vote.json").write_text(json.dumps({
        "name": "meta_vote", "description": "Walk-forward logistic meta-vote over zoo members (direction), weighted-median p50 "
        "aligned with the vote, split-conformal bands, P(>15%) mix; all choices on VALIDATION (scripts/zoo_meta.py)",
        "config": {k: report[k] for k in ("chosen_up", "p50_chosen", "prob_cfg", "gate_conf")},
        "rows": [{"item_id": k[0], "cutoff": k[1], "h": k[2], "p10": be.r(v[0], 4), "p50": be.r(v[1], 4), "p90": be.r(v[2], 4),
                  "prob_up": be.r(v[3], 4), "prob_bigup": be.r(v[4], 4), "confidence": be.r(conf_[k], 4)}
                 for k, v in sorted(rows.items())]}))
    return truth, preds, rows, report, conf_


def score(truth, preds, rows, report, conf_):
    """VAL + TEST metrics (build_zoo definitions) for meta_vote and orbit_v2; TEST read only here."""
    d = json.loads((bz.CAND / "orbit_v2.json").read_text())
    preds["orbit_v2"] = {(x["item_id"], x["cutoff"], x["h"]): (x["p10"], x["p50"], x["p90"], x["prob_up"], x["prob_bigup"])
                         for x in d["rows"]}
    preds["meta_vote"] = rows
    out = {}
    for m in ("orbit_v2", "meta_vote"):
        thr = bz.pick_thr(bz.rows_for(truth, preds[m], lambda x: x["h"] == 6 and bz.is_val(x)))
        out[m] = {"big_threshold": thr}
        for split, cond in (("val", bz.is_val), ("test", bz.is_test)):
            for h in HS:
                c = lambda x, h=h, cond=cond: x["h"] == h and cond(x) and (x["item"], x["cutoff"], h) in rows  # noqa: E731
                sel = bz.rows_for(truth, preds[m], c)
                mm = bz.full_metrics(sel, bz.rows_for(truth, preds["naive"], c), thr)
                # direction via P(up) and on the confident subset (gate from VAL)
                ks = dir_rows(truth, [(x["item"], x["cutoff"], h) for x in sel])
                pu = {k: preds[m][k][3] for k in ks}
                mm["dir_acc_prob"] = be.r(acc(truth, ks, pu), 3)
                if m == "meta_vote":
                    ck = [k for k in ks if conf_[k] >= report["gate_conf"]]
                    mm["dir_acc_confident"] = be.r(acc(truth, ck, pu), 3) if ck else None
                    mm["confident_coverage"] = be.r(len(ck) / len(ks), 3) if ks else None
                    mm["n_confident"] = len(ck)
                mm["n_dir"] = len(ks)
                out[m].setdefault(split, {})[f"h{h}"] = mm
    return out


if __name__ == "__main__":
    truth, preds, rows, report, conf_ = main()
    res = score(truth, preds, rows, report, conf_)
    if "--test" in sys.argv:
        report["metrics"] = res
    else:
        report["metrics"] = {m: {"val": v["val"]} for m, v in res.items()}
    (be.CACHE / "meta_vote_report.json").write_text(json.dumps(report, indent=1))
    cols = ["dir_acc", "dir_acc_prob", "dir_acc_confident", "confident_coverage", "skill", "mape", "coverage80",
            "brier_up", "brier_bigup", "big_move_recall", "big_precision", "big_recall_flag", "n"]
    for split in (("val", "test") if "--test" in sys.argv else ("val",)):  # TEST printed only for the final report
        for h in ("h6", "h3", "h12"):
            print(f"\n{split.upper()} {h}  " + " ".join(f"{c[:10]:>10}" for c in cols))
            for m in ("orbit_v2", "meta_vote"):
                print(f"{m:10s}" + " ".join(f"{str(res[m][split][h].get(c)):>10}" for c in cols))
