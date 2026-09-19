"""Live (latest-month) statsforecast fits for the Orbit v2 stat_combo member, reusing orbit-zoo-stats' fit_batch.

    .\.venv\Scripts\modal run modal_app/zoo_live.py   -> data/cache/eval/live_stats.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from zoo_stats import CACHE, app, fit_batch  # noqa: E402,F401


@app.local_entrypoint()
def live():
    hists = json.loads((CACHE / "histories.json").read_text())
    jobs = [{"key": f"{it}|{h['months'][-1]}", "months": h["months"], "values": h["values"]} for it, h in hists.items()]
    out = {}
    for r in fit_batch.map([[j] for j in jobs]):
        out.update(r)
    (CACHE / "live_stats.json").write_text(json.dumps(out))
    print("live fits:", {k: list(v) for k, v in out.items()})
