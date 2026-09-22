# Orbit: 5-minute demo

About 650 spoken words at a calm pace, plus time for live actions. **Bold** = say it with weight. [CLICK] = action.

**Before going on stage (2 min before):**
- Open `/landing`, `/news` and `/mission` once. This caches the globe and warms up the Modal containers.
- On Ask Orbit, have the question typed but not sent: *"Should I buy a GPU now or wait?"*
- Tabs in order: landing → app.

---

### 0:00–0:35 · Landing: the problem
[Landing page, globe turning]

> "Every price you pay starts somewhere physical. A drought in Brazil's coffee farms. A heatwave over Spanish olive groves. A new AI data centre in Texas buying up every GPU it can find.
> By the time it reaches a café in London or a procurement contract, **it's months old**, and whoever saw it first already moved.
> Traders pay millions for this kind of intelligence. Everyone else finds out at the till.
> Orbit is **satellite intelligence for commodities, fully agentic**. **Google Gemini** sees, **Jev** from TypeSafe judges, and **Modal** runs it all at scale."

### 0:35–1:00 · Earth: where prices grow
[CLICK: Open Orbit → Earth. Click the Coffee chip, then GPU.]

> "Twenty regions, watched from orbit with real **Sentinel-2** imagery: cocoa in Côte d'Ivoire, coffee in Brazil and Vietnam, hops in Bavaria, and also **AI data centres and chip fabs**.
> Coffee: crop health below its five-year norm. One click and we're at the GPU supply chain."

### 1:00–1:20 · Overview: one screen for the market
[CLICK: Overview]

> "Everything rolls up here. Price pressure per market, what's rising fastest, and your basket: **up about 3 % in six months**.
> For a **business**, this is supply risk before it hits the P&L. For a **person**, it's when to buy."

### 1:20–1:45 · Groceries: it's shopping
[CLICK: Groceries. Open the olive oil or bread card.]

> "We made it feel like a shop, because that's how people think about prices.
> Each product: today's price, the price in six months, and a simple call: **stock up, hold or wait**.
> Open one and you see its price history, the farm it comes from **seen from space**, and the headlines Jev judged behind the move."

### 1:45–2:25 · GPU & Gadgets: the AI era
[CLICK: GPU & Gadgets. Drag the Stargate before/after slider, then hover a driver bar.]

> "Now the one this room cares about: **GPUs**.
> This is the Stargate AI campus in Abilene, 2019 versus today. **You can watch AI demand being built from space.**
> Orbit breaks the forecast down in pounds: AI data centres buying chips, the memory shortage, and new data centres we measure by satellite. Taiwan's chip-fab reservoir is **73 % below normal**.
> **£1,650 today, about £1,758 by February, 66 % chance it rises.**
> A hardware buyer locks in contracts now. A gamer buys this month, not next."

### 2:25–2:50 · Rent Radar: personal and local
[CLICK: Rent Radar. Toggle 3D, zoom into south London, click Peckham, switch the metric to "Built change".]

> "Same engine, pointed at London's most painful price: **rent**.
> We measure new construction from orbit in 2,400 neighbourhood hexagons. Where building is slow and demand is high, rent pressure rises.
> **Peckham: £2,475 today, about £2,610 next year.** A landlord sees pricing power; a tenant sees when to lock in."

### 2:50–3:20 · News hub: Jev at full speed
[CLICK: News hub → **Scan the news**. Stay quiet for 2 seconds while it starts.]

> "Satellites show the ground, but markets move on **words** too.
> Right now Orbit is pulling **four thousand fresh headlines**, and **Jev** judges every single one: is it relevant, which commodity, does the price go up or down, how severe, with **calibrated probabilities**, not guesses.
> **Sixteen thousand judgments in about six seconds**, on fifty Modal containers, for **under eight cents**.
> An LLM would take minutes and dollars to do this. Jev does it faster than you can read one headline."

### 3:20–3:55 · Mission Control: the agentic core
[CLICK: Mission Control → **Scan now**. Talk while the tiles fill in.]

> "This is the whole loop, live. **Modal** fans out to up to **100 containers**, pulls the latest Sentinel-2 image for every region, and measures crops, water and construction. **Jev** judges fresh news, **Google's TimesFM** forecasts on **NVIDIA L4 GPUs**, and **Gemini** writes the explanation.
> No analyst team and no monthly report. **It runs in under a minute, and it costs cents.**"

### 3:55–4:25 · Ask Orbit: talk to it
[CLICK: Ask Orbit → send *"Should I buy a GPU now or wait?"*]

> "And you can just ask. Jev first routes the question and says how confident it is. Then a **Gemini agent** calls Orbit's own tools (forecasts, satellite, news) and answers in plain English, with the chart."

### 4:25–4:50 · Track record: why you can trust it
[CLICK: Track record]

> "We didn't just build forecasts, we **tested them honestly**: 266 forecasts on data the model never saw, 2023 to today.
> Orbit gets the direction right **65 % of the time**, beats the 'price stays the same' baseline, and catches about **7 in 10 big price jumps**. We show every model we tried, including the ones that lost."

### 4:50–5:00 · Close
[CLICK: back to landing or Earth]

> "Farms, reservoirs, data centres and the world's news, turned into tomorrow's prices.
> **Orbit: know tomorrow's prices today.** Thank you."

---

## If something breaks
- **News hub is slow:** click **Replay**. It streams a real recorded scan.
- **Mission Control has no connection:** it automatically replays the last real scan.
- **Ask Orbit is slow:** skip it and say "it's the same engine you just saw, in chat form".

## Judge Q&A
- **Accuracy?** 65 % direction right on 266 unseen forecasts. It beats "no change", catches about 7 in 10 rises above 15 %, and its probabilities are calibrated. Details are in `docs/MODEL.md`.
- **Why Jev, not an LLM?** Typed, calibrated judgments at about 2,500 per second for fractions of a cent. Code acts on probabilities, not on generated text.
- **Why Modal?** Satellite processing on up to 100 containers, TimesFM on L4 GPUs, 50-container news scans, and the whole app is served from Modal.
- **What's real?** Satellite imagery, news, commodity prices, and the Jev and Gemini calls are real. The GPU street-price series is curated from public sources, and rents are modelled.
