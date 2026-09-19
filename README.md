# Orbit: the AI operating system for tomorrow's prices

> **Satellites see prices rising months before you pay them.**
> Gemini sees · Jev judges · Modal scales

Orbit watches 16 farms, reservoirs and ports from orbit using real Sentinel-2 imagery. It has Jev judge tens of thousands of news headlines, and it forecasts what a Londoner will pay for a latte, a bar of chocolate, a pint, a GPU or a 1-bed flat.

**Live:** https://bernararno17--orbit-web-web.modal.run

## Architecture

```
                 Modal (heavy compute, Volume "orbit-data" → /data/built)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ orbit-satellite  Sentinel-2 (Planetary Computer) 16 regions × 92 months  │
 │                  = 1,472 tiles, ≤100 CPU containers → NDVI/NDWI/NDBI+PNG │
 │ orbit-signals    Google News/GDELT → 16.7k headlines → 67k Jev judgments │
 │                  + Jev harvest-risk judgment per satellite region        │
 │ orbit-forecast   FRED/synthetic prices → TimesFM 3.0 → p10/p50/p90       │
 │ orbit-rent       33 London boroughs, Sentinel-2 built-up change → 3D     │
 │ orbit-web        FastAPI + frontend (this dashboard, public URL)         │
 └──────────────────────────────────────────────────────────────────────────┘
        │ scripts/pull_data.py                     ▲ /api/scan fans out live
        ▼                                          │ (96 tiles + Jev batches)
 data/built/*.json ──► scripts/build_orbit_signal.py (TimesFM + Jev news + satellite overlay, backtests)
                   ──► scripts/build_insights.py     (Gemini vision: then vs now tiles, 3 cards/module)
                   ──► scripts/build_summary.py      (pressure 0-100 per module, stats)
                   ──► backend/ (FastAPI) ──► frontend/ (vanilla JS, ECharts, deck.gl)
                          /api/ask:      Jev routes intent (calibrated) → Gemini function-calling
                          /api/briefing: Gemini writes the script → Gemini TTS (cached wav)
```

## Run it locally

```powershell
.\.venv\Scripts\pip install -r requirements.txt       # .env holds GEMINI_API_KEY, TYPESAFE_API_KEY
.\.venv\Scripts\python scripts/pull_data.py            # data/built/ from the Modal Volume (tiles ~210 MB)
.\.venv\Scripts\uvicorn backend.main:app --port 8000   # open http://localhost:8000
```

To rebuild the data, run each Modal app with `.\.venv\Scripts\modal run modal_app/<x>.py`. Signals need `PYTHONPATH=.` and `::main`. Then run:

```powershell
$env:PYTHONPATH="."; .\.venv\Scripts\modal run modal_app/signals.py::regions   # Jev region judgments
.\.venv\Scripts\python scripts/pull_data.py
.\.venv\Scripts\python scripts/build_orbit_signal.py
.\.venv\Scripts\python scripts/build_insights.py --force
.\.venv\Scripts\python scripts/build_summary.py --briefing
.\.venv\Scripts\modal deploy modal_app/web.py
```

To make the public app serve new data, upload any locally rebuilt files to the Volume with `modal volume put --force orbit-data data/built/<x> /built/<x>`.

**Presenter shortcuts:**
- `#/mission/scan` starts a live scan.
- `#/mission/replay` plays the recorded scan. Use it if the Wi-Fi dies.
- `#/ask/<question>` asks that question on load.

## 3-minute demo script

| Time | Click | Say |
|---|---|---|
| 0:00 | **Overview** | "Prices don't start rising at the till. They start in a drought in Jaén, or a dry reservoir next to TSMC. Orbit watches those places from space." Point at the 5 pressure scores and at Tomorrow's Basket: *"+1.6% in 6 months."* |
| 0:25 | Satellite watchlist map | "16 real Sentinel-2 regions: cocoa, coffee, olives, hops, vines and Taiwan's fab reservoirs. That's 1,472 tiles we processed on 100 Modal containers." |
| 0:40 | **Groceries → Olive oil** | Point at the backtest strip. "March 2023: the model alone said −2%. Satellites saw the Jaén groves 10% browner than normal, and Orbit flagged it. Olive oil went up 39%." Drag the before/after slider. "And today the groves are greener again, so Orbit expects olive oil to *ease*." |
| 1:05 | **Latte Index** | "Each square is a headline, and Jev judged every one: 8,700 typed judgments for coffee alone, with calibrated probabilities. Gemini reads the satellite tiles and writes these cards." Point at *£3.95 → £4.10*. |
| 1:25 | **Rent Radar** | "London in 3D. Height is new building seen from orbit, and colour is rent pressure. Newham is on top: little new supply plus Elizabeth-line demand." Hover over a borough. |
| 1:50 | **Mission Control → Scan now** | "Now live. Scan now fans out 96 satellite tiles and 5 news sweeps across Modal: 100+ containers, hundreds of Jev judgments per second, done in under a minute." Let the tiles fill in. |
| 2:30 | **Ask Orbit**: "Will my latte cost more by Christmas?" | "Jev routes the question with 100% confidence, and Gemini calls our tools and answers with the evidence." Then click **Play the spoken briefing**. |
| 2:55 | | "Orbit: tomorrow's prices, today. Gemini sees, Jev judges, Modal scales." |

## Honest notes
- Forecast = TimesFM 3.0 (run on Modal CPU; the GPU path needs a payment method) × an Orbit overlay (Jev news pressure + Jev satellite harvest risk + 3% CPI on the non-commodity share). Wine, laptop and rent prices are synthetic.
- Backtest `orbit_signal` uses a single weight fitted **in-sample** on 3 events. The satellite NDVI signal caught olive oil in 2023, but not cocoa in 2023 (that crisis was disease and rain, which NDVI can't see) or coffee in 2024.
- Mock images in `design/` are AI-generated mockups only. Every tile in the app is real Sentinel-2 imagery.
