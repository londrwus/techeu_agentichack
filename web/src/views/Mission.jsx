// Mission Control: the live-scan screen. Counters, the Sentinel-2 tile grid, providers and Jev throughput.
// Ported from vanilla js/views/mission.js — the scan store (lib/scan.jsx) now drives React state directly.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BriefingButton } from '@/components/orbit/chrome.jsx';
import { Icon } from '@/lib/icons.jsx';
import { api, allModules, useAsync } from '@/lib/api.js';
import { MODULE_META } from '@/lib/meta.js';
import { fmt, shortRegion } from '@/lib/format.js';
import { CountUp, hideTip, showTip } from '@/lib/dom.jsx';
import { MAX_CONTAINERS, startScan, stopScan, useScan } from '@/lib/scan.jsx';
import { fmtMonth, tipHtml } from '@/lib/chartTheme.js';

function gpuShort(model) {
  const m = String(model || '').match(/(B200|H200|H100|A100|A10G|L40S|L4|T4)/i);
  if (m) return m[1].toUpperCase();
  if (/timesfm/i.test(model || '')) return 'TimesFM';
  return model ? String(model).split(' ')[0] : 'GPU';
}
function gpuFamily(model) {
  const s = String(model || '').replace(/\s*(on|·)?\s*(NVIDIA\s*)?(B200|H200|H100|A100|A10G|L40S|L4|T4).*$/i, '').trim();
  return s || 'Forecast';
}
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function Mission() {
  const { arg } = useParams();
  const scan = useScan();
  const [stats, setStats] = useState({});
  const { data } = useAsync(async () => {
    const [s, mods, lastScan] = await Promise.all([
      api('/api/stats', { fresh: true }),
      allModules(),
      api('/api/scan/last').catch(() => null),
    ]);
    const regionName = {}, regionMod = {}, idleTiles = [];
    mods.forEach(m => (m.regions || []).forEach(r => {
      regionName[r.region_id] = shortRegion(r);
      regionMod[r.region_id] = m.module?.id;
      const last = (r.series || []).filter(x => x.thumb).pop();
      if (last) idleTiles.push({ region_id: r.region_id, thumb: last.thumb, module_id: m.module?.id });
    }));
    // Tight window around the burst (2 s either side) so the bars read as a chart, not three hairlines.
    const j = lastScan?.jps || [];
    const a = j.findIndex(v => v > 0);
    let ghost = [];
    if (a >= 0) { let b = j.length - 1; while (b > a && !(j[b] > 0)) b--; ghost = j.slice(Math.max(0, a - 2), Math.min(j.length, b + 3)).slice(0, 30); }
    return { stats: s || {}, regionName, regionMod, idleTiles, lastScan, ghost };
  }, []);

  useEffect(() => { if (data?.stats) setStats(data.stats); }, [data]);
  // #/mission/scan (or /replay) starts a scan as soon as the screen opens.
  useEffect(() => {
    if ((arg === 'scan' || arg === 'replay') && !scan.running) startScan(arg === 'replay' ? 'replay' : 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arg]);

  useEffect(() => {
    const poll = setInterval(async () => { const s = await api('/api/stats', { fresh: true }); if (s) setStats(s); }, 4000);
    return () => { clearInterval(poll); hideTip(); };
  }, []);

  const l = scan.last || {};
  const live = scan.running;
  const { regionName = {}, regionMod = {}, idleTiles = [], lastScan, ghost = [] } = data || {};

  const active = Math.min(MAX_CONTAINERS, l.containers_active || 0);
  const jps = scan.jevHistory.length ? scan.jevHistory[scan.jevHistory.length - 1] : 0;
  const gpu = l.gpu_model || stats.gpu_model;
  const gt = stats.gpu_type ? String(stats.gpu_type).replace(/\s*\(.*\)/, '') : null;

  const total = live || scan.finished ? (l.tiles_total || 0) : idleTiles.length;
  const done = live || scan.finished ? (l.tiles_done || 0) : idleTiles.length;
  const p = total ? Math.round((done / total) * 100) : 0;

  // tile grid cells
  const cells = useMemo(() => {
    if (live || scan.finished) {
      const cap = Math.min(45, Math.max(total, scan.tiles.length, 16));
      const shown = scan.tiles.slice(-cap);
      const remaining = Math.max(0, total - done);
      const proc = live ? Math.min(remaining, Math.max(1, Math.min(active, 6)), cap - shown.length) : 0;
      return Array.from({ length: cap }, (_, i) => (i < shown.length ? { state: 'done', ev: shown[i] }
        : i < shown.length + proc ? { state: 'proc' } : { state: 'pending' }));
    }
    const n = Math.max(idleTiles.length, 16);
    return Array.from({ length: n }, (_, i) => (idleTiles[i] ? { state: 'stale', ev: idleTiles[i] } : { state: 'pending' }));
  }, [live, scan.finished, scan.tiles, total, done, active, idleTiles]);
  const cols = cells.length <= 16 ? 6 : cells.length <= 24 ? 8 : cells.length <= 60 ? 10 : 16;

  const jevTotal = (stats.jev_judgments_total ?? stats.jev_judgments ?? 0) + (live ? (l.jev_judgments || 0) : 0);

  // throughput
  const hist = scan.jevHistory.slice(-30);
  const useGhost = !live && !scan.finished && ghost.length && !hist.some(v => v > 0);
  const pad = useGhost ? ghost : Array(30 - hist.length).fill(0).concat(hist);
  const max = Math.max(10, ...pad);
  const nowJ = hist.length ? hist[hist.length - 1] : 0;
  const tput = useRef(null);

  const onTputMove = e => {
    const bars = [...tput.current.children], i = bars.indexOf(e.target);
    if (i < 0) { hideTip(); return; }
    const arr = useGhost ? ghost : Array(30 - hist.length).fill(null).concat(hist), v = arr[i];
    const ago = 29 - i;
    if (useGhost) {
      showTip(tipHtml({ title: `Last scan · second ${i + 1}`, tag: 'Recorded',
        rows: [{ color: '#C7D2FE', label: 'Jev judgments / sec', value: fmt(v) }],
        note: `${fmt(lastScan.jev_judgments)} judgments · ${fmt(lastScan.tiles)} tiles in ${Math.round(lastScan.elapsed_s || 0)}s` }), e.clientX, e.clientY);
      return;
    }
    showTip(tipHtml({ title: ago ? `${ago}s ago` : 'Now', tag: scan.running ? 'Live' : '',
      rows: [{ color: i === 29 ? 'var(--accent)' : '#C7D2FE', label: 'Jev judgments / sec', value: v == null ? 'no data' : fmt(v) }],
      note: v == null ? 'Press Scan now to stream live judgments.' : `Peak this scan: ${fmt(scan.peakJps)}/s` }), e.clientX, e.clientY);
  };

  return (
    <>
      <header className="topbar">
        <div>
          <div className="title-row">
            <h1>Mission Control</h1>
            {live ? <Badge variant="liveRed">LIVE · scan running {mmss(scan.elapsed)}{l.replay ? ' · replay' : ''}</Badge>
              : scan.finished ? <Badge variant="down"><Icon name="check" />Scan complete · {mmss(scan.elapsed)}</Badge>
                : <Badge variant="live">Ready · Modal standing by</Badge>}
          </div>
          <div className="tagline">Every satellite tile, every headline, re-judged in under a minute.</div>
        </div>
        <div className="actions">
          {live
            ? <Button variant="orbit" size="orbit" onClick={stopScan}><Icon name="square" />Stop</Button>
            : <BriefingButton className="btn" />}
          {live
            ? <Button variant="orbitPrimary" size="orbit" className="running"><Icon name="loader" className="spin" />Scanning…</Button>
            : <Button variant="orbitPrimary" size="orbit" onClick={() => startScan()}><Icon name="satellite-dish" />Scan now</Button>}
        </div>
      </header>

      <section className="counter-row">
        <Counter icon="boxes" label="Modal containers" cap="Parallel containers on Modal"
                 value={live || scan.finished ? (live ? active : scan.peakContainers) : Math.min(MAX_CONTAINERS, stats.modal_containers_peak || 0)}
                 suffix={live || scan.finished ? (live ? `/ ${MAX_CONTAINERS}` : 'peak') : 'peak'} />
        <Counter icon="image" label="Tiles processed" cap="Sentinel-2 satellite tiles"
                 value={live || scan.finished ? (l.tiles_done || 0) : (stats.tiles_processed_total ?? stats.tiles_processed ?? 0)}
                 suffix={live || scan.finished ? `/ ${fmt(l.tiles_total || 0)}` : 'total'} />
        <Counter icon="gavel" label="Jev judgments / sec" cap="Typed judgments by TypeSafe Jev"
                 value={live || scan.finished ? (live ? jps : scan.peakJps) : (lastScan?.peak_jps ?? '–')}
                 suffix={live || scan.finished ? (live ? '' : 'peak') : (lastScan?.peak_jps ? 'last scan' : 'press Scan now')} />
        <Counter icon="cpu" label="Forecast model"
                 cap={/timesfm/i.test(gpu || '') ? `TimesFM 3.0 · ${(gt || 'GPU').replace(/^NVIDIA\s+/i, '')} GPU on Modal` : `${gpuFamily(gpu)} on Modal`}
                 value={gpuShort(gpu)} suffix="" />
      </section>

      <section className="mc-row">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Sentinel-2 tiles, arriving live</div>
              <div className="card-sub">
                {live || scan.finished
                  ? `${fmt(total)} tiles · fanned out on up to 75 Modal containers${l.month ? ' · ' + l.month : ''}`
                  : `${idleTiles.length || 16} regions · last scan · press Scan now`}
              </div>
            </div>
            <div className="pct">{total ? p + '%' : '–'}</div>
          </div>
          <div className="progress"><i style={{ width: `${p}%` }} /></div>
          <div className="tile-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {cells.map((c, i) => <Tile key={i} {...c} regionName={regionName} regionMod={regionMod} />)}
          </div>
        </div>
        <div className="side">
          <div className="card" style={{ padding: 20 }}>
            <div className="prov-title">Gemini sees · Jev judges · Modal scales</div>
            <Prov icon="server" name="Modal" role={/timesfm/i.test(gpu || '') ? 'CPU fan-out + TimesFM 3.0' : `CPU fan-out + ${gpuShort(gpu)} GPU`}
                  stat={live ? `${active} live` : `peak ${fmt(Math.min(MAX_CONTAINERS, Math.max(stats.modal_containers_peak || 0, scan.peakContainers)))}`} />
            <Prov icon="eye" name="Google Gemini" role="3.8-flash · vision + TTS"
                  stat={`${fmt(stats.gemini_calls_total ?? stats.gemini_calls ?? 0)} calls`} />
            <Prov icon="scale" name="TypeSafe Jev" role="jev-latest · typed judgments" stat={`${fmt(jevTotal)} judged`} />
          </div>
          <div className="card" style={{ padding: 20, flex: 1 }}>
            <div className="card-head">
              <div style={{ fontSize: 15, fontWeight: 700 }}>Jev judgments / sec</div>
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                {useGhost ? `last scan · peak ${fmt(lastScan.peak_jps)}/s` : `peak ${fmt(scan.peakJps)}/s`}
              </div>
            </div>
            <div className="tput-sum">
              {useGhost ? (<>
                <b>{fmt(lastScan.peak_jps)}</b>
                <span>/s peak · {fmt(lastScan.jev_judgments)} judgments on {fmt(lastScan.tiles)} tiles in {Math.round(lastScan.elapsed_s || 0)} s</span>
              </>) : live || scan.finished ? (<>
                <b>{fmt(live ? nowJ : scan.peakJps)}</b>
                <span>/s {live ? 'now' : 'peak'} · peak {fmt(scan.peakJps)}/s</span>
              </>) : null}
            </div>
            <div className="tput-wrap">
              <div className={`tput${useGhost ? ' ghost' : ''}`} ref={tput} onMouseMove={onTputMove} onMouseLeave={hideTip}>
                {Array.from({ length: 30 }, (_, i) => (
                  <i key={i} hidden={i >= pad.length}
                     style={{ height: `${Math.max(2, ((pad[i] || 0) / max) * 100)}%` }}
                     data-v={useGhost && pad[i] > 0 ? fmt(pad[i]) : ''}
                     data-t={useGhost ? `${i + 1}s` : ''} />
                ))}
              </div>
              <div className={`tput-empty${useGhost ? ' ghost' : ''}`} hidden={hist.some(v => v > 0) || !!useGhost}>
                {useGhost ? 'Last scan shown · press Scan now to stream live' : 'Live throughput appears here during a scan'}
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Counter({ icon, label, cap, value, suffix }) {
  return (
    <div className="card counter">
      <div className="counter-head"><Icon name={icon} />{label}</div>
      <div className="v">
        {typeof value === 'number'
          ? <CountUp className="cv" to={value} dur={600} />
          : <span className="cv">{value}</span>}
        <small>{suffix}</small>
      </div>
      <div className="cap">{cap}</div>
    </div>
  );
}

function Prov({ icon, name, role, stat }) {
  return (
    <div className="prov">
      <div className="lg"><Icon name={icon} /></div>
      <div><div className="nm">{name}</div><div className="rl">{role}</div></div>
      <div className="st">{stat}</div>
    </div>
  );
}

function Tile({ state, ev, regionName, regionMod }) {
  const [broken, setBroken] = useState(false);
  if (state === 'proc') return <div className="tile proc"><Icon name="loader" /></div>;
  if (state !== 'done' && state !== 'stale') return <div className="tile" />;
  const col = MODULE_META[ev.module_id || regionMod[ev.region_id]]?.color || '#A8A29E';
  const tm = /(\d{4}-\d{2})\.png$/.exec(ev.thumb || '')?.[1] || ev.month || '';
  const label = regionName[ev.region_id] || ev.region_id || '';
  return (
    <div className={`tile done${state === 'stale' ? ' stale' : ''}`} style={{ boxShadow: `inset 0 -3px 0 ${col}` }}>
      {ev.thumb && !broken ? (<>
        <img src={`/${ev.thumb}`} alt={label} data-sat-region={ev.region_id || ''} data-sat-month={tm}
             title={`${label}${tm ? ' · ' + fmtMonth(tm) : ''}`} onError={() => setBroken(true)} />
        <span className="lab">{label}</span>
      </>) : (
        <span className="lab" style={{ color: 'var(--text-2)', textShadow: 'none' }}>{label || 'tile'}</span>
      )}
    </div>
  );
}
