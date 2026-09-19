import { api, MODULE_META, esc, fmt, pct, money, isNum, tint, deltaPill, countUp, icons, showTip, hideTip } from '../lib.js';
import { topbar, wireScan } from './common.js';

const RAMP = [[253, 230, 138], [249, 115, 22], [153, 27, 27]];
function ramp(t) {
  t = Math.max(0, Math.min(1, isNum(t) ? t : 0));
  const [a, b, k] = t < 0.5 ? [RAMP[0], RAMP[1], t * 2] : [RAMP[1], RAMP[2], (t - 0.5) * 2];
  return a.map((v, i) => Math.round(v + (b[i] - v) * k));
}
const METRICS = { pressure: 'Rent pressure', rent_now: 'Rent now', built: 'Built change' };
const HOME = { longitude: -0.1, latitude: 51.49, zoom: 9.7, pitch: 50, bearing: -20 };

function centroid(geom) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = c => (typeof c[0] === 'number' ? (x0 = Math.min(x0, c[0]), x1 = Math.max(x1, c[0]), y0 = Math.min(y0, c[1]), y1 = Math.max(y1, c[1])) : c.forEach(walk));
  try { walk(geom.coordinates); } catch { return null; }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export async function render(page) {
  const meta = MODULE_META.rent;
  page.innerHTML = topbar({
    crumb: 'Modules  /  Rent Radar', title: 'Rent Radar',
    iconSq: `<div class="icon-sq lg" style="background:${tint(meta.color)}">${meta.emoji}</div>`,
    subtitle: 'London · new building seen from orbit × rents',
    right: `<div class="seg dark" id="metric">${Object.entries(METRICS).map(([k, v], i) => `<button class="${i ? '' : 'on'}" data-m="${k}">${v}</button>`).join('')}</div>`,
  }) + `
  <section class="rent-row">
    <div class="map3d" id="map3d">
      <div class="mapc" id="mapc"></div>
      <div class="glass chip3d"><i data-lucide="rotate-3d"></i><span id="chip3d">3D · London boroughs · drag to rotate</span></div>
      <div class="glass zoom"><button data-z="1" title="Zoom in"><i data-lucide="plus"></i></button><button data-z="-1" title="Zoom out"><i data-lucide="minus"></i></button><button data-z="0" title="Reset view"><i data-lucide="compass"></i></button></div>
      <div class="glass ramp"><span id="ramp-t">Rent pressure</span> · height = built-up change<div class="ramp-bar"></div><div class="ramp-l" id="ramp-l"><span>0</span><span>50</span><span>100</span></div></div>
    </div>
    <div class="side">
      <div class="card" id="avg"><div class="skeleton" style="height:110px"></div></div>
      <div class="card" id="top5"><div class="card-title" style="font-size:18px">Top 5 by rent pressure</div><div class="skeleton" style="height:260px;margin-top:14px"></div></div>
      <div class="card ink-card"><div class="lbl"><i data-lucide="sparkles"></i>Gemini sees</div><p id="rent-ins">Reading London from orbit…</p></div>
    </div>
  </section>`;
  wireScan(page); icons();

  const [geo, mod] = await Promise.all([api('/api/rent'), api('/api/modules/rent')]);
  const feats = (geo?.features || []).filter(f => f?.geometry && f.properties);
  const card = mod?.insights?.cards?.[0];
  page.querySelector('#rent-ins').textContent = card?.text || mod?.insights?.headline || 'East London is adding rooftops fastest, yet rents still lead the city. New supply is not keeping up.';

  if (!feats.length) {
    page.querySelector('#mapc').innerHTML = `<div class="empty" style="height:100%;background:transparent;color:rgba(255,255,255,.6)">Borough data is being built on Modal…</div>`;
    page.querySelector('#avg').innerHTML = `<div class="card-sub">Average London rent, 1-bed</div><div class="empty" style="margin-top:10px">Pending</div>`;
    page.querySelector('#top5').innerHTML = `<div class="card-title" style="font-size:18px">Top 5 by rent pressure</div><div class="empty" style="margin-top:14px">Pending</div>`;
    return;
  }
  page.querySelector('#chip3d').textContent = `3D · ${feats.length} boroughs · drag to rotate`;
  feats.forEach(f => (f.properties._c = centroid(f.geometry)));
  const P = f => f.properties;

  // Average card
  const avg = k => { const v = feats.map(f => P(f)[k]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const now = avg('rent_now'), nxt = avg('rent_12m');
  const ch = isNum(now) && isNum(nxt) ? (nxt / now - 1) * 100 : avg('change_pct');
  page.querySelector('#avg').innerHTML = `<div class="card-sub" style="margin:0">Average London rent, 1-bed</div>
    <div class="avg-line"><span class="a">${money(now)}</span>${isNum(nxt) ? `<i data-lucide="arrow-right" style="color:var(--text-3)"></i><span class="b" id="avg-b">${money(nxt)}</span>` : ''}</div>
    ${deltaPill(ch, 'in 12 mo', 1)}`;
  if (isNum(nxt)) countUp(page.querySelector('#avg-b'), nxt, { prefix: '£', dur: 1100 });

  // Top 5
  const top = feats.filter(f => isNum(P(f).pressure)).sort((a, b) => P(b).pressure - P(a).pressure).slice(0, 5);
  page.querySelector('#top5').innerHTML = `<div class="card-title" style="font-size:18px">Top 5 by rent pressure</div>
    <div class="top5">${top.map((f, i) => `<div class="t5" data-i="${i}">
      <div class="rk ${i ? '' : 'first'}">${i + 1}</div>
      <div><div class="t5n">${esc(P(f).name)}</div><div class="t5s">${pct(P(f).change_pct, 1)} rent · ${pct(P(f).built_change_pct)} built</div></div>
      <div class="pv ${i < 2 ? 'hot' : ''}">${fmt(P(f).pressure)}</div>
      <div class="bar"><i style="background:${i < 2 ? 'var(--accent)' : 'var(--accent-light)'}" data-w="${P(f).pressure}"></i></div></div>`).join('')}</div>`;
  requestAnimationFrame(() => page.querySelectorAll('#top5 .bar i').forEach(i => (i.style.width = Math.min(100, i.dataset.w) + '%')));
  icons();

  // 3D map
  if (!window.deck) {
    page.querySelector('#mapc').innerHTML = `<div class="empty" style="height:100%;background:transparent;color:rgba(255,255,255,.6)">3D engine offline</div>`;
    return;
  }
  const rng = k => { const v = feats.map(f => P(f)[k]).filter(isNum); return [Math.min(...v), Math.max(...v)]; };
  const ranges = { rent_now: rng('rent_now'), built_change_pct: rng('built_change_pct') };
  let metric = 'pressure';
  const colorOf = f => {
    const p = P(f);
    if (metric === 'rent_now') { const [a, b] = ranges.rent_now; return ramp((p.rent_now - a) / ((b - a) || 1)); }
    if (metric === 'built') { const [a, b] = ranges.built_change_pct; return ramp((p.built_change_pct - a) / ((b - a) || 1)); }
    return ramp((p.pressure ?? 0) / 100);
  };
  const elevOf = f => { const p = P(f); const v = isNum(p.built_change_pct) ? p.built_change_pct : (p.pressure ?? 0) / 8; return 150 + Math.max(0, v) * 130; };
  let hovered = null;
  const fc = { type: 'FeatureCollection', features: feats };
  const labelData = feats.filter(f => P(f)._c);
  const container = page.querySelector('#mapc');
  const layers = () => [
    new deck.TileLayer({
      id: 'basemap', data: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', minZoom: 0, maxZoom: 16, tileSize: 256,
      renderSubLayers: props => { const bb = props.tile.boundingBox; return new deck.BitmapLayer(props, { data: null, image: props.data, tintColor: [110, 118, 135], bounds: [bb[0][0], bb[0][1], bb[1][0], bb[1][1]] }); },
      onTileError: () => {},
    }),
    new deck.GeoJsonLayer({
      id: 'boroughs', data: fc, extruded: true, filled: true, stroked: false, wireframe: false, pickable: true,
      getElevation: elevOf, getFillColor: f => [...colorOf(f), f === hovered ? 255 : 225], getLineColor: [255, 255, 255, 40], lineWidthMinPixels: 1,
      material: { ambient: 0.55, diffuse: 0.6, shininess: 24 },
      updateTriggers: { getFillColor: [metric, hovered] },
      transitions: { getElevation: { duration: 1200 }, getFillColor: { duration: 500 } },
      onHover: info => {
        hovered = info.object || null; redraw();
        if (!info.object) return hideTip();
        const p = P(info.object), r = container.getBoundingClientRect();
        showTip(`<b>${esc(p.name)}</b><div style="font-weight:600">${money(p.rent_now)} → ${money(p.rent_12m)} <span class="red">${pct(p.change_pct, 1)}</span></div>
          <div class="muted">Built-up area ${pct(p.built_change_pct)} since 2019 · pressure ${fmt(p.pressure)}</div>`, r.left + info.x, r.top + info.y);
      },
    }),
    new deck.TextLayer({
      id: 'labels', data: labelData, getPosition: f => [...P(f)._c, elevOf(f) + 40], getText: f => P(f).name.replace(' and ', ' & '),
      getSize: 11, getColor: [255, 255, 255, 200], fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 600, characterSet: 'auto',
      getTextAnchor: 'middle', outlineWidth: 2, outlineColor: [0, 0, 0, 160], fontSettings: { sdf: true },
    }),
  ];
  let vs = { ...HOME }, interacted = false, raf = 0;
  const dk = new deck.Deck({
    parent: container, style: { position: 'absolute', inset: 0 },
    viewState: vs, controller: true,
    onViewStateChange: ({ viewState, interactionState }) => {
      if (interactionState && (interactionState.isDragging || interactionState.isZooming || interactionState.isRotating || interactionState.isPanning)) interacted = true;
      vs = viewState; dk.setProps({ viewState: vs });
    },
    getCursor: ({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    layers: layers(),
  });
  function redraw() { dk.setProps({ layers: layers() }); }
  const spin = () => { if (!interacted) { vs = { ...vs, bearing: vs.bearing + 0.05, transitionDuration: 0 }; dk.setProps({ viewState: vs }); } raf = requestAnimationFrame(spin); };
  raf = requestAnimationFrame(spin);
  const fly = target => { interacted = true; vs = { ...vs, ...target, transitionDuration: 1200, transitionInterpolator: new deck.FlyToInterpolator() }; dk.setProps({ viewState: vs }); };
  page.querySelectorAll('.zoom button').forEach(b => b.addEventListener('click', () => {
    const z = +b.dataset.z;
    if (z === 0) { fly({ ...HOME }); interacted = false; } else fly({ zoom: vs.zoom + z });
  }));
  page.querySelectorAll('.t5').forEach(row => row.addEventListener('click', () => {
    const f = top[+row.dataset.i]; const c = P(f)._c; if (!c) return;
    hovered = f; redraw(); fly({ longitude: c[0], latitude: c[1], zoom: 11.3, pitch: 55 });
  }));
  page.querySelectorAll('#metric button').forEach(b => b.addEventListener('click', () => {
    page.querySelectorAll('#metric button').forEach(x => x.classList.toggle('on', x === b));
    metric = b.dataset.m; redraw();
    page.querySelector('#ramp-t').textContent = METRICS[metric];
    const l = page.querySelector('#ramp-l');
    if (metric === 'rent_now') l.innerHTML = `<span>${money(ranges.rent_now[0])}</span><span></span><span>${money(ranges.rent_now[1])}</span>`;
    else if (metric === 'built') l.innerHTML = `<span>${pct(ranges.built_change_pct[0])}</span><span></span><span>${pct(ranges.built_change_pct[1])}</span>`;
    else l.innerHTML = '<span>0</span><span>50</span><span>100</span>';
  }));
  return () => { cancelAnimationFrame(raf); try { dk.finalize(); } catch {} hideTip(); };
}
