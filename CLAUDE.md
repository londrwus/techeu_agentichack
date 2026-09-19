# Orbit — the AI Operating System for Tomorrow's Prices

> *Satellites see prices rising months before you pay them.*
> **Gemini sees · Jev judges · Modal scales**

Hackathon project for the {Tech: Europe} Agentic AI Hack in London (co-hosted with Google DeepMind; partners Modal, Pydantic). Build day: one Saturday, demos at 20:00, opt-in deadline 19:00.

## #1 RULE: THE DEMO IS THE PRODUCT
- Judging: 50% technical execution (novelty, latest tech), 30% creativity & wow, 20% problem solving.
- **Winning depends on how the demo looks and flows, not on forecast accuracy or code quality.**
- Prices only need to *feel reasonable*. A small, simple model is fine. Plausible synthetic data is fine wherever real data is slow to get — but keep real satellite images and real Jev/Gemini/Modal calls, since those are the story.
- **Visualise everything.** Charts, maps, 3D, images, live counters. Avoid walls of text. Any AI prose shows up as short cards (1–3 sentences).
- Prefer "works reliably on stage" over "clever". Every live feature needs a cached fallback (precomputed JSON), so the demo never breaks without internet or quota.
- Make the Modal and Google AI Studio usage *visible* in the UI (e.g. a "Mission Control" panel with live container count, tiles processed, Jev judgments/sec, GPU model used).
- Everything is built from scratch in this repo. Libraries are fine; forking or copying existing projects is not.

## Stack (Windows 11, no Docker)
- Python 3.12 in `.venv` (`.\.venv\Scripts\python`, `.\.venv\Scripts\modal`). Install with `.\.venv\Scripts\pip install ...` and add it to `requirements.txt`.
- Backend: **FastAPI** (`backend/`), run locally with `.\.venv\Scripts\uvicorn backend.main:app --reload --port 8000`. It's also deployable to Modal as an ASGI app.
- Heavy compute: **Modal only** (GPU *and* big CPU/RAM/storage jobs). Budget ≈ $50 total. Up to **10 GPU containers** and **100 CPU containers** in parallel are allowed. Modal bills by usage, so fan out wide for speed, but keep each job short.
- LLM / vision / TTS: **Google AI Studio (Gemini)** via `google-genai`. Models verified working with our key:
  - `gemini-3.8-flash`: default for agents, vision and narratives
  - `gemini-3.5-flash-lite`: cheap bulk calls
  - `gemini-3.1-pro-preview`: hard reasoning (use sparingly)
  - `gemini-3.1-flash-tts-preview`: spoken briefing
  - `gemini-3.1-flash-image` / `nano-banana-pro-preview`: image generation
- Fast calibrated judgments: **Jev** (TypeSafe, `typesafe-sdk`, model `jev-latest`). Jev reads text/JSON only (no images) and returns typed answers (`Noul` yes/no, `Choice`, `Score`) with probabilities and confidence. It's very cheap ($0.042 per 1M input tokens; balance $5), with limits of 1,200 requests/min and a 64k context. Batch many questions into one `system_one` call. Docs: https://docs.typesafe.ai/llms.txt, skill: `C:\Users\Lenovo\.claude\plugins\cache\typesafe-ai\typesafe\0.5.7\skills\typesafe-ai\SKILL.md`.
- Frontend: static HTML/CSS/vanilla-JS served by FastAPI from `frontend/` (no build step). Designed in **Pencil (pen.dev) via its MCP**, then implemented. Libraries come from CDN (jsdelivr): Tailwind (optional), ECharts (charts), deck.gl + MapLibre GL (3D London map).
- Secrets: `.env` locally (git-ignored: `TYPESAFE_API_KEY`, `GEMINI_API_KEY`). On Modal, the secret is `orbit-secrets` with the same keys. **Never commit keys.**

## Architecture
```
Modal (heavy work, writes to Volume "orbit-data" at /data)
  modal_app/satellite.py   app "orbit-satellite": Sentinel-2 (Planetary Computer STAC) per region×month → indices + PNG thumbnails; CPU fan-out
  modal_app/signals.py     app "orbit-signals":   GDELT news headlines → Jev typed judgments at scale; Jev judges region stats JSON
  modal_app/forecast.py    app "orbit-forecast":  price history (FRED/World Bank or synthetic) → GPU time-series model (TimesFM or Chronos) → 12-month forecast + backtest
  modal_app/rent.py        app "orbit-rent":      London boroughs: Sentinel-2 built-up change + synthetic rents → 3D radar data
  modal_app/evaluate.py  app "orbit-eval":     point-in-time TimesFM backtests on 10 L4 GPUs → scripts/build_eval.py tunes (train <2023) + scores (test 2023+)
  modal_app/scan.py        app "orbit-scan":      "Scan now" live fan-out used during the demo (reuses functions above via modal.Function.from_name)
Local
  orbit/config.py          SINGLE SOURCE OF TRUTH: modules, regions, items, prices, series ids
  scripts/pull_data.py     modal volume get → data/built/
  backend/ (FastAPI)       serves data/built/*.json, Gemini agent chat, SSE live scan, TTS briefing; serves frontend/
  frontend/                dashboard UI
```

### Modules (see `orbit/config.py`)
Groceries 🛒 · Latte Index ☕ · Beer & Wine 🍺 · GPU & Gadgets 🖥️ · Rent Radar 🏠 (London only, 3D)

### Data contracts: `data/built/` (same layout on the Volume under `/data/built/`)
All JSON. Months are `"YYYY-MM"`. Prices are in GBP.
- `satellite/{region_id}.json` → `{region_id, module, name, lat, lon, series:[{month, ndvi, ndwi, ndbi, cloud_pct, thumb}], anomaly:{ndvi_vs_5yr_pct, ndwi_vs_5yr_pct}}`, where `thumb` = `"tiles/{region_id}/{month}.png"` (RGB, 256px)
- `tiles/{region_id}/{YYYY-MM}.png`
- `signals/{module_id}.json` → `{module_id, n_headlines, n_judgments, headlines:[{title, url, date, source, relevant_p, item_id, supply_effect:{label, probs}, severity:{label, probs}, confidence}], net_supply_pressure (-1..1), region_judgments:[{region_id, harvest_risk:{label, probs}, confidence}]}`
- `forecast/{item_id}.json` → `{item_id, unit, history:[{month, price}], forecast:[{month, p10, p50, p90}], prob_up_6m, change_6m_pct, model, backtest:{as_of, predicted_change_pct, actual_change_pct}|null}`
  plus `drivers:[{name, value, contribution_pct, source}]` (contributions sum to `change_6m_pct`), `model_forecast` (raw TimesFM retail path), `model_driver:{months, values, quantiles, commodity_share, retail_now}` (driver-space input for the tuned overlay), `orbit_overlay:{params, ...}`; gpu/laptop also `ai_era:{ai_index_now, ai_index_baseline, timeline, buildout_sites, water_sites}`, gpu `anchors`, `context`, `sources`. `backtest.orbit_signal` = tuned method at as_of (out-of-sample).
- `eval/summary.json` → `{generated_at, n_forecasts, model, gpu:{type, seconds, containers}, cutoffs:{from,to}, orbit_weights, items:[{item_id, name, series, by_method:{naive|drift|timesfm|orbit:{h3,h6,h12:{mape, dir_acc, coverage80, skill, n, big_move_recall?}}}, test:{same}}], overall:{same}, test_overall:{same}, tuned:{train_period, test_period, objective, params, before_params, before:{h3,h6,h12}, after, timesfm_test, naive_test, drift_test, ai_ablation_test}, reliability_test_h6:[{bin, n, predicted, observed}], highlights:[{item_id, cutoff, kind: hit|miss, story, predicted_change_pct, actual_change_pct, split}]}` (driver-series space; train = cutoff+h <= 2022-12, test = cutoffs >= 2023-01)
- `eval/{item_id}.json` → `{item_id, name, series, unit, history:[{month, price}], satellite_stress:[{cutoff, stress}], ai_drift_12m?:[{cutoff, drift12_pct}], backtests:[{cutoff, h, method, base, p10, p50, p90, actual, prob_up, split}]}` (h6 every cutoff; all horizons every 6th cutoff). Served at `/api/eval` and `/api/eval/{item_id}`.
- `rent/london.json` → GeoJSON FeatureCollection of boroughs with properties `{name, rent_now, rent_12m, change_pct, built_change_pct, pressure (0..100)}`
- `insights/{module_id}.json` → `{module_id, headline, cards:[{title, text}], vision_notes:[{region_id, text}]}` (Gemini)
- `summary.json` → `{generated_at, modules:[{module_id, name, emoji, pressure (0..100), prob_up_6m, top_item, change_6m_pct}], stats:{tiles_processed, jev_judgments, modal_containers_peak, gpu_model, gemini_calls}}`

Anyone who produces a file owns its schema. Consumers read defensively (missing fields → hide the widget).

## Conventions
- Keep code small and readable. No over-engineering, no test suites beyond quick smoke scripts.
- Scripts must run on Windows (use `pathlib`, no bash-only tricks in Python).
- Each Modal file is standalone (`modal run modal_app/x.py`, `modal deploy modal_app/x.py`). Use `.aio()` in async code.
- Cache aggressively: never recompute what's already on the Volume unless `--force`.
