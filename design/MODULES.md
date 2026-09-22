# Orbit module screens: design spec

Source: `design/orbit.pen` (Pencil). Frames: `00 Earth` (TCxlm), `06 Groceries` (A1odYJ), `07 Latte Index` (cT8Bd), `08 Beer & Wine` (NPxet), `09 GPU & Gadgets` (gFcLd).
Screenshots: `design/modules/{earth,groceries,latte,beer_wine,gpu}.png`. These screens replace section 2 ("Module detail") of `DESIGN.md`. Tokens: `web/src/styles/tokens.css`.

**Direction:** restrained and premium, closer to Stripe or Linear than to a toy. Each screen has one hero, at most 4–5 elements, calm neutrals and one accent per module. There are no illustrations or emoji-heavy UI. Modules differ in **content and layout**, not in metaphor. Every module uses the same chart language (below).

Module accents (used only for the forecast line, the active risk curve and sparklines):
`groceries #F97316` · `latte #A16207` · `beer #CA8A04` · `gpu #6366F1`. Price up = `--up` red.

Data: `GET /api/modules/{module_id}` →
`{module, items[], regions[], signals{headlines[], n_judgments, net_supply_pressure, region_judgments[]}, insights{headline, cards, vision_notes}}`. Tiles are at `/tiles/{region}/{month}.png`.
Follow the usual rule: if a field is missing, hide the widget.

---

## Shared layout (all 4 module screens)

```
[Sidebar 248][Main: padding 32, column gap 20]
  Top bar            1128 × 64    (unchanged: breadcrumb, 44px icon square, title 32/700, backtest badge, Scan now)
  Hero row           1128 × 500   gap 16  → module specific (below)
  Signal row         1128 × 232   gap 16  → 3 equal cards (365 × 232): Price · Risk · Earth
```
CSS: `.module{display:grid;grid-template-rows:64px 500px 232px;gap:20px}`, and for the hero `grid-template-columns` is given per module.

Card: white, 1px `--border`, radius 16, padding 24 (signal cards use 20), no shadow. Card title 20/700 (15/700 in signal cards), subtitle 13/500 `--text-3`.

### Chart language (ECharts), used for every price chart
- **History**: `type:'line'`, colour `#334155`, width 2.5, `symbol:'none'`, `smooth:false`, with `areaStyle` as a vertical linear gradient from `rgba(100,116,139,.18)` to `rgba(100,116,139,0)`.
- **Forecast (p50)**: a **separate series** that starts at today's point (it repeats the last history value) and runs to the horizon. Use `lineStyle:{type:[7,5], width:2.5, color: moduleAccent}` and `symbol:'none'`. Give the end point a `markPoint` or a small scatter: an 8px accent dot with a 2px white border and a 20px halo (accent at 15% alpha).
- **Today divider**: `markLine` on the history series with `xAxis: today`, `lineStyle:{type:[3,4], color:'#A8A29E', width:1}`, `symbol:'none'`, and a label chip "Today" (black `--ink` bg, white 10/600, radius 5, `position:'end'`). Today's point is a white circle with a 2.5px `#334155` stroke.
- **Axes**: y-axis labels on the left, 11/500 `--text-3` (e.g. `£4.40`), split lines `#F1F0EE`, no axis line or ticks. The x-axis shows 3–4 labels only (`Sep 25 · Sep 26 · Mar 27`).
- **Optional band**: p10–p90 as the stacked-area trick, accent at 12% alpha. Hero charts only, and off by default to keep them calm.
- **Floating callout**: a custom **HTML overlay**, not an ECharts tooltip. It is an absolutely positioned `<div class="callout">` placed with `chart.convertToPixel({seriesIndex:1}, [lastMonth, p50])`. Offset it so it never covers the dashed line: top-left of the plot for rising series, otherwise below the end point. Style: white, 1px `--border`, radius 12, padding 10×14, shadow `0 8px 24px rgba(0,0,0,.12)`.
  - line 1: `"{Item} · {Mon YYYY}"` 12/600 `--text-2`
  - line 2: value 24/700 `--text-1` (tracking -0.5), then the delta 13/600 `--up` (`↑ 11.4%`), or `--down` when it's negative
  - Recompute its position on `chart.on('finished')` and on resize.
- Motion: draw the history first (ECharts `animationDuration: 800`), then the forecast (`animationDelay: 800`), then fade the callout in (200 ms).

### Signal row (3 cards, the same on every module)
Head row: title 15/700 on the left, source 12/500 `--text-3` on the right. The chart fills the rest (~325 × 140). No other text.

1. **Price signal** (subtitle "TimesFM forecast"): a mini version of the chart above with no axes, a dashed today line, a dashed accent forecast and an end dot. The callout sits top-left in compact form (title 11/500, value 18/700, delta 12/600).
   Data: a second item of the module (`items[1]`), or the module "basket" index. `history[-12:]`, `forecast[].p50`, `change_6m_pct`.
2. **Risk signal** (subtitle "Jev · per region"): multi-line curves, one per region, from Jev harvest or supply risk (0..1) over 12 months. The worst region is in the module accent (width 2), the 2nd in `#94A3B8` and the 3rd in `#E2E8F0`. Grid lines are `#F1F0EE`. A legend row below uses 10×3 swatches and 11/500 labels. The callout shows `"{Commodity} supply risk"` with the value (e.g. `0.84`) and the delta vs last month in `--up`.
   Data: `signals.region_judgments[]` (risk = P(high) from `harvest_risk.probs`). The history of this value is synthetic or cached per scan; if there's no history, show a single point per region as a dot plot.
3. **Earth signal** (subtitle "Crop health vs 5-yr", or "Reservoir level vs 5-yr" for GPU): a bar chart with one bar per region. Bars are `#CBD5E1` with top radius 4. The **worst region is amber `#F59E0B`** with a chip above it "Under avg." (bg `#FEF3C7`, text `#B45309`, 10/600). Region labels 11/500 `--text-3` sit below.
   Data: `regions[].anomaly.ndvi_vs_5yr_pct` (GPU uses `ndwi_vs_5yr_pct`), with bar height = `100 + pct`. The amber bar is `argmin`.

Motion: bars grow from 0 (300 ms, 40 ms stagger). Curves draw left to right. Callouts fade in last.

---

## 00 Earth (`#earth`): the demo opener

Full-bleed, dark, no white cards. The sidebar collapses to a 56px glass **rail**.

```
Map: 1440 × 900 full bleed, bg #0A0F2C
  Rail          x16  y16  56 × 868   glass; logo tile + 9 nav icons (active = globe, bg #F9731633, icon #FDBA74)
  Title glass   x92  y16  420 wide   kicker "● LIVE FROM SENTINEL-2 · SEP 2026" 11/700 +0.8 tracking #FFFFFFA6
                                     title "Where tomorrow's prices grow" 26/800 white; sub "13 farm & fab regions · greener = more production" 14/500
  Stats glass   right 16, y16, 444   3 stats: 1,536 tiles seen · 2,431 headlines judged · 78 avg pressure (the 78 in #FDBA74). Values 24/800
  Scan now      below stats, right-aligned (primary button)
  Region glass  250 wide, anchored to the selected region with a 1.5px white leader line and a 68px white focus ring
  Legend glass  bottom-right 220 wide: "Production" ramp (#16A34A26 → #22C55EE6), orange ring = "Crop health below 5-yr", indigo dot = "Chip fabs (water)"
  Chip carousel x92 y804, 1332 × 80 glass, chips 52 high centred
```
- **Glass**: `background: rgba(10,15,44,.6–.7); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,.12); border-radius: 16px;` Floating cards add `box-shadow: 0 12px 32px rgba(0,0,0,.4)`.
- **Basemap**: MapLibre with raster **EOX Sentinel-2 cloudless** tiles (`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg`), with an attribution chip. Initial view: centre 15, 20, zoom ~1.6. Offline fallback: a static world image.
- **Choropleth**: admin-1 GeoJSON polygons for the producing regions, as a `fill` layer `#22C55E` with opacity ramped by production share (0.15 → 0.7), plus a 1px `#86EFAC` outline. Taiwan fabs use indigo `#818CF8`. Regions with `anomaly.ndvi_vs_5yr_pct < -10` get a 2px `#F97316` ring (a circle layer) that pulses slowly (2 s).
  Regions: Jaén (olives), Soubré + Ashanti (cocoa), Sul de Minas (coffee), São Paulo (oranges), Huila (coffee), Đắk Lắk (coffee), Poltava (wheat), Hallertau + Žatec (hops), Bordeaux + Rioja (vines), Hsinchu/Tainan (fabs). London gets a white ring with an orange dot.
- **Region glass**: region 17/800 white, sub 12/500 60% white ("Arabica coffee · 31% of Brazil's crop"), divider, then:
  - "Crop health vs 5-yr" with **−14%** 28/800 `#FB923C`
  - "Price pressure" with **78** 28/800 + "/100", and a 6px bar (`#F97316` on 15% white)
  - "{Item}, London · in 6 months" with `£3.95 → £4.40` (20/700 at 50% white → 28/800 `#FB923C`)
  - Data: `regions[].anomaly`, `summary.modules[].pressure`, `items[0].retail_now/retail_6m`.
- **Chip carousel**: Chocolate, Olive oil, Orange juice, Bread, Coffee, Beer, Wine, GPU, Laptop, Rent. Each chip is 52 high with padding 0 16, radius 999, a lucide icon 18 plus a 14/500 label (icons: candy, droplet, citrus, wheat, coffee, beer, wine, cpu, laptop, building-2).
  - Inactive: `rgba(255,255,255,.06)` with a 1px 10% white border.
  - Active: solid white, `#1C1917` 14/700 text, icon `#C2410C`.
  - Click → `map.flyTo({center, zoom: 5.5, duration: 2000})`. The region glass then fades in at the region.
- Motion on load: the camera eases from zoom 1.2 to 1.6 (3 s), choropleth opacity fades in, and the numbers in the stats glass count up.

---

## 06 Groceries (`#module/groceries`)
Hero: `grid-template-columns: 1fr 440px`.

**Map card** (672 × 500, radius 16, overflow hidden, no padding): a satellite basemap (same EOX tiles, locked view lon −60..72, lat 60..−30; or the static crop) under a `rgba(10,15,44,.2)` shade.
- Region discs: 22–44px, sized by production share. At risk: fill `#F9731640` with stroke `#FB923C`; calm: `#22C55E40` with `#86EFAC`. Each has a 6px white centre dot.
- Arcs to London are quadratic curves. At risk they are 2px `#F97316`, otherwise 1.5px at 50% white. deck.gl `ArcLayer`, or SVG paths on the MapLibre overlay. London is a white 10px dot with a 3px orange ring.
- Region labels are small glass pills (11/600).
- Title glass top-left: "Where your basket grows" 16/700 + "5 source regions · Sentinel-2".
- Region glass (220 wide) under the worst region: "Soubré, Côte d'Ivoire" 14/700, "Cocoa · 40% of world supply", then two stats: **−18%** (`#FB923C`) "Crop health" and **82** "Pressure", both 22/700.
- Item chips glass bottom-right: Chocolate (active) · Olive oil · Orange juice · Bread. Clicking one highlights its regions and table row.
- Regions: Jaén, Soubré, Ashanti, São Paulo, Poltava (`regions[]` with lat/lon/anomaly).

**Basket table card** (440 × 500): title "Your basket" 20/700 + "Shelf price today vs in 6 months".
- Columns: ITEM (fill) · NOW 64 · 6 MO 64 · Δ 64 · TREND 76. Headers 11/600 uppercase `--text-3`. Rows use 1px `--border` bottom dividers and equal heights.
- Row: name 15/600 + unit 12 `--text-3`, now 15/500 `--text-3`, 6 mo 15/700, Δ as a pill (`--up-soft` / `--up` 12/700, e.g. "+17%"), and a sparkline (76×28 SVG, 2px accent, last 12 months).
- Total row: "Basket total" 15/700, £14.25 (`--text-3`), **£15.92** 18/800 `--accent`, and an orange pill "+11.7% in 6 mo".
- Data: `items[]` with `name`, `retail_now`, `retail_6m`, `change_6m_pct`, `history[-12:]`. Total = sum.
- Copy: Chocolate bar 200 g £2.10 → £2.45 +17%; Olive oil 1 L £8.50 → £9.40 +11%; Orange juice 1 L £2.20 → £2.55 +16%; Loaf of bread 800 g £1.45 → £1.52 +5%.

Signal row: Price = basket index ("Basket · Mar 2027 £15.92 ↑ 11.7%"). Risk = Soubré / São Paulo / Jaén ("Cocoa supply risk 0.84 ↑ 0.11"). Earth = Jaén, Soubré (amber), Ashanti, São Paulo, Poltava.

---

## 07 Latte Index (`#module/latte`)
Hero: `grid-template-columns: 1fr 420px`.

**Forecast card** (692 × 500, padding 24, gap 10):
- Head: "Latte, London café" 15/500 `--text-2`, then **£4.40** 40/700 (tracking -1.5) + "from £3.95 today" 15/500 `--text-3`. The legend sits on the right (History solid swatch, Forecast (p50) dashed accent swatch, 12/500).
- Chart 640 × 300 in the chart language, accent `#A16207`. Y ticks £3.40–£4.60, x labels Sep 2025 · Mar 2026 · Sep 2026 · Mar 2027. Callout "Latte · Mar 2027 / £4.40 / ↑ 11.4%" sits below and left of the end point.
- Stat strip (top border 1px, padding-top 14, gap 24), each value 18/700 + label 12 `--text-3`: "87%" chance it rises in 6 mo (`prob_up_6m`) · "+23%" arabica futures, 3 mo (`--up`) · "p10–p90" £4.12 – £4.61 (forecast at 6 m).

**Satellite card** (420 × 500): "Sul de Minas, from orbit" 20/700, "Sentinel-2 · Aug 2019 vs Aug 2026", and the NDVI pill "NDVI −14%" (`--up-soft`, lucide `leaf`). A before/after compare fills the card: the two tiles `/tiles/{region}/{2019-08}.png` and `/tiles/{region}/{latest}.png`, a draggable 3px white divider and a 36px knob (`chevrons-left-right`). Tags "Aug 2019" / "Aug 2026" are dark pills. Same implementation as DESIGN.md §2.

Signal row: Price = arabica futures ("Arabica · Mar 2027 $3.10/lb ↑ 23%"). Risk = Sul de Minas / Đắk Lắk / Huila ("Arabica supply risk 0.80 ↑ 0.12"). Earth = Minas (amber), Cerrado, Huila, Đắk Lắk, Sidama.

---

## 08 Beer & Wine (`#module/beer_wine`)
Hero: `grid-template-columns: 1fr 420px`.

**Heatmap card** (692 × 500): "Crop health by region" 20/700, sub "Sentinel-2 NDVI in July vs 5-year average, %". A legend on the right reads "Stressed ▮▮▮▮▮▮ Healthy" (16×10 swatches).
- Layout: a CSS grid `130px repeat(8, 1fr)`, gap 6. The year header is 12/500 `--text-3`, with the current year 700 `--text-1`.
- Row label: region 14/600 + kind 11/500 `--text-3` (Wine grapes / Hops). Rows: Bordeaux, Rioja, Hallertau, Žatec, Champagne. Years: 2019–2026.
- Cell: radius 6 with the value centred at 12/600 (`+2`, `−14`). The scale is diverging and calm, bucketed on the value:
  - ≤−12 `#EA580C` (white text)
  - ≤−6 `#FB923C` (text `#7C2D12`)
  - ≤−2 `#FED7AA`
  - <2 `#F1F5F9`
  - <5 `#BBF7D0`
  - ≥5 `#4ADE80`
- The current-year column gets a 1.5px `#1C1917` outline.
- Hover shows a tooltip with the region, year, NDVI value and the July tile thumbnail.
- Data: `regions[].series` filtered to July, as pct vs the 5-yr mean (compute client-side from `ndvi`).
- Motion: cells fade in column by column (60 ms stagger).

**Forecast card** (420 × 500): a segmented control Pint | Wine (bg `--bg`, active white + `--shadow-seg`). "Pint of lager, London pub", **£6.75** 40/700 + "from £6.40 today". Chart 372 × 250, accent `#CA8A04`, with the callout top-left "Pint · Mar 2027 / £6.75 / ↑ 5.5%". Stat strip: "74%" chance it rises · "+18%" hop prices, 12 mo. Wine: £9.00 → £9.60 (↑ 6.7%).

Signal row: Price = wine bottle ("Wine, bottle · Mar 2027 £9.60 ↑ 6.7%"). Risk = Hallertau / Žatec / Bordeaux ("Hop supply risk 0.78 ↑ 0.14"). Earth = Bordeaux, Rioja, Hallertau (amber), Žatec.

---

## 09 GPU & Gadgets (`#module/gpu`), light theme like the rest
Hero: `grid-template-columns: 1fr 420px`.

**Reservoir card** (692 × 500): "Water for the fabs" 20/700, sub "Reservoir level, % of capacity · 24 months". The stat on the right is **41%** 32/700 + pill "−27 pts vs 5-yr" (`--up-soft`), with "Tsengwen today · 5-yr avg 68%" 12 `--text-3` below.
- Body: the chart (430 × 330) on the left and a tile column (fill) on the right, gap 20.
- Chart: y 0–100%. Tsengwen is `#6366F1` 2.5px with a gradient area; Baoshan is `#94A3B8` 2px; the 5-yr average is a dashed `#A8A29E` 1.5px line. Callout at the minimum: "Tsengwen · Jan 2026 / 28% / lowest since 2021". End dot is indigo.
- Tile column:
  - the latest reservoir tile (`/tiles/tsengwen/{latest}.png`, radius 12, cover) with tag "Tsengwen · Aug 2026"
  - a legend (solid / solid / dashed swatches)
  - a pill "Water area −38% vs 5-yr" (`--up-soft`, lucide `droplets`)
- Data: `regions[]` for the reservoirs, using `series[].ndwi` → % of capacity (or synthetic levels). The Δ comes from `anomaly.ndwi_vs_5yr_pct`.

**Forecast card** (420 × 500): segmented GPU | Laptop. "RTX-class graphics card", **£1,790** + "from £1,650 today". Chart accent `#6366F1`, callout "GPU · Mar 2027 / £1,790 / ↑ 8.5%". Stat strip: "81%" chance it rises · "−27 pts" reservoir vs 5-yr. Laptop: £1,150 → £1,205 (↑ 4.8%).

Signal row: Price = laptop ("Laptop · Mar 2027 £1,205 ↑ 4.8%"). Risk = Hsinchu fabs / Tainan fabs / Kaohsiung port ("Fab water risk 0.72 ↑ 0.18"). Earth (subtitle "Reservoir level vs 5-yr") = Baoshan (amber), Tsengwen, Shihmen, Nanhua.

---

## Implementation notes
- One renderer, `renderModule(data, layout)`. The hero is chosen by `module_id`: `groceries → map+table`, `latte → chart+compare`, `beer_wine → heatmap+chart`, `gpu → reservoir+chart`. The signal row is shared code.
- Keep to at most 5 elements per screen and no extra insight cards. Gemini text appears only in the Earth region glass and in tooltips (1 sentence).
- Every chart renders from `data/built/*.json` (cached fallback). The satellite basemap falls back to a static image when offline.

---

## 06b Groceries: Shop (`#module/groceries`), which replaces the 06 map+table hero
Frame `06b Groceries — Shop` (Np3zh) in the Pencil doc. Screenshot: `design/modules/groceries_shop.png`. The goal is an Amazon-style shop page where you see the real products; it keeps the same sidebar, top bar, tokens and chart language. The design numbers are MOCK, so always render from the API.

Product photos (Gemini `gemini-3.1-flash-image`, white studio background, no text or logos, 800×800 JPG <100 KB) live at `web/public/products/{item_id}.jpg` (served at `/products/{item_id}.jpg`) for **every** item in `orbit/config.py` (`chocolate, olive_oil, orange_juice, bread, latte, pint, wine, gpu, laptop, rent_1bed`), so other modules can reuse them. If an image is missing, show a neutral `#F5F5F4` square with the module emoji.

```
[Sidebar 248][Main: padding 32, gap 20]
  Top bar        1128 × 64   (unchanged; breadcrumb "Modules / Groceries / Shop")
  Body           1128 × 752  grid-template-columns: 1fr 320px; gap 16
    Shop column  792: rows 34px (filter) · 303px (grid) · 1fr (detail); gap 14
    Cart panel   320 × 752
```

**Filter row** (34 high): chips on the left, sort on the right.
- Chips are pills, height 34, radius 17, padding 0×14, label 13/600 + count 12/600. Active: `--ink` background with white text (count at 60% white). Inactive: white, 1px `--border`, label `--text-2`, count `--text-3`.
- Chips: **All** (n items) · **Rising** (`change_6m_pct > 0`) · **Falling** (`< 0`) · **Staples** (all groceries items for now).
- Sort (13/500 `--text-2` + chevron-down 16): "Sort by  Biggest 6-mo rise". Sorting is by `change_6m_pct` descending.

**Product grid**: 4 cards in one row, gap 12 (`repeat(4,1fr)`), each 189 × 303. White, 1px `--border`, radius 14, overflow hidden, and the whole card is clickable. The **selected** card has a 2px `--accent` border.
- Photo: 148 high, full width, `object-fit: cover` on white, padding 10.
  - The recommendation badge sits over the photo top-left: pill h24, radius 12, padding 0×9, a 6px dot plus a label 11/700.
    - **Stock up now**: bg `#FFF7ED`, border `#FED7AA`, text/dot `#C2410C`
    - **Wait**: bg `--down-soft`, border `#BBF7D0`, text/dot `#15803D`
    - **Hold**: bg `#F5F5F4`, border `#E7E5E4`, text/dot `#57534E`
- Info block: padding 10/12/12, gap 6.
  1. Origin line: a 16×16 satellite thumb (radius 4, `/tiles/{region_id}/{latest_month}.png`) plus the region name 11/500 `--text-3` (e.g. "Soubré, Côte d'Ivoire").
  2. Name 14/600 plus unit 12 `--text-3`.
  3. Price now **26/700**, tracking −0.6 (`£1.85`).
  4. A row with "in 6 months £1.91" (12/600 `--text-2`) and a delta pill on the right (padding 3×7, radius 6, 11/700): "▲ 3.2%" (`--up-soft`/`--up`) or "▼ 2.3%" (`--down-soft`/`--down`).
  5. A sparkline filling the card width × 26: the last 12 history months plus the 6-month p50, 2px, groceries accent when rising and `--down` when falling.

**Recommendation rule** (in the frontend, per item):
```
if (prob_up_6m >= 0.6 && change_6m_pct >= 2)  → "Stock up now"
else if (change_6m_pct <= -2)                   → "Wait"
else                                            → "Hold"
```

**Product detail** (fills the rest of the column, ~792 × 387): a card with padding 20 and gap 14 that shows the selected product (default: the biggest riser). Clicking another card swaps its content with a 150 ms fade.
- Header: a 40×40 thumb (radius 8, border), name "Chocolate bar · 100 g" 16/700, and the sub-line "Price history & TimesFM forecast · Sep 2023 – Jan 2027" 12 `--text-3`. On the right: a segmented control **1Y · 3Y · 5Y** (bg `#F5F5F4`, radius 9, active white with a small shadow; 3Y is the default), then a 30×30 close button (the close button collapses the detail).
- Content: `grid-template-columns: 432px 1fr; gap 20`.
  - **Keepa-style chart** (432 × ~293). History is drawn as a **step line** (ECharts `step:'end'`) in `#334155`, 2.5px, with the grey gradient area from the shared chart language. The dashed accent p50 forecast starts at today, with a p10–p90 band as a **cone** (accent at 12% alpha). The black "Today" chip sits on the dashed divider. There's an end dot with a halo. Y labels are `£x.xx` 11/500. The x-axis shows 4 labels. The floating callout sits top-left: "{Item} · {Mon YYYY}" / **£1.91** + "↑ 3.2%", with a third line 11 `--text-3`: "likely £p10 – £p90 · {round(prob_up_6m*100)}% chance it rises".
  - **Evidence column** (gap 8):
    - The origin farm box (bg `#FAFAF9`, radius 12, padding 8) holds a 72×72 satellite tile (radius 8) of the item's main region, eyebrow "SENTINEL-2 · {MON YYYY}" 10/600 tracking .4 `--text-3`, the region name 15/700, and two stats at 18/700: crop health `anomaly.ndvi_vs_5yr_pct` in `#EA580C` when negative, and harvest risk = P(high) from `region_judgments`.
    - "Why it moves" 13/700, with "Jev · {n_judgments} headlines judged" 11 `--text-3` on the right.
    - 3 headlines, each a row: title 12/600 (2 lines max, line-height 1.3) + "{source} · {Mon YYYY}" 11 `--text-3`. On the right: "↑ 0.99" 13/700 `--up` (`--down` for down effects), and under it "P(price up)" 10 `--text-3`. Each row links to `url`.

**Cart panel** "Your weekly basket" (white card, radius 16, padding 20, gap 14, column):
- Head: title 18/700 + "{Σqty} items · prices in 6 months" 12 `--text-3`, with a 36×36 icon square on the right (`#F9731622`, lucide `shopping-basket` in the accent).
- Rows (padding 10 0, 1px bottom `--border`): a 44×44 thumb, then the name 13/600 over a qty stepper (h24, radius 7, border, cells 26 wide: "−" · qty · "+"). On the right: the line total now 14/700 over "→ £x.xx" in 6 months 11/600 (`--up` if it rises, `--down` if it falls). Default qty: chocolate 2, olive oil 1, orange juice 2, bread 1. Keep qty in `localStorage` (try/catch).
- **Basket cost by month** (fills the free space, bottom-aligned): title 13/700 + "£ · TimesFM p50". Values 10/600 sit above 6 bars (now → +5 months). Bars have radius 4, gap 8, height ∝ cost (scale from min−margin). Today's bar is `#334155`, the peak month is the accent, and the rest are `#E7E5E4`. Month labels 11 `--text-3` sit below.
- Totals (1px top border, padding-top 12): "Total today" / "Same basket in 6 months", labels 13 `--text-2`, values 14/700.
- Savings box (bg `#FFF7ED`, border `#FED7AA`, radius 12, padding 14): "Stock up on {k} items now" 13/600 `#9A3412` + "Save £x.xx" 15/800 `#C2410C`, and a line 11 "Buy {stock-up items} today, wait on {wait items}".
  - savings = Σ over "Stock up now" items of `qty × (p50_6m − now)`. Hide the box if k = 0.
- Button "Stock up on {k} items" (full width, h44, radius 12, `--accent`, lucide `package-plus`). This is decorative: a click shows a toast "Added to plan".

**Data mapping** (`GET /api/modules/groceries`):
| UI | field |
|---|---|
| card name/unit/photo | `items[].name`, `items[].item_id` → `/assets/products/{item_id}.jpg` |
| price now | `items[].retail_now` or `history[-1].price` |
| in 6 months | `items[].retail_6m` or `forecast[5].p50` (use `forecast`, the Orbit overlay, even when `model_forecast` is also present) |
| Δ pill / badge | `change_6m_pct`, `prob_up_6m` |
| sparkline / detail chart | `history[]`, `forecast[]` (p10/p50/p90) |
| origin + thumb | first `regions[]` matching the item's commodity, `series[-1].thumb`, `anomaly` |
| harvest risk | `signals.region_judgments[region_id].harvest_risk.probs.high` |
| headlines | `signals.headlines` filtered by `item_id`, sorted by `supply_effect.probs.strongly_up + up` desc, top 3 |

If any field is missing, hide that widget: no badge without `prob_up_6m`, no origin line without a region, and no evidence column without either the farm box or headlines. Motion: cards fade up in a 40 ms stagger, the detail chart draws history then the forecast (same as the shared chart language), and cart totals count up (400 ms) when qty changes.
