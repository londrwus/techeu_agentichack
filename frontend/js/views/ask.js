import { api, allModules, MODULE_META, ITEM_META, esc, fmt, pct, money, isNum, icons, monthLabel, retailMapper } from '../lib.js';
import { wireBriefing } from './common.js';

const SUGGEST = ['🍫 Why is chocolate so expensive?', '🖥️ Will GPUs get cheaper next year?', '🏠 Where will rents rise most?', '🍺 Is a pint going to hit £8?'];
const STEPS = [
  ['git-branch', 'var(--p-jev)', 'var(--p-jev-soft)', 'Jev routes the question'],
  ['eye', 'var(--p-gemini)', '#DBEAFE', 'Gemini reads the evidence'],
  ['server', 'var(--p-modal)', 'var(--down-soft)', 'Forecast from Modal'],
  ['volume-2', 'var(--accent)', 'var(--accent-soft)', 'Spoken briefing'],
];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, christmas: 12, xmas: 12, summer: 7, spring: 4, winter: 1 };

let msgs = null; // chat history survives route changes

export async function render(page, arg) {
  page.innerHTML = `
  <header class="topbar"><div><div class="title-row"><h1>Ask Orbit</h1></div>
    <div class="tagline">Ask about any price. Jev routes it, Gemini answers with the evidence.</div></div></header>
  <section class="ask-row">
    <div class="card chat">
      <div id="msgs-slot" style="display:contents"></div>
      <form class="ask-input" id="form" autocomplete="off">
        <input id="q" placeholder="Ask about olive oil, GPUs, rent in Hackney…" aria-label="Ask Orbit">
        <button type="button" class="ibtn" id="mic" title="Speak"><i data-lucide="mic"></i></button>
        <button type="submit" class="ibtn send" title="Send"><i data-lucide="arrow-up"></i></button>
      </form>
    </div>
    <div class="side">
      <div class="card" style="padding:20px">
        <div style="font-size:16px;font-weight:700">How Orbit answered</div>
        <div class="steps" id="steps">${STEPS.map(([ic, c, bg, nm], i) => `<div class="step" data-s="${i}"><div class="ic" style="background:${bg};color:${c}"><i data-lucide="${ic}"></i></div>
          <div style="min-width:0"><div class="nm">${nm}</div><div class="dt">Waiting for a question</div></div><i data-lucide="check" class="ok"></i></div>`).join('')}</div>
        <button class="btn dark" id="brief"></button>
      </div>
      <div class="card" style="padding:20px;flex:1">
        <div style="font-size:16px;font-weight:700">Try asking</div>
        <div class="sugg">${SUGGEST.map(s => `<button data-q="${esc(s.slice(s.indexOf(' ') + 1))}">${esc(s)}</button>`).join('')}</div>
      </div>
    </div>
  </section>`;
  if (!msgs) {
    msgs = document.createElement('div');
    msgs.className = 'msgs';
    msgs.innerHTML = `<div class="amsg"><div class="avatar"><i data-lucide="orbit"></i></div><div class="abody"><p class="atext" style="color:var(--text-2)">Hi, I'm Orbit. Ask me what anything will cost in 6 months. I'll show you the satellites, the news and the forecast behind the answer.</p></div></div>`;
  }
  page.querySelector('#msgs-slot').replaceWith(msgs);
  msgs.scrollTop = msgs.scrollHeight;
  wireBriefing(page.querySelector('#brief'), 'Play the spoken briefing');
  const input = page.querySelector('#q');
  page.querySelector('#form').addEventListener('submit', e => { e.preventDefault(); send(page, input.value); input.value = ''; });
  page.querySelectorAll('.sugg button').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.q; send(page, b.dataset.q); input.value = ''; }));
  wireMic(page.querySelector('#mic'), input, q => send(page, q));
  icons();
  input.focus();
  if (arg) setTimeout(() => send(page, arg), 200);
}

function setStep(page, i, on, detail) {
  const s = page.querySelector(`.step[data-s="${i}"]`); if (!s) return;
  s.classList.toggle('on', on);
  if (detail != null) s.querySelector('.dt').textContent = detail;
}

let busy = false;
async function send(page, q) {
  q = (q || '').trim();
  if (!q || busy) return;
  busy = true;
  msgs.insertAdjacentHTML('beforeend', `<div class="umsg">${esc(q)}</div>`);
  const row = document.createElement('div');
  row.className = 'amsg';
  row.innerHTML = `<div class="avatar"><i data-lucide="orbit"></i></div><div class="abody"><span class="route"><i data-lucide="git-branch"></i>Jev is routing…</span><div class="typing"><i></i><i></i><i></i></div></div>`;
  msgs.appendChild(row);
  icons();
  msgs.scrollTop = msgs.scrollHeight;
  for (let i = 0; i < 4; i++) setStep(page, i, false, i === 0 ? 'Routing with calibrated confidence…' : 'Waiting');

  const t0 = performance.now();
  let res = null;
  try {
    const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
    res = r.ok ? await r.json() : null;
  } catch (e) { console.warn('[ask]', e); }
  const ms = Math.round(performance.now() - t0);
  const body = row.querySelector('.abody');
  if (!res) {
    body.innerHTML = `<p class="atext" style="color:var(--text-2)">Orbit couldn't reach its agents just now. Try again in a moment.</p>`;
    busy = false; return;
  }
  const label = res.route?.label, conf = res.route?.confidence;
  const mMeta = MODULE_META[label];
  const confTxt = isNum(conf) ? `${Math.round(conf * 100)}% confident` : '';
  const focus = res.focus || {};
  const mods = await allModules();
  const itemId = focus.item_id;
  const mod = mods.find(m => (m.items || []).some(i => i.item_id === itemId)) || mods.find(m => m.module?.id === (focus.module_id || label));
  const item = itemId ? mod?.items?.find(i => i.item_id === itemId) : null;

  body.innerHTML = `<span class="route"><i data-lucide="git-branch"></i>Jev routed → ${mMeta ? `${mMeta.emoji} ${esc(mMeta.name)}` : 'General'}${confTxt ? ' · ' + confTxt : ''}</span><p class="atext"></p>`;
  icons();
  // Trace (one by one)
  const calls = res.tool_calls || [];
  const steps = [
    `${mMeta ? mMeta.name : 'General'}${isNum(conf) ? ` · ${Math.round(conf * 100)}%` : ''}${res.route?.item && res.route.item !== 'none' ? ` · ${res.route.item.replace(/_/g, ' ')}` : ''}`,
    calls.length ? `${calls.length} tool call${calls.length > 1 ? 's' : ''} · ${[...new Set(calls.map(c => c.name))].slice(0, 2).join(', ')}` : `answered in ${(ms / 1000).toFixed(1)} s`,
    item ? `${item.model || 'Forecast'} · 6 mo ${money(item.retail_6m ?? item.retail_now)}` : mod ? `${mod.module?.name} forecasts` : 'No forecast needed',
    'Gemini TTS · ready to play',
  ];
  steps.forEach((d, i) => setTimeout(() => setStep(page, i, true, d), 150 + i * 280));

  await typeText(body.querySelector('.atext'), res.answer || '…');
  if (item) body.appendChild(chartCard(item, q));
  const src = sources(mod, item, focus);
  if (src) body.insertAdjacentHTML('beforeend', src);
  icons();
  msgs.scrollTop = msgs.scrollHeight;
  busy = false;
}

async function typeText(el, text) {
  const words = String(text).split(/(\s+)/);
  for (let i = 0; i < words.length; i++) {
    el.textContent += words[i];
    if (i % 2 === 0) { await new Promise(r => setTimeout(r, 18)); el.closest('.msgs') && (msgs.scrollTop = msgs.scrollHeight); }
  }
}

function chartCard(item, q) {
  const map = retailMapper(item) || (() => null);
  const fc = (item.forecast || []).slice(0, 6);
  const nowMonth = item.history?.[item.history.length - 1]?.month;
  const bars = [{ m: nowMonth, v: item.retail_now, now: true }, ...fc.map(f => ({ m: f.month, v: map(f.p50) }))].filter(b => isNum(b.v));
  const card = document.createElement('div');
  card.className = 'ans-chart';
  if (bars.length < 2) { card.innerHTML = `<div class="h">${esc(item.name)}<span>${isNum(item.prob_up_6m) ? Math.round(item.prob_up_6m * 100) + '% chance of rising' : ''}</span></div>`; return card; }
  const words = q.toLowerCase().match(/[a-z]+/g) || [];
  const wanted = words.map(w => MONTHS[w.slice(0, 3)] ?? MONTHS[w]).find(Boolean);
  let hl = bars.findIndex((b, i) => i > 0 && b.m && Number(b.m.slice(5)) === wanted);
  if (hl < 0) hl = bars.length - 1;
  const hi = Math.max(...bars.map(b => b.v)), lo = Math.min(...bars.map(b => b.v), hi * 0.9);
  const H = v => 30 + ((v - lo) / ((hi - lo) || 1)) * 70;
  card.innerHTML = `<div class="h">${esc(ITEM_META[item.item_id]?.short || item.name)} price, next ${bars.length - 1} months<span>${isNum(item.prob_up_6m) ? Math.round(item.prob_up_6m * 100) + '% chance of rising' : ''}</span></div>
    <div class="cols">${bars.map((b, i) => `<div class="c ${b.now ? 'now' : ''} ${i === hl ? 'hl' : ''}"><b>${money(b.v)}</b><i data-h="${H(b.v)}"></i><span>${monthLabel(b.m)}</span></div>`).join('')}</div>`;
  card.querySelectorAll('.cols i').forEach((el, i) => setTimeout(() => (el.style.height = el.dataset.h + '%'), 60 + i * 60));
  return card;
}

function sources(mod, item, focus) {
  if (!mod) return '';
  const out = [];
  const regs = mod.regions || [];
  const reg = regs.find(r => r.region_id === focus.region_id) || regs[0];
  if (reg) out.push(`<span><i data-lucide="satellite"></i>Sentinel-2 · ${esc((reg.name || '').split(',')[0].replace(/ \(.*?\)/, ''))}</span>`);
  const n = mod.signals?.n_headlines;
  if (isNum(n)) out.push(`<span><i data-lucide="newspaper"></i>${fmt(n)} headlines</span>`);
  if (item?.model) out.push(`<span><i data-lucide="chart-line"></i>${esc(item.model.split(' on ')[0])} forecast</span>`);
  return out.length ? `<div class="srcs">${out.join('')}</div>` : '';
}

function wireMic(btn, input, onFinal) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.title = 'Voice input not supported in this browser'; btn.style.opacity = .5; return; }
  let rec = null;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'en-GB'; rec.interimResults = true;
    btn.classList.add('rec');
    rec.onresult = e => { const r = e.results[e.results.length - 1]; input.value = r[0].transcript; if (r.isFinal) { onFinal(input.value); input.value = ''; } };
    rec.onend = rec.onerror = () => { btn.classList.remove('rec'); rec = null; };
    rec.start();
  });
}
