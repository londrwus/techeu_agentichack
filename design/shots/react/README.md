# React port — visual check

Every screen of the React build (`/`) at 1440×900, captured 5 s after the route opened.
Taken with Playwright against the same backend as the vanilla build (served at `/legacy` at the time of the
port, commit a93fae9; the vanilla build has since been removed), then diffed pixel-by-pixel against it.

| Screen | Pixels differing by >40/255 | What differs |
|---|---|---|
| ask | 0.00% | – |
| beer_wine | 0.00% | – |
| gpu | 0.00% | – |
| groceries | 0.00% | – |
| track | 0.04% | count-up animation phase |
| latte | 0.03% | NDVI pill, 1 px |
| overview | 0.06% | basemap tiles arriving at a different moment |
| rent | 0.07% | basemap tiles arriving at a different moment |
| mission | 0.17% | live counters (tiles/judgments tick between runs) |
| news | 0.22% | feed text antialiasing |
| earth | 3.83% | the globe is mid-drift — it never stops moving, so the two runs catch it at different longitudes |

Everything else (0.03–6% of "any non-zero pixel") is font antialiasing and animation phase.

A stricter check compares the **rendered text** of all 11 routes between the two builds with numbers
normalised: **11/11 identical** (`scratchpad/textdiff.py`). Interaction smoke test: 25 flows
(filters, seg toggles, lightbox, drag-compare, rent search + fly-to, Ask Orbit round trip, news
replay scan, Mission Control live scan) all pass with zero console errors.
