"""Mission Control idle state: the last recorded scan's Jev throughput (judgments per second) from scan_replay.json."""
from fastapi import APIRouter

from backend import data

router = APIRouter()


@router.get("/api/scan/last")
def scan_last():
    rec = data.read_json("scan_replay.json") or {}
    ev = rec.get("events") or []
    if not ev:
        return {"recorded_at": None, "jps": [], "peak_jps": 0}
    n = int(max(e.get("elapsed_s") or 0 for e in ev)) + 1
    cum = [0] * n
    for e in ev:
        s = int(e.get("elapsed_s") or 0)
        cum[s] = max(cum[s], e.get("jev_judgments") or 0)
    for i in range(1, n):
        cum[i] = max(cum[i], cum[i - 1])
    jps = [cum[0]] + [cum[i] - cum[i - 1] for i in range(1, n)]
    last = ev[-1]
    return {"recorded_at": rec.get("recorded_at"), "jps": jps, "peak_jps": max(jps),
            "tiles": last.get("tiles_done"), "jev_judgments": last.get("jev_judgments"), "elapsed_s": last.get("elapsed_s")}
