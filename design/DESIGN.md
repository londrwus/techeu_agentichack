# Orbit frontend design spec

Screenshots: `design/01-overview.png`, `02-module-latte.png`, `03-rent-radar.png`, `04-mission-control.png`, `05-ask-orbit.png`. Tokens: `web/src/styles/tokens.css` (Inter from Google Fonts). All frames are 1440×900. Build for 1440×900 first; below 1280 px it may stack.

Principles: light, calm, **big numbers, few elements per card**, readable from the back of a room. Orange (`--accent`) means "rising / act". Red means price up, green means price down. AI prose only appears in 1–3 sentence cards. If data is missing, hide the widget.

## Shell (all screens)

```
body: bg var(--bg), font var(--font), color var(--text-1)
[ Sidebar 248px ][ Main: flex column, padding 32, gap 20-24 ]
```

**Sidebar** (`248×100vh`, white, right border 1px `--border`, padding 24/16, column gap 24):
- Brand: 36×36 `--ink` tile, radius 10, lucide `orbit` icon 20px in `--accent`. "Orbit" 20/700, and "Tomorrow's prices" 12 `--text-3` below it.
- Section labels: 11/600 uppercase, tracking 0.8px, `--text-3`. Sections: WORKSPACE (Overview), MODULES (Groceries, Latte Index, Beer & Wine, GPU & Gadgets, Rent Radar), AGENTS (Ask Orbit, Mission Control).
- Nav item: height 40, radius 10, padding 0 12, gap 12, lucide icon 18 `--text-2`, label 14/500 `--text-2`. Module items have an 8px dot in the module colour on the right. Icons: layout-dashboard, shopping-cart, coffee, beer, cpu, building-2, sparkles, satellite.
- Active item: bg `--accent-soft`, icon and label `--accent-ink`, label 600.
- Bottom card (pushed down): bg `--bg`, radius 12, padding 16. "Gemini sees · Jev judges · Modal scales" 12/600, then "16 satellite regions watched" 12 `--text-3`.

**Top bar** (height ~64, space-between, center-aligned):
- Left: optional breadcrumb 13 `--text-3` ("Modules / Latte Index"). Title row: 44px module icon square (optional), title 32/700 with -0.5px tracking, then an optional pill or subtitle.
- Right: buttons are 44 high with radius 12 and padding 0 18–20, label 15/600, 18px icon, gap 8.
  - Secondary: white, 1px border ("Share", "Stop").
  - Primary: `--accent` with white text and `--shadow-primary` ("Scan now", lucide `satellite-dish`). While running, show "Scanning…" at opacity .6 with a spinning `loader` icon.

**Card**: white, 1px `--border`, radius 16, padding 24 (KPI cards 20), no shadow. Card title 20/700, subtitle 14 `--text-3`, gap 4. Gap between cards 16.

**Pills**: radius 999, padding 4–5 × 10–12, 13/600, lucide icon 14.
- Delta up: bg `--up-soft`, text `--up`, icon `trending-up`, e.g. "+12% in 6 mo".
- Delta down: `--down-soft` / `--down`.
- Live: "● Updated 2 mins ago", white with border and an 8px green dot.

**Icon square**: 36×36 (44 in page titles), radius 10–12, bg = module colour + `22` alpha, holding the emoji (18–22px) or a lucide icon in the module colour.

---

## 1. Overview (`#overview`)

1. **Top bar**: "Overview" + live pill "Updated 2 mins ago". Tagline under it, 16 `--text-2`: *Satellites see prices rising months before you pay them.* Right: Share, then **Scan now** (switches to Mission Control and starts the SSE scan).
2. **KPI row**: 5 equal cards, gap 16, height ~216. Data from `summary.json.modules[]`. Each card is a column with gap 16:
   - Head: icon square (emoji) + module name 15/600.
   - "Price pressure" 13 `--text-3`, then the value **78** at 44/700 (tracking -1, line-height 1) + "/100" 16/500 `--text-3`.
   - Bar: 6px track `--muted`, radius 3, fill = `pressure%` in the module colour.
   - Delta pill "+{change_6m_pct}% in 6 mo".
   - The whole card is clickable and goes to the module.
3. **Bottom row** (fills the remaining height, gap 16):
   - **Tomorrow's Basket** card, 560 wide. Header: title + "Expected price change in 6 months"; on the right, **+9.4%** 28/700 `--accent` + "basket vs today" 13 `--text-3`.
     - Waffle bar chart with 8 columns, space-between, bottom-aligned. Each column (gap 10, centered) is:
       - value label 14/700 ("+22%"): `--accent-ink` if ≥10%, else `--text-2`
       - a stack of 10 rounded squares (30×22, radius 5, gap 5). Filled from the bottom: `round(change/2.2)` squares. Fill colour is `--accent` if ≥10%, else `--accent-light`. Empty squares are `--muted`.
       - emoji 20px
       - name 12/500 `--text-2`
     - Items come from the `forecast/{item}.json` `change_6m_pct` values: Choc, Olive oil, OJ, Latte, Pint, Wine, Bread, GPU.
     - Legend row: 12px swatches with radius 3, labels "Rising fast (≥10%)", "Rising", "Headroom".
   - **Satellite watchlist** card (fills the rest). Header: title + "16 regions · Sentinel-2", with a segmented control on the right: All / Crops / Water / Built. The control has bg `--bg`, padding 4, radius 10; the active item is white with `--shadow-seg`; items are 13px.
     - Map area: fills the card, radius 12, bg `--map-light`, overflow hidden. Background is the dotted world map `design/images/generated.png` (the React Overview uses a MapLibre light basemap instead). Position it as an absolutely placed, stretched image:
       - with `k = mapWidth/667`: width `1408k`, height `768k`, left `-340.9·(mapWidth/504)`, top `-142.8·(mapWidth/504)`. This shows lon −95..140 and lat 70..−60.
       - Pin position: `x = (721 + lon·2.84)·k − 340.9·(mapWidth/504)`, `y = (403 − lat·3.06)·k − 142.8·(mapWidth/504)`.
       - Alternative: a MapLibre light style if you already load it. The image is offline-safe.
     - Pins: 12px circle in the module colour with a 2px white stroke, over a 22px halo (module colour at 20% alpha). Use a pulse animation on pins whose `anomaly.ndvi_vs_5yr_pct < -10`.
     - Callout on the worst anomaly: white, radius 12, `--shadow-pop`, padding 10×14. Line 1: "☕ Sul de Minas, Brazil" 13/600. Line 2: "NDVI −14% vs 5-yr" 13/700 `--up`.
     - Stats row (height 72, 3 tiles, bg `--bg`, radius 12): "16 regions watched", "5 in drought stress" (`--up`), "−6% avg NDVI vs 5-yr" (`--up`). Values 22/700, labels 12 `--text-3`.
     - Legend: 10px dots with module names, 13 `--text-2`.

## 2. Module detail (`#module/latte`; same layout for every module)

Top bar: breadcrumb, 44px icon square + "Latte Index". Right: **backtest badge**, 44 high, bg `--down-soft`, radius 12, lucide `history` in `--down`, text 14/600 `--down-ink` "Backtest: would have flagged it 6 months early" (from `forecast.backtest`; hide if null). Then Scan now.

**Row 1** (height 320, gap 16):
- **Price card** (340 wide), laid out top-to-bottom with space-between:
  - Item name 15/500 `--text-2` ("Latte, London café").
  - **£3.95** 40/700 `--text-3` → lucide `arrow-right` 28 → **£4.40** 48/800 `--accent` (tracking -1.5).
  - Delta pill "+11.4% by Sep 2027".
  - Bottom: 2 stat tiles (bg `--bg`, radius 12, padding 14). Value 24/700 with label 13 `--text-3`: "87% chance it rises" (`prob_up_6m`) and "+23% arabica futures".
- **Forecast card** (fill): title "12-month forecast", sub "TimesFM on Modal · A10G · p10–p90 band". Legend on the right: History (dark line), Forecast (p50) (orange line), p10–p90 (orange at 15% alpha).
  - ECharts line chart, ~724×210, no chart title/toolbox.
  - History: `--text-1` line, width 3, no symbols, smooth off.
  - Forecast p50: `--accent`, width 3.
  - Band: stacked-area trick for p10..p90, fill `rgba(249,115,22,.15)`.
  - Y axis on the left, labels "£3.50" 12 `--text-3`, split lines `--border`, no axis line.
  - X axis shows 4 labels only.
  - **Today**: vertical markLine in `--text-3` 2px, with a black label chip "Today" (white 12/600, radius 6). Today's point is a white circle with a 3px dark stroke.
  - End point: orange dot + orange chip "£4.40".

**Row 2** (fills the rest, gap 16):
- **Satellite card** (400 wide). Title "Sul de Minas, from orbit", sub "Sentinel-2 · 10 m · Aug". NDVI pill on the right (`--up-soft`, lucide `leaf`, "NDVI −14%").
  - Before/after compare (fills the card, radius 12, overflow hidden). Show two `tiles/{region}/{month}.png`: 2019 on the left, latest on the right, with the left image clipped by `clip-path: inset(0 X 0 0)`.
  - Handle: 3px white vertical line + 36px white circle knob (lucide `chevrons-left-right`, shadow). Drag it with pointer events.
  - Tags "2019" / "Now": top corners, bg `rgba(12,10,9,.7)`, white 13/600, pill.
  - Use `image-rendering: auto` and `object-fit: cover`.
- **Jev card** (fill):
  - **2,431** 32/800 + "headlines judged by Jev" 16/600 `--text-2`. Sub "Each square is a news story · coloured by supply effect".
  - Waffle: CSS grid of 20 columns × 8 rows (160 squares; sample headlines if there are more), gap 4, square height 20, radius 4. Colours: tightens-high `--up`, tightens-low `--up-light`, none `--muted`, loosens `--down`.
  - Hover shows a tooltip with the headline title + source. Animate squares filling in with a stagger (8 ms each) on load.
  - Legend rows with counts right-aligned (13/700).
- **Insights column** (300 wide): 3 stacked cards of equal height (`insights/{module}.json.cards[0..2]`). Padding 16. Head: lucide icon 16 `--accent` + title 15/700. Body 14/1.45 `--text-2`, max 2 sentences.

## 3. Rent Radar (`#module/rent`)

Top bar: "Rent Radar" + subtitle 16 `--text-2` "London · new building seen from orbit × rents". Right: a segmented control (white, 1px border, radius 12, padding 4; active item `--ink` bg with white 14/600; items padding 8×14): Rent pressure / Rent now / Built change. Then Scan now.

Content row (gap 16):
- **3D map card** (fill, radius 16, bg `--map-dark`, overflow hidden). deck.gl `GeoJsonLayer` on MapLibre with dark tiles (Carto dark-matter). `extruded: true`.
  - Elevation = `built_change_pct` (or `pressure`) × scale. Fill = the pressure ramp `--ramp-0 → --ramp-50 → --ramp-100`.
  - Camera: pitch 50, bearing -20, zoom ~10, centred on 51.50,-0.10. Slow auto-rotate (bearing += 0.05/frame) until the user interacts.
  - Overlays use glass (bg `--glass`, 1px `--glass-border`, radius 12, backdrop blur 12, white text):
    - top-left chip "3D · 33 boroughs · drag to rotate" (lucide `rotate-3d`)
    - top-right zoom/compass stack (32px buttons)
    - bottom-left legend, 280 wide: "Rent pressure · height = built-up change", 10px gradient ramp, labels 0 / 50 / 100
  - Hover tooltip: white card, radius 12, `--shadow-tooltip`. Name 15/700, "£2,650 → £2,860" 14/600 + "+7.8%" `--up`, and "Built-up area +11% since 2019" 12 `--text-3`.
- **Side panel** (360 wide, column gap 16):
  - Average card: "Average London rent, 1-bed" 14 `--text-3`, "£2,310 → £2,405" (32/700 grey → 36/800 orange), delta pill "+4.1% in 12 mo".
  - **Top 5 by rent pressure** card: title 18/700. Each row:
    - rank square 26px (radius 8; #1 is `--accent` with a white number, others `--bg`)
    - name 15/600, sub "+7.8% rent · +11% built" 12 `--text-3`
    - pressure number on the right, 22/700 (top 2 in `--accent-ink`)
    - a 6px bar below (top 2 `--accent`, others `--accent-light`)
    - Clicking a row flies the camera to that borough.
  - Insight card (fills the rest): bg `--ink`, lucide `sparkles` + "Gemini sees" 13/600 `--accent-light`, body 16/1.5 white (1–2 sentences).

## 4. Mission Control (`#mission`), the live-scan screen

Top bar: "Mission Control" + live pill (bg `--up-soft`, 8px red dot pulsing, "LIVE · scan running 00:42" 13/700 `--up`). Tagline "Every satellite tile, every headline, re-judged in under a minute." Right: Stop (secondary, lucide `square`), and "Scanning…" (primary, disabled look).

- **Counter row**: 4 equal cards, padding 20, gap 14.
  - Head: 36px icon square (tint) + label 15/600.
  - Value 52/800 (tracking -1.5, line-height 1) + suffix 18/500 `--text-3`.
  - Source chip (bg `--bg`, 6px dot, 12/600 `--text-2`).
  - Cards:
    1. `box` "Modal containers" **87** / 100, green, chip "Modal"
    2. `image` "Tiles processed" **1,204** / 1,536, orange, chip "Sentinel-2"
    3. `gavel` "Jev judgments / sec" **412**, indigo, chip "TypeSafe Jev"
    4. `cpu` "GPU model" **A10G** × 8, ink, chip "TimesFM on Modal"
  - Animate the numbers with a count-up (requestAnimationFrame, tabular-nums).
- **Content row** (gap 16):
  - **Tiles card** (fill): title "Sentinel-2 tiles, arriving live", sub "16 regions × 96 months · one Modal container per tile batch". On the right a big % (32/800 `--accent`).
    - Progress bar: 10px, radius 5, gradient `--accent-light → --accent`.
    - Tile grid: CSS grid with 9 columns, gap 8, square-ish cells (radius 8), laid out as 5 rows that fill the card. States:
      - done: `<img>` thumb with a fade/scale-in (200 ms)
      - processing: bg `--accent-soft`, 2px `--accent` border, spinning lucide `loader` 20px
      - pending: bg `--bg`, 1px border
    - Show the latest 45 tiles and shift the grid as new ones arrive via SSE.
  - **Side panel** (360 wide):
    - "Powered by" card, titled "Gemini sees · Jev judges · Modal scales" 16/700. It has 3 provider rows (bg `--bg`, radius 12, padding 12). Each row has a 40px coloured logo square with a white lucide icon, then name 15/700 + role 12 `--text-3`, and a stat on the right 13/700 in the provider colour:
      - Modal, green `server`: "87 CPU + 8 GPU", "$0.42"
      - Google Gemini, blue `eye`: "3.8-flash · vision", "214 calls"
      - TypeSafe Jev, purple `scale`: "jev-latest", "18,442 judged"
    - Throughput card (fills the rest): "Jev judgments / sec" 15/700, "peak 506" 13 `--text-3`. Live bar chart of the last 30 seconds: bars `#C7D2FE`, gap 3, radius 2, with the newest bar in `--accent`.

## 5. Ask Orbit (`#ask`)

Top bar: "Ask Orbit", tagline "Ask about any price. Jev routes it, Gemini answers with the evidence."

- **Chat panel** (fill, padding 28, column gap 20):
  - User bubble, right-aligned: bg `--ink`, white 18/500, padding 14×18, radius 18 18 4 18.
  - Answer row: 36px ink avatar (orbit icon in orange) + body column (gap 14):
    - **Jev route pill**: bg `--p-jev-soft`, lucide `git-branch` 14 `--p-jev`, 13/600 `--p-jev-ink`: "Jev routed → ☕ Latte Index · 94% confident".
    - Answer text 18/1.5, max ~3 sentences.
    - **Chart answer card**: 560 wide, bg `--bg`, radius 16, padding 20. Head: "Latte price, next 6 months" 15/700 + "87% chance of rising" 13/600 `--accent-ink`. Chart is monthly columns, height 150, gap 12, top radius 6.
      - Colours: current month `--text-3`; the month the question asks about (Dec) `--accent` with a bold label; others `--accent-light`.
      - Value labels 12/600 above the columns, month labels below.
    - Source chips: 1px border, radius 8, 12/500, lucide icons `satellite`, `newspaper`, `chart-line`.
  - Input pinned to the bottom: height 60, radius 14, 1.5px border. Placeholder "Ask about olive oil, GPUs, rent in Hackney…" 16 `--text-3`. Then a 44px mic button (`--bg`) and a 44px send button (`--accent`, lucide `arrow-up`).
- **Side panel** (360 wide):
  - "How Orbit answered" trace card. Each step row has a 34px tinted icon square, name 14/600, detail 12 `--text-3`, and a green `check`. Steps appear one by one while the answer streams:
    1. `git-branch`, purple: "Jev routes the question" / "Latte Index · 94% · 38 ms"
    2. `eye`, blue: "Gemini reads the tiles" / "3 regions · NDVI −14%"
    3. `server`, green: "Forecast from Modal" / "TimesFM · p50 £4.20"
    4. `volume-2`, orange: "Spoken briefing" / "Gemini TTS · 0:18"

    Below the steps is a full-width ink button "▶ Play 18-second briefing" (44 high, radius 12).
  - "Try asking" card: 4 suggestion chips (bg `--bg`, radius 10, padding 10×12, 14/500 `--text-2`). Clicking one fills the input and sends it:
    - 🍫 Why is chocolate so expensive?
    - 🖥️ Will GPUs get cheaper next year?
    - 🏠 Where will rents rise most?
    - 🍺 Is a pint going to hit £8?

## Motion and demo polish
- Page switches: 150 ms fade. Count-up on all big numbers. Waffle squares and tiles stagger in.
- Scan now → navigate to Mission Control, start SSE, and update the counters live. When the scan finishes, show a toast "Scan complete · 1,536 tiles · 2,431 headlines" and link back to Overview.
- Fallbacks: every widget renders from `data/built/*.json`. The live scan replays a cached event log if SSE fails.

## Assets
- `design/images/generated.png`: dotted world map for the Overview (calibration above).
- The other `design/images/generated-*.png` files are AI mock imagery for the design only. **Do not ship them as real satellite data**; use the real `tiles/` PNGs.
