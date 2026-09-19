"""/api/scan: live Modal fan-out streamed as SSE events, with a recorded replay fallback."""
import asyncio
import json
import random
import time

from backend import data
from backend.data import MODULES, REGIONS
from backend.live import COUNTERS

REPLAY = "scan_replay.json"
GPU_MODEL_DEFAULT = "Chronos-Bolt on NVIDIA L4"


def _gpu_model():
    return data.get_summary().get("stats", {}).get("gpu_model") or GPU_MODEL_DEFAULT


SCAN_MONTHS = 6  # 16 regions x 6 months = 96 tiles in parallel


def sse(ev: dict) -> str:
    return f"data: {json.dumps(ev, default=str)}\n\n"


async def live_events(month: str | None = None):
    """Yields event dicts from a real Modal fan-out. Raises before the first yield if Modal is unreachable."""
    import modal
    process_tile = modal.Function.from_name("orbit-satellite", "process_tile")
    fetch_latest = modal.Function.from_name("orbit-signals", "fetch_latest")
    judge = modal.Function.from_name("orbit-signals", "judge_headlines")
    await process_tile.hydrate.aio()  # fail fast if the app isn't deployed / no auth
    month = month or data.latest_month()
    t0 = time.time()
    gpu = _gpu_model()
    y, mm = map(int, month.split("-"))
    months = []
    for i in range(SCAN_MONTHS):
        m2, y2 = mm - i, y
        while m2 < 1:
            m2 += 12
            y2 -= 1
        months.append(f"{y2:04d}-{m2:02d}")
    pairs = [(r["id"], m) for m in months for r in REGIONS]
    st = {"tiles_done": 0, "tiles_total": len(pairs), "jev_judgments": 0, "inflight": 0}
    q: asyncio.Queue = asyncio.Queue()

    def base(**kw):
        return {"containers_active": st["inflight"], "tiles_done": st["tiles_done"], "tiles_total": st["tiles_total"],
                "jev_judgments": st["jev_judgments"], "gpu_model": gpu, "elapsed_s": round(time.time() - t0, 2),
                "modal_runners": st.get("runners"), **kw}

    async def tiles():
        st["inflight"] += len(pairs)
        async for res in process_tile.starmap.aio(pairs, kwargs={"force": True},
                                                  order_outputs=False, return_exceptions=True):
            st["inflight"] = max(0, st["inflight"] - 1)
            st["tiles_done"] += 1
            COUNTERS["tiles_scanned"] += 1
            ev = {"type": "progress", "kind": "tile"}
            if isinstance(res, dict):
                rid = res.get("region_id")
                ev.update(region_id=rid, module_id=res.get("module") or data.REGION_BY_ID.get(rid, {}).get("module"),
                          thumb=res.get("thumb"), ndvi=res.get("ndvi"), ndwi=res.get("ndwi"), month=res.get("month"))
                if not ev["thumb"] and rid:
                    ev["thumb"], _ = data.latest_thumb(rid)
            else:
                ev["error"] = str(res)[:200]
            await q.put(base(**ev))

    async def signals(module_id: str):
        try:
            st["inflight"] += 1
            heads = await asyncio.wait_for(fetch_latest.remote.aio(module_id, 40), 60)
            st["inflight"] -= 1
            batches = [heads[i:i + 10] for i in range(0, len(heads), 10)] or []
            st["inflight"] += len(batches)
            async for res in judge.map.aio(batches, kwargs={"module_id": module_id},
                                           order_outputs=False, return_exceptions=True):
                st["inflight"] = max(0, st["inflight"] - 1)
                if isinstance(res, dict):
                    n = res.get("n_judgments") or len(res.get("rows") or []) * 4
                    res = res.get("rows") or []
                else:
                    n = len(res) * 4 if isinstance(res, list) else 0
                st["jev_judgments"] += n
                COUNTERS["jev_judgments"] += n
                top = res[0].get("title") if isinstance(res, list) and res and isinstance(res[0], dict) else None
                await q.put(base(type="progress", kind="signals", module_id=module_id, headline=top))
        except Exception as e:
            st["inflight"] = max(0, st["inflight"] - 1)
            await q.put(base(type="progress", kind="signals", module_id=module_id, error=str(e)[:200]))

    async def ticker(stop: asyncio.Event):
        while not stop.is_set():
            await asyncio.sleep(1.0)
            try:
                s = await process_tile.get_current_stats.aio()
                st["runners"] = s.num_total_runners
            except Exception:
                pass
            await q.put(base(type="progress", kind="tick"))

    yield base(type="start", month=month)
    stop = asyncio.Event()
    tasks = [asyncio.create_task(tiles())] + [asyncio.create_task(signals(m["id"])) for m in MODULES]
    tick = asyncio.create_task(ticker(stop))
    done_all = asyncio.gather(*tasks, return_exceptions=True)
    deadline = t0 + 240
    while True:
        if done_all.done() and q.empty():
            break
        if time.time() > deadline:
            break
        try:
            ev = await asyncio.wait_for(q.get(), 0.5)
            COUNTERS["containers_active"] = ev["containers_active"]
            yield ev
        except asyncio.TimeoutError:
            pass
    stop.set()
    tick.cancel()
    for t in tasks:
        t.cancel()
    st["inflight"] = 0
    COUNTERS["containers_active"] = 0
    yield base(type="done", month=month)


def synthetic_recording() -> list:
    """Plausible replay if nothing was ever recorded (keeps the demo alive offline)."""
    evs, t, done, jev = [], 0.0, 0, 0
    gpu = _gpu_model()
    total = len(REGIONS)
    evs.append({"type": "start", "containers_active": 0, "tiles_done": 0, "tiles_total": total, "jev_judgments": 0,
                "gpu_model": gpu, "elapsed_s": 0.0, "month": data.latest_month()})
    regions = REGIONS[:]
    random.Random(7).shuffle(regions)
    active = total + 25
    for i, r in enumerate(regions):
        t += random.Random(i).uniform(0.4, 1.3)
        done += 1
        jev += 40
        active = max(3, active - random.Random(i + 99).randint(1, 3))
        thumb, ndvi = data.latest_thumb(r["id"])
        evs.append({"type": "progress", "kind": "tile", "containers_active": active, "tiles_done": done,
                    "tiles_total": total, "jev_judgments": jev, "gpu_model": gpu, "elapsed_s": round(t, 2),
                    "region_id": r["id"], "module_id": r["module"], "thumb": thumb, "ndvi": ndvi})
        if i % 3 == 0:
            m = MODULES[(i // 3) % len(MODULES)]
            jev += 40
            evs.append({"type": "progress", "kind": "signals", "containers_active": active, "tiles_done": done,
                        "tiles_total": total, "jev_judgments": jev, "gpu_model": gpu, "elapsed_s": round(t + 0.2, 2),
                        "module_id": m["id"]})
    evs.append({"type": "done", "containers_active": 0, "tiles_done": total, "tiles_total": total,
                "jev_judgments": jev, "gpu_model": gpu, "elapsed_s": round(t + 0.5, 2)})
    return evs


async def replay_events():
    rec = data.read_json(REPLAY) or {}
    evs = rec.get("events") or synthetic_recording()
    start = time.time()
    for ev in evs:
        wait = (ev.get("elapsed_s") or 0) - (time.time() - start)
        if wait > 0:
            await asyncio.sleep(min(wait, 3))
        e = dict(ev, replay=True)
        if e.get("type") == "progress":
            COUNTERS["containers_active"] = e.get("containers_active", 0)
            if e.get("kind") == "tile":
                COUNTERS["tiles_scanned"] += 1
        yield e
    COUNTERS["containers_active"] = 0


async def scan_stream(mode: str = "auto"):
    COUNTERS["scans"] += 1
    recorded, ok = [], False
    if mode != "replay":
        try:
            async for ev in live_events():
                ok = True
                if ev.get("kind") != "tick":
                    recorded.append(ev)
                yield sse(ev)
        except Exception as e:
            if ok:  # failed mid-scan: close gracefully
                yield sse({"type": "done", "error": str(e)[:200], "containers_active": 0})
            else:
                print(f"[scan] Modal unavailable ({type(e).__name__}: {e}); replaying recording")
        if ok:
            tiles_ok = sum(1 for e in recorded if e.get("kind") == "tile" and not e.get("error"))
            if tiles_ok >= len(REGIONS) // 2:
                data.write_json(REPLAY, {"recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "events": recorded})
            return
    async for ev in replay_events():
        yield sse(ev)
