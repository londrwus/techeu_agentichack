"""Orbit layer on top of the TimesFM forecasts in data/built/forecast/{item}.json.

1) Live forecast = the Orbit method that was tuned and backtested in scripts/build_eval.py (params are read
   from data/built/eval/summary.json -> tuned.params, fitted on cutoffs before 2023, tested on 2023+):
       driver path = TimesFM quantiles (from `model_driver`, written by modal_app/forecast.py) shifted by
       (damp-1)*ln(TimesFM p50/now) + blend*24m trend*h + satellite tilt + AI-era drivers (gpu, laptop)
   mapped to retail with commodity_share, then x (1 + h/12 x extra) where extra =
       share x 40% x 0.6 x Jev news pressure (NOT backtested: headline history is too short)
       + (1 - share) x 3% UK CPI on the non-commodity part of the price.
   Every forecast gets `drivers:[{name, value, contribution_pct, source}]` that sum to change_6m_pct.
   The raw TimesFM retail path is kept in `model_forecast` (idempotent: always recomputed from it).
2) Backtests: backtest.orbit_signal = the same tuned method at the story's as_of date (out-of-sample:
   every as_of is in the 2023+ test period), from the eval harness.

    .\\.venv\\Scripts\\python scripts/build_orbit_signal.py
"""
import json
import math
import statistics as st
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from orbit.config import BACKTESTS, ITEM_BY_ID, ITEMS, REGIONS  # noqa: E402
import build_eval as be  # noqa: E402

BUILT = ROOT / "data" / "built"
NEWS_W, SCALE, CPI = 0.6, 0.40, 0.03


def _phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def live_overlay(it: dict, fc: dict, sig: dict, params: dict) -> None:
    md = fc["model_driver"]
    months, vals, q = md["months"], md["values"], md["quantiles"]
    iid, s, R = it["id"], it["commodity_share"], it["retail_now"]
    cut = max(months[-1], time.strftime("%Y-%m"))  # live: all information available today
    f = be.features(iid, vals, len(vals) - 1, months[-1])
    ai = be.ai_drivers(iid, cut)
    f["ai12"] = ai["drift12"] if ai else 0.0
    qo = be.orbit_apply(q, f, params)
    c_last = vals[-1]

    news = 0.0
    if it["module"] != "gpu":  # gpu module: its Jev news enters through the AI-era drivers
        news = (sig.get("item_pressure") or {}).get(iid, sig.get("net_supply_pressure") or 0.0)
    extra_news = s * SCALE * NEWS_W * news
    extra_cpi = (1 - s) * CPI if not ai else 0.0  # laptop's CPI part is inside its AI-era drivers
    extra = extra_news + extra_cpi

    def retail(c: float, h: int) -> float:
        return round(max(R * (1 + s * (c / c_last - 1)), 0.05 * R) * (1 + extra * h / 12), 2)

    base_rows = fc["model_forecast"]
    out = [{"month": base_rows[h - 1]["month"], "p10": retail(row[0], h), "p50": retail(row[4], h),
            "p90": retail(row[8], h)} for h, row in enumerate(qo, 1)]
    fc["forecast"] = out
    now_p = (fc.get("history") or [{}])[-1].get("price") or R
    r6 = out[5]
    fc["change_6m_pct"] = round((r6["p50"] / now_p - 1) * 100, 1)
    sigma = max((r6["p90"] - r6["p10"]) / 2.563, 1e-6)
    fc["prob_up_6m"] = round(min(0.97, max(0.03, _phi((r6["p50"] - now_p) / sigma))), 3)

    # driver contributions to the 6-month retail change (pct points), residual folded into the trend bar
    p = params
    tilt = f["sig"] * max(-p["cap"], min(p["cap"], p["sat"] * f["stress"] + p["mom"] * f["mom3"] / f["sig"]))
    tfm6 = math.log(q[5][4] / c_last)
    pct = lambda lf: s * (math.exp(lf) - 1) * 100  # noqa: E731
    drivers = [
        {"name": "Price trend (24-month momentum)", "value": round(f["slope"] * 1200, 2),
         "contribution_pct": pct(p["blend"] * f["slope"] * 6), "source": f"price history, weight {p['blend']} (tuned)"},
        {"name": "TimesFM forecast path", "value": round(tfm6 * 100, 2), "contribution_pct": pct(p["damp"] * tfm6),
         "source": f"TimesFM 3.0 on L4 GPU, weight {p['damp']} (tuned; TimesFM always sets the p10-p90 band)"},
    ]
    if p["sat"] or p["mom"]:
        drivers.append({"name": "Satellite crop stress", "value": round(f["stress"], 3), "contribution_pct": pct(tilt),
                        "source": "Sentinel-2 NDVI/NDWI anomaly, 6 months vs prior years"})
    for name, val, d12, src in (ai["parts"] if ai else []):
        drivers.append({"name": name, "value": round(val, 3), "contribution_pct": s * d12 * 6 / 12 * 100
                        if "inflation" not in name else d12 * 6 / 12 * 100, "source": src})
    if it["module"] != "gpu":
        drivers.append({"name": "Jev news pressure", "value": round(news, 3), "contribution_pct": extra_news * 50,
                        "source": "Jev supply-effect judgments over recent headlines (not backtested)"})
        drivers.append({"name": "UK inflation (non-commodity costs)", "value": 3.0, "contribution_pct": extra_cpi * 50,
                        "source": "3% CPI on the non-commodity share"})
    resid = fc["change_6m_pct"] - sum(d["contribution_pct"] for d in drivers)
    drivers[0]["contribution_pct"] += resid
    for d in drivers:
        d["contribution_pct"] = round(d["contribution_pct"], 2)
    fc["drivers"] = drivers
    fc["orbit_overlay"] = {"params": params, "news_pressure": round(news, 3), "satellite_stress": round(f["stress"], 3),
                           "trend_24m_pct_per_year": round(f["slope"] * 1200, 2),
                           "ai_drift_12m_pct": round(f["ai12"] * 100, 2) if ai else None,
                           "extra_12m_pct": round(extra * 100, 2), "tuned_on": "cutoffs < 2023 (see eval/summary.json)",
                           "method": "TimesFM band re-centred by the tuned Orbit shift (trend blend, damping, satellite "
                                     "tilt, AI-era drivers) -> retail pass-through -> x (1 + h/12 x (Jev news + CPI))"}
    if ai:
        tl = be._ai_timeline()
        sig_ai = sig.get("ai_index") or {}
        fc["ai_era"] = {"ai_index_now": (sig_ai.get("now") or {}).get("index"),
                        "ai_index_baseline": (sig_ai.get("baseline") or {}).get("index"),
                        "baseline_window": sig_ai.get("baseline_window"),
                        "timeline": [{k: t[k] for k in ("month", "index", "ai_demand", "supply_constraint", "export_controls")}
                                     for t in tl.values()],
                        "buildout_sites": ai["buildout_sites"], "water_sites": ai["water_sites"]}
    fc["model"] = f"{(fc.get('model') or 'TimesFM').split(' (')[0].split(' + ')[0]} + Orbit (tuned)"
    print(f"overlay {iid:<13} 6m TimesFM {fc.get('model_change_6m_pct')}% -> Orbit {fc['change_6m_pct']:+.1f}%  "
          f"p_up {fc['prob_up_6m']}  | " + ", ".join(f"{d['name'].split(' (')[0]} {d['contribution_pct']:+.1f}"
                                                   for d in drivers if abs(d["contribution_pct"]) >= 0.05))


def overlay(params: dict):
    sigs = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (BUILT / "signals").glob("*.json")
            if not p.name.startswith("_")}
    for it in ITEMS:
        fp = BUILT / "forecast" / f"{it['id']}.json"
        if not fp.exists():
            continue
        fc = json.loads(fp.read_text(encoding="utf-8"))
        base = fc.get("model_forecast") or fc.get("forecast") or []
        if not base:
            continue
        fc["model_forecast"] = base
        fc.setdefault("model_prob_up_6m", fc.get("prob_up_6m"))
        fc.setdefault("model_change_6m_pct", fc.get("change_6m_pct"))
        if it["id"] == "rent_1bed" or not fc.get("model_driver"):  # rent model carries its own trend
            fc["forecast"] = base
            print(f"overlay {it['id']:<13} kept model path")
        else:
            live_overlay(it, fc, sigs.get(it["module"]) or {}, params)
        fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")


def ndvi_regions(item_id: str, as_of: str) -> list[dict]:
    out = []
    for r in REGIONS:
        if r.get("item") != item_id or r.get("signal") != "crop":
            continue
        a = be.region_anomaly(r, as_of)
        if a is not None:
            out.append({"region_id": r["id"], "ndvi_anomaly_pct": round(a * 100, 1)})
    return out


def backtests(params: dict):
    for bt in BACKTESTS:
        fp = BUILT / "forecast" / f"{bt['item_id']}.json"
        ep = BUILT / "eval" / f"{bt['item_id']}.json"
        if not fp.exists() or not ep.exists():
            continue
        fc = json.loads(fp.read_text(encoding="utf-8"))
        b = fc.get("backtest")
        ev = json.loads(ep.read_text(encoding="utf-8"))
        row = next((x for x in ev["backtests"] if x["cutoff"] == (b or {}).get("as_of") and x["h"] == 6
                    and x["method"] == "orbit"), None)
        if not b or not row:
            continue
        s = ITEM_BY_ID[bt["item_id"]]["commodity_share"]
        pred = s * (row["p50"] / row["base"] - 1) * 100
        pressure = round(100 * (row.get("prob_up") or 0.5))
        anoms = ndvi_regions(bt["item_id"], b["as_of"])
        stress = -st.mean(a["ndvi_anomaly_pct"] for a in anoms) if anoms else 0.0
        name = ""
        if anoms:
            worst = min(anoms, key=lambda a: a["ndvi_anomaly_pct"])
            name = next(r["name"] for r in REGIONS if r["id"] == worst["region_id"]).split(",")[0]
        story = (f"Satellites saw {name} {stress:.0f}% less green than normal in the 6 months before {b['as_of']}."
                 if stress > 0 else f"Crop canopy looked normal-to-greener before {b['as_of']} "
                                    f"(NDVI {-stress:+.0f}%): the shock wasn't visible from orbit.")
        b["orbit_signal"] = {"satellite_stress_pct": round(stress, 1), "regions": anoms,
                             "predicted_change_pct": round(pred, 1), "prob_up_6m": row.get("prob_up"),
                             "pressure": pressure, "flagged": pred >= 2 and (b.get("actual_change_pct") or 0) > 5,
                             "in_sample": False, "split": row.get("split"), "params": params, "story": story,
                             "method": "tuned Orbit method (fit on cutoffs < 2023) at as_of; retail = share x driver change"}
        fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"backtest {bt['item_id']} {b['as_of']}: orbit {pred:+.1f}% (p_up {row.get('prob_up')}) "
              f"vs actual {b.get('actual_change_pct')}%  [{row.get('split')}]")


EXOG_NAMES = {"m_fx3": "FX", "m_fx12": "FX", "m_brent3": "Brent", "m_brent12": "Brent", "m_gas6": "Gas"}


def apply_v2():
    """Orbit v2 (scripts/build_zoo.py: validated stack) replaces the live path for every backtested item.
    Keeps all v1 keys; v1 path moves to forecast_v1. Items without backtests (wine, rent) keep their path + get
    prob_bigup_6m from their band."""
    lv_p = be.CACHE / "live_v2.json"
    lb = json.loads((BUILT / "eval" / "leaderboard.json").read_text()) if (BUILT / "eval" / "leaderboard.json").exists() else {}
    live = json.loads(lv_p.read_text()) if lv_p.exists() else {}
    thr = (lb.get("final") or {}).get("big_alert_threshold_h6") or 0.25
    for it in ITEMS:
        fp = BUILT / "forecast" / f"{it['id']}.json"
        if not fp.exists():
            continue
        fc = json.loads(fp.read_text(encoding="utf-8"))
        L = live.get(it["id"])
        if not L:
            r6 = fc["forecast"][5]
            sd = max((math.log(r6["p90"]) - math.log(r6["p10"])) / 2.563, 1e-6)
            fc["prob_bigup_6m"] = round(1 - _phi((math.log(1.15) - math.log(r6["p50"] / fc["history"][-1]["price"])) / sd), 3)
            fc["method"] = "orbit_v1 (no backtest series: v2 stack not applicable)"
            fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
            continue
        s, R = it["commodity_share"], fc["history"][-1]["price"]
        extra = ((fc.get("orbit_overlay") or {}).get("extra_12m_pct") or 0) / 100
        H = {int(k): v for k, v in L["h"].items()}

        def interp(key, h):  # piecewise-linear in log space through (0,0), h3, h6, h12
            pts = [(0, 0.0)] + [(x, H[x][key]) for x in (3, 6, 12)]
            for (a, va), (b, vb) in zip(pts, pts[1:]):
                if h <= b:
                    return va + (vb - va) * (h - a) / (b - a)
            return pts[-1][1]

        def retail(lr, h):
            return round(max(R * (1 + s * (math.exp(lr) - 1)), 0.05 * R) * (1 + extra * h / 12), 2)

        fc["forecast_v1"] = fc["forecast"]
        fc["prob_up_6m_v1"], fc["change_6m_pct_v1"] = fc.get("prob_up_6m"), fc.get("change_6m_pct")
        fc["drivers_v1"] = fc.get("drivers")
        fc["forecast"] = [{"month": row["month"], "p10": retail(interp("q10", h), h), "p50": retail(interp("lr", h), h),
                           "p90": retail(interp("q90", h), h)} for h, row in enumerate(fc["forecast_v1"], 1)]
        x6 = H[6]
        fc["change_6m_pct"] = round((fc["forecast"][5]["p50"] / R - 1) * 100, 1)
        fc["prob_up_6m"] = round(min(0.97, max(0.03, x6["prob_up"])), 3)
        fc["prob_bigup_6m"] = round(min(0.97, max(0.01, x6["prob_bigup"])), 3)
        fc["driver_change_6m_pct"] = round((math.exp(x6["lr"]) - 1) * 100, 1)
        fc["big_move_alert"] = fc["prob_bigup_6m"] >= thr
        fc["recommendation"] = ("stock_up" if fc["prob_up_6m"] >= 0.6 and fc["change_6m_pct"] >= 2 else
                                "wait" if fc["prob_up_6m"] <= 0.4 and fc["change_6m_pct"] <= -2 else "hold")

        # drivers: split the 6m driver log-change by stack member, then map proportionally to retail pct points
        p = dict(x6["parts"])
        w6 = (lb["final"]["horizons"]["h6"]["weights"] if lb else {})
        k_v1 = w6.get("orbit_v1", 0.25)
        parts = []
        if "orbit_v1" in p:
            ai = L["v1"]["ai_parts"]
            ai_lr = [(n, k_v1 * d12 * 6 / 12) for n, _, d12 in ai]
            parts += [("Price trend (24-month momentum)", L["v1"]["slope"] * 1200, p["orbit_v1"] - sum(v for _, v in ai_lr),
                       "Orbit v1 member: 24m log-trend blend (weight 0.25 in the v2 stack)")]
            parts += [(n, v, lr, "AI-era driver inside the Orbit v1 member (Jev news / Sentinel-2)") for (n, lr), (_, v, _) in zip(ai_lr, ai)]
        if "stat_combo" in p:
            ms = x6["members"]["stat_combo"]
            tf = p["stat_combo"] * L["tfm_in_stat_h6"] / ms if abs(ms) > 1e-9 else 0.0
            parts += [("TimesFM 3.0 (GPU foundation model)", x6["members"].get("timesfm", 0) * 100, tf,
                       "TimesFM share of the statistical ensemble member"),
                      ("Statistical ensemble (ETS/ARIMA/Theta)", x6["members"]["stat_combo"] * 100, p["stat_combo"] - tf,
                       "statsforecast fits on Modal CPUs, equal-weight, damped 0.75")]
        if "quant_tsmom" in p:
            parts.append(("Quant momentum & mean-reversion", x6["members"]["quant_tsmom"] * 100, p["quant_tsmom"],
                          "ridge TSMOM on 40 commodity series (vol-scaled momentum, breakouts, 5y z-score)"))
        if "exog_ridge" in p:
            ep = L.get("exog_parts_h6") or {}
            tot_feat = sum(ep.values())
            macro = {}
            for c, v in ep.items():
                if c in EXOG_NAMES:
                    macro[EXOG_NAMES[c]] = macro.get(EXOG_NAMES[c], 0) + v
            scale = p["exog_ridge"] / x6["members"]["exog_ridge"] if x6["members"]["exog_ridge"] else 0
            for nm, lab in (("FX", "GBP/USD exchange rate"), ("Brent", "Oil price (Brent)"), ("Gas", "EU gas / fertiliser proxy")):
                if nm in macro:
                    parts.append((lab, round(macro[nm], 4), macro[nm] * scale, "exog ridge member (frozen 2022 fit)"))
            parts.append(("Price momentum (macro ridge)", round(tot_feat, 4),
                          p["exog_ridge"] - sum(macro.values()) * scale, "exog ridge member: price features + item level"))
        parts.append(("Satellite crop stress", round(L["v1"]["stress"], 3), 0.0,
                      "Sentinel-2 NDVI/NDWI anomaly: tracked, but no validated forecast skill yet -> weight 0 in v2"))
        tot_lr = sum(v for _, _, v, _ in parts)
        commodity_pct = s * (math.exp(x6["lr"]) - 1) * 100
        drivers = [{"name": n, "value": round(val, 3), "contribution_pct": commodity_pct * v / tot_lr if tot_lr else 0.0,
                    "source": src} for n, val, v, src in parts]
        for d in fc.get("drivers_v1") or []:
            if d["name"] in ("Jev news pressure", "UK inflation (non-commodity costs)"):
                drivers.append(dict(d))
        resid = fc["change_6m_pct"] - sum(d["contribution_pct"] for d in drivers)
        max(drivers, key=lambda d: abs(d["contribution_pct"]))["contribution_pct"] += resid
        for d in drivers:
            d["contribution_pct"] = round(d["contribution_pct"], 2)
        fc["drivers"] = drivers
        fc["model"] = "Orbit v2 (validated stack: TimesFM + stats + quant + macro)"
        fc["method"] = "orbit_v2"
        fc["orbit_v2"] = {"as_of": L["month"], "driver_base": L["base"], "weights_h6": w6,
                          "members_6m_pct": {m: round((math.exp(v) - 1) * 100, 2) for m, v in x6["members"].items()},
                          "driver_band_6m_pct": [round((math.exp(x6["q10"]) - 1) * 100, 1), round((math.exp(x6["q90"]) - 1) * 100, 1)],
                          "big_alert_threshold": thr,
                          "note": "weights/bands/probabilities selected on 2020-07..2022-06 validation; see eval/leaderboard.json"}
        fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"v2 {it['id']:<13} 6m {fc['change_6m_pct_v1']:+.1f}% -> {fc['change_6m_pct']:+.1f}%  p_up {fc['prob_up_6m']}  "
              f"p_big {fc['prob_bigup_6m']}  {fc['recommendation']}  | " +
              ", ".join(f"{d['name'].split(' (')[0]} {d['contribution_pct']:+.1f}" for d in drivers if abs(d["contribution_pct"]) >= 0.1))


def backtests_v2():
    """Attach the Orbit v2 backtest (out-of-sample at every as_of in 2023+) next to the v1 orbit_signal."""
    cp = be.CACHE / "candidates" / "orbit_v2.json"
    if not cp.exists():
        return
    rows = {(x["item_id"], x["cutoff"], x["h"]): x for x in json.loads(cp.read_text())["rows"]}
    hists = json.loads((be.CACHE / "histories.json").read_text())
    for bt in BACKTESTS:
        fp = BUILT / "forecast" / f"{bt['item_id']}.json"
        if not fp.exists():
            continue
        fc = json.loads(fp.read_text(encoding="utf-8"))
        b = fc.get("backtest")
        x = rows.get((bt["item_id"], (b or {}).get("as_of"), 6))
        if not b or not x:
            continue
        h = hists[bt["item_id"]]
        base = h["values"][h["months"].index(b["as_of"])]
        s = ITEM_BY_ID[bt["item_id"]]["commodity_share"]
        b["orbit_v2_signal"] = {"predicted_change_pct": round(s * (x["p50"] / base - 1) * 100, 1),
                                "driver_change_pct": round((x["p50"] / base - 1) * 100, 1),
                                "prob_up_6m": x["prob_up"], "prob_bigup_6m": x["prob_bigup"],
                                "in_sample": False, "split": "test" if b["as_of"] >= be.TEST_START else "train"}
        fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"backtest v2 {bt['item_id']} {b['as_of']}: {b['orbit_v2_signal']}")


def main():
    params = be.load_params()
    print("Orbit params (eval/summary.json tuned):", params)
    overlay(params)
    backtests(params)
    apply_v2()
    backtests_v2()


if __name__ == "__main__":
    main()
