"""Orbit signal layer on top of the TimesFM forecasts in data/built/forecast/{item}.json.

1) Live overlay: forecast = TimesFM retail path x (1 + h/12 * drift), where
   drift = commodity_share * 40% * (0.6 * Jev news item_pressure + 0.4 * Jev satellite harvest risk)
         + (1 - commodity_share) * 3% UK CPI on the non-commodity part of the price.
   The raw model path is kept in `model_forecast` (idempotent: always recomputed from it).
2) Backtests: add backtest.orbit_signal (below).

Orbit signal = model-implied 6m change + w * satellite crop stress at as_of,
where stress = -(NDVI anomaly %) over the 6 months up to as_of vs the same months in
earlier years (real Sentinel-2 series). One weight w is fitted in-sample by least squares
across all backtests -> "in_sample": true.

    .\\.venv\\Scripts\\python scripts/build_backtest.py
"""
import json
import math
import statistics as st
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from orbit.config import BACKTESTS, ITEMS, REGIONS  # noqa: E402

BUILT = ROOT / "data" / "built"
WINDOW = 6


def _months(as_of: str, back_years: int = 0):
    y, m = map(int, as_of.split("-"))
    y -= back_years
    out = []
    for i in range(WINDOW):
        mm, yy = m - i, y
        while mm < 1:
            mm += 12
            yy -= 1
        out.append(f"{yy:04d}-{mm:02d}")
    return out


def ndvi_anomaly(region_id: str, as_of: str):
    p = BUILT / "satellite" / f"{region_id}.json"
    if not p.exists():
        return None
    s = {x["month"]: x for x in json.loads(p.read_text(encoding="utf-8"))["series"]}

    def mean(ms):
        v = [s[m]["ndvi"] for m in ms if m in s and s[m].get("ndvi") is not None and (s[m].get("cloud_pct") or 0) <= 60]
        return st.mean(v) if v else None

    cur = mean(_months(as_of))
    base = [b for b in (mean(_months(as_of, j)) for j in range(1, 6)) if b is not None]
    if cur is None or not base:
        return None
    b = st.mean(base)
    return {"region_id": region_id, "ndvi": round(cur, 3), "ndvi_normal": round(b, 3),
            "ndvi_anomaly_pct": round((cur - b) / abs(b) * 100, 1), "baseline_years": len(base)}


NEWS_W, SAT_W, SCALE, CPI = 0.6, 0.4, 0.40, 0.03
RISK = {"low": 0.0, "medium": 1.0, "high": 2.0, "severe": 3.0}


def _phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def overlay():
    sigs = {}
    for p in (BUILT / "signals").glob("*.json"):
        if not p.name.startswith("_"):
            sigs[p.stem] = json.loads(p.read_text(encoding="utf-8"))
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
        sig = sigs.get(it["module"]) or {}
        news = (sig.get("item_pressure") or {}).get(it["id"], sig.get("net_supply_pressure") or 0.0)
        risks = []
        for rj in sig.get("region_judgments") or []:
            if rj.get("item_id", (REGIONS_BY.get(rj.get("region_id")) or {}).get("item")) == it["id"]:
                hr = rj.get("harvest_risk") or {}
                sc = hr.get("score")
                risks.append(sc if isinstance(sc, (int, float)) else RISK.get(hr.get("label"), 1.0))
        sat = (sum(risks) / len(risks) - 1.0) / 2.0 if risks else 0.0   # medium risk = neutral
        share = it["commodity_share"]
        if it["id"] == "rent_1bed":  # rent model already carries its own trend
            drift, news, sat = 0.0, 0.0, 0.0
        else:
            drift = share * SCALE * (NEWS_W * news + SAT_W * sat) + (1 - share) * CPI
        out = []
        for h, row in enumerate(base, 1):
            f = 1 + drift * h / 12
            out.append({"month": row["month"], **{k: round(row[k] * f, 2) for k in ("p10", "p50", "p90")}})
        fc["forecast"] = out
        now = (fc.get("history") or [{}])[-1].get("price") or it["retail_now"]
        r6 = out[min(5, len(out) - 1)]
        fc["change_6m_pct"] = round((r6["p50"] / now - 1) * 100, 1)
        sigma = max((r6["p90"] - r6["p10"]) / 2.563, 1e-6)
        fc["prob_up_6m"] = round(min(0.97, max(0.03, _phi((r6["p50"] - now) / sigma))), 3)
        fc["orbit_overlay"] = {"news_pressure": round(news, 3), "satellite_risk": round(sat, 3),
                               "drift_12m_pct": round(drift * 100, 2), "cpi_pct": CPI * 100,
                               "method": "TimesFM path x (1 + h/12 x drift); drift = share x 40% x (0.6 news + 0.4 satellite) + (1-share) x CPI"}
        if "Orbit" not in (fc.get("model") or ""):
            fc["model"] = f"{(fc.get('model') or 'TimesFM').split(' (')[0]} + Orbit signal"
        fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"overlay {it['id']:<13} news {news:+.2f} sat {sat:+.2f} drift12 {drift*100:+.1f}%  "
              f"6m {fc['model_change_6m_pct']:+.1f}% -> {fc['change_6m_pct']:+.1f}%  p_up {fc['prob_up_6m']}")


REGIONS_BY = {r["id"]: r for r in REGIONS}


def main():
    overlay()
    rows = []
    for bt in BACKTESTS:
        fp = BUILT / "forecast" / f"{bt['item_id']}.json"
        if not fp.exists():
            continue
        fc = json.loads(fp.read_text(encoding="utf-8"))
        b = fc.get("backtest")
        if not b:
            continue
        regs = [r for r in REGIONS if r["item"] == bt["item_id"] and r["signal"] == "crop"]
        anoms = [a for a in (ndvi_anomaly(r["id"], b["as_of"]) for r in regs) if a]
        if not anoms:
            continue
        stress = -st.mean(a["ndvi_anomaly_pct"] for a in anoms)
        rows.append((fp, fc, b, anoms, stress))

    # single weight, least squares on residual (actual - model)
    num = sum(s * (b["actual_change_pct"] - b["predicted_change_pct"]) for _, _, b, _, s in rows)
    den = sum(s * s for *_, s in rows) or 1.0
    w = max(0.0, num / den)
    print(f"fitted weight w = {w:.3f} (per % NDVI stress)")

    for fp, fc, b, anoms, stress in rows:
        pred = b["predicted_change_pct"] + w * stress
        pressure = round(100 / (1 + math.exp(-pred / 6)))
        flagged = pressure >= 65 and b["actual_change_pct"] > 5
        worst = min(anoms, key=lambda a: a["ndvi_anomaly_pct"])
        name = next(r["name"] for r in REGIONS if r["id"] == worst["region_id"]).split(",")[0]
        if stress > 0:
            story = (f"Satellites saw {name} {abs(worst['ndvi_anomaly_pct']):.0f}% less green than normal "
                     f"in the 6 months before {b['as_of']}.")
        else:
            story = (f"Crop canopy looked normal-to-greener before {b['as_of']} "
                     f"(NDVI {-stress:+.0f}%) - the shock wasn't visible from orbit.")
        b["orbit_signal"] = {
            "satellite_stress_pct": round(stress, 1),
            "regions": anoms,
            "weight": round(w, 3),
            "predicted_change_pct": round(pred, 1),
            "pressure": pressure,
            "flagged": flagged,
            "in_sample": True,
            "story": story,
            "method": f"model + {w:.2f} x NDVI stress ({WINDOW}m vs prior years), 1 weight fit in-sample",
        }
        fp.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{fc['item_id']}: stress {stress:+.1f}%  model {b['predicted_change_pct']:+.1f}% -> orbit {pred:+.1f}% "
              f"(pressure {pressure}, actual {b['actual_change_pct']:+.1f}%, flagged={flagged})")


if __name__ == "__main__":
    main()
