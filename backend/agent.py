"""/api/ask: Jev routes intent (calibrated), a DeepSeek function-calling agent answers over Orbit data."""
import asyncio
import json
import os

from backend import data
from backend.data import ITEMS, MODULES, REGIONS, ITEM_BY_ID, MODULE_BY_ID, REGION_BY_ID
from backend.live import COUNTERS

MODEL = "gemini-3.8-flash"  # Ask fallback when no DeepSeek key, and the (cached) spoken briefing
LLM = "deepseek-flash"  # Ask Orbit agent (DeepSeek-V4.1-Flash, OpenAI-compatible API)
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
_gclient = None


def gemini():
    global _gclient
    if _gclient is None:
        from google import genai
        _gclient = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
    return _gclient


# ---------------- Jev routing ----------------

MODULE_TOPICS = {
    "groceries": "supermarket food: chocolate, cocoa, olive oil, orange juice, bread, wheat",
    "latte": "coffee in any form: coffee beans, lattes, espresso, cafe drinks, arabica, robusta",
    "beer_wine": "alcohol: beer, lager, hops, barley, wine, vineyards",
    "gpu": "electronics: GPUs, graphics cards, laptops, chips, semiconductors, TSMC, Taiwan",
    "rent": "London housing: rent, flats, boroughs, moving house",
}

async def jev_route(question: str) -> dict:
    from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul
    mod_criteria = {m["id"]: f"{m['name']} ({MODULE_TOPICS.get(m['id'], '')}): " + ", ".join(i["name"] for i in ITEMS if i["module"] == m["id"]) for m in MODULES}
    mod_criteria["general"] = "General question about Orbit, prices overall, or none of the specific topics"
    item_criteria = {i["id"]: i["name"] for i in ITEMS}
    item_criteria["none"] = "No specific product is mentioned or implied"
    region_criteria = {r["id"]: r["name"] for r in REGIONS}
    region_criteria["none"] = "No specific place or producing region is mentioned"
    qs = {
        "module": Choice(instructions="Which Orbit price module is the user's question `question` about?", criteria=mod_criteria),
        "item": Choice(instructions="Which consumer product is the user's question `question` about?", criteria=item_criteria),
        "region": Choice(instructions="Which satellite-monitored producing region does the user's question `question` refer to?", criteria=region_criteria),
        "buy_now": Noul(instructions="The question `question` asks whether to buy now or wait (a timing decision about a purchase)."),
    }
    async with AsyncTypeSafeClient() as ts:
        r = await asyncio.wait_for(ts.system_one(state={"question": question}, questions=qs, model="jev-latest"), 6)
    COUNTERS["jev_judgments"] += len(qs)
    c = r.choices
    return {"module": (c["module"].choice, c["module"].confidence),
            "item": (c["item"].choice, c["item"].confidence),
            "region": (c["region"].choice, c["region"].confidence),
            "buy_now": r.nouls["buy_now"].noul}


def keyword_route(question: str) -> dict:
    """Free local fallback when Jev is unreachable: first module/item/region whose words appear."""
    q = question.lower()
    def hit(words):
        return any(w and w in q for w in words)
    mod = next((m for m, t in MODULE_TOPICS.items()
                if hit([w.strip() for w in t.replace(":", ",").split(",")[1:]] + [MODULE_BY_ID[m]["name"].lower()])), "general")
    item = next((i["id"] for i in ITEMS if hit([i["name"].lower(), i["id"].split("_")[0]])), "none")
    region = next((r["id"] for r in REGIONS if hit([r["name"].split(",")[0].lower()])), "none")
    if mod == "general" and item != "none":
        mod = ITEM_BY_ID[item]["module"]
    buy = 0.9 if hit(["buy", "wait", "stock up", "cheaper"]) else 0.1
    return {"module": (mod, 0.8 if mod != "general" else 0.5), "item": (item, 0.8 if item != "none" else 0.5),
            "region": (region, 0.8 if region != "none" else 0.5), "buy_now": buy, "engine": "keywords"}


# ---------------- tools ----------------

def _trim_item(it: dict) -> dict:
    return {k: it.get(k) for k in ("item_id", "name", "retail_now", "retail_6m", "retail_12m", "prob_up_6m",
                                    "change_6m_pct", "model", "backtest")} | {
        "commodity_last_6m": (it.get("history") or [])[-6:],
        "forecast_p50": [{"month": f.get("month"), "p50": f.get("p50")} for f in (it.get("forecast") or [])[:12:3]]}


def get_module(module_id: str) -> dict:
    v = data.module_view(module_id)
    if not v:
        return {"error": f"unknown module {module_id}", "valid": list(MODULE_BY_ID)}
    sig = v["signals"] or {}
    summ = next((m for m in data.get_summary().get("modules", []) if m.get("module_id") == module_id), {})
    return {"module": v["module"], "pressure": summ.get("pressure"),
            "items": [_trim_item(i) for i in v["items"]],
            "regions": [{"region_id": r.get("region_id"), "name": r.get("name"), "anomaly": r.get("anomaly")} for r in v["regions"]],
            "news": {"net_supply_pressure": sig.get("net_supply_pressure"),
                     "top_headlines": [h.get("title") for h in (sig.get("headlines") or []) if (h.get("relevant_p") or 0) > 0.5][:4]},
            "insight": (v["insights"] or {}).get("headline")}


def get_forecast(item_id: str) -> dict:
    it = ITEM_BY_ID.get(item_id)
    if not it:
        return {"error": f"unknown item {item_id}", "valid": list(ITEM_BY_ID)}
    return _trim_item(data.item_view(it))


def get_region(region_id: str) -> dict:
    r = REGION_BY_ID.get(region_id)
    if not r:
        return {"error": f"unknown region {region_id}", "valid": list(REGION_BY_ID)}
    sat = data.read_json(f"satellite/{region_id}.json") or {}
    notes = [n["text"] for n in ((data.read_json(f"insights/{r['module']}.json") or {}).get("vision_notes") or [])
             if n.get("region_id") == region_id]
    return {"region_id": region_id, "name": r["name"], "module": r["module"], "item": r["item"], "signal": r["signal"],
            "anomaly": sat.get("anomaly"), "recent": (sat.get("series") or [])[-3:], "vision_note": notes[0] if notes else None}


def get_rent(borough: str = "") -> dict:
    rent = data.read_json("rent/london.json") or {}
    feats = [f.get("properties", {}) for f in rent.get("features") or []]
    if not feats:
        it = data.item_view(ITEM_BY_ID["rent_1bed"])
        return {"note": "borough data not built yet", "london_avg": _trim_item(it)}
    b = borough.lower().strip()
    hit = [p for p in feats if b and b in str(p.get("name", "")).lower()]
    if hit:
        return {"borough": hit[0]}
    top = sorted(feats, key=lambda p: -(p.get("pressure") or 0))[:5]
    return {"borough_not_found": borough, "highest_pressure_boroughs": top}


TOOLS_IMPL = {"get_module": get_module, "get_forecast": get_forecast, "get_region": get_region, "get_rent": get_rent}


def _decl(name, desc, param, enum=None):
    p = {"type": "string", "description": desc}
    if enum:
        p["enum"] = enum
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": {param: p}, "required": [param]}}}


TOOLS = [
    _decl("get_module", "Overview of one Orbit module (items, price pressure, satellite anomalies, news)", "module_id", list(MODULE_BY_ID)),
    _decl("get_forecast", "12-month price forecast and retail price projection for one consumer item", "item_id", list(ITEM_BY_ID)),
    _decl("get_region", "Satellite readings (NDVI/NDWI anomaly vs 5-year normal) and vision note for a producing region", "region_id", list(REGION_BY_ID)),
    _decl("get_rent", "London rent pressure for a borough (name, e.g. 'Hackney'); empty string for top boroughs", "borough"),
]

SYSTEM = ("You are Orbit, an AI that forecasts tomorrow's consumer prices in London from satellite imagery, news judged by Jev, "
          "and GPU time-series models on Modal. Always call tools to ground your answer in Orbit data. "
          "Call all tools you need in ONE parallel batch (max 3), then answer. If data is missing, give your best estimate from general market knowledge. "
          "Answer in at most 3 short sentences, plain text, concrete numbers in GBP and %, and a clear buy-now-or-wait tip when relevant.")

_http = None


async def deepseek_answer(question: str, hint: str) -> tuple[str, list]:
    global _http
    import httpx
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError("DEEPSEEK_API_KEY not set")
    _http = _http or httpx.AsyncClient(timeout=25, headers={"Authorization": f"Bearer {key}"})
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"{question}\n\n(router hint: {hint})"}]
    calls = []
    for rnd in range(2):
        last = rnd == 1
        if last:
            msgs.append({"role": "system", "content": "Tools are no longer available: answer now from what you have."})
        body = {"model": LLM, "messages": msgs, "max_tokens": 600, "tools": TOOLS}
        if last:
            body["tool_choice"] = "none"
        r = await _http.post(DEEPSEEK_URL, json=body)
        COUNTERS["deepseek_calls"] += 1
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        fcs = msg.get("tool_calls") or []
        if not fcs:
            return (msg.get("content") or "").strip(), calls
        msgs.append({k: v for k, v in msg.items() if v is not None})
        for fc in fcs:
            name = fc["function"]["name"]
            try:
                args = json.loads(fc["function"].get("arguments") or "{}")
            except ValueError:
                args = {}
            calls.append({"name": name, "args": args})
            try:
                res = TOOLS_IMPL[name](**args)
            except Exception as e:
                res = {"error": str(e)}
            msgs.append({"role": "tool", "tool_call_id": fc["id"], "content": json.dumps(res, default=str)[:6000]})
    return "I looked at the data but couldn't finish the analysis in time.", calls


def _gemini_tools():
    """Same tools in the Gemini Interactions API shape."""
    return [{"type": "function", "name": t["function"]["name"], "description": t["function"]["description"],
             "parameters": t["function"]["parameters"]} for t in TOOLS]


async def gemini_answer(question: str, hint: str) -> tuple[str, list]:
    """Fallback agent when no DeepSeek key is configured."""
    client = gemini()
    history = [{"type": "user_input", "content": [{"type": "text", "text": f"{question}\n\n(router hint: {hint})"}]}]
    calls = []
    for rnd in range(2):
        last = rnd == 1
        kw = {} if last else {"tools": _gemini_tools()}
        sysmsg = SYSTEM + (" Tools are no longer available: answer now from what you have." if last else "")
        it = await asyncio.wait_for(client.aio.interactions.create(
            model=MODEL, store=False, input=history, system_instruction=sysmsg,
            generation_config={"thinking_level": "low"}, **kw), 20)
        COUNTERS["gemini_calls"] += 1
        fcs = [s for s in it.steps if s.type == "function_call"]
        if not fcs:
            return (it.output_text or "").strip(), calls
        for s in it.steps:
            history.append(s.model_dump(exclude_none=True))
        for s in fcs:
            args = dict(s.arguments or {})
            calls.append({"name": s.name, "args": args})
            try:
                res = TOOLS_IMPL[s.name](**args)
            except Exception as e:
                res = {"error": str(e)}
            history.append({"type": "function_result", "name": s.name, "call_id": s.id,
                            "result": [{"type": "text", "text": json.dumps(res, default=str)[:6000]}]})
    return "I looked at the data but couldn't finish the analysis in time.", calls


def _template_answer(route: dict) -> str:
    item_id = route["item"][0] if route["item"][0] != "none" else None
    if not item_id and route["module"][0] in MODULE_BY_ID:
        item_id = next((i["id"] for i in ITEMS if i["module"] == route["module"][0]), None)
    if not item_id:
        return "Orbit tracks groceries, coffee, beer & wine, GPUs and London rent from space. Ask about any of them."
    it = data.item_view(ITEM_BY_ID[item_id])
    if it.get("retail_6m"):
        direction = "rise" if it["retail_6m"] > it["retail_now"] else "ease"
        tip = "Buy now." if direction == "rise" else "Waiting looks fine."
        return f"{it['name']} is £{it['retail_now']:.2f} today and Orbit expects it to {direction} to about £{it['retail_6m']:.2f} in 6 months. {tip}"
    return f"{it['name']} is about £{it['retail_now']:.2f} today; Orbit's forecast is still being computed."


async def ask(question: str) -> dict:
    question = (question or "").strip()[:500]
    COUNTERS["asks"] += 1
    try:  # Jev stays on even in the public showcase: a routing call costs a fraction of a cent
        route = await jev_route(question) | {"engine": "jev"}
    except Exception as e:
        route = keyword_route(question) | {"error": str(e)}
    hint = f"module={route['module'][0]} ({route['module'][1]:.2f}), item={route['item'][0]}, region={route['region'][0]}, buy_now_question_p={route['buy_now']:.2f}"
    try:
        # DeepSeek when its key is set, else the Gemini agent; the template answer only if both fail.
        if os.environ.get("DEEPSEEK_API_KEY"):
            answer, calls = await deepseek_answer(question, hint)
            llm = LLM
        else:
            answer, calls = await gemini_answer(question, hint)
            llm = MODEL
        if not answer:
            raise ValueError("empty answer")
    except Exception as e:
        print("[ask] LLM unavailable:", type(e).__name__, str(e)[:200])
        answer, calls, llm = _template_answer(route), [], None

    focus = {}
    for c in calls:
        a = c["args"]
        if c["name"] == "get_module":
            focus.setdefault("module_id", a.get("module_id"))
        elif c["name"] == "get_forecast" and a.get("item_id") in ITEM_BY_ID:
            focus.setdefault("item_id", a["item_id"])
            focus.setdefault("module_id", ITEM_BY_ID[a["item_id"]]["module"])
        elif c["name"] == "get_region" and a.get("region_id") in REGION_BY_ID:
            focus.setdefault("region_id", a["region_id"])
            focus.setdefault("module_id", REGION_BY_ID[a["region_id"]]["module"])
        elif c["name"] == "get_rent":
            focus.setdefault("module_id", "rent")
    if route["module"][0] in MODULE_BY_ID and route["module"][1] >= 0.5:
        focus.setdefault("module_id", route["module"][0])
    if route["item"][0] in ITEM_BY_ID and route["item"][1] >= 0.5:
        focus.setdefault("item_id", route["item"][0])
    if route["region"][0] in REGION_BY_ID and route["region"][1] >= 0.5:
        focus.setdefault("region_id", route["region"][0])

    return {"answer": answer,
            "route": {"label": route["module"][0], "confidence": round(route["module"][1], 3),
                      "buy_now_question_p": round(route["buy_now"], 3),
                      "item": route["item"][0], "region": route["region"][0], "engine": route.get("engine")},
            "llm": llm,
            "tool_calls": calls, "focus": {k: v for k, v in focus.items() if v}}
