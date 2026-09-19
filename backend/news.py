"""News hub: live Google News -> Jev fan-out on Modal, streamed as SSE, with a recorded replay fallback.

Pipeline: fetch_news (<=10 containers, many RSS queries per commodity) -> global dedupe -> batches of 25
-> judge_news (<=40 containers) -> each finished batch is streamed immediately as a "judged" event.
"""
import asyncio
import hashlib
import json
import random
import time

from backend import data
from backend.data import MODULES
from backend.live import COUNTERS

REPLAY = "news_replay.json"
BATCH = 25
FIRST_BATCH = 10          # smaller first batches -> first judged headline on screen sooner
MAX_HEADLINES = 4000
TARGET = 3000             # expected headlines (announced in "start"; refined in "fetched")
FETCH_MAX, JUDGE_MAX = 10, 40
QUERIES_PER_CALL = 3
WINDOWS = ("30d", "1y")  # fresh news first, then the past year for volume
DEADLINE_S = 50
PRICE_PER_TOKEN = 0.042e-6
MODULE_IDS = [m["id"] for m in MODULES]

_warm = {"until": 0.0, "task": None}
_fn_cache: dict = {}

NEWS_QUERIES = {
    "groceries": ["cocoa prices", "cocoa harvest Ivory Coast", "cocoa Ghana crop", "olive oil prices",
                  "olive harvest Spain", "orange juice prices", "citrus greening Brazil", "wheat prices",
                  "wheat harvest", "grain markets drought"],
    "latte": ["coffee prices", "arabica futures", "robusta prices", "Vietnam coffee harvest",
              "Brazil coffee harvest", "coffee frost drought", "Colombia coffee", "coffee shop prices UK"],
    "beer_wine": ["barley harvest", "barley prices", "hops harvest", "hop growers", "wine harvest",
                  "vineyard drought heatwave", "beer prices", "wine prices", "grape harvest"],
    "gpu": ["GPU prices", "Nvidia supply", "HBM shortage", "DRAM prices", "memory chip prices",
            "semiconductor shortage", "data centre construction", "AI capex hyperscalers", "TSMC capacity",
            "AI chip export controls"],
    "rent": ["London rents", "London rental market", "London housing supply", "London new homes",
             "UK rents", "London landlords", "UK house building"],
}


def sse(ev: dict) -> str:
    return f"data: {json.dumps(ev, default=str, ensure_ascii=False)}\n\n"


def _key(title: str) -> str:
    return " ".join((title or "").lower().split())[:120]


def trim(r: dict, module_id: str | None = None) -> dict:
    """Headline row -> the contract's item shape."""
    se = r.get("supply_effect") or {}
    sev = r.get("severity") or {}
    pp = r.get("price_pressure")
    if pp is None and isinstance(se.get("score"), (int, float)):
        pp = round((se["score"] - 2) / 2, 3)
    return {"id": hashlib.md5(_key(r.get("title")).encode()).hexdigest()[:12],
            "title": r.get("title"), "source": r.get("source"), "date": r.get("date"), "url": r.get("url"),
            "module_id": module_id or r.get("module_id"), "item_id": r.get("item_id"),
            "relevant_p": r.get("relevant_p"),
            "supply_effect": {"label": se.get("label"), "probs": se.get("probs") or {}},
            "price_pressure": pp if pp is not None else 0.0,
            "severity": {"label": sev.get("label")}, "confidence": r.get("confidence")}


class Pressure:
    """Relevance-weighted mean price_pressure per item / module."""

    def __init__(self):
        self.item, self.mod = {}, {}

    def add(self, it: dict):
        w = it.get("relevant_p") or 0
        p = it.get("price_pressure") or 0
        for d, k in ((self.mod, it.get("module_id")), (self.item, it.get("item_id"))):
            if not k or k == "none":
                continue
            a = d.setdefault(k, [0.0, 0.0])
            a[0] += w
            a[1] += w * p

    def event(self, t0: float) -> dict:
        f = lambda d: {k: round(v[1] / v[0], 3) for k, v in d.items() if v[0] > 0}  # noqa: E731
        return {"type": "pressure", "by_item": f(self.item), "by_module": f(self.mod),
                "elapsed_s": round(time.time() - t0, 2)}


# ---------------------------------------------------------------- Modal handles + prewarm
async def _fns():
    """Hydrated Modal handles, cached for the process (hydrating costs ~2 s; /api/news/warm pays it up front)."""
    if "fns" not in _fn_cache:
        import modal
        fetch = modal.Function.from_name("orbit-signals", "fetch_news")
        judge = modal.Function.from_name("orbit-signals", "judge_news")
        await asyncio.gather(fetch.hydrate.aio(), judge.hydrate.aio())
        _fn_cache["fns"] = (fetch, judge)
    return _fn_cache["fns"]


async def _set_min(fetch, judge, n_fetch: int, n_judge: int):
    try:
        await asyncio.gather(fetch.update_autoscaler.aio(min_containers=n_fetch),
                             judge.update_autoscaler.aio(min_containers=n_judge))
    except Exception as e:  # noqa: BLE001
        print("[news] autoscaler", e)


async def warm(seconds: float = 120) -> dict:
    """Pre-start containers (called when the News hub opens) so the live scan has no cold starts."""
    fetch, judge = await _fns()
    _warm["until"] = max(_warm["until"], time.time() + seconds)
    await _set_min(fetch, judge, FETCH_MAX, JUDGE_MAX)

    async def reset():
        while time.time() < _warm["until"]:
            await asyncio.sleep(max(1.0, _warm["until"] - time.time()))
        await _set_min(fetch, judge, 0, 0)
        _warm["task"] = None
    if not _warm["task"]:
        _warm["task"] = asyncio.create_task(reset())
    return {"ok": True, "warm_until": round(_warm["until"]), "fetch": FETCH_MAX, "judge": JUDGE_MAX}


# ---------------------------------------------------------------- live
async def live_events():
    """Yields contract events from a real Modal fan-out. Raises before the first yield if Modal is unreachable."""
    t0 = time.time()  # scan keeps containers warm; the reset task scales back to 0 afterwards
    el = lambda: round(time.time() - t0, 2)  # noqa: E731

    calls = []
    for m in MODULES:
        qs = NEWS_QUERIES.get(m["id"]) or [m["news_query"]]
        for w, win in enumerate(WINDOWS):
            part = [(qs[i:i + QUERIES_PER_CALL], m["id"], win) for i in range(0, len(qs), QUERIES_PER_CALL)]
            random.Random(w).shuffle(part)
            calls += [(w, c) for c in part]
    # interleave modules so every lane lights up early; fresh (30d) window before the 1-year window
    calls = [c for _, c in sorted(calls, key=lambda x: (x[0], random.Random(str(x[1])).random()))]

    yield {"type": "start", "target": TARGET, "modules": MODULE_IDS, "elapsed_s": 0,
           "queries": sum(len(c[0]) for c in calls), "fetch_calls": len(calls)}
    fetch, judge = await _fns()  # raises here (after "start") if Modal is unreachable -> caller replays
    asyncio.create_task(warm(60))  # scan keeps containers warm; the reset task scales back to 0 afterwards

    st = {"fetched": 0, "judged": 0, "judgments": 0, "calls": 0, "tok_in": 0, "tok_out": 0, "inflight": 0,
          "runners": 0, "peak": 0, "first_batch": True}
    seen, judge_tasks, fetch_tasks = set(), set(), set()
    per_mod = {m: 0 for m in MODULE_IDS}
    pres = Pressure()
    q: asyncio.Queue = asyncio.Queue()
    pending: list[asyncio.Task] = []

    def containers():
        n = min(JUDGE_MAX, max(len(judge_tasks), st["runners"])) + min(FETCH_MAX, len(fetch_tasks))
        st["peak"] = max(st["peak"], n)
        return n

    async def judge_one(batch, mid):
        st["inflight"] += 1
        try:
            res = await judge.remote.aio(batch, mid)
        except Exception as e:  # noqa: BLE001
            print("[news] judge failed", mid, str(e)[:120])
            return
        finally:
            st["inflight"] -= 1
        if res.get("task_id"):
            judge_tasks.add(res["task_id"])
        items = [trim(r, mid) for r in res.get("rows") or []]
        for it in items:
            pres.add(it)
        st["judged"] += len(items)
        st["judgments"] += res.get("n_judgments") or len(items) * 4
        st["calls"] += 1
        st["tok_in"] += res.get("input_tokens") or 0
        st["tok_out"] += res.get("output_tokens") or 0
        COUNTERS["jev_judgments"] += res.get("n_judgments") or 0
        await q.put({"type": "judged", "items": items, "total_judged": st["judged"], "judgments": st["judgments"],
                     "jev_calls": st["calls"], "containers_active": containers(), "tokens_in": st["tok_in"],
                     "elapsed_s": el()})

    def dispatch(rows, mid):
        i = 0
        while i < len(rows):
            size = FIRST_BATCH if st["first_batch"] else BATCH
            if st["first_batch"] and i >= 2 * FIRST_BATCH:
                st["first_batch"] = False
                size = BATCH
            pending.append(asyncio.create_task(judge_one(rows[i:i + size], mid)))
            i += size
        if i:
            st["first_batch"] = False

    async def fetch_all():
        async for res in fetch.starmap.aio(calls, order_outputs=False, return_exceptions=True):
            if not isinstance(res, dict):
                print("[news] fetch failed", str(res)[:120])
                continue
            if res.get("task_id"):
                fetch_tasks.add(res["task_id"])
            mid = res["module_id"]
            new = []
            for r in res.get("rows") or []:
                k = _key(r.get("title"))
                if k in seen or st["fetched"] + len(new) >= MAX_HEADLINES:
                    continue
                seen.add(k)
                new.append(r)
            st["fetched"] += len(new)
            per_mod[mid] += len(new)
            dispatch(new, mid)  # pipeline: judge as soon as headlines arrive
            await q.put({"type": "fetched", "module_id": mid, "n": len(new), "module_total": per_mod[mid],
                         "total_fetched": st["fetched"], "target": max(TARGET, st["fetched"]), "elapsed_s": el()})

    async def ticker(stop):
        while not stop.is_set():
            await asyncio.sleep(1.0)
            try:
                s = await judge.get_current_stats.aio()
                st["runners"] = min(JUDGE_MAX, s.num_total_runners or 0)
            except Exception:  # noqa: BLE001
                pass
            await q.put(pres.event(t0))

    stop = asyncio.Event()
    ft = asyncio.create_task(fetch_all())
    tick = asyncio.create_task(ticker(stop))
    deadline = t0 + DEADLINE_S
    while time.time() < deadline:
        if ft.done() and all(t.done() for t in pending) and q.empty():
            break
        try:
            ev = await asyncio.wait_for(q.get(), 0.25)
        except asyncio.TimeoutError:
            continue
        if ev["type"] == "judged":
            COUNTERS["containers_active"] = ev["containers_active"]
        yield ev
    stop.set()
    tick.cancel()
    ft.cancel()
    for t in pending:
        t.cancel()
    COUNTERS["containers_active"] = 0
    secs = max(0.01, time.time() - t0)
    yield pres.event(t0)
    yield {"type": "done", "total_judged": st["judged"], "judgments": st["judgments"], "jev_calls": st["calls"],
           "seconds": round(secs, 2), "cost_usd": round((st["tok_in"] + st["tok_out"]) * PRICE_PER_TOKEN, 4),
           "containers_peak": min(FETCH_MAX + JUDGE_MAX, max(st["peak"], len(judge_tasks) + len(fetch_tasks))),
           "headlines_per_s": round(st["judged"] / secs, 1), "judgments_per_s": round(st["judgments"] / secs, 1),
           "total_fetched": st["fetched"], "tokens_in": st["tok_in"], "tokens_out": st["tok_out"],
           "elapsed_s": round(secs, 2)}


# ---------------------------------------------------------------- replay
def _synthetic() -> list:
    """Replay built from the judged signals files if nothing was ever recorded (offline safety net)."""
    rows = latest(limit=1200)["items"]
    random.Random(3).shuffle(rows)
    evs = [{"type": "start", "target": len(rows), "modules": MODULE_IDS, "elapsed_s": 0}]
    t, pres, n, fetched = 0.4, Pressure(), 0, 0
    for m in MODULE_IDS:
        k = sum(1 for r in rows if r["module_id"] == m)
        fetched += k
        t += 0.25
        evs.append({"type": "fetched", "module_id": m, "n": k, "total_fetched": fetched, "elapsed_s": round(t, 2)})
    t = 2.2
    for i in range(0, len(rows), BATCH):
        b = rows[i:i + BATCH]
        n += len(b)
        for it in b:
            pres.add(it)
        t += random.Random(i).uniform(0.05, 0.3)
        evs.append({"type": "judged", "items": b, "total_judged": n, "judgments": n * 4, "jev_calls": i // BATCH + 1,
                    "containers_active": min(JUDGE_MAX, 8 + i // BATCH), "tokens_in": n * 356,
                    "elapsed_s": round(t, 2)})
        if (i // BATCH) % 4 == 0:
            evs.append(pres.event(time.time() - t))
    evs.append(pres.event(time.time() - t))
    evs.append({"type": "done", "total_judged": n, "judgments": n * 4, "jev_calls": -(-n // BATCH),
                "seconds": round(t, 2), "cost_usd": round(n * 450 * PRICE_PER_TOKEN, 4), "containers_peak": 50,
                "headlines_per_s": round(n / t, 1), "judgments_per_s": round(n * 4 / t, 1), "elapsed_s": round(t, 2)})
    return evs


async def replay_events():
    rec = data.read_json(REPLAY) or {}
    evs = rec.get("events") or _synthetic()
    start = time.time()
    for ev in evs:
        wait = (ev.get("elapsed_s") or 0) - (time.time() - start)
        if wait > 0:
            await asyncio.sleep(min(wait, 3))
        if ev.get("type") == "judged":
            COUNTERS["containers_active"] = ev.get("containers_active", 0)
        yield dict(ev, replay=True)
    COUNTERS["containers_active"] = 0


def _save_recording(events: list):
    data.write_json(REPLAY, {"recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "events": events})
    try:
        import modal
        vol = modal.Volume.from_name("orbit-data")
        with vol.batch_upload(force=True) as b:
            b.put_file(str(data.DATA / REPLAY), "/built/news_replay.json")
    except Exception as e:  # noqa: BLE001
        print("[news] volume upload failed", e)


async def news_stream(mode: str = "live"):
    COUNTERS["scans"] += 1
    if mode != "replay":
        recorded, ok, done, started = [], False, None, False
        try:
            async for ev in live_events():
                if ev["type"] == "start":
                    started = True
                else:
                    ok = True
                recorded.append(ev)
                if ev["type"] == "done":
                    done = ev
                    if not ev.get("total_judged"):  # nothing judged (Jev/RSS down): fall back to the replay
                        ok = False
                        break
                yield sse(ev)
        except Exception as e:  # noqa: BLE001
            if ok:
                yield sse({"type": "done", "error": str(e)[:200], "total_judged": 0, "judgments": 0})
            else:
                print(f"[news] Modal unavailable ({type(e).__name__}: {e}); replaying recording")
        if ok:
            if done and done.get("total_judged", 0) >= 300:
                await asyncio.to_thread(_save_recording, recorded)
            return
    else:
        started = False
    async for ev in replay_events():
        if started and ev.get("type") == "start":
            continue  # live already announced the scan
        yield sse(ev)


# ---------------------------------------------------------------- latest (from judged signals files)
def latest(limit: int = 300, module: str = "all") -> dict:
    mods = MODULE_IDS if module in ("all", "", None) else [module]
    items, by_module, heads, judg = [], {}, 0, 0
    for m in mods:
        doc = data.read_json(f"signals/{m}.json") or {}
        rows = [trim(r, m) for r in doc.get("headlines") or [] if r.get("title")]
        items += rows
        heads += doc.get("n_headlines") or len(rows)
        judg += doc.get("n_judgments") or 0
        by_module[m] = {"net_supply_pressure": doc.get("net_supply_pressure"), "n_headlines": doc.get("n_headlines"),
                        "n_judgments": doc.get("n_judgments"), "n_relevant": doc.get("n_relevant"),
                        "item_pressure": doc.get("item_pressure") or {}}
    items.sort(key=lambda r: ((r.get("relevant_p") or 0) >= 0.5, r.get("date") or "", r.get("relevant_p") or 0),
               reverse=True)
    stats = data.read_json("signals/_stats.json") or {}
    if module in ("all", "", None) and stats:
        heads = max(heads, stats.get("headlines") or 0)
        judg = max(judg, stats.get("jev_judgments") or 0)
    return {"items": items[:max(1, min(int(limit), 5000))], "totals": {"headlines": heads, "judgments": judg},
            "by_module": by_module}

