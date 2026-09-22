// The landing globe: a WebGL Sentinel-2 Earth (globe-gl.js) with a 2D overlay for the great-circle
// arcs to London, flowing particles and pulsing regions, SVG orbit rings with a satellite, and real
// Orbit tiles floating as cards with connector lines to their regions.
// React owns the stage, rings and cards; the per-frame work (shader, overlay, lines) runs on refs.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createGlobe, project, RADIUS } from './globe-gl.js';
import { cn } from '@/lib/utils';

const TEX_SMALL = '/globe/earth-512.jpg';
const TEX_BIG = '/globe/earth-2k.jpg';
const MONTH = '2026-08';
const RAD = Math.PI / 180;
const LONDON = [-0.128, 51.507];
const COL = { groceries: '#FB923C', latte: '#E0A96D', beer_wine: '#FACC15', gpu: '#A5B4FC', rent: '#34D399' };
// [id, label, lon, lat, module, good tile for a card]
const REGIONS = [
  ['bordeaux_vines', 'Bordeaux vines', -0.3, 44.9, 'beer_wine', 1],
  ['rioja_vines', 'Rioja vines', -2.6, 42.45, 'beer_wine', 1],
  ['hallertau_hops', 'Hallertau hops', 11.8, 48.55, 'beer_wine', 1],
  ['zatec_hops', 'Žatec hops', 13.55, 50.33, 'beer_wine', 1],
  ['jaen_olives', 'Jaén olives', -3.75, 37.85, 'groceries', 1],
  ['poltava_wheat', 'Poltava wheat', 34.5, 49.6, 'groceries', 0],
  ['ashanti_cocoa', 'Ashanti cocoa', -1.6, 6.7, 'groceries', 0],
  ['soubre_cocoa', 'Soubré cocoa', -6.6, 5.8, 'groceries', 0],
  ['saopaulo_oranges', 'São Paulo oranges', -48.5, -20.9, 'groceries', 1],
  ['minas_coffee', 'Minas coffee', -45.4, -21.5, 'latte', 1],
  ['huila_coffee', 'Huila coffee', -75.8, 2.5, 'latte', 1],
  ['daklak_coffee', 'Đắk Lắk coffee', 108.0, 12.7, 'latte', 0],
  ['stargate_abilene', 'Stargate, Texas', -99.788, 32.503, 'gpu', 1],
  ['tsmc_arizona', 'TSMC Arizona', -112.162, 33.772, 'gpu', 1],
  ['xai_colossus', 'xAI Colossus', -90.157, 35.06, 'gpu', 1],
  ['loudoun_dc_alley', 'Data Centre Alley', -77.47, 39.01, 'gpu', 1],
  ['kaohsiung_port', 'Kaohsiung port', 120.28, 22.6, 'gpu', 1],
  ['hsinchu_park', 'Hsinchu fabs', 121.0, 24.78, 'gpu', 0],
  ['baoshan_reservoir', 'Baoshan reservoir', 121.044, 24.723, 'gpu', 0],
  ['tsengwen_reservoir', 'Tsengwen reservoir', 120.572, 23.286, 'gpu', 0],
];
// Card slots, as fractions of the globe stage.
const SLOTS = [{ x: 0.84, y: 0.04 }, { x: 1.0, y: 0.6 }, { x: 0.3, y: 0.93 }];
// Orbit rings in the 1000-unit ring SVG (the SVG is 108 % of the stage, so the globe radius there is 0.37 / 1.08).
const RINGS = [{ cls: 'r1', rx: 405, ry: 104, rot: -12 }, { cls: 'r2', rx: 390, ry: 180, rot: 22 }];
const GLOBE_R_SVG = (RADIUS / 2) / 1.08 * 1000;

/** Great-circle polyline between two [lon, lat] points (degrees in, radians out). */
function greatCircle([lo1, la1], [lo2, la2], n = 48) {
  const v = (lo, la) => [Math.cos(la * RAD) * Math.cos(lo * RAD), Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)];
  const a = v(lo1, la1), b = v(lo2, la2);
  const w = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w);
    const x = s1 * a[0] + s2 * b[0], y = s1 * a[1] + s2 * b[1], z = s1 * a[2] + s2 * b[2];
    out.push([Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y))]);
  }
  return out;
}
const ARCS = REGIONS.map(r => ({ r, path: greatCircle([r[2], r[3]], LONDON), ph: Math.random() }));

const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const ORANGE = [249, 115, 22], CREAM = [255, 237, 213];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Center of the view at time t (seconds): slow eastward spin with a gentle nod. */
const viewAt = t => ({ lng: -38 + t * 4.2, lat: 24 + 4 * Math.sin(t / 9) });

export default function Globe() {
  const stage = useRef(null);
  const glCanvas = useRef(null);
  const fxCanvas = useRef(null);
  const sat = useRef(null);
  const cardEls = useRef([]);
  const lineEls = useRef([]);
  const dotEls = useRef([]);
  const [mode, setMode] = useState('gl'); // 'gl' | 'css'
  const [painted, setPainted] = useState(false);
  const [cards, setCards] = useState(SLOTS.map(() => ({ region: null, on: false })));
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  // Place the cards around the stage (on mount and on resize; they float via CSS).
  useLayoutEffect(() => {
    const place = () => {
      const g = stage.current?.getBoundingClientRect();
      if (!g) return;
      cardEls.current.forEach((el, i) => {
        if (!el) return;
        const s = SLOTS[i], w = el.offsetWidth || 120, h = el.offsetHeight || 150;
        el.style.left = `${Math.min(window.innerWidth - w - 20, g.left + s.x * g.width - w / 2)}px`;
        el.style.top = `${Math.max(16, Math.min(window.innerHeight - h - 16, g.top + s.y * g.height - h / 2))}px`;
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  // Prefetch the card tiles so a swap never shows an empty frame.
  useEffect(() => { REGIONS.filter(r => r[5]).forEach(r => { new Image().src = `/tiles/${r[0]}/${MONTH}.png`; }); }, []);

  useEffect(() => {
    const glEl = glCanvas.current, fxEl = fxCanvas.current, ctx = fxEl.getContext('2d');
    const globe = createGlobe(glEl);
    if (!globe) setMode('css');

    // Progressive texture: 15 KB first (first frame), the 2k one right after.
    let alive = true;
    const load = src => new Promise((res, rej) => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = rej; im.src = src; });
    if (globe) {
      load(TEX_SMALL).then(im => { if (!alive) return; globe.setTexture(im); setPainted(true); return load(TEX_BIG); })
        .then(im => { if (alive && im) globe.setTexture(im); })
        .catch(e => { console.warn('[globe] texture', e); if (alive) setMode('css'); });
    }

    let size = 0, dpr = 1;
    const resize = () => {
      const r = stage.current.getBoundingClientRect();
      size = r.width;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      globe?.resize(size, Math.min(1.5, dpr)); // the texture is 2048 px wide; more pixels would not add detail
      fxEl.width = fxEl.height = Math.round(size * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage.current);

    const t0 = performance.now();
    let raf = 0, lastCycle = 0, slotTurn = 0;

    const showCard = (i, r) => {
      const had = !!cardsRef.current[i].region;
      setCards(cs => cs.map((c, k) => (k === i ? { ...c, on: false } : c)));
      setTimeout(() => {
        if (!alive) return;
        setCards(cs => cs.map((c, k) => (k === i ? { region: r, on: true } : c)));
      }, had ? 450 : 0);
    };

    const frame = now => {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      const t = (now - t0) / 1000;
      const c = viewAt(t), lon0 = c.lng * RAD, lat0 = c.lat * RAD;
      globe?.render(lon0, lat0);
      const half = size / 2, Rp = half * RADIUS;
      const P = (lon, lat) => { const p = project(lon, lat, lon0, lat0); return [half + p.x * Rp, half - p.y * Rp, p.z]; };

      // ---- overlay: arcs, particles, region pulses, London ----
      // Only over the WebGL globe: the CSS fallback scrolls a flat texture, which a projected overlay can't match.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      if (globe) {
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.3;
      for (const a of ARCS) {
        const pts = a.path.map(([lo, la]) => P(lo, la));
        // One path per arc (its visible run), stroked with a gradient from the region toward London:
        // ~20 strokes a frame instead of ~1,000 segment strokes.
        let first = -1, last = -1;
        for (let i = 0; i < pts.length; i++) if (pts[i][2] > 0.04) { if (first < 0) first = i; last = i; }
        if (last - first >= 1) {
          const [ax, ay] = pts[first], [bx, by] = pts[last], n = pts.length - 1;
          const grad = ctx.createLinearGradient(ax, ay, bx, by);
          const stop = (prog, at) => {
            const [r, g, b] = prog < 0.5 ? mix(ORANGE, [251, 146, 60], prog * 2) : mix([251, 146, 60], CREAM, (prog - 0.5) * 2);
            grad.addColorStop(at, `rgba(${r},${g},${b},${0.06 + 0.84 * prog})`);
          };
          stop(first / n, 0); stop((first + last) / 2 / n, 0.5); stop(last / n, 1);
          ctx.strokeStyle = grad;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          for (let i = first + 1; i <= last; i++) ctx.lineTo(pts[i][0], pts[i][1]);
          ctx.stroke();
        }
        // two particles flowing toward London
        for (const k of [0, 0.5]) {
          const p = (a.ph + k + t * 0.22) % 1, idx = Math.floor(p * (a.path.length - 1));
          const [x, y, z] = pts[idx];
          if (z <= 0.02) continue;
          const f = smooth(0, 0.18, z), rr = 1.3 + 1.5 * p;
          ctx.fillStyle = `rgba(255,237,213,${0.18 * f})`;
          ctx.beginPath(); ctx.arc(x, y, rr * 2.6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `rgba(255,247,237,${0.95 * f})`;
          ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
        }
      }
      const pulse = (t % 2.2) / 2.2;
      for (const r of REGIONS) {
        const [x, y, z] = P(r[2] * RAD, r[3] * RAD);
        if (z <= 0) continue;
        const f = smooth(0, 0.15, z), [cr, cg, cb] = hexRgb(COL[r[4]]);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.4 * (1 - pulse) * f})`;
        ctx.beginPath(); ctx.arc(x, y, 3 + 13 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${f})`;
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * f})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const [lx, ly, lz] = P(LONDON[0] * RAD, LONDON[1] * RAD);
      if (lz > 0) {
        const lp = (t % 1.6) / 1.6, f = smooth(0, 0.15, lz);
        ctx.fillStyle = `rgba(249,115,22,${0.45 * (1 - lp) * f})`;
        ctx.beginPath(); ctx.arc(lx, ly, 7 + 16 * lp, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${f})`;
        ctx.strokeStyle = `rgba(249,115,22,${f})`;
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      }

      // ---- the satellite on the front ring ----
      const R0 = RINGS[0], th = t * 0.35, rc = Math.cos(R0.rot * RAD), rs = Math.sin(R0.rot * RAD);
      const ex = R0.rx * Math.cos(th), ey = R0.ry * Math.sin(th);
      const sx = ex * rc - ey * rs, sy = ex * rs + ey * rc, inFront = Math.sin(th) > 0;
      if (sat.current) {
        sat.current.setAttribute('cx', 500 + sx);
        sat.current.setAttribute('cy', 500 + sy);
        sat.current.style.opacity = !inFront && Math.hypot(sx, sy) < GLOBE_R_SVG ? 0 : inFront ? 1 : 0.45;
      }

      // ---- card cycling: tiles from regions on the visible face ----
      const facing = r => project(r[2] * RAD, r[3] * RAD, lon0, lat0).z;
      const shown = cardsRef.current;
      if (t > 0.9 && now - lastCycle > (lastCycle ? 3200 : 0)) {
        lastCycle = now;
        const vis = REGIONS.filter(r => r[5] && facing(r) > 0.35 && !shown.some(s => s.region === r)).sort(() => Math.random() - 0.5);
        if (!shown[0].region) shown.forEach((_, i) => vis[i] && setTimeout(() => alive && showCard(i, vis[i]), i * 350));
        else { const i = slotTurn++ % SLOTS.length; if (vis[0]) showCard(i, vis[0]); }
      }

      // ---- connector lines from each card to its region ----
      const g = stage.current.getBoundingClientRect();
      shown.forEach((s, i) => {
        const line = lineEls.current[i], dot = dotEls.current[i], el = cardEls.current[i];
        if (!line || !dot || !el) return;
        const r = s.region, f = r ? facing(r) : -1;
        if (!globe || !r || f < 0.12 || !s.on) { line.style.opacity = 0; dot.style.opacity = 0; return; }
        const [px, py] = P(r[2] * RAD, r[3] * RAD);
        const X = g.left + px, Y = g.top + py, cb = el.getBoundingClientRect();
        line.setAttribute('x1', Math.max(cb.left, Math.min(cb.right, X)));
        line.setAttribute('y1', Math.max(cb.top, Math.min(cb.bottom, Y)));
        line.setAttribute('x2', X); line.setAttribute('y2', Y);
        dot.setAttribute('cx', X); dot.setAttribute('cy', Y);
        const o = Math.min(1, (f - 0.12) * 4);
        line.style.opacity = 0.7 * o; dot.style.opacity = o;
      });
    };
    raf = requestAnimationFrame(frame);

    return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); globe?.dispose(); };
  }, []);

  return (
    <>
      <div className="ld-globe" ref={stage} aria-hidden="true">
        <div className="ld-halo" />
        <Rings side="back" />
        {mode === 'css' ? <div className="ld-fallback" /> : null}
        <canvas ref={glCanvas} className={cn('ld-canvas', painted && 'on')} hidden={mode === 'css'} />
        <canvas ref={fxCanvas} className="ld-canvas on" />
        <Rings side="front" satRef={sat} />
      </div>

      <svg className="ld-links" aria-hidden="true">
        {SLOTS.map((_, i) => (
          <g key={i}>
            <line ref={el => { lineEls.current[i] = el; }} />
            <circle r="3" ref={el => { dotEls.current[i] = el; }} />
          </g>
        ))}
      </svg>

      <div className="ld-cards" aria-hidden="true">
        {cards.map((c, i) => (
          <figure
            key={i}
            ref={el => { cardEls.current[i] = el; }}
            className={cn('ld-card', c.on && 'on')}
            style={{ animationDelay: `${-i * 2.3}s`, '--c': c.region ? COL[c.region[4]] : undefined }}
          >
            {c.region ? (
              <img
                alt=""
                src={`/tiles/${c.region[0]}/${MONTH}.png`}
                onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = `/tiles/${c.region[0]}/2026-07.png`; }}
              />
            ) : <div className="ld-card-ph" />}
            <div className="scan" />
            <figcaption><i />{c.region?.[1]}</figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}

/** Half an orbit ring: the back half sits behind the globe, the front half (with the satellite) over it. */
function Rings({ side, satRef }) {
  const sweep = side === 'back' ? 1 : 0;
  return (
    <svg className={`ld-rings ${side}`} viewBox="0 0 1000 1000">
      {RINGS.map(R => (
        <path key={R.cls} className={R.cls} d={`M${500 - R.rx},500 A${R.rx},${R.ry} 0 0 ${sweep} ${500 + R.rx},500`}
              transform={`rotate(${R.rot} 500 500)`} />
      ))}
      {satRef ? <circle ref={satRef} r="4.5" className="ld-sat" /> : null}
    </svg>
  );
}
