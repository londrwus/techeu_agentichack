# News hub: design spec

Screens: `10 News hub` (1440x900) and `10b News hub · Done banner`.
PNGs: `design/modules/news_hub.png`, `design/modules/news_hub_done.png`.
This is the demo moment where Jev reads about 1.3k headlines in about 12 s on Modal. It has to look fast and read from the back of the room, so keep text to a minimum.

## Tokens (same as the rest of Orbit)
| token | value | use |
|---|---|---|
| bg | #F5F5F4 | page |
| card | #FFFFFF | cards, feed rows |
| border | #E7E5E4 | 1px hairlines |
| text-1 / text-2 / text-3 | #1C1917 / #57534E / #A8A29E | primary / secondary / meta |
| accent / accent-soft / accent-ink | #F97316 / #FFEDD5 / #C2410C | price up, live, primary button |
| down / down-soft / down-ink | #16A34A / #DCFCE7 / #15803D | price down |
| muted | #E7E5E4 | flat verdict, bar tracks |
| ink | #0C0A09 | active chip, Jev mark |
| severity major | bg #FEE2E2, text #B91C1C | |
| severity notable | bg #FEF3C7, text #A16207 | |
| severity minor | bg #F5F5F4, text text-3 | |

Font: Inter. Numbers use `font-variant-numeric: tabular-nums`. Icons: Lucide, 1.75 stroke.
Price-up colour here is **orange** (accent), not the red `up` token.

## Layout (1440x900)
- Sidebar 248px (existing). AGENTS section: Ask Orbit · **News hub** (active: accent-soft bg, accent-ink text, small orange `LIVE` badge while scanning) · Mission Control · Track record.
- Main: x=248, padding 32, vertical gap 20, content width 1128.
  1. **Top bar** (about 87px tall)
     - Left: breadcrumb `Agents / News hub` (13, text-3); a 44px icon square (accent-soft, `newspaper` 22 accent-ink); title `News hub` (32/700, -0.5 tracking); tagline `Jev reads the world's commodity news in seconds` (16, text-2).
     - Right, gap 12: engine badge (h44, white, hairline, r12: `zap` accent, **Jev** 14/600, `on Modal · jev-latest` 13 text-3), then the primary button (h44, r12, accent, padding 0 20).
       - Idle: `radar` icon + `Scan the news`.
       - Running: spinning `loader` icon + `Scanning…` + timer `12.4 s` (white at 70%).
       - Done: back to idle label.
  2. **Counter strip**: card h96, r16, six equal cells split by 1px `border` right-dividers, cell padding 0 20.
     - Value 30/700, -0.8 tracking. Suffix 15/600 text-3 (`/ 100`, `s`).
     - Label row: 14px icon (text-3) + 12/500 text-2.
     - Cells:
       - Headlines read `newspaper`
       - Jev judgments `scale`
       - Judgments / sec `gauge` (value in **accent**)
       - Modal containers `server`
       - Cost `coins`
       - Elapsed `timer`
  3. **Body**: fills the rest (about 613px), horizontal, gap 16.
     - Feed column: fluid, about 752px.
     - Right column: 360px, cards stacked with gap 12.

### Feed column (vertical, gap 12)
- **Header row** (space-between):
  - Left: pulsing live dot (8px accent inside a 14px `#F9731633` halo), `Live feed` 18/700, `newest on top` 13 text-3.
  - Right: toggle `Only price-moving`. Switch is 32x18, r9, accent when on.
- **Filter chips**: h30, r15, padding 0 12, 13/500.
  - Chips: All · Groceries · Coffee · Beer & Wine · GPU · Rent.
  - Active chip is ink bg with white text. Inactive chips are white with a hairline border and text-2.
- **Feed list**: 8 visible rows, gap 6, overflow hidden. The bottom row is at 45% opacity, which suggests it is scrolling out.
  - **Row card**: h58, r12, white, 1px border, padding 0 14, gap 12, centred. Left to right:
    1. Commodity tile: 34x34, r9, commodity colour at 10% alpha, 18px Lucide icon in the commodity colour.
    2. Text column (fluid):
       - Headline 14/500 text-1, one line, ellipsis.
       - Meta 12: `Commodity` (600, commodity colour) · source · `2 s ago` · `conf 88%`, all text-3, separated by `·`.
    3. Relevance, 56px wide: `REL 94` (9/600, +0.5 tracking, text-3) above a 4px bar (track muted). The fill is accent when relevance is above 80, text-3 otherwise.
    4. Severity tag: 64x22, r6, 11/600, lowercase.
    5. Verdict pill: 74x28, r8, icon 14 + `81%` 14/700.
       - up: `arrow-up-right`, accent-soft/accent-ink
       - down: `arrow-down-right`, down-soft/down-ink
       - flat: `arrow-right`, muted/text-2
  - **Newest row**: 1.5px accent border, plus a `NEW` tag (h16, r4, accent bg, white 9/700) before the commodity in the meta line.
  - **Major row flash**: bg #FEF2F2, 1.5px border #FCA5A5, glow `0 0 14px #EF444440`.

Commodity icons and colours:
| commodity | icon | colour |
|---|---|---|
| cocoa | `bean` | #92400E |
| coffee | `coffee` | #A16207 |
| olive oil | `droplet` | #65A30D |
| wheat | `wheat` | #CA8A04 |
| hops | `hop` | #16A34A |
| wine | `wine` | #BE123C |
| GPU / semis | `cpu` | #6366F1 |
| London housing | `house` | #10B981 |

### Right column (360px; cards white, r16, hairline, padding 18)
1. **Pressure by commodity** (fit content, about 286px)
   - Header: `Pressure by commodity` 15/700; `Jev · live` 12 text-3.
   - Rows (h20, gap 5), sorted by value, descending: icon 14 · name 12/500 (w100) · negative half 62 · 1px zero line (text-3) · positive half 62 · value 12/700 (w40, right aligned).
   - Bars are 12px tall and scale |v|·62 px. Positive bars are accent with right corners r3. Negative bars are down with left corners r3.
   - Axis captions under the bars: `← cheaper` (down-ink) and `pricier →` (accent-ink), 11/500.
2. **Throughput** (fills the remaining height, about 206px)
   - Header: `Throughput` 15/700 + `Jev judgments per second` 12 text-3. Right side: `412` 26/700 accent + `/ s`.
   - Area sparkline over the fluid width:
     - 2px accent line, round caps
     - area fill `#F973161F`
     - 8px accent dot on the latest point
   - Axis row: `0 s` · `peak 418 / s` · `12.4 s` (11, text-3).
3. **Jev at work** (about 97px, padding 14 18)
   - Header: 22px ink square with an accent `zap`, `Jev at work` 15/700, and `relevance · item · direction · severity` (11, text-3) on the right. These are the 4 questions asked per headline.
   - Four equal stats, each a value 18/700 over a label 11 text-3:
     - `4` per headline
     - `25` per batch
     - `214` Jev calls
     - `180 ms` avg latency

### Done banner (replaces the counter strip for about 6 s after the scan, then collapses back)
- Card h96, r16, padding 0 24, gap 20.
- Left: 40px green check circle (down-soft bg, `check` in down).
- Summary: kicker `Scan complete` (12/600, down), then a stats line of 22/700 values with 13/500 labels, separated by 4px text-3 dots: `1,532 headlines · 6,128 Jev judgments · 18 s · $0.004`.
- Right: `TOP MOVERS` label (11/600, +0.8 tracking), then 3 chips (h34, r10): icon + name 13/600 + arrow + value 13/700.
  - Up chips are accent-soft/accent-ink.
  - Down chips are down-soft/down-ink.

## Motion
- **Row insert**: a new row slides in from y -12 and fades 0 to 1 over 220 ms (`cubic-bezier(.2,.8,.2,1)`). Rows below shift with `transform` only. Keep at most 8 rows in the DOM and drop the oldest.
  - During the scan, batch inserts to about 8 rows/s visually (a random sample), even though Jev does about 400 judgments/s. The counters carry the true speed.
- **Newest row**: accent border for 1.2 s, then it fades to the normal border.
- **Major row flash**: red glow pulses twice (2 × 400 ms), then the tint settles.
- **Counters**: tween to the target value every animation frame over about 300 ms, using tabular numbers so they don't jitter. Elapsed ticks every 100 ms.
- **Pressure bars**: animate width over 400 ms when a value changes. Re-sort rows at most once per second, using a FLIP animation.
- **Sparkline**: append one point every 500 ms. The head dot pulses (scale 1 to 1.6, fade out, 1 s loop).
- **Live dot** (sidebar badge and feed header): opacity pulse, 1.2 s loop, only while scanning.
- **Button**: the spinner rotates at 1 rev/s while running.
- Honour `prefers-reduced-motion`: turn off slides and pulses, keep the number updates.

## Copy
Header: `News hub` / `Jev reads the world's commodity news in seconds`. Button: `Scan the news` → `Scanning… 12.4 s`. No AI prose on this screen.

## Data
- Use `/api/news/scan` (SSE) when it's live. Otherwise replay `data/built/news_replay.json` at real speed.
- The feed row maps to the `signals/{module}.json` headline schema:
  - `relevant_p` → REL
  - `supply_effect` → verdict (probability of the chosen label)
  - `severity.label` → tag
  - `confidence` → conf
- Pressure comes from `net_supply_pressure` for each item.
