// Orbit landing: rotating Sentinel-2 globe (MapLibre 5 globe + EOX s2cloudless), satellite regions pulsing,
// great-circle arcs flowing to London, real Orbit tiles floating as cards. Static CSS globe if WebGL fails.
(() => {
  const EOX = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
  const LONDON = [-0.128, 51.507];
  const MONTH = '2026-08';
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
  const RAD = Math.PI / 180;
  const $ = s => document.querySelector(s);

  /* ---------- stats (real numbers, cached fallbacks already in the HTML) ---------- */
  const fmt = (v, k) => k === 'dir' ? `${Math.round(v)}%` : v >= 100000 ? `${Math.round(v / 1000)}k` : Math.round(v).toLocaleString('en-GB');
  function countUp(el, to, k) {
    const t0 = performance.now(), d = 1300;
    const step = now => { const p = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(to * e, k); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const getJSON = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([getJSON('/api/summary'), getJSON('/api/leaderboard')]).then(([s, lb]) => {
    const st = s?.stats || {};
    const best = lb?.final?.name || 'orbit_v2';
    const v2 = (lb?.rows || []).find(r => r.method === best)?.test?.h6 || {};
    const dir = typeof v2.dir_acc === 'number' ? v2.dir_acc : lb?.improvement_vs_v1?.dir_acc?.[1];
    const vals = { tiles: st.tiles_processed, jev: st.jev_judgments, dir: typeof dir === 'number' ? dir * 100 : null };
    document.querySelectorAll('.ld-stat b').forEach(b => { const v = vals[b.dataset.k]; if (typeof v === 'number' && v > 0) countUp(b, v, b.dataset.k); });
  });

  /* ---------- helpers ---------- */
  function gc([lo1, la1], [lo2, la2], n = 72) { // great-circle polyline
    const v = (lo, la) => [Math.cos(la * RAD) * Math.cos(lo * RAD), Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)];
    const a = v(lo1, la1), b = v(lo2, la2);
    const w = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w);
      const x = s1 * a[0] + s2 * b[0], y = s1 * a[1] + s2 * b[1], z = s1 * a[2] + s2 * b[2];
      out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
    }
    return out;
  }
  const facing = ([lo, la], c) => Math.sin(la * RAD) * Math.sin(c.lat * RAD) + Math.cos(la * RAD) * Math.cos(c.lat * RAD) * Math.cos((lo - c.lng) * RAD);

  const arcs = REGIONS.map(r => ({ r, path: gc([r[2], r[3]], LONDON), ph: Math.random() }));
  const fc = features => ({ type: 'FeatureCollection', features });
  const pt = (c, p = {}) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: c } });

  /* ---------- orbit rings (SVG, back half behind the globe, front half over it) ---------- */
  const RINGS = [{ cls: 'r1', rx: 405, ry: 104, rot: -12 }, { cls: 'r2', rx: 390, ry: 180, rot: 22 }];
  const back = $('.ld-rings.back'), front = $('.ld-rings.front');
  const ns = 'http://www.w3.org/2000/svg';
  for (const R of RINGS) {
    for (const [svg, sweep] of [[back, 1], [front, 0]]) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', `M${500 - R.rx},500 A${R.rx},${R.ry} 0 0 ${sweep} ${500 + R.rx},500`);
      p.setAttribute('class', R.cls); p.setAttribute('transform', `rotate(${R.rot} 500 500)`);
      svg.appendChild(p);
    }
  }
  const sat = document.createElementNS(ns, 'circle'); sat.setAttribute('r', 4.5); sat.setAttribute('class', 'ld-sat'); front.appendChild(sat);
  let globeR = 343; // globe radius in ring-svg units, measured from the map once it loads
  function moveSat(t) {
    const R = RINGS[0], th = t * 0.35, c = Math.cos(R.rot * RAD), s = Math.sin(R.rot * RAD);
    const ex = R.rx * Math.cos(th), ey = R.ry * Math.sin(th);
    const x = ex * c - ey * s, y = ex * s + ey * c;
    const inFront = Math.sin(th) > 0, hidden = !inFront && Math.hypot(x, y) < globeR;
    sat.setAttribute('cx', 500 + x); sat.setAttribute('cy', 500 + y);
    sat.style.opacity = hidden ? 0 : inFront ? 1 : 0.45;
  }

  /* ---------- floating tile cards ---------- */
  const SLOTS = [{ x: .84, y: .04 }, { x: 1.0, y: .60 }, { x: .30, y: .93 }];
  const cardsEl = $('.ld-cards'), links = $('.ld-links');
  const cards = SLOTS.map((s, i) => {
    const f = document.createElement('figure'); f.className = 'ld-card'; f.style.animationDelay = `${-i * 2.3}s`; f.style.margin = 0;
    f.innerHTML = `<img alt=""><div class="scan"></div><figcaption><i></i><span></span></figcaption>`;
    cardsEl.appendChild(f);
    const line = document.createElementNS(ns, 'line'); links.appendChild(line);
    const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('r', 3); links.appendChild(dot);
    return { el: f, img: f.querySelector('img'), cap: f.querySelector('span'), line, dot, slot: s, region: null };
  });
  for (const r of REGIONS) if (r[5]) { const im = new Image(); im.src = `/tiles/${r[0]}/${MONTH}.png`; }
  function placeCards() {
    const g = $('.ld-globe').getBoundingClientRect();
    for (const c of cards) {
      const w = c.el.offsetWidth || 120, h = c.el.offsetHeight || 150;
      const x = Math.min(innerWidth - w - 20, g.left + c.slot.x * g.width - w / 2);
      const y = Math.max(16, Math.min(innerHeight - h - 16, g.top + c.slot.y * g.height - h / 2));
      c.el.style.left = `${x}px`; c.el.style.top = `${y}px`;
    }
  }
  function show(c, r) {
    c.region = r;
    c.el.classList.remove('on');
    setTimeout(() => {
      c.img.onerror = () => { c.img.onerror = null; c.img.src = `/tiles/${r[0]}/2026-07.png`; };
      c.img.src = `/tiles/${r[0]}/${MONTH}.png`;
      c.cap.textContent = r[1]; c.el.style.setProperty('--c', COL[r[4]]);
      c.el.classList.add('on');
    }, c.region ? 450 : 0);
  }

  /* ---------- globe ---------- */
  let map = null, ready = false, center = { lng: -38, lat: 24 };
  const t0 = performance.now();
  function initMap() {
    const ML = window.maplibregl;
    if (!ML) throw new Error('maplibre missing');
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('no webgl');
    map = new ML.Map({
      container: 'ld-map', attributionControl: false, interactive: false, fadeDuration: 0,
      center: [center.lng, center.lat], zoom: 1.6, renderWorldCopies: false,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          s2: { type: 'raster', tiles: [EOX], tileSize: 256, maxzoom: 6 },
          arcs: { type: 'geojson', lineMetrics: true, data: fc(arcs.map(a => ({ type: 'Feature', properties: { c: COL[a.r[4]] }, geometry: { type: 'LineString', coordinates: a.path } }))) },
          regions: { type: 'geojson', data: fc(REGIONS.map(r => pt([r[2], r[3]], { c: COL[r[4]] }))) },
          london: { type: 'geojson', data: fc([pt(LONDON)]) },
          particles: { type: 'geojson', data: fc([]) },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0B1630' } },
          { id: 's2', type: 'raster', source: 's2', paint: { 'raster-saturation': 0.05, 'raster-contrast': 0.08, 'raster-brightness-max': 0.95, 'raster-fade-duration': 300 } },
          { id: 'arcs', type: 'line', source: 'arcs', layout: { 'line-cap': 'round' },
            paint: { 'line-width': 1.4, 'line-opacity': 0.9,
              'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(249,115,22,0.05)', 0.5, 'rgba(251,146,60,0.45)', 1, 'rgba(255,237,213,0.9)'] } },
          { id: 'halo', type: 'circle', source: 'regions', paint: { 'circle-radius': 10, 'circle-color': ['get', 'c'], 'circle-opacity': 0.25, 'circle-blur': 0.4, 'circle-pitch-alignment': 'map' } },
          { id: 'dots', type: 'circle', source: 'regions', paint: { 'circle-radius': 3.6, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-pitch-alignment': 'map' } },
          { id: 'particles', type: 'circle', source: 'particles', paint: { 'circle-radius': ['get', 's'], 'circle-color': '#FFF7ED', 'circle-blur': 0.3, 'circle-pitch-alignment': 'map' } },
          { id: 'london-halo', type: 'circle', source: 'london', paint: { 'circle-radius': 16, 'circle-color': '#F97316', 'circle-opacity': 0.3, 'circle-blur': 0.5, 'circle-pitch-alignment': 'map' } },
          { id: 'london', type: 'circle', source: 'london', paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#F97316', 'circle-stroke-width': 2.5, 'circle-pitch-alignment': 'map' } },
        ],
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
      },
    });
    map.on('error', e => console.warn('[landing]', e?.error?.message || e));
    map.once('load', () => { ready = true; fit(); $('.ld-map').style.opacity = 1; });
    addEventListener('resize', () => { fit(); placeCards(); });
  }
  // zoom so the globe radius is ~37% of the stage (measured, since globe zoom depends on latitude)
  function fit() {
    if (!map) return;
    const box = $('.ld-map').getBoundingClientRect(), target = box.width * 0.37;
    for (let i = 0; i < 3; i++) {
      const c = map.getCenter(), a = map.project(c), b = map.project([c.lng, c.lat - 89.5]);
      const r = Math.hypot(a.x - b.x, a.y - b.y);
      if (!(r > 1)) break;
      map.jumpTo({ zoom: map.getZoom() + Math.log2(target / r) });
    }
    globeR = 0.37 / 1.08 * 1000;
  }

  let lastCycle = 0, slotTurn = 0, tick = 0;
  function frame(now) {
    const t = (now - t0) / 1000;
    moveSat(t);
    if (map && map.loaded !== undefined) {
      center = { lng: -38 + t * 4.2, lat: 24 + 4 * Math.sin(t / 9) };
      map.jumpTo({ center: [center.lng, center.lat] });
      const pulse = (t % 2.2) / 2.2;
      if (ready) {
        map.setPaintProperty('halo', 'circle-radius', 4 + 16 * pulse);
        map.setPaintProperty('halo', 'circle-opacity', 0.45 * (1 - pulse));
        map.setPaintProperty('london-halo', 'circle-radius', 8 + 18 * ((t % 1.6) / 1.6));
        map.setPaintProperty('london-halo', 'circle-opacity', 0.5 * (1 - (t % 1.6) / 1.6));
        const feats = [];
        if ((tick = (tick + 1) % 2) === 0) for (const a of arcs) for (const k of [0, 0.5]) {
          const p = (a.ph + k + t * 0.22) % 1, i = Math.floor(p * (a.path.length - 1));
          feats.push(pt(a.path[i], { s: 1.6 + 1.6 * p }));
        }
        if (feats.length) map.getSource('particles')?.setData(fc(feats));
      }
    } else {
      center = { lng: -38 + t * 4.2, lat: 24 };
    }
    // cards: follow regions on the visible face; connector lines to their dots
    if (t > 0.9 && now - lastCycle > (lastCycle ? 3200 : 0)) {
      lastCycle = now;
      const vis = REGIONS.filter(r => r[5] && facing([r[2], r[3]], center) > 0.35 && !cards.some(c => c.region === r))
        .sort(() => Math.random() - 0.5);
      const first = !cards[0].region;
      if (first) cards.forEach((c, i) => vis[i] && setTimeout(() => show(c, vis[i]), i * 350));
      else { const c = cards[slotTurn++ % cards.length]; if (vis[0]) show(c, vis[0]); }
    }
    for (const c of cards) {
      const r = c.region, f = r ? facing([r[2], r[3]], center) : -1;
      if (!map || !r || f < 0.12 || !c.el.classList.contains('on')) { c.line.style.opacity = 0; c.dot.style.opacity = 0; continue; }
      const p = map.project([r[2], r[3]]), mb = $('.ld-map').getBoundingClientRect(), cb = c.el.getBoundingClientRect();
      const px = mb.left + p.x, py = mb.top + p.y;
      const cx = Math.max(cb.left, Math.min(cb.right, px)), cy = Math.max(cb.top, Math.min(cb.bottom, py));
      c.line.setAttribute('x1', cx); c.line.setAttribute('y1', cy); c.line.setAttribute('x2', px); c.line.setAttribute('y2', py);
      c.dot.setAttribute('cx', px); c.dot.setAttribute('cy', py);
      const o = Math.min(1, (f - 0.12) * 4); c.line.style.opacity = 0.7 * o; c.dot.style.opacity = o;
    }
    requestAnimationFrame(frame);
  }

  function start() {
    try { initMap(); } catch (e) { console.warn('[landing] static globe:', e.message); document.body.classList.add('no-gl'); map = null; }
    placeCards();
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
})();
