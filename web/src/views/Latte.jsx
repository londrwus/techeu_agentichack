// Latte Index screen (MODULES.md §07): hero forecast + Sul de Minas before/after, then the shared signal row.
// Ported from vanilla js/views/latte.js.
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { ModuleHeader } from '@/components/orbit/chrome.jsx';
import { Delta } from '@/components/orbit/bits.jsx';
import { ForecastChart, SignalRow } from '@/components/orbit/charts.jsx';
import { Icon } from '@/lib/icons.jsx';
import { loadModule, useAsync } from '@/lib/api.js';
import { ACCENT } from '@/lib/meta.js';
import { fmtGBP, isNum, monthLabel, shortRegion } from '@/lib/format.js';
import { CountUp } from '@/lib/dom.jsx';

const ID = 'latte', REGION = 'minas_coffee';

const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };

/** Latest clear tile + same season 5 years earlier (lowest cloud within ±1 month). */
function pickPair(region) {
  const s = (region?.series || []).filter(p => p?.thumb && isNum(p.cloud_pct));
  if (s.length < 2) return null;
  const recent = s.slice(-4);
  const clear = recent.filter(p => p.cloud_pct <= 10);
  const after = clear.length ? clear[clear.length - 1] : recent.reduce((a, b) => (b.cloud_pct < a.cloud_pct ? b : a));
  const target = addMonths(after.month, -60);
  const win = [-1, 0, 1].map(d => addMonths(target, d));
  let cands = s.filter(p => win.includes(p.month));
  if (!cands.length) cands = s.filter(p => p.month < addMonths(after.month, -36)).slice(-3);
  if (!cands.length) return null;
  const before = cands.reduce((a, b) => (b.cloud_pct < a.cloud_pct - 0.5 || (Math.abs(b.cloud_pct - a.cloud_pct) <= 0.5 && b.month === target) ? b : a));
  return { before, after };
}

export default function Latte() {
  const { data, loading } = useAsync(() => loadModule(ID), []);

  if (loading) return <><ModuleHeader moduleId={ID} /><div className="card skeleton" style={{ height: 500 }} /></>;
  if (!data) return <><ModuleHeader moduleId={ID} /><div className="empty">No data for this module yet.</div></>;

  const accent = ACCENT[ID];
  const item = data.items?.find(i => i.item_id === 'latte') || data.items?.[0];
  const region = data.regions?.find(r => r.region_id === REGION) || data.regions?.[0];
  const sig = data.signals || {};

  const items = data.items || [];
  const flagged = items.find(i => i?.backtest?.orbit_signal?.flagged) || items.find(i => i?.backtest?.flagged);
  const right = flagged ? null : (
    <Link className="backtest muted" to="/track"><Icon name="history" /><span>Backtested since 2018</span></Link>
  );

  // Hero numbers (real data)
  const hist = item?.history || [], fc = item?.forecast || [];
  const now = isNum(item?.retail_now) ? item.retail_now : hist.at(-1)?.price;
  // One horizon on the whole card: 6 months (same as every other module).
  const i6 = Math.min(5, fc.length - 1);
  const p6 = fc[i6];
  const end = p6?.p50;
  const chg6 = isNum(now) && isNum(end) ? (end / now - 1) * 100 : null;
  const press = sig.net_supply_pressure;

  const stats = [
    isNum(item?.prob_up_6m) && (
      <div key="p"><CountUp as="div" className="v" to={Math.round(item.prob_up_6m * 100)} suffix="%" placeholder="0%" /><div className="l">chance it rises in 6 mo</div></div>
    ),
    isNum(press) && (
      <div key="s">
        <div className="v" style={{ color: `var(--${press > 0.05 ? 'up' : press < -0.05 ? 'down' : 'text-1'})` }}>
          {press > 0.2 ? 'Tight' : press > 0.05 ? 'Tightening' : press < -0.05 ? 'Easing' : 'Balanced'}
        </div>
        <div className="l">coffee supply, judged by Jev from news</div>
      </div>
    ),
    p6 && isNum(p6.p10) && isNum(p6.p90) && (
      <div key="r"><div className="v">{fmtGBP(p6.p10)} – {fmtGBP(p6.p90)}</div><div className="l">likely range in 6 mo</div></div>
    ),
  ].filter(Boolean);

  const pair = pickPair(region);
  const ndvi = region?.anomaly?.ndvi_vs_5yr_pct;
  const note = data.insights?.vision_notes?.find(v => v.region_id === region?.region_id)?.text;

  const hasFc = item && hist.length;
  const hasSat = !!region;

  return (
    <>
      <ModuleHeader moduleId={ID} data={data} right={right} />
      <div className="lt-page">
        {hasFc || hasSat ? (
          <div className="lt-hero" style={!hasFc || !hasSat ? { gridTemplateColumns: '1fr' } : undefined}>
            {hasFc ? (
              <section className="card lt-fc">
                <div className="lt-fc-head">
                  <div>
                    <div className="k">{item.name?.replace(/\s*\((.*)\)/, ', $1') || 'Latte'}</div>
                    <div className="hero-price">
                      <CountUp as="b" to={end ?? now} digits={2} prefix="£" placeholder="£0.00" />
                      <span>
                        from {fmtGBP(now)} today{isNum(chg6) ? <> · <Delta v={chg6} /> in 6 mo</> : null}
                      </span>
                    </div>
                  </div>
                  <div className="fc-legend">
                    <span><i />History</span>
                    <span><i className="dash" style={{ '--c': accent }} />Forecast</span>
                  </div>
                </div>
                <ForecastChart
                  className="lt-chart"
                  history={hist}
                  forecast={fc.slice(0, i6 + 1)}
                  accent={accent}
                  unit={item.unit || '£'}
                  calloutTitle="Latte"
                  months={12}
                  calloutIndex={i6}
                />
                {stats.length ? <div className="stat-strip">{stats}</div> : null}
              </section>
            ) : null}
            {hasSat ? (
              <section className="card lt-sat">
                <div className="lt-sat-head">
                  <div>
                    <h3>{shortRegion(region)}, from orbit</h3>
                    <div className="sub">
                      Sentinel-2{pair ? ` · ${monthLabel(pair.before.month, true)} vs ${monthLabel(pair.after.month, true)}` : ''}
                    </div>
                  </div>
                  {isNum(ndvi) ? (
                    <Badge variant={ndvi < 0 ? 'up' : 'down'}>
                      <Icon name="leaf" />NDVI {ndvi > 0 ? '+' : ndvi < 0 ? '−' : ''}{Math.abs(Math.round(ndvi))}%
                    </Badge>
                  ) : null}
                </div>
                {pair ? (
                  <>
                    <Compare pair={pair} region={region} note={note} />
                    <div className="lt-hint">Drag to compare · click a date to zoom</div>
                  </>
                ) : (
                  <div className="empty" style={{ marginTop: 16 }}>Satellite tiles are still downloading…</div>
                )}
              </section>
            ) : null}
          </div>
        ) : null}
        {/* Signal row. Price card = raw TimesFM for the same latte, labelled with what Orbit's signals add. */}
        <SignalRow data={data} accent={accent} priceItem={item} />
      </div>
    </>
  );
}

/** Drag-to-compare before/after slider over two Sentinel-2 tiles. */
function Compare({ pair, region, note }) {
  const box = useRef(null);
  const before = useRef(null);
  const handle = useRef(null);
  const drag = useRef(false);

  const set = x => {
    const r = box.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100));
    before.current.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
    handle.current.style.left = p + '%';
  };

  return (
    <div
      className="compare"
      ref={box}
      title={note || undefined}
      onPointerDown={e => { if (e.target.closest('.lt-zoom')) return; drag.current = true; box.current.setPointerCapture(e.pointerId); set(e.clientX); }}
      onPointerMove={e => drag.current && set(e.clientX)}
      onPointerUp={() => { drag.current = false; }}
      onPointerCancel={() => { drag.current = false; }}
    >
      <img className="after" data-no-lightbox src={`/${pair.after.thumb}`} alt={pair.after.month}
           onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />
      <img className="before" ref={before} data-no-lightbox src={`/${pair.before.thumb}`} alt={pair.before.month}
           style={{ clipPath: 'inset(0 50% 0 0)' }} onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />
      <div className="handle" ref={handle} style={{ left: '50%' }}>
        <div className="knob"><Icon name="chevrons-left-right" /></div>
      </div>
      <div className="lt-zoom">
        {[pair.before, pair.after].map(p => (
          <button key={p.month} type="button" data-sat-region={region.region_id} data-sat-month={p.month}
                  title={`Open ${monthLabel(p.month, true)} tile`}>
            <Icon name="zoom-in" size={14} />{monthLabel(p.month, true)}
          </button>
        ))}
      </div>
    </div>
  );
}
