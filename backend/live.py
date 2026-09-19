"""Process-wide live counters shown in Mission Control."""
import time

COUNTERS = {"asks": 0, "gemini_calls": 0, "jev_judgments": 0, "scans": 0, "tiles_scanned": 0,
            "containers_active": 0, "started_at": time.time()}
