"""News hub API: live Jev news scan (SSE), latest judged headlines, container prewarm."""
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from backend import news
from backend.live import SHOWCASE

router = APIRouter()


@router.get("/api/news/scan")
async def news_scan(mode: str = "live"):
    if SHOWCASE:
        mode = "replay"  # no live Jev fan-out on the public deploy
    return StreamingResponse(news.news_stream(mode), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/api/news/latest")
def news_latest(limit: int = 300, module: str = "all"):
    return news.latest(limit, module)


@router.get("/api/news/warm")
async def news_warm():
    """Call when the News hub opens: pre-starts fetch/judge containers for ~2 min so Scan has no cold start."""
    if SHOWCASE:
        return {"ok": False, "showcase": True}
    try:
        return await news.warm(120)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}
