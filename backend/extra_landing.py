"""Landing page: /landing serves frontend/landing.html (a 5-10 s demo opener)."""
from fastapi import APIRouter
from fastapi.responses import FileResponse, RedirectResponse

from backend import data

router = APIRouter()


@router.get("/landing", include_in_schema=False)
def landing():
    p = data.FRONTEND / "landing.html"
    return FileResponse(p, headers={"Cache-Control": "no-cache"}) if p.exists() else RedirectResponse("/")
