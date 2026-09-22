"""Process-wide live counters shown in Mission Control, and the showcase switch."""
import os
import time

COUNTERS = {"asks": 0, "gemini_calls": 0, "deepseek_calls": 0, "jev_judgments": 0, "scans": 0, "tiles_scanned": 0,
            "containers_active": 0, "started_at": time.time()}

# ORBIT_SHOWCASE=1 (set on the public Modal deploy): the hackathon demo is over, so no live Jev / LLM / Modal
# fan-outs. Scans replay the on-stage recording and Ask routes by keywords; run locally for the live pipeline.
SHOWCASE = os.environ.get("ORBIT_SHOWCASE", "").lower() in ("1", "true", "yes")
