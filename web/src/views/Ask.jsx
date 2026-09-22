// Ask Orbit: Jev routes the question, Gemini answers with the evidence.
// Ported from vanilla js/views/ask.js — the chat transcript lives in module state so it survives route changes.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BriefingButton } from '@/components/orbit/chrome.jsx';
import { Icon, ModuleIcon } from '@/lib/icons.jsx';
import { allModules } from '@/lib/api.js';
import { ITEM_META, MODULE_META } from '@/lib/meta.js';
import { fmt, isNum, money, monthLabel, retailMapper } from '@/lib/format.js';
import { hideTip, showTip } from '@/lib/dom.jsx';
import { fmtMonth, fmtPct, tipHtml } from '@/lib/chartTheme.js';

const SUGGEST = [['candy', 'Why is chocolate so expensive?'], ['cpu', 'Will GPUs get cheaper next year?'], ['building-2', 'Where will rents rise most?'], ['beer', 'Is a pint going to hit £8?']];
const STEPS = [
  ['git-branch', 'var(--p-jev)', 'var(--p-jev-soft)', 'Jev routes the question'],
  ['eye', 'var(--p-gemini)', '#DBEAFE', 'Gemini reads the evidence'],
  ['server', 'var(--p-modal)', 'var(--down-soft)', 'Forecast from Modal'],
  ['volume-2', 'var(--accent)', 'var(--accent-soft)', 'Spoken briefing'],
];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, christmas: 12, xmas: 12, summer: 7, spring: 4, winter: 1 };

const INTRO = { id: 0, role: 'intro' };
// Chat history survives route changes, like the detached .msgs node in the vanilla build.
let saved = null;
let busy = false;
let nextId = 1;
// How many words of each answer are already on screen, by message id. Lives outside React so a
// re-render (a trace step lighting up, a keystroke, a route change) can never restart the reveal.
const revealed = new Map();

export default function Ask() {
  const { arg } = useParams();
  const [msgs, setMsgs] = useState(() => saved || [INTRO]);
  const [steps, setSteps] = useState(() => STEPS.map(() => ({ on: false, detail: 'Waiting for a question' })));
  const box = useRef(null);

  useEffect(() => { saved = msgs; }, [msgs]);
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [msgs]);
  const stickToBottom = useCallback(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, []);

  const setStep = (i, on, detail) => setSteps(s => s.map((x, k) => (k === i ? { on, detail: detail ?? x.detail } : x)));

  const send = async q => {
    q = (q || '').trim();
    if (!q || busy) return;
    busy = true;
    setMsgs(m => [...m, { id: nextId++, role: 'user', text: q }, { id: nextId++, role: 'pending' }]);
    setSteps(STEPS.map((_, i) => ({ on: false, detail: i === 0 ? 'Routing with calibrated confidence…' : 'Waiting' })));

    const t0 = performance.now();
    let res = null;
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
      res = r.ok ? await r.json() : null;
    } catch (e) { console.warn('[ask]', e); }
    const ms = Math.round(performance.now() - t0);

    if (!res) {
      setMsgs(m => [...m.slice(0, -1), { id: nextId++, role: 'error' }]);
      busy = false;
      return;
    }
    const label = res.route?.label, conf = res.route?.confidence;
    const mMeta = MODULE_META[label];
    const focus = res.focus || {};
    const mods = await allModules();
    const itemId = focus.item_id;
    const mod = mods.find(m => (m.items || []).some(i => i.item_id === itemId)) || mods.find(m => m.module?.id === (focus.module_id || label));
    const item = itemId ? mod?.items?.find(i => i.item_id === itemId) : null;

    const calls = res.tool_calls || [];
    const detail = [
      `${mMeta ? mMeta.name : 'General'}${isNum(conf) ? ` · ${Math.round(conf * 100)}%` : ''}${res.route?.item && res.route.item !== 'none' ? ` · ${res.route.item.replace(/_/g, ' ')}` : ''}`,
      calls.length ? `${calls.length} tool call${calls.length > 1 ? 's' : ''} · ${[...new Set(calls.map(c => c.name))].slice(0, 2).join(', ')}` : `answered in ${(ms / 1000).toFixed(1)} s`,
      item ? `${item.model || 'Forecast'} · 6 mo ${money(item.retail_6m ?? item.retail_now)}` : mod ? `${mod.module?.name} forecasts` : 'No forecast needed',
      'Gemini TTS · ready to play',
    ];
    detail.forEach((d, i) => setTimeout(() => setStep(i, true, d), 150 + i * 280));

    setMsgs(m => [...m.slice(0, -1), { id: nextId++, role: 'answer', q, label, conf, text: res.answer || '…', item, mod, focus }]);
    busy = false;
  };

  useEffect(() => {
    if (!arg) return undefined;
    const t = setTimeout(() => send(decodeURIComponent(arg)), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arg]);

  return (
    <>
      <header className="topbar">
        <div>
          <div className="title-row"><h1>Ask Orbit</h1></div>
          <div className="tagline">Ask about any price. Jev routes it, Gemini answers with the evidence.</div>
        </div>
      </header>
      <section className="ask-row">
        <div className="card chat">
          <div className="msgs" ref={box}>
            {msgs.map(m => <Message key={m.id} m={m} onGrow={stickToBottom} />)}
          </div>
          <Composer onSend={send} />
        </div>
        <div className="side">
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>How Orbit answered</div>
            <div className="steps">
              {STEPS.map(([ic, c, bg, nm], i) => (
                <div className={`step${steps[i].on ? ' on' : ''}`} key={nm}>
                  <div className="ic" style={{ background: bg, color: c }}><Icon name={ic} /></div>
                  <div style={{ minWidth: 0 }}><div className="nm">{nm}</div><div className="dt">{steps[i].detail}</div></div>
                  <Icon name="check" className="ok" />
                </div>
              ))}
            </div>
            <BriefingButton label="Play the spoken briefing" />
          </div>
          <div className="card" style={{ padding: 20, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Try asking</div>
            <div className="sugg">
              {SUGGEST.map(([ic, s]) => (
                <button key={s} onClick={() => send(s)}><Icon name={ic} size={16} /><span>{s}</span></button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** The input row. Owns its own value so a keystroke never re-renders the chat or the trace. */
function Composer({ onSend }) {
  const [value, setValue] = useState('');
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <form className="ask-input" autoComplete="off" onSubmit={e => { e.preventDefault(); onSend(value); setValue(''); }}>
      <input ref={input} value={value} onChange={e => setValue(e.target.value)}
             placeholder="Ask about olive oil, GPUs, rent in Hackney…" aria-label="Ask Orbit" />
      <Mic onFinal={q => { onSend(q); setValue(''); }} setValue={setValue} />
      <button type="submit" className="ibtn send" title="Send"><Icon name="arrow-up" /></button>
    </form>
  );
}

const Message = memo(function Message({ m, onGrow }) {
  if (m.role === 'user') return <div className="umsg">{m.text}</div>;
  if (m.role === 'intro') {
    return (
      <div className="amsg">
        <div className="avatar"><Icon name="orbit" /></div>
        <div className="abody">
          <p className="atext" style={{ color: 'var(--text-2)' }}>
            Hi, I&apos;m Orbit. Ask me what anything will cost in 6 months. I&apos;ll show you the satellites, the news and the forecast behind the answer.
          </p>
        </div>
      </div>
    );
  }
  if (m.role === 'error') {
    return (
      <div className="amsg">
        <div className="avatar"><Icon name="orbit" /></div>
        <div className="abody"><p className="atext" style={{ color: 'var(--text-2)' }}>Orbit couldn&apos;t reach its agents just now. Try again in a moment.</p></div>
      </div>
    );
  }
  if (m.role === 'pending') {
    return (
      <div className="amsg">
        <div className="avatar"><Icon name="orbit" /></div>
        <div className="abody">
          <span className="route"><Icon name="git-branch" />Jev is routing…</span>
          <div className="typing"><i /><i /><i /></div>
        </div>
      </div>
    );
  }
  const mMeta = MODULE_META[m.label];
  const confTxt = isNum(m.conf) ? `${Math.round(m.conf * 100)}% confident` : '';
  return (
    <div className="amsg">
      <div className="avatar"><Icon name="orbit" /></div>
      <div className="abody">
        <span className="route">
          <Icon name="git-branch" />Jev routed <Icon name="arrow-right" size={13} />{' '}
          {mMeta ? <><ModuleIcon id={m.label} size={14} />{mMeta.name}</> : 'General'}{confTxt ? ' · ' + confTxt : ''}
        </span>
        <Typed id={m.id} text={m.text} onGrow={onGrow} />
        {m.item ? <AnswerChart item={m.item} q={m.q} /> : null}
        <Sources mod={m.mod} item={m.item} focus={m.focus} />
      </div>
    </div>
  );
});

/** Word-by-word reveal of the answer, like the vanilla typeText().
 *  Progress is kept per message id in `revealed`, and the effect depends only on the message, so
 *  parent re-renders pick up where the reveal is instead of starting it again. */
function Typed({ id, text, onGrow }) {
  const words = String(text).split(/(\s+)/);
  const [n, setN] = useState(() => revealed.get(id) ?? 0);

  useEffect(() => {
    let i = revealed.get(id) ?? 0;
    if (i >= words.length) return undefined;
    let timer = 0;
    const tick = () => {
      i = Math.min(words.length, i + 2);
      revealed.set(id, i);
      setN(i);
      onGrow?.();
      if (i < words.length) timer = setTimeout(tick, 18);
    };
    timer = setTimeout(tick, 18);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- words is derived from text
  }, [id, text, onGrow]);

  return <p className="atext">{words.slice(0, n).join('')}</p>;
}

function AnswerChart({ item, q }) {
  const map = retailMapper(item) || (() => null);
  const fc = (item.forecast || []).slice(0, 6);
  const nowMonth = item.history?.[item.history.length - 1]?.month;
  const bars = [{ m: nowMonth, v: item.retail_now, now: true }, ...fc.map(f => ({ m: f.month, v: map(f.p50), lo: map(f.p10), hi: map(f.p90) }))].filter(b => isNum(b.v));
  const [grown, setGrown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGrown(true), 60); return () => clearTimeout(t); }, []);

  if (bars.length < 2) {
    return (
      <div className="ans-chart">
        <div className="h">{item.name}<span>{isNum(item.prob_up_6m) ? Math.round(item.prob_up_6m * 100) + '% chance of rising' : ''}</span></div>
      </div>
    );
  }
  const words = q.toLowerCase().match(/[a-z]+/g) || [];
  const wanted = words.map(w => MONTHS[w.slice(0, 3)] ?? MONTHS[w]).find(Boolean);
  let hl = bars.findIndex((b, i) => i > 0 && b.m && Number(b.m.slice(5)) === wanted);
  if (hl < 0) hl = bars.length - 1;
  const hi = Math.max(...bars.map(b => b.v)), lo = Math.min(...bars.map(b => b.v), hi * 0.9);
  const H = v => 30 + ((v - lo) / ((hi - lo) || 1)) * 70;
  const base = bars[0].v;

  return (
    <div className="ans-chart">
      <div className="h">
        {ITEM_META[item.item_id]?.short || item.name} price, next {bars.length - 1} months
        <span>{isNum(item.prob_up_6m) ? Math.round(item.prob_up_6m * 100) + '% chance of rising' : ''}</span>
      </div>
      <div className="cols">
        {bars.map((b, i) => {
          const html = tipHtml({
            title: fmtMonth(b.m), tag: b.now ? 'Today' : 'Forecast',
            rows: [
              { color: b.now ? '#A8A29E' : 'var(--accent)', label: b.now ? 'Price' : 'Expected price', value: money(b.v) },
              !b.now && isNum(b.lo) && isNum(b.hi) && { label: 'Likely range', value: `${money(b.lo)} – ${money(b.hi)}` },
              !b.now && isNum(base) && { label: 'vs today', value: fmtPct((b.v / base - 1) * 100) },
            ],
          });
          return (
            <div className={`c ${b.now ? 'now' : ''} ${i === hl ? 'hl' : ''}`} key={i}
                 onMouseMove={e => showTip(html, e.clientX, e.clientY)} onMouseLeave={hideTip}>
              <b>{money(b.v)}</b>
              <i style={{ height: grown ? `${H(b.v)}%` : 0, transitionDelay: `${i * 60}ms` }} />
              <span>{monthLabel(b.m)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Sources({ mod, item, focus }) {
  if (!mod) return null;
  const regs = mod.regions || [];
  const reg = regs.find(r => r.region_id === focus?.region_id) || regs[0];
  const n = mod.signals?.n_headlines;
  const out = [];
  if (reg) out.push(<span key="s"><Icon name="satellite" />Sentinel-2 · {(reg.name || '').split(',')[0].replace(/ \(.*?\)/, '')}</span>);
  if (isNum(n)) out.push(<span key="n"><Icon name="newspaper" />{fmt(n)} headlines</span>);
  if (item?.model) out.push(<span key="m"><Icon name="chart-line" />{item.model.split(' on ')[0]} forecast</span>);
  return out.length ? <div className="srcs">{out}</div> : null;
}

/** Web-Speech mic button (no-op with a dimmed icon where the API is missing). */
function Mic({ onFinal, setValue }) {
  const rec = useRef(null);
  const [on, setOn] = useState(false);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return <button type="button" className="ibtn" title="Voice input not supported in this browser" style={{ opacity: 0.5 }}><Icon name="mic" /></button>;
  const click = () => {
    if (rec.current) { rec.current.stop(); return; }
    const r = new SR();
    r.lang = 'en-GB'; r.interimResults = true;
    rec.current = r;
    setOn(true);
    r.onresult = e => {
      const last = e.results[e.results.length - 1];
      setValue(last[0].transcript);
      if (last.isFinal) { onFinal(last[0].transcript); setValue(''); }
    };
    r.onend = r.onerror = () => { setOn(false); rec.current = null; };
    r.start();
  };
  return <button type="button" className={`ibtn${on ? ' rec' : ''}`} title="Speak" onClick={click}><Icon name="mic" /></button>;
}
