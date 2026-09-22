# Google Gemini and Google DeepMind / Research tech

[← back to README](../README.md) · [Jev](JEV.md) · [Modal](MODAL.md) · [Architecture](ARCHITECTURE.md)

> **In one sentence:** Gemini is Orbit's eyes and voice. It looks at pairs of real Sentinel-2 images and says what changed, writes every short insight card, runs the tool-calling "Ask Orbit" agent, speaks a 30-second briefing, and generated the product photography. Google Research's TimesFM 3.0 is the forecasting foundation model under every price.

"Gemini sees · Jev judges · Modal scales": in Orbit's tagline, Gemini is the step that *sees*.

## Models used

| Model | Where | What for |
|---|---|---|
| `gemini-3.8-flash` | [`backend/agent.py`](../backend/agent.py) (`MODEL`), [`scripts/build_insights.py`](../scripts/build_insights.py), [`backend/briefing.py`](../backend/briefing.py) | Vision on satellite tiles, structured JSON insight cards, function-calling agent, briefing script |
| `gemini-3.1-flash-tts-preview` | [`backend/briefing.py`](../backend/briefing.py) | Text-to-speech, voice "Charon", 24 kHz PCM → WAV |
| `gemini-3.1-flash-image` | assets in `web/public/products/` | 10 studio product photos (chocolate, olive oil, …, GPU, laptop, flat), 800×800 |
| **TimesFM 3.0** (Google Research) | `modal_app/forecast.py`, `evaluate.py`, `train.py` | Zero-shot quantile forecasts on NVIDIA L4 (see [MODEL.md](MODEL.md)) |

All calls use the `google-genai` SDK 2.24.0 and the **Interactions API** (`client.aio.interactions.create`) with `thinking_level: "low"` for latency. The key is read from `GEMINI_API_KEY` (in `.env` locally, and in the Modal secret `orbit-secrets` in production).

Our key was also verified with `gemini-3.1-pro-preview` and `gemini-3.5-flash-lite`. We kept them off the runtime path: 3.8 Flash handled every task within the latency budget of a live demo.

## 1. Gemini sees: satellite vision notes

For each region, `build_insights.py` sends Gemini **two real Sentinel-2 RGB tiles** (the latest month, and the same month 5 years earlier), their NDVI / NDWI / NDBI and cloud statistics, and the 5-year anomaly. Gemini answers in at most 35 words, and the output is forced into a JSON schema:

```python
prompt = (f"Two Sentinel-2 RGB satellite images of {region['name']} (signal: {region['signal']}, drives the price of "
          f"{item_name}). Image 1 = {then['month']}, image 2 = {now['month']}. Index stats: {stats}; anomaly vs 5-year "
          "normal: {anomaly}. In 1-2 short sentences (max 35 words) say what visibly changed (greenness, water extent, "
          "construction, clouds) and what it means for supply. Be concrete, no hedging boilerplate.")
res = await gen([{"type": "text", "text": prompt}, _img(then["thumb"]), _img(now["thumb"])],
                {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]})
```

Real output (`data/built/insights/gpu.json`, Baoshan II reservoir next to the Hsinchu fabs, 2021-08 → 2026-08):

> "Clearer views reveal robust green vegetation and stable reservoir water levels near 5-year norms. Stable water availability ensures uninterrupted cooling for Hsinchu fabs, supporting steady high-end GPU production."

The module files currently hold **16 vision notes** across 5 modules.

## 2. Structured insight cards

For each module, Gemini gets the forecasts, Jev's news pressure, the top Jev-judged headlines, satellite anomalies and its own vision notes. It writes **one headline (≤ 10 words) and exactly 3 cards (≤ 25 words each)**, enforced by a JSON schema (`CARDS_SCHEMA`, `minItems = maxItems = 3`). The prompt says: *use only numbers present in the data*. A small post-processor (`tidy_money`) formats £ values.

| Module | Current Gemini headline |
|---|---|
| Groceries | London olive oil prices falling towards £9.03 as harvests recover |
| Latte | London Latte Prices Rising to £4.10 Within 12 Months |
| Beer & Wine | London Beer and Wine Prices to Rise Within Six Months |
| GPU & Gadgets | London Laptop Prices Set to Rise 3.9% Within Months |
| Rent | London 1-Bed Rents to Hit £2,335 Within a Year |

These show up as the short "Gemini sees" cards on every page, following the project rule that AI prose is at most 3 sentences.

## 3. Ask Orbit: a function-calling agent

[`backend/agent.py`](../backend/agent.py) declares 4 tools that read Orbit's own JSON:

| Tool | Argument | Returns |
|---|---|---|
| `get_module` | `module_id` (enum of 5) | Items, pressure, satellite anomalies, top relevant headlines, Gemini headline |
| `get_forecast` | `item_id` (enum of 10) | Retail now / 6 m / 12 m, P(up), backtest, last 6 months, quarterly p50 path |
| `get_region` | `region_id` (enum of 20) | NDVI / NDWI anomaly, last 3 months, vision note |
| `get_rent` | `borough` | Borough properties, or the 5 highest-pressure boroughs |

The flow:

1. The question arrives with **Jev's routing hint**, for example `module=latte (0.97), item=latte, …`.
2. Round 1: Gemini calls the tools it needs, in parallel.
3. Round 2: tools are removed and Gemini must answer in **≤ 3 sentences with £ and %** and a buy-now-or-wait tip.
4. The tool calls go back to the UI, which shows "How Orbit answered" and deep-links to the evidence.

```python
it = await asyncio.wait_for(client.aio.interactions.create(
    model=MODEL, store=False, input=history, system_instruction=sysmsg,
    generation_config={"thinking_level": "low"}, tools=TOOLS), 20)
fcs = [s for s in it.steps if s.type == "function_call"]
...
history.append({"type": "function_result", "name": s.name, "call_id": s.id,
                "result": [{"type": "text", "text": json.dumps(res)[:6000]}]})
```

If Gemini fails or times out (20 s), a template answer built from the forecast JSON keeps the demo alive.

## 4. The spoken briefing (Gemini TTS)

`GET /api/briefing` makes two calls:

1. Gemini 3.8 Flash writes a ~70-word radio script from `summary.json` and the module headlines. It opens with "This is Orbit, with tomorrow's prices." and ends with one buy-now tip.
2. `gemini-3.1-flash-tts-preview` reads it in a "confident, upbeat newsreader voice" (voice **Charon**).

The PCM audio is wrapped into WAV and cached as `data/built/briefing.wav` together with `briefing.txt`. `scripts/build_summary.py --briefing` pre-renders it, so the button plays instantly on stage.

Current script (`data/built/briefing.txt`):

> This is Orbit, with tomorrow's prices. Satellites spotted it first, London, so here is what is hitting your wallet next. Alcohol faces the heaviest heat, with wine virtually guaranteed to jump nearly two percent over the next six months. Tech is not far behind, with high-end gadget and GPU prices surging almost seven percent. Your move today: if you are planning a computer upgrade, buy that tech right now before the hike lands.

## 5. Image generation

Every consumer item has a product photo generated with `gemini-3.1-flash-image`: white studio background, no text or logos, 800×800 JPEG under 100 KB (spec in [`design/MODULES.md`](../design/MODULES.md)). They live in [`web/public/products/`](../web/public/products). Early UI mock-ups in `design/images/` were also generated. **No generated image is ever shown as satellite data.** Every tile in the app is real Sentinel-2.

## 6. TimesFM 3.0 (Google Research)

TimesFM is a decoder-only time-series foundation model. We run `google/timesfm-3.0-pytorch` (via `timesfm[torch]==3.0.2`, falling back to TimesFM 2.5 200M) on Modal L4 GPUs. It produces 12-month forecasts with 9 quantiles, which become the p10 / p50 / p90 fan charts.

It is used in three places:
- live forecasts for 13 series;
- **1,436 point-in-time backtests** on 10 × L4;
- 6,695 contexts as features for the LightGBM learner.

How it scores against the naive "no change" benchmark is in [MODEL.md](MODEL.md). In short, on its own it does not beat naive at 6 months, which is why Orbit stacks it with other members.

## Usage numbers

| Metric | Value | Source |
|---|---|---|
| Gemini calls to build insights (cumulative) | 42 | `data/built/insights/_stats.json` |
| Live calls per Ask | 1–2 (tool round + answer round) | `backend/agent.py` |
| Live calls per new briefing | 2 (script + TTS) | `backend/briefing.py` |
| Vision notes | 16 | `data/built/insights/*.json` |
| Product images | 10 | `web/public/products/` |

Mission Control shows the running total (`gemini_calls_total` in `/api/stats`).
