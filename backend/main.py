"""Orbit FastAPI backend. Run: .\\.venv\\Scripts\\uvicorn backend.main:app --reload --port 8000"""
import asyncio
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import data
from backend.live import COUNTERS

@asynccontextmanager
async def lifespan(app):
    async def warm():  # pre-import SDKs/clients so the first /api/ask on stage is fast
        try:
            from backend.agent import gemini
            import typesafe_sdk  # noqa: F401
            await asyncio.to_thread(gemini)
        except Exception as e:
            print("[warmup]", e)
    async def reload_volume():  # on Modal: pick up new data other apps wrote to the Volume
        import modal
        vol = modal.Volume.from_name(os.environ["ORBIT_VOLUME"])
        while True:
            await asyncio.sleep(60)
            try:
                await vol.reload.aio()
            except Exception as e:
                print("[volume reload]", e)
    asyncio.create_task(warm())
    if os.environ.get("ORBIT_VOLUME"):
        asyncio.create_task(reload_volume())
    yield


app = FastAPI(title="Orbit", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

PLACEHOLDER = """<!doctype html><title>Orbit</title><body style="font-family:system-ui;background:#05070d;color:#e6ecff;
display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>🛰️ Orbit</h1>
<p>Satellites see prices rising months before you pay them.</p><p><a style="color:#8ab4ff" href="/api/summary">/api/summary</a></p></div>"""


@app.get("/", response_class=HTMLResponse)
def index():
    p = data.FRONTEND / "index.html"
    return FileResponse(p) if p.exists() else HTMLResponse(PLACEHOLDER)


class _LazyStatic(StaticFiles):
    """StaticFiles that tolerates the directory not existing yet."""
    def __init__(self, directory):
        super().__init__(directory=str(directory), check_dir=False)

    async def __call__(self, scope, receive, send):
        if not self.directory or not __import__("os").path.isdir(self.directory):
            return await Response(status_code=404)(scope, receive, send)
        return await super().__call__(scope, receive, send)


app.mount("/static", _LazyStatic(data.FRONTEND), name="static")

_SAFE = re.compile(r"^[A-Za-z0-9_\-]+$")


@app.get("/tiles/{region_id}/{fname}")
def tile(region_id: str, fname: str):
    month = fname.removesuffix(".png")
    if not _SAFE.match(region_id) or not re.match(r"^\d{4}-\d{2}$", month):
        raise HTTPException(404)
    p = data.DATA / "tiles" / region_id / f"{month}.png"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/summary")
def summary():
    return data.get_summary()


@app.get("/api/modules/{module_id}")
def module(module_id: str):
    v = data.module_view(module_id)
    if not v:
        raise HTTPException(404, f"unknown module {module_id}")
    return v


@app.get("/api/rent")
def rent():
    return data.read_json("rent/london.json") or {"type": "FeatureCollection", "features": []}


@app.get("/api/eval")
def eval_summary():
    """Track record: rolling-origin backtest summary (data/built/eval/summary.json)."""
    return data.read_json("eval/summary.json") or {}


@app.get("/api/leaderboard")
def leaderboard():
    """Model zoo leaderboard (VAL + TEST metrics) and the Orbit v2 stack (data/built/eval/leaderboard.json)."""
    return data.read_json("eval/leaderboard.json") or {}


@app.get("/api/eval/{item_id}")
def eval_item(item_id: str):
    v = data.read_json(f"eval/{item_id}.json") if item_id.replace("_", "").isalnum() else None
    if not v:
        raise HTTPException(404, f"no evaluation for {item_id}")
    return v


class AskIn(BaseModel):
    question: str


@app.post("/api/ask")
async def ask(body: AskIn):
    from backend.agent import ask as run_ask
    return await run_ask(body.question)


@app.get("/api/scan")
async def scan(mode: str = "auto"):
    from backend.scan import scan_stream
    return StreamingResponse(scan_stream(mode), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/briefing")
async def briefing(force: bool = False):
    p = data.DATA / "briefing.wav"
    if p.exists() and not force:
        return FileResponse(p, media_type="audio/wav")
    try:
        from backend.briefing import build_briefing
        wav = await build_briefing()
        return Response(wav, media_type="audio/wav")
    except Exception as e:
        if p.exists():
            return FileResponse(p, media_type="audio/wav")
        return JSONResponse({"error": f"briefing unavailable: {e}"}, status_code=503)


@app.get("/api/briefing/text")
def briefing_text():
    p = data.DATA / "briefing.txt"
    return {"text": p.read_text(encoding="utf-8") if p.exists() else None}


@app.get("/api/stats")
def stats():
    s = dict(data.get_summary().get("stats") or {})
    live = {k: v for k, v in COUNTERS.items() if k != "started_at"}
    s["jev_judgments_total"] = (s.get("jev_judgments") or 0) + COUNTERS["jev_judgments"]
    s["gemini_calls_total"] = (s.get("gemini_calls") or 0) + COUNTERS["gemini_calls"]
    s["tiles_processed_total"] = (s.get("tiles_processed") or 0) + COUNTERS["tiles_scanned"]
    s["live"] = live
    s["uptime_s"] = round(time.time() - COUNTERS["started_at"])
    return s


@app.get("/api/health")
def health():
    return {"ok": True, "data_dir": str(data.DATA), "data_exists": data.DATA.exists(),
            "frontend": (data.FRONTEND / "index.html").exists()}


from backend.extra_rent import router as _rent_router  # noqa: E402
app.include_router(_rent_router)
from backend.extra_mission import router as _mission_router  # noqa: E402
app.include_router(_mission_router)
from backend.extra_landing import router as _landing_router  # noqa: E402
app.include_router(_landing_router)
