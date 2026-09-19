"""Rent Radar neighbourhood detail: H3 hexagons built by modal_app/rent_detail.py."""
from fastapi import APIRouter

from backend import data

router = APIRouter()


@router.get("/api/rent/hex")
def rent_hex():
    return data.read_json("rent/hex.json") or {"type": "FeatureCollection", "features": []}
