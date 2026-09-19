# Modal: the compute backbone

[← back to README](../README.md) · [Jev](JEV.md) · [Gemini](GEMINI.md) · [Architecture](ARCHITECTURE.md)

> **In one sentence:** every heavy step in Orbit runs on Modal. That covers downloading 1,840 Sentinel-2 tiles on 100 parallel containers, 1,400+ Jev calls, TimesFM 3.0 on NVIDIA L4 GPUs, hundreds of walk-forward model fits, and the public web app itself. The live "Scan now" button fans out across Modal while the audience watches.

## Why Modal

Orbit's work is **bursty and embarrassingly parallel**: 20 regions × 92 months of imagery, 1,436 point-in-time forecasts, 2,406 London hexagons. On a laptop this takes hours. On Modal each job is a plain Python function with a decorator. It scales to 100 containers in seconds and scales to zero afterwards, so we pay only for the seconds used. That kept us inside a hackathon budget of about $50.

We use nearly every Modal primitive:

| Modal feature | How Orbit uses it | Code |
|---|---|---|
| `@app.function` + `.map` / `.starmap` fan-out | Satellite tiles, Jev batches, statsforecast fits, walk-forward folds, ERA5 downloads, borough and scene reads | every `modal_app/*.py` |
| `max_containers` | Keeps the whole account at ≤ 100 containers. During a live scan: 75 tile + 20 Jev + 5 fetch = 100. | `satellite.py`, `signals.py` |
| **GPU** `gpu="L4"` | TimesFM 3.0 inference (live forecasts, backtests, training features) | `forecast.py`, `evaluate.py`, `train.py` |
| **Volumes** | `orbit-data` (all data, `/data/built` = the UI's data contract, `/data/cache` = raw caches); `orbit-models` (Hugging Face weights cached at `/models/hf`, so GPU cold starts skip the download) | all apps |
| **Secrets** | `orbit-secrets` holds `TYPESAFE_API_KEY` and `GEMINI_API_KEY` for Jev calls and the web app | `signals.py`, `web.py` |
| **Images** | `debian_slim(3.12)` + `pip_install` / `uv_pip_install`, GDAL env vars, `add_local_python_source("orbit")` to ship the shared config | all apps |
| **Retries** | `retries=1` on tiles, `modal.Retries(max_retries=2, initial_delay=2.0)` on Jev batches | `satellite.py`, `signals.py` |
| `modal deploy` + `Function.from_name` | The web backend calls the **deployed** `process_tile`, `fetch_latest` and `judge_headlines` live | `backend/scan.py` |
| `.aio()` async API | `starmap.aio`, `remote.aio`, `hydrate.aio`, `get_current_stats.aio`, all streamed into SSE | `backend/scan.py` |
| `get_current_stats()` | Live runner count shown in Mission Control | `backend/scan.py` |
| `MODAL_TASK_ID` | Each result reports its container id, so we count **distinct containers** actually used | `satellite.py`, `signals.py` |
| **ASGI web endpoint** | `@modal.asgi_app()` + `@modal.concurrent(max_inputs=100)` + `scaledown_window=1200` serves FastAPI and the frontend at a public URL | `web.py` |
| `Volume.reload()` / `commit()` / `batch_upload` | Workers commit results, and the web app reloads the Volume every 60 s. Local scripts upload FRED CSVs and eval files with `batch_upload`. | `satellite.py`, `backend/main.py`, `forecast.py`, `evaluate.py` |
| `@app.local_entrypoint()` | Every pipeline is `modal run modal_app/<x>.py[::entry]` | all apps |
| `.spawn()` | The slow, rate-limited GDELT fetch runs in the background while RSS fans out | `signals.py` |

## Scale, from the `_stats.json` files

| Job | App | Parallelism | Work | Wall time |
|---|---|---|---|---|
| Sentinel-2 history | `orbit-satellite` | **100 containers** at peak (101 distinct task ids: Modal replaced one) | **1,840 tiles** (20 regions × 92 months, 2019-01 → 2026-08), 0 errors | 673 s |
| Headline judging | `orbit-signals` | up to 56 containers | 16,737 headlines → 673 Jev calls | 1,413 s |
| AI-era layer | `orbit-signals` | 20 containers | 7,653 new headlines, 75,048 judgments | 126 s |
| Live forecasts | `orbit-forecast` | 1 × **NVIDIA L4** | 13 series, TimesFM 3.0 | 5.7 GPU-s (18.9 s total) |
| Rolling-origin backtest | `orbit-eval` | **10 × NVIDIA L4** | **1,436** point-in-time TimesFM forecasts | 95.9 GPU-s (20.2 s wall for the last run) |
| Learner features | `orbit-train` | 6 × L4 + 52 CPU containers | 6,695 TimesFM contexts + LightGBM config search | 62.1 GPU-s |
| Stats zoo | `orbit-zoo-stats` | up to **100** CPU containers | AutoETS / AutoARIMA / AutoTheta per item × cutoff (incl. warm-up cutoffs from 2012) | – |
| Quant / direction zoo | `orbit-zoo-quant`, `orbit-zoo-dir` | up to 100 / 60 CPU containers | Walk-forward refits at every cutoff | – |
| Weather | `orbit-zoo-exog` | up to 60 containers | ERA5 archive per crop region × decade since 1981 | – |
| London boroughs | `orbit-rent` | 33 containers | 33 boroughs, NDBI 2019 vs latest | 69 s |
| London hexagons | `orbit-rent-detail` | **67 containers** (one per Sentinel-2 scene) | 67 scenes → 2,406 H3 cells | 968 s |
| **Live "Scan now"** | web → satellite + signals | 62 distinct containers (51 satellite, 6 Jev, fetchers) | **120 tiles + 800 Jev judgments** | **45.8 s** |

In total the GPU work took **about 164 L4 GPU-seconds** (5.7 + 95.9 + 62.1). Modal bills per second, so that is a tiny slice of the budget.

> These figures come from `data/built/satellite/_stats.json`, `signals/_stats.json`, `forecast/_stats.json`, `eval/summary.json → gpu`, `model/summary.json → gpu`, `rent/_stats.json`, `rent/_hex_stats.json` and `scan_replay.json`. Every pipeline rewrites them when it runs.

## Code highlights

**1,840 tiles, 100 containers, one line of fan-out** ([`modal_app/satellite.py`](../modal_app/satellite.py)):

```python
@app.function(volumes={"/data": vol}, timeout=120, max_containers=MAX_CONTAINERS, cpu=1.0, memory=1024, retries=1)
def process_tile(region_id: str, month: str, force: bool = False, include_png: bool = False) -> dict:
    ...  # STAC search → windowed COG reads → NDVI/NDWI/NDBI → PNG → vol.commit()

jobs = [(r["id"], m) for r in REGIONS for m in months]
for i, res in enumerate(process_tile.starmap(jobs, kwargs={"force": force}, return_exceptions=True)):
    ...
```

Every tile caches its result as a `.json` sidecar on the Volume, so a rerun without `--force` returns immediately (`"cached": true`).

**TimesFM 3.0 on L4 with cached weights** ([`modal_app/evaluate.py`](../modal_app/evaluate.py)):

```python
@app.function(image=gpu_image, gpu=GPU_TYPE, memory=16384, volumes={"/models": model_vol},
              timeout=900, max_containers=N_GPU, retries=1)          # N_GPU = 10
def gpu_forecast(batch: list[dict]) -> dict:
    from timesfm3 import TimesFM3Forecaster
    m = TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch", device=dev, ...)
    ...
chunks = [jobs[i::N_GPU] for i in range(N_GPU)]
for r in gpu_forecast.map(chunks):
    res.update(r["results"])
```

**Live fan-out from the web backend** ([`backend/scan.py`](../backend/scan.py)):

```python
process_tile = modal.Function.from_name("orbit-satellite", "process_tile")
fetch_latest = modal.Function.from_name("orbit-signals", "fetch_latest")
judge        = modal.Function.from_name("orbit-signals", "judge_headlines")
await process_tile.hydrate.aio()                                     # fail fast → replay fallback
async for res in process_tile.starmap.aio(pairs, kwargs={"force": True}, order_outputs=False, return_exceptions=True):
    sat_tasks.add(res["task_id"])                                    # distinct containers, honestly counted
    await q.put(base(type="progress", kind="tile", ...))             # → SSE to the browser
```

**The whole web app is a Modal function** ([`modal_app/web.py`](../modal_app/web.py)):

```python
@app.function(image=image, volumes={"/data": vol}, secrets=[modal.Secret.from_name("orbit-secrets")],
              max_containers=1, scaledown_window=1200, timeout=600)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def web():
    from backend.main import app as fastapi_app
    return fastapi_app
```

`max_containers=1` is deliberate: the live counters in Mission Control live in process memory, so one container with 100 concurrent inputs keeps them consistent.

## What would be impossible or expensive without Modal

- **A live scan on stage.** Without a serverless fan-out we could not re-download 120 satellite tiles and judge 200 fresh headlines in under a minute while the audience watches.
- **Honest backtesting.** 1,436 point-in-time TimesFM runs (the model is re-run at every historical cutoff with only the data known then) need GPUs for about a minute and never again. Renting a GPU box for that would cost more in setup time than the whole compute bill.
- **One storage layer for everything.** The Volume is both the pipeline's output and the web app's database. `scripts/pull_data.py` mirrors it locally for offline demos.

## Caveats

- New Modal workspaces may reject GPU functions until a payment method is added. `forecast.py` reads `ORBIT_GPU` (default `L4`), and `ORBIT_GPU=cpu` runs TimesFM on 8 vCPUs instead. `evaluate.py` and `train.py` need a GPU.
- The container limit of 100 applies across all apps, which is why `process_tile` is capped at 75.
- FRED blocks many cloud IPs, so `forecast.py`'s local entrypoint downloads FRED CSVs on your machine and uploads them to the Volume (`upload_fred_local`).
