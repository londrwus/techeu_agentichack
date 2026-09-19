"""Gemini insights per module -> data/built/insights/{module_id}.json

Vision: latest tile vs same month 5 years earlier per region (2 images + stats) -> 1-2 sentence note.
Text: punchy headline + 3 short cards from forecasts + signals.
    .\\.venv\\Scripts\\python scripts/build_insights.py [--force] [module_id ...]
"""
import asyncio
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from backend import data  # noqa: E402
from backend.agent import gemini, MODEL  # noqa: E402

SEM = asyncio.Semaphore(8)
CALLS = 0


async def gen(input_, schema: dict) -> dict:
    global CALLS
    async with SEM:
        for attempt in range(3):
            try:
                it = await asyncio.wait_for(gemini().aio.interactions.create(
                    model=MODEL, store=False, input=input_,
                    generation_config={"thinking_level": "low"},
                    response_format={"type": "text", "mime_type": "application/json", "schema": schema}), 60)
                CALLS += 1
                return json.loads(it.output_text)
            except Exception as e:
                if attempt == 2:
                    raise
                print("  retry:", type(e).__name__, str(e)[:120])
                await asyncio.sleep(2 * (attempt + 1))


def pick_tiles(sat: dict):
    ser = [s for s in sat.get("series") or [] if s.get("thumb") and (data.DATA / s["thumb"]).exists()]
    if len(ser) < 2:
        return None, None
    now = ser[-1]
    y, m = now["month"].split("-")
    target = f"{int(y) - 5}-{m}"
    same_moy = [s for s in ser[:-1] if s["month"].endswith(f"-{m}")]
    then = next((s for s in ser if s["month"] == target), None) or (same_moy[0] if same_moy else ser[0])
    return then, now


def _img(rel: str) -> dict:
    return {"type": "image", "mime_type": "image/png",
            "data": base64.b64encode((data.DATA / rel).read_bytes()).decode()}


async def vision_note(region: dict, sat: dict):
    then, now = pick_tiles(sat)
    if not now:
        return None
    stats = {k: {"ndvi": s.get("ndvi"), "ndwi": s.get("ndwi"), "ndbi": s.get("ndbi"), "cloud_pct": s.get("cloud_pct")}
             for k, s in (("then", then), ("now", now))}
    prompt = (f"Two Sentinel-2 RGB satellite images of {region['name']} (signal: {region['signal']}, drives the price of "
              f"{data.ITEM_BY_ID[region['item']]['name']}). Image 1 = {then['month']}, image 2 = {now['month']}. "
              f"Index stats: {json.dumps(stats)}; anomaly vs 5-year normal: {json.dumps(sat.get('anomaly'))}. "
              "In 1-2 short sentences (max 35 words) say what visibly changed (greenness, water extent, construction, clouds) "
              "and what it means for supply. Be concrete, no hedging boilerplate.")
    res = await gen([{"type": "text", "text": prompt}, _img(then["thumb"]), _img(now["thumb"])],
                    {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]})
    return {"region_id": region["id"], "text": res["text"].strip(), "then": then["month"], "now": now["month"]}


CARDS_SCHEMA = {"type": "object", "properties": {
    "headline": {"type": "string", "description": "Punchy headline, max 10 words"},
    "cards": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "object", "properties": {
        "title": {"type": "string", "description": "2-4 words"},
        "text": {"type": "string", "description": "max 25 words"}}, "required": ["title", "text"]}}},
    "required": ["headline", "cards"]}


async def module_cards(mod: dict, view: dict, notes: list) -> dict:
    items = [{k: i.get(k) for k in ("name", "retail_now", "retail_6m", "retail_12m", "prob_up_6m", "change_6m_pct", "backtest")}
             for i in view["items"]]
    sig = view["signals"] or {}
    heads = sorted(sig.get("headlines") or [], key=lambda h: -(h.get("relevant_p") or 0))[:8]
    ctx = {"module": mod["name"], "items": items,
           "news": {"net_supply_pressure": sig.get("net_supply_pressure"),
                    "headlines": [{"title": h.get("title"), "supply_effect": (h.get("supply_effect") or {}).get("label"),
                                   "severity": (h.get("severity") or {}).get("label")} for h in heads]},
           "satellite": [{"region": r.get("name"), "anomaly": r.get("anomaly")} for r in view["regions"]],
           "vision_notes": [n["text"] for n in notes]}
    if mod["id"] == "rent":
        rent = data.read_json("rent/london.json") or {}
        props = sorted((f.get("properties") or {} for f in rent.get("features") or []), key=lambda p: -(p.get("pressure") or 0))
        ctx["boroughs_top"] = props[:5]
    prompt = ("You write for Orbit, which forecasts London consumer prices from satellites + news + GPU forecasts. "
              "From this data write a punchy headline (max 10 words, include a number if available) and exactly 3 cards "
              "(title 2-4 words, text max 25 words): 1) what satellites/news see, 2) what it means for London prices in £, "
              "3) buy-now-or-wait advice. Use only numbers present in the data.\n\nDATA: " + json.dumps(ctx, default=str))
    return await gen(prompt, CARDS_SCHEMA)


def tidy_money(obj):
    """£1150.0 -> £1,150 ; £2334.91 -> £2,335 ; £4.1 -> £4.10 (Gemini copies raw floats)."""
    import re

    def fix(m):
        v = float(m.group(1).replace(",", ""))
        return f"£{v:,.0f}" if v >= 100 else f"£{v:.2f}"
    if isinstance(obj, str):
        return re.sub(r"£(\d[\d,]*(?:\.\d+)?)", fix, obj)
    if isinstance(obj, list):
        return [tidy_money(x) for x in obj]
    if isinstance(obj, dict):
        return {k: tidy_money(v) for k, v in obj.items()}
    return obj


async def build_module(mod: dict, force: bool):
    out = f"insights/{mod['id']}.json"
    if data.read_json(out) and not force:
        print(f"skip {mod['id']} (exists; --force to rebuild)")
        return
    view = data.module_view(mod["id"])
    has_fc = any(i.get("forecast") for i in view["items"])
    if not (has_fc or view["signals"] or any(r.get("series") for r in view["regions"]) or data.read_json("rent/london.json")):
        print(f"skip {mod['id']} (no inputs yet)")
        return
    regions = [r for r in data.REGIONS if r["module"] == mod["id"]]
    sats = {r["id"]: data.read_json(f"satellite/{r['id']}.json") or {} for r in regions}
    res = await asyncio.gather(*[vision_note(r, sats[r["id"]]) for r in regions], return_exceptions=True)
    notes = [n for n in res if isinstance(n, dict)]
    for r, n in zip(regions, res):
        if isinstance(n, Exception):
            print(f"  vision {r['id']} failed: {n}")
    try:
        cards = await module_cards(mod, view, notes)
    except Exception as e:
        print(f"  cards {mod['id']} failed: {e}")
        cards = {"headline": None, "cards": []}
    data.write_json(out, tidy_money({"module_id": mod["id"], "headline": cards.get("headline"),
                                     "cards": cards.get("cards", [])[:3], "vision_notes": notes, "model": MODEL}))
    print(f"{mod['emoji']} {mod['id']}: {cards.get('headline')}  ({len(notes)} vision notes)")


async def main():
    force = "--force" in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    mods = [m for m in data.MODULES if not only or m["id"] in only]
    await asyncio.gather(*[build_module(m, force) for m in mods])
    prev = (data.read_json("insights/_stats.json") or {}).get("gemini_calls", 0)
    if CALLS:
        data.write_json("insights/_stats.json", {"gemini_calls": prev + CALLS})
    print(f"gemini calls: {CALLS}")


if __name__ == "__main__":
    asyncio.run(main())
