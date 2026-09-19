# API reference

[← back to README](../README.md) · [Architecture](ARCHITECTURE.md) · [Tech stack](TECH_STACK.md)

The backend is one FastAPI app ([`backend/main.py`](../backend/main.py), plus routers in `backend/extra_*.py`). Locally it runs at `http://localhost:8000`, and publicly at **https://bernararno17--orbit-web-web.modal.run**. FastAPI also serves interactive docs at `/docs`.

CORS is open (`*`). There is no authentication: every endpoint is read-only over public data, except `/api/ask` and `/api/briefing?force=true`, which spend Gemini and Jev quota.

> The example responses below are trimmed from the real files in `data/built/` (2026-09-19). Values change whenever the pipelines rerun.

## Endpoint index

| Method | Path | Purpose | Source |
|---|---|---|---|
| GET | `/` | Dashboard SPA (`frontend/index.html`) | `main.py` |
| GET | `/landing` | 5–10 s animated opener (`frontend/landing.html`); redirects to `/` if missing | `extra_landing.py` |
| GET | `/static/{path}` | Frontend assets (JS, CSS, product images) | `main.py` |
| GET | `/tiles/{region_id}/{YYYY-MM}.png` | Sentinel-2 RGB thumbnail | `main.py` |
| GET | `/api/summary` | Module pressure scores and global stats | `main.py` |
| GET | `/api/modules/{module_id}` | Everything for one module page | `main.py` |
| GET | `/api/rent` | London boroughs GeoJSON | `main.py` |
| GET | `/api/rent/hex` | 2,406 H3 neighbourhood hexagons GeoJSON | `extra_rent.py` |
| GET | `/api/eval` | Track-record summary (rolling-origin backtest) | `main.py` |
| GET | `/api/eval/{item_id}` | Per-item backtest detail | `main.py` |
| GET | `/api/leaderboard` | Model-zoo leaderboard and the Orbit v2 stack | `main.py` |
| POST | `/api/ask` | Ask Orbit: Jev routing + Gemini function calling | `main.py` → `agent.py` |
| GET | `/api/scan` | **SSE** live Modal fan-out ("Scan now") | `main.py` → `scan.py` |
| GET | `/api/scan/last` | Last recorded scan, reduced to judgments per second | `extra_mission.py` |
| GET | `/api/briefing` | Spoken briefing (WAV) | `main.py` → `briefing.py` |
| GET | `/api/briefing/text` | Script of the cached briefing | `main.py` |
| GET | `/api/stats` | Mission Control counters (built + live) | `main.py` |
| GET | `/api/health` | Health check | `main.py` |

---

## GET `/api/summary`

Returns `data/built/summary.json`, or computes it on the fly if the file is missing. `modal_containers_peak` is capped at 100.

```json
{
  "generated_at": "2026-09-19T13:39:56+00:00",
  "modules": [
    {"module_id": "groceries", "name": "Groceries", "emoji": "🛒", "color": "#F97316",
     "pressure": 51, "prob_up_6m": 0.574, "top_item": "Chocolate bar (100g)",
     "top_item_id": "chocolate", "change_6m_pct": 4.3},
    {"module_id": "gpu", "name": "GPU & Gadgets", "pressure": 65, "prob_up_6m": 0.66,
     "top_item": "High-end GPU", "change_6m_pct": 6.6}
  ],
  "stats": {"tiles_processed": 1840, "jev_judgments": 142016, "modal_containers_peak": 100,
            "gpu_model": "TimesFM 3.0 (google/timesfm-3.0-pytorch)", "gemini_calls": 42,
            "gpu_type": "NVIDIA L4"}
}
```

## GET `/api/modules/{module_id}`

`module_id` is one of `groceries`, `latte`, `beer_wine`, `gpu` or `rent`. An unknown id returns **404**.

For each item, the endpoint adds London retail prices to `forecast/{item}.json` using a pass-through model:

`retail_6m = retail_now × (1 + commodity_share × (p50_6m / last − 1))`

If the forecast is already in retail £, the share is 1.

```json
{
  "module": {"id": "latte", "name": "Latte Index", "emoji": "☕", "color": "#A16207"},
  "items": [{
    "item_id": "latte", "name": "Latte (London café)", "unit": "£", "source": "FRED:PCOFFOTMUSDM",
    "retail_now": 3.95, "retail_6m": 4.03, "retail_12m": 4.11,
    "history": [{"month": "2019-08", "price": 3.64}, "…84 months"],
    "forecast": [{"month": "2026-08", "p10": 3.94, "p50": 3.96, "p90": 4.0}, "…12 months"],
    "prob_up_6m": 0.577, "prob_bigup_6m": 0.334, "change_6m_pct": 2.0,
    "model": "Orbit v2 (validated stack: TimesFM + stats + quant + macro)",
    "drivers": [{"name": "Jev news pressure", "value": 0.268, "contribution_pct": 0.39,
                 "source": "Jev supply-effect judgments over recent headlines (not backtested)"}, "…"],
    "backtest": {"as_of": "2024-03", "story": "Brazil 2024 drought → coffee at record highs",
                 "orbit_v2_signal": {"predicted_change_pct": 0.1, "prob_up_6m": 0.5335, "split": "test"}},
    "orbit_v2": {"weights_h6": {"orbit_v1": 0.25, "stat_combo": 0.25, "quant_tsmom": 0.25, "exog_ridge": 0.25},
                 "driver_band_6m_pct": [-18.5, 48.1]},
    "recommendation": "hold"
  }],
  "regions": [{"region_id": "minas_coffee", "name": "Sul de Minas coffee, Brazil", "signal": "crop",
               "series": [{"month": "2026-08", "ndvi": 0.5676, "ndwi": -0.6046, "cloud_pct": 0.0,
                           "thumb": "tiles/minas_coffee/2026-08.png"}],
               "anomaly": {"ndvi_vs_5yr_pct": 8.6, "ndwi_vs_5yr_pct": -3.4}}],
  "signals": {"n_headlines": 2182, "n_judgments": 8728, "net_supply_pressure": 0.22,
              "headlines": ["…400 top headlines with Jev judgments…"],
              "region_judgments": [{"region_id": "minas_coffee",
                                    "harvest_risk": {"label": "low", "probs": {"low": 0.89, "medium": 0.07, "high": 0.04, "severe": 0.0}},
                                    "confidence": 0.85}]},
  "insights": {"headline": "London Latte Prices Rising to £4.10 Within 12 Months",
               "cards": [{"title": "London Price Impact", "text": "London lattes cost £3.95 today. …"}],
               "vision_notes": [{"region_id": "minas_coffee", "text": "Widespread greenness has recovered …",
                                 "then": "2021-08", "now": "2026-08"}]}
}
```

A single Jev-judged headline from `signals.headlines` looks like this (real row from `signals/gpu.json`):

```json
{"title": "Memory chip shortage 2026 worsens as Samsung hikes prices 60%…", "date": "2025-11-17",
 "source": "Tech Wire Asia", "relevant_p": 0.95, "item_id": "laptop", "item_p": 0.69,
 "supply_effect": {"label": "strongly_up", "probs": {"strongly_down": 0.0, "down": 0.0, "unchanged": 0.0, "up": 0.03, "strongly_up": 0.97}, "score": 3.97},
 "price_pressure": 0.985,
 "severity": {"label": "major", "probs": {"minor": 0.0, "notable": 0.05, "major": 0.95}, "score": 1.95},
 "confidence": 0.54}
```

## GET `/api/rent` and `/api/rent/hex`

GeoJSON FeatureCollections. If a file is missing, you get an empty collection.

```json
{"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": "…"},
 "properties": {"name": "Barking and Dagenham", "rent_now": 1625, "rent_12m": 1728, "change_pct": 6.3,
                "built_change_pct": 1.6, "green_change_pct": -9.1, "pressure": 83,
                "ndbi_2019": 0.005, "ndbi_latest": 0.0397, "latest_year": 2026, "scenes": 6,
                "why": "Construction in line with London since 2019 and regeneration and fast transport links keep pulling renters in."}}
```

Hex cell properties: `{id (H3 res 8), name, borough, rent_now, rent_12m, change_pct, built_change_pct, green_change_pct, pressure, built_share_2019, built_share_latest, centroid}`.

## GET `/api/eval`, `/api/eval/{item_id}`, `/api/leaderboard`

These return `data/built/eval/summary.json`, `eval/{item_id}.json` and `eval/leaderboard.json` unchanged. An empty object means the file is not built yet. `/api/eval/{item_id}` returns 404 for unknown items. The fields and the metrics are explained in [MODEL.md](MODEL.md).

```json
// /api/leaderboard (trimmed)
{"split": {"train": "cutoff+h <= 2022-12",
           "val": "cutoffs 2020-07..2022-06 with cutoff+h <= 2022-12 (all model selection)",
           "test": "cutoffs >= 2023-01 (reported once)"},
 "rows": [{"method": "orbit_v2", "family": "Orbit v2 (stack)",
           "test": {"h6": {"mape": 18.9, "skill": 0.026, "dir_acc": 0.639, "coverage80": 0.774,
                           "width80_pct": 59.3, "brier_up": 0.2448, "big_move_recall": 0.708, "n": 266}}}],
 "final": {"horizons": {"h6": {"weights": {"orbit_v1": 0.25, "stat_combo": 0.25, "quant_tsmom": 0.25, "exog_ridge": 0.25}}}},
 "notes": ["disclosure: after a first full run (TEST visible) three a-priori-motivated design changes were made …"]}
```

## POST `/api/ask`

Request:

```json
{"question": "Will my latte cost more by Christmas?"}
```

The question is trimmed to 500 characters. Response:

```json
{
  "answer": "A London latte is £3.95 today and Orbit expects about £4.03 in 6 months …",
  "route": {"label": "latte", "confidence": 0.97, "buy_now_question_p": 0.62, "item": "latte", "region": "none"},
  "tool_calls": [{"name": "get_forecast", "args": {"item_id": "latte"}},
                 {"name": "get_module", "args": {"module_id": "latte"}}],
  "focus": {"module_id": "latte", "item_id": "latte"}
}
```

- `route` is Jev's calibrated routing. `confidence` is the probability Jev gives the chosen module.
- `tool_calls` lists the Gemini function calls that ran against Orbit's data.
- `focus` tells the UI which module, item or region to open. Router suggestions are used only when their confidence is at least 0.5.
- If both AIs fail, the answer is a template built from the forecast JSON, so the response shape stays the same.

The answer text above is illustrative. It is generated live on each call.

## GET `/api/scan` (Server-Sent Events)

Query: `mode=auto` (default: live Modal fan-out, falling back to replay) or `mode=replay`.

Response: `text/event-stream`. Each message is one `data: {json}\n\n` line. Every event carries the running totals:

| Field | Meaning |
|---|---|
| `type` | `start`, `progress` or `done` |
| `kind` | For `progress`: `tile`, `signals` or `tick` (1 Hz heartbeat with the live Modal runner count) |
| `containers_active`, `containers_max` | Distinct Modal containers seen (capped at 100) |
| `tiles_done`, `tiles_total` | Satellite progress (20 regions × 6 months = 120) |
| `jev_judgments` | Typed Jev judgments so far in this scan |
| `gpu_model` | The forecast model shown in the UI |
| `elapsed_s` | Seconds since start |
| `region_id`, `module_id`, `month`, `thumb`, `ndvi`, `ndwi` | Only on `tile` events |
| `headline` | Only on `signals` events (the first judged headline of the batch) |
| `error` | Present if a single tile or batch failed |
| `replay` | `true` when the event comes from the recording |
| `containers_used`, `sat_containers`, `signal_containers` | Only on `done` |

Real events from `scan_replay.json`:

```text
data: {"type": "start", "containers_active": 0, "containers_max": 100, "tiles_done": 0, "tiles_total": 120, "jev_judgments": 0, "gpu_model": "TimesFM 3.0 (google/timesfm-3.0-pytorch)", "elapsed_s": 0.0, "month": "2026-08"}

data: {"type": "progress", "kind": "tile", "containers_active": 17, "tiles_done": 1, "tiles_total": 120, "jev_judgments": 0, "elapsed_s": 14.99, "region_id": "ashanti_cocoa", "module_id": "groceries", "thumb": "tiles/ashanti_cocoa/2026-08.png", "month": "2026-08"}

data: {"type": "progress", "kind": "signals", "containers_active": 21, "tiles_done": 1, "jev_judgments": 40, "elapsed_s": 15.97, "module_id": "latte", "headline": "Inside Plymouth's newest coffee hangout with 152 seats over two floors"}

data: {"type": "done", "containers_active": 0, "tiles_done": 120, "tiles_total": 120, "jev_judgments": 800, "elapsed_s": 45.75, "month": "2026-08", "containers_used": 62, "sat_containers": 51, "signal_containers": 6}
```

The scan stops after 240 s. A successful live scan (at least half the regions returned) overwrites `scan_replay.json`, so the next offline replay uses the newest recording.

Browser usage ([`frontend/js/scan.js`](../frontend/js/scan.js)):

```js
const es = new EventSource('/api/scan');          // or '/api/scan?mode=replay'
es.onmessage = m => { const ev = JSON.parse(m.data); /* update counters, add tile */ if (ev.type === 'done') es.close(); };
```

## GET `/api/scan/last`

The recorded scan reduced to a judgments-per-second histogram, for the idle Mission Control chart:

```json
{"recorded_at": "2026-09-19T16:01:37", "jps": [0, 0, 120, 480, 200, "…"], "peak_jps": 480,
 "tiles": 120, "jev_judgments": 800, "elapsed_s": 45.75}
```

## GET `/api/briefing` and `/api/briefing/text`

- `/api/briefing` returns `audio/wav`: the cached `briefing.wav` if there is one.
- `?force=true` makes a new one: Gemini 3.8 Flash writes a ~70-word script, and `gemini-3.1-flash-tts-preview` speaks it with the voice "Charon". The result is cached.
- If generation fails, the old WAV is returned. With no WAV at all, you get `503 {"error": "briefing unavailable: …"}`.
- `/api/briefing/text` returns `{"text": "This is Orbit, with tomorrow's prices. …"}`.

## GET `/api/stats`

Built stats from `summary.json` plus live counters of this server process:

```json
{"tiles_processed": 1840, "jev_judgments": 142016, "modal_containers_peak": 100,
 "gpu_model": "TimesFM 3.0 (google/timesfm-3.0-pytorch)", "gpu_type": "NVIDIA L4", "gemini_calls": 42,
 "jev_judgments_total": 142816, "gemini_calls_total": 44, "tiles_processed_total": 1960,
 "live": {"asks": 1, "gemini_calls": 2, "jev_judgments": 800, "scans": 1, "tiles_scanned": 120, "containers_active": 0},
 "uptime_s": 5120}
```

(The `*_total` and `live` values above are illustrative. They depend on what the running server has done.)

## GET `/api/health`

```json
{"ok": true, "data_dir": "/data/built", "data_exists": true, "frontend": true}
```

## GET `/tiles/{region_id}/{YYYY-MM}.png`

A 256×256 PNG with a one-hour cache header. `region_id` must match `[A-Za-z0-9_-]+` and the month must match `YYYY-MM`, otherwise you get 404. Region ids are in [`orbit/config.py`](../orbit/config.py), for example `jaen_olives`, `stargate_abilene` or `tsengwen_reservoir`.

---

## Modal function interfaces

The backend calls **deployed** Modal functions by name with `modal.Function.from_name(app, fn)`. Deploy them first:

```bash
modal deploy modal_app/satellite.py   # orbit-satellite
modal deploy modal_app/signals.py     # orbit-signals
```

| Lookup | Signature | Returns |
|---|---|---|
| `from_name("orbit-satellite", "process_tile")` | `process_tile(region_id: str, month: str, force: bool = False, include_png: bool = False) -> dict` | `{region_id, month, ndvi, ndwi, ndbi, water_frac, built_frac, cloud_pct, thumb, scene, scene_cloud_cover, datetime, seconds, cached, task_id, png_b64?, error?}`. The PNG and a `.json` sidecar are written to the Volume. |
| `from_name("orbit-signals", "fetch_latest")` | `fetch_latest(module_id: str, n: int = 40) -> list[dict]` | Up to `n` deduplicated Google News RSS headlines from the last 7 days: `[{title, url, date, source}]` |
| `from_name("orbit-signals", "judge_headlines")` | `judge_headlines(batch: list[dict], module_id: str) -> dict` | One Jev `system_one` call with 4 questions per headline: `{rows:[headline + relevant_p, item_id, item_p, supply_effect, price_pressure, severity, confidence], n_judgments, input_tokens, output_tokens, task_id}` |
| `from_name("orbit-signals", "judge_regions")` | `judge_regions(module: str = "") -> dict` | Jev reads each region's satellite JSON and returns risk labels. Also writes `region_judgments` into `signals/*.json`. |

Usage from async code (as in [`backend/scan.py`](../backend/scan.py)):

```python
import modal
process_tile = modal.Function.from_name("orbit-satellite", "process_tile")
await process_tile.hydrate.aio()                      # fail fast if not deployed / no auth
async for res in process_tile.starmap.aio(pairs, kwargs={"force": True},
                                          order_outputs=False, return_exceptions=True):
    ...
stats = await process_tile.get_current_stats.aio()    # live runner count for the UI
```

Batch-only functions (called by `modal run` local entrypoints, not by the web app):

| App | Function | Signature |
|---|---|---|
| `orbit-signals` | `build`, `build_ai`, `judge_ai`, `fetch_gdelt`, `fetch_rss` | `build(force=False)`, `build_ai(refetch=False)`, `judge_ai(batch)`, `fetch_gdelt(n_months=24)`, `fetch_rss(module_id, n_windows=8, queries=None)` |
| `orbit-forecast` | `load_history`, `gpu_forecast`, `run` | `gpu_forecast(contexts: list[list[float]], horizon: int) -> dict`, `run(force=False, items="")` |
| `orbit-eval` | `gpu_forecast` | `gpu_forecast(batch: list[dict]) -> {results, seconds, model, gpu}` |
| `orbit-train` | `tfm_batch`, `backtest_fold`, `eval_config`, `run` | see [`modal_app/train.py`](../modal_app/train.py) |
| `orbit-zoo-stats` | `fit_batch` | `fit_batch(batch: list[dict]) -> dict` (AutoETS / AutoARIMA / AutoTheta per point-in-time context) |
| `orbit-zoo-quant` / `orbit-zoo-dir` | `fit_chunk` | `fit_chunk(job: dict)` walk-forward fits |
| `orbit-zoo-exog` | `fetch_weather` | `fetch_weather(rid, lat, lon, start, end) -> dict` (Open-Meteo ERA5 archive) |
| `orbit-rent` | `borough_stats` | `borough_stats(feature: dict) -> dict` |
| `orbit-rent-detail` | `scene_mosaic` | `scene_mosaic(href: dict, offset: int) -> dict` |
