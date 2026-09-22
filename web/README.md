# Orbit front-end (React)

React 19 + Vite + Tailwind v4 + shadcn/ui. Builds to `../frontend_react/`, which FastAPI serves at `/`.
The pre-React vanilla build still lives in `../frontend/` and is served at `/legacy`.

```bash
npm install
npm run dev     # http://localhost:5173, proxies /api /tiles /static to the backend on :8010
npm run build   # -> ../frontend_react (committed, so the demo runs without npm)
```

Run the backend alongside it:

```powershell
..\.venv\Scripts\uvicorn backend.main:app --reload --port 8010
```

## How the port keeps the design 1:1

The design system is the **same hand-written CSS** as before, moved verbatim into `src/styles/`
(`tokens.css`, `app.css`, `css/*.css`) and imported once from `src/index.css`. Tailwind is loaded
**without preflight** — only its `theme` and `utilities` layers — so it can never reset an Orbit rule:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "./styles/tokens.css";   /* unlayered: always wins over Tailwind */
```

shadcn/ui primitives wear Orbit classes (`<Button variant="orbitPrimary">` renders `.btn.primary`,
`<Badge variant="up">` renders `.pill.up`). The small "Orbit ⇄ shadcn bridge" block at the end of
`src/index.css` drops the handful of shadcn utility defaults Orbit has no counterpart for
(fixed control heights, Tailwind's type-scale line-heights), so every control measures as before.

## Layout

```
src/
  main.jsx                 entry: motion layer + lightbox + <App/>
  App.jsx                  shell: sidebar, hash router (react-router), error boundary, toaster, tooltip node
  index.css                Tailwind (no preflight) + Orbit design system + shadcn token mapping
  views/                   one component per screen, lazily imported so each is its own chunk
  components/ui/           shadcn/ui primitives (button, badge, card, tabs, toggle-group, dialog, …)
  components/orbit/        Sidebar, chrome (topbar / scan button / module header), bits, chart wrappers
  lib/                     api + hooks, formatting, meta, icons, chart theme, forecast chart, signal cards,
                           scan store (useSyncExternalStore), motion, echarts bootstrap, lightbox
  styles/                  the design system, verbatim from the vanilla build
```

**Charts and maps stay imperative.** ECharts, MapLibre and the drag-compare sliders live in
`useEffect` with refs — the option builders are the same code as before. React owns the markup,
state and composition. The News hub keeps its 60 fps counter lerp and slide-in offset on refs for
the same reason (a firehose must not re-render the tree 60×/s).

**Icons** come from `lucide-react` through an explicit registry (`lib/lucide-icons.js`): importing
lucide's whole `icons` barrel pulled ~1 MB of unused icons into the entry chunk. `iconSvg()` renders
the same icons to SVG strings for the ECharts tooltip HTML. Add a name to the registry if a new icon
is needed — in dev, a missing one logs a warning and falls back to a circle.
