# 3-minute demo script

[← back to README](../README.md) · [Architecture](ARCHITECTURE.md)

**URL:** https://bernararno17--orbit-web-web.modal.run/landing. Open it at 1440×900 in full screen.

> The numbers in quotes match `data/built/*.json` on 2026-09-19. If the pipelines have rerun, glance at the screen and say what it shows.

## Before you go on stage

| Check | How |
|---|---|
| App is warm | Open `/api/health` a minute before. The first request after a long idle wakes the Modal container. |
| Satellite and signals apps deployed | `modal deploy modal_app/satellite.py` and `modal deploy modal_app/signals.py`, so "Scan now" can run live |
| Fallback ready | `#/mission/replay` plays the last recorded scan (no network to Modal needed) |
| Briefing cached | `data/built/briefing.wav` exists, so it plays instantly |
| Backup tab | `#/ask/Will%20my%20latte%20cost%20more%20by%20Christmas%3F` asks on load |

Presenter shortcuts:

- `#/mission/scan` starts a live scan.
- `#/mission/replay` replays the recorded scan.
- `#/ask/<question>` asks a question on load.
- Legacy `#/module/<id>` links still work.

## The run

| Time | Screen / click | Say |
|---|---|---|
| **0:00** | **`/landing`**: rotating Sentinel-2 globe, regions pulsing, arcs flowing to London | "Prices don't start rising at the till. They start in a drought in Jaén, a dry reservoir next to TSMC, or a new AI campus in Texas. Orbit watches those places **from space**, and tells Londoners what they'll pay next." Point at the chips: *1,840 satellite tiles · 142k Jev judgments · 64% direction right.* Click **Open Orbit**. |
| **0:15** | **Earth** (`#/earth`): world map on Sentinel-2 cloudless. Hover **Bordeaux**. | "20 real Sentinel-2 regions: 12 farms and 8 chip and AI sites. Here Bordeaux's vines are 11% less green than their 5-year norm, pressure 72 out of 100, so a £9 bottle heads to about £9.16." Click the product chips along the bottom to hop between items. |
| **0:35** | **Groceries** (`#/groceries`) → open **Olive oil** | "Every price has a fan chart: a 10–90% range, not a single number. In March 2023 satellites saw the Jaén groves 10% less green than normal. Olive oil then rose 39%." Be honest: "Our model didn't call the size of that one. The Track record page shows the hits *and* the misses." Drag the before/after slider on the satellite tile. |
| **0:55** | **GPU & Gadgets** (`#/gpu`) | "AI is eating the world's GPUs. This waterfall shows *why* the forecast moves: the price trend, AI data-centre demand and a memory-chip shortage (Jev read 11,000 headlines here), and data centres we can **see being built**. Drag the slider: Stargate in Abilene, January 2019 vs August 2026." Headline: "GPU up 6.6% by February 2027, £1,650 → about £1,758, 66% chance it rises." Point at **Supply risk by region**: "Jev judged each site's satellite statistics." |
| **1:20** | **Rent Radar** (`#/rent`): switch 2D → **3D**, then **Neighbourhoods** | "London in 3D. Height is new building seen from orbit, and colour is rent pressure. Newham is on top. Zoom in, and you get 2,406 neighbourhood hexagons, each with real Sentinel-2 built-up change since 2019." Say it plainly: "The rents here are synthetic. The building change is real." |
| **1:40** | **Mission Control** (`#/mission`) → **Scan now** | "Now live. One click fans out across **Modal**: 120 satellite tiles, re-downloaded and re-processed, plus fresh headlines from 5 news sweeps, each judged by **Jev**." Let the tiles fill the grid and point at the counters: containers climbing toward 100, Jev judgments per second (last run peaked at 480/s), done in about 45 s. "Gemini sees, Jev judges, Modal scales." |
| **2:15** | **Track record** (`#/track`) | "Is any of this right? We re-ran every model **as if it were the past**: 1,436 TimesFM runs on 10 L4 GPUs, each seeing only data known at the time. We chose the model on 2020–22 and scored it once on 2023–26. It gets the direction right 64% of the time, catches 71% of big price rises, and beats 'price stays the same' by 2.6%. That's small, and we show exactly how small." Point at the leaderboard and the calibration chart. |
| **2:35** | **Ask Orbit** (`#/ask`): type or say *"Will my latte cost more by Christmas?"* | "**Jev** routes the question to the Latte module with a calibrated confidence, and **Gemini** calls our tools and answers with the evidence." Point at "How Orbit answered". Then click **Play the spoken briefing** (Gemini TTS). |
| **2:55** | – | "Orbit: tomorrow's prices, seen from space. **Gemini sees, Jev judges, Modal scales.**" |

## If something breaks

| Symptom | Recovery |
|---|---|
| Scan doesn't start or Modal errors | Go to `#/mission/replay`. The backend also falls back to the recording by itself if Modal is unreachable. |
| Ask is slow or has no answer | The template answer appears after the timeouts (Jev 6 s, Gemini 20 s). Or use the pre-loaded backup tab. |
| Map tiles missing (venue firewall) | The landing page has a static CSS globe fallback. Module pages still show the fan charts. |
| Briefing button silent | `/api/briefing` serves the cached WAV. Check that the laptop audio is on. |

## Pitch lines to remember

- "Satellite intelligence for commodities. Fully agentic."
- "Every tile is real Sentinel-2. Every headline was judged by Jev. Every forecast ran on a Modal GPU."
- "We show our misses."
