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
 │ orbit-forecast   FRED/curated prices → TimesFM 3.0 (L4 GPU) → p10/p50/p90 │
 │ orbit-eval       1,436 point-in-time TimesFM backtests on 10 L4 GPUs     │
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

## Track record (how right are we?)
`modal run modal_app/evaluate.py` runs 1,436 point-in-time TimesFM 3.0 backtests on 10 Modal L4 GPUs (cutoffs every month 2018-01..2026-05, 3/6/12-month horizons, 2 context lengths). `scripts/build_eval.py` tunes the Orbit layer on cutoffs before 2023 and scores it only on 2023+ (266 six-month forecasts over 8 items). Results are in `data/built/eval/summary.json` and at `/api/eval`.

| Test 2023+, 6 months ahead | MAPE | Direction right | 80% band hit | Skill vs "no change" | Big rises (>15%) called |
|---|---|---|---|---|---|
| Naive (no change) | 19.2% | – | – | 0 | 0 / 65 |
| Drift (24-month trend) | 24.3% | 52% | – | −0.164 | 71% |
| TimesFM 3.0 alone | 19.1% | 50% | 76% | −0.017 | 32% |
| Orbit before tuning | 19.0% | 49% | 77% | −0.013 | 32% |
| **Orbit tuned** | 19.7% | 49% | **79%** | **−0.002** | **66%** |

## Honest notes
- **Accuracy.** Commodity prices are close to a random walk. No method here reliably beats "the price stays the same" on point error. Tuned Orbit matches it at 6 months (skill −0.002) and at 3 months (−0.007). At 12 months it is slightly worse (−0.030, down from +0.011 before tuning). What tuning bought is **catching rises**: two thirds of the >15% rises in the test period were flagged "up", against one third before. The 80% bands hold (79% hit).
- **What the fit chose.** The objective was error vs naive, averaged over 3/6/12 months, minus 0.05 × big-rise recall. On error alone the fit picks "never move", which is useless for a warning system. The fit kept TimesFM for the uncertainty band but set its centre weight to 0, and uses a quarter of the 24-month trend. The Sentinel-2 NDVI tilt got weight 0: it did not improve out-of-sample error. Satellite data still feeds the pressure scores and the GPU build-out driver, but not the commodity price paths. Six parameters were searched over a small grid (552 combinations).
- **Live forecast = the tuned method.** On top of it: a Jev news-pressure term, which is **not backtested** because headline history covers only about 2 years, and 3% UK CPI on the non-commodity share of each retail price.
- **GPU.** The GPU street index is curated from public anchor points (launch prices, widely reported street prices, 2026 GDDR7-crunch sources), with months between anchors interpolated. It is backtested only at anchor months (7 test cutoffs), so the context never depends on a later anchor. Laptop is FRED CPI Computers (`CUSR0000SEEE01`). Wine is synthetic; rent is synthetic plus Sentinel-2 built-up change.
- **AI-era drivers.** The GPU and laptop driver coefficients are priors, not fitted, because the Jev AI index starts in 2022-09. Tested on 2023+ for GPU and laptop together (44 forecasts): skill rises from +0.007 to +0.065, but direction accuracy falls from 63% to 45%. The Jev headlines are dated before each cutoff, but Jev itself was trained later, so a little hindsight may leak into its scores.
- **Data fix.** The FRED olive-oil series has a Nov–Dec 2020 glitch. The two affected points are replaced by the median of their neighbours; this is the only use of data from after a cutoff.
- Story backtests on the item pages (`backtest.orbit_signal`) now come from the tuned method at each `as_of`. All three are in the 2023+ test period, so they are out-of-sample. They are also mostly misses on size (olive oil 2023-03: said +1.9%, went +39%).
- Mock images in `design/` are AI-generated mockups only. Every tile in the app is real Sentinel-2 imagery.
