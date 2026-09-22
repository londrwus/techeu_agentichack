"""Defensive readers for data/built/*.json + derived views (retail prices, summary fallback)."""
import json
import os
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from orbit.config import ITEMS, MODULES, MODULE_BY_ID, ITEM_BY_ID, REGIONS, REGION_BY_ID  # noqa: E402

DATA = Path(os.environ.get("ORBIT_DATA") or ROOT / "data" / "built").resolve()
FRONTEND = Path(os.environ.get("ORBIT_FRONTEND") or ROOT / "frontend").resolve()
# React build (web/ -> frontend_react/). Served at "/" when present; the vanilla build stays at "/legacy".
FRONTEND_REACT = Path(os.environ.get("ORBIT_FRONTEND_REACT") or ROOT / "frontend_react").resolve()


def read_json(rel: str):
    p = DATA / rel
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_json(rel: str, obj):
    p = DATA / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def _price_at(forecast: list, idx: int):
    if not forecast:
        return None
    return forecast[min(idx, len(forecast) - 1)].get("p50")


def item_view(item: dict) -> dict:
    """forecast/{item}.json + retail_now/6m/12m via pass-through model."""
    fc = read_json(f"forecast/{item['id']}.json") or {}
    out = dict(fc)
    out.setdefault("item_id", item["id"])
    out["name"] = item["name"]
    out["unit"] = fc.get("unit") or item["unit"]
    now = item["retail_now"]
    out["retail_now"] = now
    hist, fut = fc.get("history") or [], fc.get("forecast") or []
    last = hist[-1]["price"] if hist and hist[-1].get("price") else None
    share = item.get("commodity_share", 0.3)
    if last and abs(last / now - 1) < 0.03:  # forecast already in retail £ -> no second pass-through
        share = 1.0
    for k, idx in (("retail_6m", 5), ("retail_12m", 11)):
        p = _price_at(fut, idx)
        if last and p:
            out[k] = round(now * (1 + share * (p / last - 1)), 2)
        elif k == "retail_6m" and fc.get("change_6m_pct") is not None:
            out[k] = round(now * (1 + share * fc["change_6m_pct"] / 100), 2)
        else:
            out[k] = None
    return out


def module_view(module_id: str):
    m = MODULE_BY_ID.get(module_id)
    if not m:
        return None
    regions = []
    for r in REGIONS:
        if r["module"] == module_id:
            sat = read_json(f"satellite/{r['id']}.json")
            regions.append(sat or {"region_id": r["id"], "module": module_id, "name": r["name"],
                                   "lat": r["lat"], "lon": r["lon"], "series": [], "anomaly": None})
    return {
        "module": {k: m[k] for k in ("id", "name", "emoji", "color")},
        "items": [item_view(i) for i in ITEMS if i["module"] == module_id],
        "regions": regions,
        "signals": read_json(f"signals/{module_id}.json"),
        "insights": read_json(f"insights/{module_id}.json"),
    }


def latest_month() -> str:
    """Latest month present in satellite files, else last month."""
    best = None
    for r in REGIONS:
        sat = read_json(f"satellite/{r['id']}.json") or {}
        for s in sat.get("series") or []:
            if s.get("month") and (best is None or s["month"] > best):
                best = s["month"]
    if best:
        return best
    d = date.today()
    y, mth = (d.year, d.month - 1) if d.month > 1 else (d.year - 1, 12)
    return f"{y}-{mth:02d}"


def latest_thumb(region_id: str):
    sat = read_json(f"satellite/{region_id}.json") or {}
    for s in reversed(sat.get("series") or []):
        if s.get("thumb") and (DATA / s["thumb"]).exists():
            return s["thumb"], s.get("ndvi")
    return None, None


# ---------------- summary ----------------

def _risk_from_probs(probs: dict) -> float | None:
    if not probs:
        return None
    tot, w = 0.0, 0.0
    for label, p in probs.items():
        l = str(label).lower()
        v = 1.0 if any(x in l for x in ("high", "severe", "critical", "extreme")) else \
            0.5 if any(x in l for x in ("med", "moderate", "elevated")) else 0.0
        tot += v * p
        w += p
    return tot / w if w else None


def _sat_component(module_id: str, signals: dict | None) -> float | None:
    if module_id == "rent":
        rent = read_json("rent/london.json") or {}
        ps = [f.get("properties", {}).get("pressure") for f in rent.get("features") or []]
        ps = [p for p in ps if isinstance(p, (int, float))]
        return sum(ps) / len(ps) / 100 if ps else None
    risks = []
    for rj in (signals or {}).get("region_judgments") or []:
        r = _risk_from_probs((rj.get("harvest_risk") or {}).get("probs") or {})
        if r is not None:
            risks.append(r)
    if risks:
        return sum(risks) / len(risks)
    vals = []
    for r in REGIONS:
        if r["module"] != module_id:
            continue
        an = (read_json(f"satellite/{r['id']}.json") or {}).get("anomaly") or {}
        key = "ndwi_vs_5yr_pct" if r["signal"] == "water" else "ndvi_vs_5yr_pct"
        v = an.get(key)
        if isinstance(v, (int, float)):
            vals.append(min(1.0, max(0.0, 0.5 - v / 40)))  # below-normal greenness/water -> pressure
    return sum(vals) / len(vals) if vals else None


def _stats_from_files() -> dict:
    stats = {"tiles_processed": 0, "jev_judgments": 0, "modal_containers_peak": 0,
             "gpu_model": None, "gemini_calls": 0}
    if DATA.exists():
        for p in DATA.rglob("_stats.json"):
            try:
                s = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            for k, v in s.items():
                if k in ("modal_containers_peak", "containers_peak", "containers") and isinstance(v, (int, float)):
                    stats["modal_containers_peak"] = min(MODAL_MAX_CONTAINERS, max(stats["modal_containers_peak"], v))
                elif k == "region_judgments" and isinstance(v, (int, float)):
                    stats["jev_judgments"] += v
                elif k == "gpu_type" and v:
                    stats["gpu_type"] = v
                elif k == "gpu_model" and v:
                    stats[k] = v
                elif k in stats and isinstance(v, (int, float)):
                    stats[k] += v
        if not stats["tiles_processed"]:
            stats["tiles_processed"] = sum(1 for _ in (DATA / "tiles").rglob("*.png")) if (DATA / "tiles").exists() else 0
    if not stats["jev_judgments"]:
        stats["jev_judgments"] = sum(((read_json(f"signals/{m['id']}.json") or {}).get("n_judgments") or 0) for m in MODULES)
    if not stats["gpu_model"]:
        for i in ITEMS:
            fc = read_json(f"forecast/{i['id']}.json")
            if fc and fc.get("model"):
                stats["gpu_model"] = fc["model"]
                break
    return stats


def compute_summary() -> dict:
    from datetime import datetime, timezone
    mods = []
    for m in MODULES:
        signals = read_json(f"signals/{m['id']}.json")
        items = [item_view(i) for i in ITEMS if i["module"] == m["id"]]
        with_fc = [i for i in items if i.get("prob_up_6m") is not None]
        sat = _sat_component(m["id"], signals)
        nsp = (signals or {}).get("net_supply_pressure")
        news = (nsp + 1) / 2 if isinstance(nsp, (int, float)) else None
        fcp = sum(i["prob_up_6m"] for i in with_fc) / len(with_fc) if with_fc else None
        parts = [(0.35, sat), (0.25, news), (0.40, fcp)]
        parts = [(w, v) for w, v in parts if v is not None]
        pressure = round(100 * sum(w * v for w, v in parts) / sum(w for w, _ in parts)) if parts else None
        top = max(with_fc or items, key=lambda i: (i.get("change_6m_pct") or 0)) if items else None
        change = top.get("change_6m_pct") if top else None
        if m["id"] == "rent" and change is None:
            rent = read_json("rent/london.json") or {}
            cs = [f["properties"].get("change_pct") for f in rent.get("features") or [] if f.get("properties")]
            cs = [c for c in cs if isinstance(c, (int, float))]
            change = round(sum(cs) / len(cs) / 2, 1) if cs else None  # 12m -> ~6m
        mods.append({"module_id": m["id"], "name": m["name"], "emoji": m["emoji"], "color": m["color"],
                     "pressure": pressure, "prob_up_6m": top.get("prob_up_6m") if top else None,
                     "top_item": top.get("name") if top else None, "top_item_id": top.get("item_id") if top else None,
                     "change_6m_pct": change})
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "modules": mods, "stats": _stats_from_files()}


MODAL_MAX_CONTAINERS = 100  # Modal account limit: never display a peak above it


def get_summary() -> dict:
    s = read_json("summary.json") or compute_summary()
    st = s.get("stats") or {}
    if isinstance(st.get("modal_containers_peak"), (int, float)):
        st["modal_containers_peak"] = min(MODAL_MAX_CONTAINERS, st["modal_containers_peak"])
    return s
