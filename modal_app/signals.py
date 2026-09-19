"""orbit-signals: news headlines -> Jev typed judgments at scale, on Modal.

  modal run modal_app/signals.py              # fetch + judge -> /data/built/signals/{module}.json (+ _stats.json)
  modal run modal_app/signals.py --force      # refetch headlines and rejudge
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
    "gpu": ["TSMC water drought", "chip shortage", "DRAM prices", "GPU prices", "semiconductor supply chain",
            "Taiwan shipping"],
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
def fetch_rss(module_id: str, n_windows: int = 8) -> list[dict]:
    """Google News RSS: several queries x quarterly windows (~100 items each)."""
    import httpx
    from concurrent.futures import ThreadPoolExecutor

    m = next(x for x in MODULES if x["id"] == module_id)
    queries = [m["news_query"]] + RSS_QUERIES.get(module_id, [])
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

    if sig == "water":
        instr = ("Based on the reservoir water-index (NDWI) history in `satellite` for the region in `region`, "
                 "how high is the risk of water shortage constraining chip/semiconductor production in the next months?")
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
def judge_regions() -> dict:
    """Jev reads each region's satellite stats JSON -> harvest/water/disruption risk, merged into signals files."""
    from concurrent.futures import ThreadPoolExecutor

    from typesafe_sdk import TypeSafeClient

    vol.reload()
    sat_dir = Path("/data/built/satellite")
    todo = []
    for reg in REGIONS:
        p = sat_dir / f"{reg['id']}.json"
        if p.exists():
            todo.append((reg, json.loads(p.read_text(encoding="utf-8"))))
    print("regions with satellite data:", len(todo), "/", len(REGIONS))

    def one(arg):
        reg, sat = arg
        series = [{k: s.get(k) for k in ("month", "ndvi", "ndwi", "ndbi", "cloud_pct")} for s in sat.get("series", [])]
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
    stats["region_judgments"] = n
    stats["region_input_tokens"] = tok
    _write(sp, stats)
    vol.commit()
    return {"region_judgments": n, "input_tokens": tok,
            "risks": {j["region_id"]: j["harvest_risk"]["label"] for v in by_mod.values() for j in v}}


@app.local_entrypoint()
def main(force: bool = False):
    print(json.dumps(build.remote(force), indent=2))


@app.local_entrypoint()
def regions():
    print(json.dumps(judge_regions.remote(), indent=2))


@app.local_entrypoint()
def latest(module_id: str = "latte"):
    rows = fetch_latest.remote(module_id, 10)
    res = judge_headlines.remote(rows, module_id)
    for r in res["rows"]:
        print(r["relevant_p"], r["supply_effect"]["label"], r["title"][:90])
