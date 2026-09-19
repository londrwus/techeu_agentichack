"""orbit-signals: news headlines -> Jev typed judgments at scale, on Modal.

  modal run modal_app/signals.py              # fetch + judge -> /data/built/signals/{module}.json (+ _stats.json)
  modal run modal_app/signals.py --force      # refetch headlines and rejudge
  modal run modal_app/signals.py::ai          # gpu: AI-era headlines + Jev AI demand/supply/export judgments -> ai_index
  modal run modal_app/signals.py::regions     # Jev judges /data/built/satellite/*.json -> region_judgments
  modal deploy modal_app/signals.py           # exposes judge_headlines / fetch_latest / judge_regions for the live scan
"""
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import modal

from orbit.config import ITEMS, MODULES, REGIONS

app = modal.App("orbit-signals")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("typesafe-sdk", "httpx", "feedparser")
    .add_local_python_source("orbit")
)
vol = modal.Volume.from_name("orbit-data", create_if_missing=True)
secrets = [modal.Secret.from_name("orbit-secrets")]

OUT = Path("/data/built/signals")
CACHE = Path("/data/cache/signals")
MAX_LISTED = 400  # headlines kept in the built file (full judged set stays in /data/cache/signals)
BATCH = 25  # headlines per Jev call (4 questions each -> 100 questions, ~9k tokens)

# Extra Google News RSS queries per module (volume + fallback when GDELT throttles).
RSS_QUERIES = {
    "groceries": ["cocoa harvest", "cocoa prices", "olive oil prices", "olive harvest drought",
                  "orange juice prices", "citrus greening Brazil", "wheat harvest", "wheat prices"],
    "latte": ["coffee prices", "arabica futures", "robusta Vietnam harvest", "Brazil coffee frost drought",
              "coffee harvest"],
    "beer_wine": ["barley harvest", "hops harvest", "wine harvest heatwave", "vineyard drought",
                  "beer prices", "grape harvest"],
    "gpu": ["GPU prices", "graphics card prices", "Nvidia Blackwell supply", "HBM shortage", "DRAM prices",
            "memory chip shortage", "data center capex", "hyperscaler AI capex", "TSMC CoWoS capacity",
            "AI chip export controls", "Nvidia China export", "AI data center construction", "TSMC water drought",
            "chip shortage"],
    "rent": ["London rents", "London housing supply", "London new homes", "London construction",
             "UK rental market"],
}

EFFECT_LABELS = ["strongly_down", "down", "unchanged", "up", "strongly_up"]  # consumer price pressure
SEVERITY_LABELS = ["minor", "notable", "major"]
RISK_LABELS = ["low", "medium", "high", "severe"]


def _month_windows(n_months: int):
    now = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    starts = []
    y, m = now.year, now.month
    for _ in range(n_months):
        starts.append(datetime(y, m, 1, tzinfo=timezone.utc))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return [(s, (s + timedelta(days=32)).replace(day=1)) for s in starts]


def _clean_title(t: str, source: str | None = None) -> str:
    t = (t or "").strip()
    if source and t.endswith(" - " + source):
        t = t[: -len(source) - 3]
    elif " - " in t:
        t = t.rsplit(" - ", 1)[0]
    return t.strip()


def _rss(query: str, client) -> list[dict]:
    import feedparser

    r = client.get("https://news.google.com/rss/search",
                   params={"q": query, "hl": "en-GB", "gl": "GB", "ceid": "GB:en"})
    out = []
    for e in feedparser.parse(r.text).entries:
        src = (e.get("source") or {}).get("title")
        date = time.strftime("%Y-%m-%d", e.published_parsed) if e.get("published_parsed") else None
        out.append({"title": _clean_title(e.get("title"), src), "url": e.get("link"), "date": date,
                    "source": src or "news.google.com"})
    return out


def _dedupe(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in rows:
        k = " ".join((r.get("title") or "").lower().split())[:120]
        if len(k) < 15 or k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


@app.function(image=image, timeout=1500, volumes={"/data": vol})
def fetch_gdelt(n_months: int = 24) -> dict:
    """Sequential GDELT DOC 2.0 fetch (1 request / 5 s) for all modules, monthly windows."""
    import httpx

    res = {m["id"]: [] for m in MODULES}
    deadline = time.time() + 1300
    with httpx.Client(timeout=40, headers={"User-Agent": "orbit-hackathon/0.1"}) as c:
        for start, end in _month_windows(n_months):
            for m in MODULES:
                if time.time() > deadline:
                    return res
                params = {"query": f"{m['news_query']} sourcelang:english", "mode": "artlist", "format": "json",
                          "maxrecords": 250, "sort": "hybridrel",
                          "startdatetime": start.strftime("%Y%m%d%H%M%S"),
                          "enddatetime": end.strftime("%Y%m%d%H%M%S")}
                for attempt in range(3):
                    time.sleep(5.5)
                    try:
                        r = c.get("https://api.gdeltproject.org/api/v2/doc/doc", params=params)
                    except Exception as e:  # noqa: BLE001
                        print("gdelt error", e)
                        continue
                    if r.status_code == 429:
                        time.sleep(10)
                        continue
                    try:
                        arts = r.json().get("articles", [])
                    except Exception:  # noqa: BLE001
                        print("gdelt non-json", m["id"], r.text[:120])
                        arts = []
                    for a in arts:
                        sd = a.get("seendate", "")
                        res[m["id"]].append({"title": a.get("title"), "url": a.get("url"),
                                             "date": f"{sd[:4]}-{sd[4:6]}-{sd[6:8]}" if len(sd) >= 8 else None,
                                             "source": a.get("domain")})
                    break
            print(start.strftime("%Y-%m"), {k: len(v) for k, v in res.items()})
    return res


@app.function(image=image, timeout=600)
def fetch_rss(module_id: str, n_windows: int = 8, queries: list[str] | None = None) -> list[dict]:
    """Google News RSS: several queries x quarterly windows (~100 items each)."""
    import httpx
    from concurrent.futures import ThreadPoolExecutor

    m = next(x for x in MODULES if x["id"] == module_id)
    queries = queries or ([m["news_query"]] + RSS_QUERIES.get(module_id, []))
    now = datetime.now(timezone.utc).date()
    windows = [(now - timedelta(days=91 * (i + 1)), now - timedelta(days=91 * i)) for i in range(n_windows)]
    jobs = [f"{q} after:{a} before:{b}" for q in queries for a, b in windows]
    with httpx.Client(timeout=30, follow_redirects=True) as c, ThreadPoolExecutor(8) as ex:
        def one(q):
            try:
                return _rss(q, c)
            except Exception as e:  # noqa: BLE001
                print("rss error", q, e)
                return []
        rows = [r for part in ex.map(one, jobs) for r in part]
    return _dedupe(rows)


@app.function(image=image, timeout=60)
def fetch_latest(module_id: str, n: int = 40) -> list[dict]:
    """Fast: latest headlines for the live 'Scan now' demo (Google News RSS, last 7 days)."""
    import httpx

    m = next(x for x in MODULES if x["id"] == module_id)
    with httpx.Client(timeout=20, follow_redirects=True) as c:
        rows = _rss(f"{m['news_query']} when:7d", c)
        if len(rows) < n:
            for q in RSS_QUERIES.get(module_id, [])[:3]:
                rows += _rss(f"{q} when:7d", c)
    rows = _dedupe(rows)
    rows.sort(key=lambda r: r.get("date") or "", reverse=True)
    return rows[:n]


def _questions(i: int, items: list[dict], rent: bool) -> dict:
    from typesafe_sdk import Choice, Noul, Score

    h = f"`headlines.h{i}`"
    crit = {it["id"]: it["name"] for it in items}
    crit["none"] = "None of these items"
    if rent:
        effect = ["Strong downward pressure on London rents (e.g. big wave of new homes, demand collapse)",
                  "Some downward pressure on London rents", "No meaningful effect on London rents",
                  "Some upward pressure on London rents (tighter supply, more demand, higher costs)",
                  "Strong upward pressure on London rents (severe shortage, landlord exodus, cost spike)"]
    else:
        effect = ["Supply much higher or costs much lower: strong downward pressure on consumer prices",
                  "Supply higher or costs lower: some downward pressure on consumer prices",
                  "No meaningful change in supply or costs",
                  "Supply lower or costs higher: some upward pressure on consumer prices",
                  "Supply much lower or costs much higher: strong upward pressure on consumer prices"]
    return {
        f"rel{i}": Noul(instructions=f"Headline {h} reports on supply, production, harvest, costs, demand or "
                                     f"prices relevant to these consumer items: `items`."),
        f"item{i}": Choice(instructions=f"Which consumer item's price is most affected by the news in headline {h}?",
                           criteria=crit),
        f"eff{i}": Score(instructions=f"What does headline {h} imply for future consumer prices of the affected item?",
                         criteria=effect),
        f"sev{i}": Score(instructions=f"How significant is the event in headline {h} for consumer prices?",
                         criteria=["Minor: routine news, small or local effect",
                                   "Notable: meaningful regional or market-moving development",
                                   "Major: large shock to global supply or prices"]),
    }


def _dist(ans, labels):
    probs = {labels[int(k)]: round(float(v), 4) for k, v in ans.probabilities.items()}
    return {"label": max(probs, key=probs.get), "probs": probs, "score": round(float(ans.score), 3)}


@app.function(image=image, secrets=secrets, timeout=300, max_containers=20,
              retries=modal.Retries(max_retries=2, initial_delay=2.0))
def judge_headlines(batch: list[dict], module_id: str) -> dict:
    """One Jev system_one call per batch: 4 typed questions per headline."""
    from typesafe_sdk import RetryPolicy, TypeSafeClient

    items = [it for it in ITEMS if it["module"] == module_id]
    state = {"items": ", ".join(it["name"] for it in items),
             "headlines": {f"h{i}": h["title"] for i, h in enumerate(batch)}}
    qs = {}
    for i in range(len(batch)):
        qs.update(_questions(i, items, module_id == "rent"))
    with TypeSafeClient(retry=RetryPolicy(max_retries=4)) as c:
        r = c.system_one(state, qs)
    out = []
    for i, h in enumerate(batch):
        eff, sev, it = r.scores[f"eff{i}"], r.scores[f"sev{i}"], r.choices[f"item{i}"]
        out.append({**h,
                    "relevant_p": round(float(r.nouls[f"rel{i}"].noul), 4),
                    "item_id": it.choice,
                    "item_p": round(float(it.probabilities.get(it.choice, 0)), 4),
                    "supply_effect": _dist(eff, EFFECT_LABELS),
                    "price_pressure": round((float(eff.score) - 2) / 2, 3),  # -1..1, + = prices up
                    "severity": _dist(sev, SEVERITY_LABELS),
                    "confidence": round(min(float(eff.confidence), float(sev.confidence), float(it.confidence)), 3)})
    return {"rows": out, "n_judgments": len(qs), "input_tokens": r.usage.input_tokens,
            "output_tokens": r.usage.output_tokens}


def _write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def _assemble(module_id: str, rows: list[dict], n_judgments: int, n_headlines: int) -> dict:
    wsum = sum(r["relevant_p"] for r in rows) or 1.0
    net = sum(r["relevant_p"] * r["price_pressure"] for r in rows) / wsum
    # Monthly timeline for charts (relevance-weighted pressure + volume).
    tl = {}
    for r in rows:
        mo = (r.get("date") or "")[:7]
        if len(mo) != 7:
            continue
        t = tl.setdefault(mo, [0, 0.0, 0.0])
        t[0] += 1
        t[1] += r["relevant_p"]
        t[2] += r["relevant_p"] * r["price_pressure"]
    timeline = [{"month": k, "n": v[0], "relevant": round(v[1], 1), "pressure": round(v[2] / v[1], 3) if v[1] else 0}
                for k, v in sorted(tl.items())]
    items = {}
    for r in rows:
        if r["relevant_p"] >= 0.5 and r["item_id"] != "none":
            items.setdefault(r["item_id"], []).append(r["price_pressure"])
    rows = sorted(rows, key=lambda r: (r["relevant_p"] * (1 + r["severity"]["score"]), r.get("date") or ""), reverse=True)
    return {"module_id": module_id, "n_headlines": n_headlines, "n_judgments": n_judgments,
            "net_supply_pressure": round(net, 3),
            "n_relevant": sum(1 for r in rows if r["relevant_p"] >= 0.5),
            "item_pressure": {k: round(sum(v) / len(v), 3) for k, v in items.items()},
            "timeline": timeline, "headlines": rows[:MAX_LISTED], "region_judgments": [],
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


@app.function(image=image, secrets=secrets, volumes={"/data": vol}, timeout=2400)
def build(force: bool = False) -> dict:
    t0 = time.time()
    vol.reload()
    todo = [m["id"] for m in MODULES if force or not (OUT / f"{m['id']}.json").exists()]
    if not todo:
        print("all signals exist; use --force")
        return json.loads((OUT / "_stats.json").read_text())

    # 1) headlines: GDELT (sequential, one container) || Google News RSS (fan-out), cached on the volume
    headlines = {}
    need = [m for m in todo if force or not (CACHE / f"headlines_{m}.json").exists()]
    for m in todo:
        if m not in need:
            headlines[m] = json.loads((CACHE / f"headlines_{m}.json").read_text(encoding="utf-8"))
    if need:
        g_call = fetch_gdelt.spawn(24)
        rss = dict(zip(need, list(fetch_rss.map(need))))
        try:
            gd = g_call.get(timeout=1400)
        except Exception as e:  # noqa: BLE001
            print("gdelt failed", e)
            gd = {}
        for m in need:
            rows = _dedupe((gd.get(m) or []) + rss[m])
            headlines[m] = rows
            _write(CACHE / f"headlines_{m}.json", rows)
            print(m, "gdelt", len(gd.get(m) or []), "rss", len(rss[m]), "->", len(rows))
        vol.commit()

    # 2) Jev judgments: fan out batches
    jobs = [(headlines[m][i:i + BATCH], m) for m in todo for i in range(0, len(headlines[m]), BATCH)]
    print("jev batches", len(jobs))
    per = {m: {"rows": [], "n": 0} for m in todo}
    tok_in = tok_out = calls = 0
    for (batch, m), res in zip(jobs, list(judge_headlines.starmap(jobs, return_exceptions=True))):
        if isinstance(res, Exception):
            print("batch failed", m, res)
            continue
        calls += 1
        per[m]["rows"] += res["rows"]
        per[m]["n"] += res["n_judgments"]
        tok_in += res["input_tokens"]
        tok_out += res["output_tokens"]

    for m in todo:
        _write(CACHE / f"judged_{m}.json", per[m]["rows"])
        doc = _assemble(m, per[m]["rows"], per[m]["n"], len(headlines[m]))
        old = OUT / f"{m}.json"
        if old.exists():  # keep region judgments from an earlier regions run
            doc["region_judgments"] = json.loads(old.read_text(encoding="utf-8")).get("region_judgments", [])
        _write(old, doc)
        print(m, "headlines", doc["n_headlines"], "relevant", doc["n_relevant"], "net", doc["net_supply_pressure"])

    stats = {"jev_judgments": sum(v["n"] for v in per.values()), "jev_calls": calls,
             "seconds": round(time.time() - t0, 1), "headlines": sum(len(headlines[m]) for m in todo),
             "input_tokens": tok_in, "output_tokens": tok_out,
             "jev_cost_usd_est": round(tok_in * 0.042e-6 + tok_out * 0.042e-6, 4),
             "containers_peak": min(20, len(jobs)) + 1 + len(need)}
    old_stats = OUT / "_stats.json"
    if old_stats.exists():
        prev = json.loads(old_stats.read_text())
        stats["region_judgments"] = prev.get("region_judgments", 0)
    _write(old_stats, stats)
    vol.commit()
    return stats


@app.function(image=image, volumes={"/data": vol}, timeout=300)
def compact():
    """Trim built files to MAX_LISTED headlines, moving the full judged set to the cache (one-off maintenance)."""
    vol.reload()
    for m in MODULES:
        p = OUT / f"{m['id']}.json"
        if not p.exists():
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        if len(doc.get("headlines", [])) > MAX_LISTED:
            _write(CACHE / f"judged_{m['id']}.json", doc["headlines"])
            doc["headlines"] = doc["headlines"][:MAX_LISTED]
            _write(p, doc)
            print(m["id"], "trimmed")
    vol.commit()


def _region_questions(sig: str) -> dict:
    from typesafe_sdk import Score

    if sig in ("datacenter", "fab"):
        instr = ("Based on the land-transformation share (change_frac = share of the site changed vs 2019-20) and "
                 "built-up index (NDBI) history in `satellite` for the "
                 "AI data-centre / chip-fab site in `region`, how intense is the construction build-out, i.e. how much "
                 "new demand for GPUs, memory and chips does this site signal?")
        crit = ["Low: little or no visible new construction", "Medium: steady expansion",
                "High: rapid build-out, large new halls or fabs", "Severe: explosive build-out, site transformed"]
    elif sig == "water":
        instr = ("Based on the reservoir water extent (water_frac = share of the box that is open water) and NDWI "
                 "history in `satellite` for the region in `region`, how high is the risk of water shortage "
                 "constraining chip/semiconductor production in the next months?")
        crit = ["Low: water extent normal or above normal", "Medium: somewhat below normal",
                "High: clearly below normal, rationing plausible", "Severe: drought-level lows, production at risk"]
    elif sig in ("built", "port"):
        instr = ("Based on the built-up / activity index (NDBI) history in `satellite` for the site in `region`, "
                 "how high is the risk of supply disruption for electronics supply chains?")
        crit = ["Low: activity stable or growing", "Medium: some unusual change",
                "High: marked drop or disruption signal", "Severe: major disruption signal"]
    else:
        instr = ("Based on the vegetation (NDVI) and moisture (NDWI) history and anomalies in `satellite` for the "
                 "growing region in `region`, how high is the risk of a poor harvest this season?")
        crit = ["Low: vegetation healthy, at or above the 5-year norm", "Medium: slightly below norm",
                "High: clearly stressed vegetation, likely reduced yields",
                "Severe: drought/stress at crisis level, likely crop failure"]
    return {"risk": Score(instructions=instr, criteria=crit)}


@app.function(image=image, secrets=secrets, volumes={"/data": vol}, timeout=600)
def judge_regions(module: str = "") -> dict:
    """Jev reads each region's satellite stats JSON -> harvest/water/disruption risk, merged into signals files."""
    from concurrent.futures import ThreadPoolExecutor

    from typesafe_sdk import TypeSafeClient

    vol.reload()
    sat_dir = Path("/data/built/satellite")
    todo = []
    for reg in REGIONS:
        if module and reg["module"] != module:
            continue
        p = sat_dir / f"{reg['id']}.json"
        if p.exists():
            todo.append((reg, json.loads(p.read_text(encoding="utf-8"))))
    print("regions with satellite data:", len(todo), "/", len(REGIONS))

    def one(arg):
        reg, sat = arg
        keys = ("month", "ndvi", "ndwi", "ndbi", "water_frac", "built_frac", "change_frac", "cloud_pct")
        series = [{k: s.get(k) for k in keys if k in s} for s in sat.get("series", [])
                  if (s.get("cloud_pct") or 0) <= 40]  # cloudy scenes fake "low water" / odd indices
        state = {"region": {"name": reg["name"], "signal": reg["signal"], "item": reg["item"]},
                 "satellite": {"anomaly": sat.get("anomaly"), "series": series[-48:]}}
        with TypeSafeClient() as c:
            r = c.system_one(state, _region_questions(reg["signal"]))
        a = r.scores["risk"]
        d = _dist(a, RISK_LABELS)
        return reg, {"region_id": reg["id"], "name": reg["name"], "signal": reg["signal"], "item_id": reg["item"],
                     "harvest_risk": d, "confidence": round(float(a.confidence), 3)}, r.usage.input_tokens

    by_mod, n, tok = {}, 0, 0
    with ThreadPoolExecutor(16) as ex:
        for reg, j, t in ex.map(one, todo):
            by_mod.setdefault(reg["module"], []).append(j)
            n += 1
            tok += t
    for m in MODULES:
        if m["id"] not in by_mod:
            continue
        p = OUT / f"{m['id']}.json"
        doc = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {
            "module_id": m["id"], "n_headlines": 0, "n_judgments": 0, "headlines": [], "net_supply_pressure": 0}
        doc["region_judgments"] = by_mod[m["id"]]
        _write(p, doc)
    sp = OUT / "_stats.json"
    stats = json.loads(sp.read_text()) if sp.exists() else {}
    stats["region_judgments"] = n if not module else len(REGIONS)
    stats["region_input_tokens"] = tok
    _write(sp, stats)
    vol.commit()
    return {"region_judgments": n, "input_tokens": tok,
            "risks": {j["region_id"]: j["harvest_risk"]["label"] for v in by_mod.values() for j in v}}


# ---------------------------------------------------------------- AI-era demand layer (gpu module)
AI_WINDOWS = 16  # quarterly Google-News windows -> ~4 years, covers the ChatGPT moment (late 2022) onward
AI_QUERIES = ["GPU prices", "Nvidia Blackwell supply", "Nvidia H100 shortage", "HBM shortage", "DRAM prices",
              "memory chip shortage", "data center capex", "hyperscaler AI capex", "TSMC CoWoS capacity",
              "AI chip export controls", "Nvidia China export ban", "AI data center construction",
              "graphics card prices", "GDDR7 shortage"]
AI_LEVELS = ["strongly_down", "down", "neutral", "up", "strongly_up"]
AI_KEYS = ("ai_demand", "supply_constraint", "export_controls", "index")


def _key(title: str) -> str:
    return " ".join((title or "").lower().split())[:120]


def _ai_questions(i: int) -> dict:
    from typesafe_sdk import Noul, Score

    h = f"`headlines.h{i}`"
    return {
        f"arel{i}": Noul(instructions=f"Headline {h} is about AI compute, data centres, GPUs, memory chips (DRAM/HBM), "
                                      f"chip manufacturing capacity or chip trade policy."),
        f"dem{i}": Score(instructions=f"What does headline {h} imply for demand for AI compute (GPUs, data-centre "
                                      f"chips, memory)?",
                         criteria=["Much weaker demand (capex cuts, AI bubble bursting, orders cancelled)",
                                   "Somewhat weaker demand", "No clear change in demand",
                                   "Stronger demand (new capex, new data centres, bigger models)",
                                   "Much stronger demand (record capex, massive new AI campuses, sold-out GPUs)"]),
        f"sup{i}": Score(instructions=f"What does headline {h} imply for supply of GPUs and memory (HBM/DRAM/GDDR "
                                      f"output, TSMC CoWoS packaging, fab capacity)?",
                         criteria=["Supply easing strongly (glut, big new capacity online)", "Supply easing somewhat",
                                   "No clear change in supply",
                                   "Supply tightening (shortage, allocation, capacity sold out)",
                                   "Supply severely constrained (acute shortage, production cuts, rationing)"]),
        f"exp{i}": Score(instructions=f"What does headline {h} imply for export controls and trade restrictions "
                                      f"on AI chips (and hence global GPU supply and prices)?",
                         criteria=["Restrictions loosened a lot", "Restrictions loosened somewhat",
                                   "No change in restrictions / not about trade policy",
                                   "Restrictions tightened (new controls, tariffs, bans)",
                                   "Restrictions tightened a lot (sweeping bans or tariffs)"]),
    }


@app.function(image=image, secrets=secrets, timeout=300, max_containers=20,
              retries=modal.Retries(max_retries=2, initial_delay=2.0))
def judge_ai(batch: list[dict]) -> dict:
    """One Jev system_one call: 4 AI-era typed questions per headline (relevance, demand, supply, export controls)."""
    from typesafe_sdk import RetryPolicy, TypeSafeClient

    state = {"context": "Consumer GPU, laptop and AI-accelerator prices in the AI era",
             "headlines": {f"h{i}": h["title"] for i, h in enumerate(batch)}}
    qs = {}
    for i in range(len(batch)):
        qs.update(_ai_questions(i))
    with TypeSafeClient(retry=RetryPolicy(max_retries=4)) as c:
        r = c.system_one(state, qs)
    out = {}
    for i, h in enumerate(batch):
        d, s_, e = r.scores[f"dem{i}"], r.scores[f"sup{i}"], r.scores[f"exp{i}"]
        out[_key(h["title"])] = {
            "ai_relevant_p": round(float(r.nouls[f"arel{i}"].noul), 4),
            "ai_demand": {**_dist(d, AI_LEVELS), "value": round((float(d.score) - 2) / 2, 3)},
            "supply_constraint": {**_dist(s_, AI_LEVELS), "value": round((float(s_.score) - 2) / 2, 3)},
            "export_controls": {**_dist(e, AI_LEVELS), "value": round((float(e.score) - 2) / 2, 3)},
        }
    return {"ai": out, "n_judgments": len(qs), "input_tokens": r.usage.input_tokens,
            "output_tokens": r.usage.output_tokens}


def _ai_timeline(rows: list[dict]) -> list[dict]:
    """Point-in-time monthly index: relevance-weighted mean of each Jev score (-1..1) over that month's headlines."""
    tl = {}
    for r in rows:
        mo, a = (r.get("date") or "")[:7], r.get("ai")
        if len(mo) != 7 or not a:
            continue
        w = a["ai_relevant_p"]
        t = tl.setdefault(mo, {"n": 0, "w": 0.0, "d": 0.0, "s": 0.0, "e": 0.0})
        t["n"] += 1
        t["w"] += w
        t["d"] += w * a["ai_demand"]["value"]
        t["s"] += w * a["supply_constraint"]["value"]
        t["e"] += w * a["export_controls"]["value"]
    out = []
    for mo, t in sorted(tl.items()):
        if t["w"] < 3:  # too little signal that month
            continue
        d, s_, e = t["d"] / t["w"], t["s"] / t["w"], t["e"] / t["w"]
        out.append({"month": mo, "n": t["n"], "relevant": round(t["w"], 1), "ai_demand": round(d, 3),
                    "supply_constraint": round(s_, 3), "export_controls": round(e, 3),
                    "index": round(50 + 50 * max(-1.0, min(1.0, 0.55 * d + 0.35 * s_ + 0.10 * e)), 1)})
    return out


def _wavg(rows: list[dict], k: str):
    w = sum(t["relevant"] for t in rows)
    return round(sum(t[k] * t["relevant"] for t in rows) / w, 3) if w else None


@app.function(image=image, secrets=secrets, volumes={"/data": vol}, timeout=2400)
def build_ai(refetch: bool = False) -> dict:
    """gpu module: add AI-era targeted headlines + AI demand/supply/export-control judgments.

    Reuses the judged headlines in /data/cache/signals: the standard 4 questions are only asked for new
    headlines, and the AI questions are cached per headline title so each headline is judged once.
    """
    t0 = time.time()
    vol.reload()
    m = "gpu"
    jpath = CACHE / f"judged_{m}.json"
    judged = json.loads(jpath.read_text(encoding="utf-8")) if jpath.exists() else []
    known = {_key(r["title"]) for r in judged}

    # 1) targeted AI-era headlines (cached on the volume)
    tpath = CACHE / "headlines_gpu_ai.json"
    if tpath.exists() and not refetch:
        extra = json.loads(tpath.read_text(encoding="utf-8"))
    else:
        parts = list(fetch_rss.map([m] * len(AI_QUERIES), [AI_WINDOWS] * len(AI_QUERIES),
                                   [[q] for q in AI_QUERIES]))
        extra = _dedupe([r for p in parts for r in p])
        _write(tpath, extra)
        vol.commit()
    new = [r for r in extra if _key(r["title"]) not in known]
    print("judged cache", len(judged), "targeted", len(extra), "new", len(new))

    # 2) standard judgments for new headlines only
    n_std = tok_in = tok_out = 0
    jobs = [(new[i:i + BATCH], m) for i in range(0, len(new), BATCH)]
    for res in judge_headlines.starmap(jobs, return_exceptions=True):
        if isinstance(res, Exception):
            print("std batch failed", res)
            continue
        judged += res["rows"]
        n_std += res["n_judgments"]
        tok_in += res["input_tokens"]
        tok_out += res["output_tokens"]

    # 3) AI-era judgments, cached by title
    apath = CACHE / "judged_gpu_ai.json"
    ai = json.loads(apath.read_text(encoding="utf-8")) if apath.exists() else {}
    todo = [r for r in judged if _key(r["title"]) not in ai]
    n_ai = 0
    for res in judge_ai.map([todo[i:i + BATCH] for i in range(0, len(todo), BATCH)], return_exceptions=True):
        if isinstance(res, Exception):
            print("ai batch failed", res)
            continue
        ai.update(res["ai"])
        n_ai += res["n_judgments"]
        tok_in += res["input_tokens"]
        tok_out += res["output_tokens"]
    _write(apath, ai)
    for r in judged:
        if _key(r["title"]) in ai:
            r["ai"] = ai[_key(r["title"])]
            r["ai_score"] = round(r["ai"]["ai_relevant_p"] * (r["ai"]["ai_demand"]["value"]
                                                            + r["ai"]["supply_constraint"]["value"]), 3)
    _write(jpath, judged)

    # 4) assemble the built gpu signals file (+ ai_index)
    out = OUT / f"{m}.json"
    prev = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    doc = _assemble(m, judged, prev.get("n_judgments", 0) + n_std + n_ai, len(judged))
    doc["region_judgments"] = prev.get("region_judgments", [])
    tl = _ai_timeline(judged)
    base = [t for t in tl if t["month"] < "2025-01"] or tl
    doc["ai_index"] = {
        "timeline": tl,
        "now": {k: _wavg(tl[-3:], k) for k in AI_KEYS},
        "trend_6m": {k: _wavg(tl[-6:], k) for k in AI_KEYS},
        "baseline": {k: _wavg(base, k) for k in AI_KEYS},
        "baseline_window": f"{base[0]['month']}..{base[-1]['month']}" if base else None,
        "n_relevant": sum(1 for r in judged if r.get("ai") and r["ai"]["ai_relevant_p"] >= 0.5),
        "n_judged": sum(1 for r in judged if r.get("ai")),
        "method": "Jev scores each headline (5-level Score -> -1..1) for AI compute demand, GPU/memory supply "
                  "constraint and export-control tightening; monthly relevance-weighted mean by headline date "
                  "(point-in-time). index = 50 + 50 x (0.55 demand + 0.35 supply + 0.10 export).",
    }
    _write(out, doc)
    sp = OUT / "_stats.json"
    stats = json.loads(sp.read_text()) if sp.exists() else {}
    stats["jev_judgments"] = stats.get("jev_judgments", 0) + n_std + n_ai
    stats["ai_layer"] = {"new_headlines": len(new), "std_judgments": n_std, "ai_judgments": n_ai,
                         "input_tokens": tok_in, "output_tokens": tok_out, "seconds": round(time.time() - t0, 1)}
    _write(sp, stats)
    vol.commit()
    return {"headlines": len(judged), "new": len(new), "std_judgments": n_std, "ai_judgments": n_ai,
            "months": len(tl), "ai_index": {k: doc["ai_index"][k] for k in ("now", "trend_6m", "baseline")},
            "net_supply_pressure": doc["net_supply_pressure"], "item_pressure": doc["item_pressure"],
            "tokens_in": tok_in, "seconds": round(time.time() - t0, 1)}


@app.local_entrypoint()
def ai(refetch: bool = False):
    print(json.dumps(build_ai.remote(refetch), indent=2))


@app.local_entrypoint()
def main(force: bool = False):
    print(json.dumps(build.remote(force), indent=2))


@app.local_entrypoint()
def regions(module: str = ""):
    """--module gpu re-judges only that module's regions."""
    print(json.dumps(judge_regions.remote(module), indent=2))


@app.local_entrypoint()
def latest(module_id: str = "latte"):
    rows = fetch_latest.remote(module_id, 10)
    res = judge_headlines.remote(rows, module_id)
    for r in res["rows"]:
        print(r["relevant_p"], r["supply_effect"]["label"], r["title"][:90])
