"""Build data/built/summary.json from forecasts, signals, satellite anomalies and _stats.json files.

    .\\.venv\\Scripts\\python scripts/build_summary.py            # summary only (drops stale briefing cache)
    .\\.venv\\Scripts\\python scripts/build_summary.py --briefing # also pre-render the spoken briefing
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from backend import data  # noqa: E402


def main():
    s = data.compute_summary()
    data.write_json("summary.json", s)
    for m in s["modules"]:
        print(f"{m['emoji']} {m['name']:<14} pressure={m['pressure']}  top={m['top_item']}  "
              f"p_up={m['prob_up_6m']}  6m={m['change_6m_pct']}%")
    print("stats:", s["stats"])
    print("->", data.DATA / "summary.json")
    for f in ("briefing.wav", "briefing.txt"):  # numbers changed -> regenerate briefing
        (data.DATA / f).unlink(missing_ok=True)
    if "--briefing" in sys.argv:
        from backend.briefing import build_briefing
        wav = asyncio.run(build_briefing())
        print(f"briefing.wav {len(wav) // 1024} KB:", (data.DATA / "briefing.txt").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
