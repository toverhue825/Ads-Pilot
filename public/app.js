const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = {
  money: (n) => (n == null ? '–' : `$${n.toLocaleString(undefined, { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`),
  int: (n) => (n == null ? '–' : Math.round(n).toLocaleString()),
  pct: (n) => (n == null ? '–' : `${(n * 100).toFixed(2)}%`),
  x: (n) => (n == null ? '–' : `${n.toFixed(1)}×`),
};
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};

let me = null;
let days = 7;
let target = { cpl: 45, blended: false, dailyCap: 0 };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let account = store.get('account') ?? ''; // '' = all brands
const acctById = () => new Map(me.accounts.map((a) => [a.id, a]));
const acctQS = () => (account ? `&account=${encodeURIComponent(account)}` : '');

// ---------- KPI tiles ----------
// better: which direction is good. null = neutral (spend is a choice, not a score).
const KPIS = [
  { key: 'leads', label: 'Leads', f: fmt.int, better: 'up', tip: 'Inquiries from your ads (lead forms + website leads).' },
  { key: 'cpl', label: 'Cost per lead', f: fmt.money, better: 'down', tip: 'Spend ÷ leads. The number to watch.' },
  { key: 'spend', label: 'Spend', f: fmt.money, better: null, tip: 'Total ad spend in the period.' },
  { key: 'cvr', label: 'Click → lead rate', f: fmt.pct, better: 'up', tip: 'Share of clicks that became a lead. Low = landing page or form problem.' },
  { key: 'ctr', label: 'Click-through rate', f: fmt.pct, better: 'up', tip: 'Share of people who saw an ad and clicked. Low = ad or audience problem.' },
  { key: 'cpc', label: 'Cost per click', f: fmt.money, better: 'down', tip: 'Spend ÷ clicks.' },
  { key: 'cpm', label: 'Cost per 1,000 views', f: fmt.money, better: 'down', tip: 'CPM: what Facebook charges to show your ads 1,000 times.' },
  { key: 'frequency', label: 'Frequency', f: fmt.x, better: 'down', tip: 'Average times each person saw your ads per day. Above ~3.5 people get tired of them.' },
];

function renderKpis(cur, prev) {
  $('#kpis').innerHTML = KPIS.map((k) => {
    const a = cur[k.key], b = prev[k.key];
    let delta = '<div class="delta">No earlier data</div>';
    if (a != null && b) {
      const ch = (a - b) / b;
      const cls = k.better == null || Math.abs(ch) < 0.005 ? '' : (ch > 0) === (k.better === 'up') ? 'good' : 'bad';
      delta = `<div class="delta ${cls}">${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(1)}% vs previous ${days} days</div>`;
    }
    let extra = '';
    if (k.key === 'cpl' && a != null) {
      const ratio = a / target.cpl;
      const color = ratio <= 1 ? 'var(--good)' : ratio <= 1.3 ? 'var(--warn)' : 'var(--crit)';
      const word = ratio <= 1 ? '✓ On target' : ratio <= 1.3 ? '▲ A bit high' : '● Over target';
      extra = `<div class="meter"><span style="width:${Math.min(100, (1 / Math.max(ratio, 0.01)) * 100)}%;background:${color}"></span></div>
        <div class="target">${word} · ${target.blended ? 'blended target' : 'target'} ${fmt.money(target.cpl)}</div>`;
    }
    return `<div class="kpi ${k.key === 'cpl' || k.key === 'leads' ? 'feature' : ''}">
      <div class="label">${k.label} <span class="help" title="${esc(k.tip)}">?</span></div>
      <div class="value">${k.f(a)}</div>${delta}${extra}</div>`;
  }).join('');
}

// ---------- Charts (hand-rolled SVG: one series each, hover tooltips) ----------
// Drawn at the container's real pixel width (no stretching), redrawn on resize.
let W = 520, H = 220;
const M = { t: 14, r: 12, b: 26, l: 44 };
const sizeTo = (el, height = 220) => { W = Math.max(260, Math.round(el.clientWidth)); H = height; };
const niceMax = (v) => { if (!v) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / 0.5) * 0.5 * p; };
const shortDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function frame(max, f) {
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / max);
  return {
    y,
    svg: ticks.map((t) => `<line class="${t ? 'gridline' : 'baseline'}" x1="${M.l}" x2="${W - M.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="tick" x="${M.l - 8}" y="${y(t) + 4}" text-anchor="end">${f(t)}</text>`).join(''),
  };
}
function xLabels(rows, x) {
  const every = Math.ceil(rows.length / 6);
  return rows.map((r, i) => (i % every === 0 || i === rows.length - 1) && !(i !== rows.length - 1 && rows.length - 1 - i < every / 2)
    ? `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${shortDate(r.date)}</text>` : '').join('');
}
function attachHover(el, rows, x, step, html) {
  const tip = document.createElement('div'); tip.className = 'tooltip'; el.appendChild(tip);
  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const cw = W, ch = H; // this chart's size (W/H change as other charts draw)
  svg.querySelectorAll('.hit').forEach((h) => {
    const i = Number(h.dataset.i);
    h.addEventListener('mouseenter', () => {
      const box = svg.getBoundingClientRect(), sx = box.width / cw, sy = box.height / ch;
      tip.innerHTML = html(rows[i]);
      tip.style.left = `${x(i) * sx}px`; tip.style.top = `${Number(h.dataset.top) * sy}px`; tip.style.opacity = 1;
      if (cross) { cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.style.opacity = 1; }
    });
    h.addEventListener('mouseleave', () => { tip.style.opacity = 0; if (cross) cross.style.opacity = 0; });
  });
}

function barChart(el, rows) {
  sizeTo(el);
  const n = rows.length, inner = W - M.l - M.r, step = inner / n;
  const x = (i) => M.l + step * (i + 0.5);
  const max = niceMax(Math.max(...rows.map((r) => r.leads), 4)); // at least 0–4 so the scale reads cleanly
  const { y, svg } = frame(max, (v) => fmt.int(v));
  const bw = Math.max(3, Math.min(22, step - 2));
  const bars = rows.map((r, i) => {
    const top = y(r.leads), h = y(0) - top, rad = Math.min(4, h / 2, bw / 2);
    const x0 = x(i) - bw / 2;
    // Rounded top, square at the baseline.
    const d = h <= 0 ? '' : `M${x0},${y(0)}V${top + rad}Q${x0},${top} ${x0 + rad},${top}H${x0 + bw - rad}Q${x0 + bw},${top} ${x0 + bw},${top + rad}V${y(0)}Z`;
    return `<path d="${d}" fill="var(--series-1)"/>`;
  }).join('');
  const hits = rows.map((r, i) => `<rect class="hit" data-i="${i}" data-top="${y(r.leads)}" x="${x(i) - step / 2}" y="${M.t}" width="${step}" height="${H - M.t - M.b}"/>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Leads per day">${svg}${bars}${xLabels(rows, x)}${hits}</svg>`;
  attachHover(el, rows, x, step, (r) => `${shortDate(r.date)}<br><b>${fmt.int(r.leads)} leads</b> · ${fmt.money(r.spend)} spent`);
}

// One metric over time. opts: key, label, tick (axis format), tip (tooltip html), target (dashed line),
// floor (smallest top of scale), height, area (soft fill under the line).
function lineChart(el, rows, opts) {
  const { key, label, tick, tip, target, floor = 0, height = 220, area = false } = opts;
  sizeTo(el, height);
  const n = rows.length, inner = W - M.l - M.r, step = inner / Math.max(1, n - 1);
  const x = (i) => M.l + step * i;
  const vals = rows.map((r) => r[key]).filter((v) => v != null);
  const max = niceMax(Math.max(floor, target ? target * 1.25 : 0, ...vals));
  const { y, svg } = frame(max, tick);
  // Line breaks where a day has no value (e.g. no leads → no cost per lead).
  let d = '', fill = '', pen = false, segStart = 0;
  rows.forEach((r, i) => {
    const v = r[key];
    if (v == null) { if (pen && area) fill += `L${x(i - 1)},${y(0)}L${x(segStart)},${y(0)}Z`; pen = false; return; }
    if (!pen) segStart = i;
    d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
    if (area) fill += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
    pen = true;
  });
  if (pen && area) fill += `L${x(n - 1)},${y(0)}L${x(segStart)},${y(0)}Z`;
  const last = [...rows].reverse().find((r) => r[key] != null);
  const li = rows.lastIndexOf(last);
  const ref = target ? `<line class="ref" x1="${M.l}" x2="${W - M.r}" y1="${y(target)}" y2="${y(target)}"/>
    <text class="ref-label" x="${W - M.r}" y="${y(target) - 6}" text-anchor="end">Target ${fmt.money(target)}</text>` : '';
  const hits = rows.map((r, i) => `<rect class="hit" data-i="${i}" data-top="${r[key] == null ? y(0) : y(r[key])}" x="${x(i) - step / 2}" y="${M.t}" width="${step}" height="${H - M.t - M.b}"/>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} by day" style="height:${H}px">${svg}
    ${area && fill ? `<path d="${fill}" fill="var(--series-1)" opacity="0.10"/>` : ''}${ref}
    <line class="cross" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" style="opacity:0"/>
    <path d="${d}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${last ? `<circle cx="${x(li)}" cy="${y(last[key])}" r="4.5" fill="var(--series-1)" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
    ${xLabels(rows, x)}${hits}</svg>`;
  attachHover(el, rows, x, step, tip);
}

// Small trend charts: one metric each, so every chart keeps a single honest axis.
const shortMoney = (v) => (v === 0 ? '$0' : v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const shortPct = (v) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const TRENDS = [
  { key: 'spend', label: 'Spend per day', tick: shortMoney, val: fmt.money, help: 'What Facebook charged each day.' },
  { key: 'cvr', label: 'Click → lead rate', tick: shortPct, val: fmt.pct, help: 'Share of clicks that became a lead. Drops point to the form or landing page.' },
  { key: 'ctr', label: 'Click-through rate', tick: shortPct, val: fmt.pct, help: 'Share of people who clicked. Drops point to tired ads or the wrong audience.' },
  { key: 'cpc', label: 'Cost per click', tick: shortMoney, val: fmt.money, help: 'Spend ÷ clicks.' },
  { key: 'cpm', label: 'Cost per 1,000 views', tick: shortMoney, val: fmt.money, help: 'Rising CPM means competition for your audience is up.' },
  { key: 'frequency', label: 'Frequency', tick: (v) => `${v.toFixed(1)}×`, val: fmt.x, help: 'Times each person saw your ads per day. Above ~3.5 people tune out.', floor: 1 },
];
function drawTrends(rows) {
  const grid = $('#trends');
  if (!grid.children.length) {
    grid.innerHTML = TRENDS.map((t) => `<div class="card trend"><div class="card-head"><h2>${t.label}
      <span class="help" title="${esc(t.help)}">?</span></h2><span class="sub" data-latest="${t.key}"></span></div>
      <div class="chart" data-trend="${t.key}"></div></div>`).join('');
  }
  for (const t of TRENDS) {
    const latest = [...rows].reverse().find((r) => r[t.key] != null);
    grid.querySelector(`[data-latest="${t.key}"]`).textContent = latest ? `Latest ${t.val(latest[t.key])}` : '';
    lineChart(grid.querySelector(`[data-trend="${t.key}"]`), rows, {
      key: t.key, label: t.label, tick: t.tick, floor: t.floor ?? 0, height: 160, area: true,
      tip: (r) => `${shortDate(r.date)}<br><b>${r[t.key] == null ? 'No data' : t.val(r[t.key])}</b>`,
    });
  }
}

// ---------- Campaign table ----------
function cplChip(c) {
  if (c.status !== 'ACTIVE') return '<span class="chip chip-paused">❚❚ Paused</span>';
  if (c.cpl == null) return c.spend > 0 ? '<span class="chip chip-critical">● No leads</span>' : '<span class="chip chip-paused">No data</span>';
  const r = c.cpl / (acctById().get(c.account_id)?.target_cpl ?? target.cpl);
  return r <= 1 ? '<span class="chip chip-good">✓ On target</span>' : r <= 1.3 ? '<span class="chip chip-warning">▲ A bit high</span>' : '<span class="chip chip-critical">● Over target</span>';
}
function renderCampaigns(rows) {
  const active = rows.filter((c) => c.status === 'ACTIVE');
  const budget = active.reduce((s, c) => s + (c.daily_budget ?? 0), 0);
  $('#campSub').textContent = `${active.length} active · ${fmt.money(budget)}/day of ${fmt.money(target.dailyCap)} cap`;
  const showBrand = !account && me.accounts.length > 1;
  const names = acctById();
  if (!rows.length) {
    $('#campaigns').innerHTML = `<tbody><tr><td class="empty" style="white-space:normal">
      <div class="big">🚀</div><b>No campaigns yet</b>
      <p class="muted">Create a campaign in Ads Manager under this ad account. It will show up here within an hour of launching.</p></td></tr></tbody>`;
    return;
  }
  $('#campaigns').innerHTML = `<thead><tr><th>Campaign</th><th>Health</th><th class="num">Budget/day</th><th class="num">Spend</th>
    <th class="num">Leads</th><th class="num">Cost/lead</th><th class="num">CTR</th><th class="num">Click→lead</th><th class="num">Freq.</th></tr></thead>
    <tbody>${rows.map((c) => `<tr>
      <td class="name">${esc(c.name)}${showBrand ? `<div class="brand-tag" style="margin:2px 0 0">${esc(names.get(c.account_id)?.name)}</div>` : ''}</td><td>${cplChip(c)}</td>
      <td class="num">${c.daily_budget == null ? '<span class="muted" title="Lifetime budget or none: budget suggestions skipped">–</span>'
        : c.budget_level === 'adsets' ? `${fmt.money(c.daily_budget)}<div class="brand-tag" title="Total of this campaign's ad set budgets">across ad sets</div>` : fmt.money(c.daily_budget)}</td>
      <td class="num">${fmt.money(c.spend)}</td><td class="num">${fmt.int(c.leads)}</td><td class="num"><b>${fmt.money(c.cpl)}</b></td>
      <td class="num">${fmt.pct(c.ctr)}</td><td class="num">${fmt.pct(c.cvr)}</td><td class="num">${fmt.x(c.frequency)}</td>
    </tr>`).join('')}</tbody>`;
}

// ---------- Suggestions ----------
const CHIP = { critical: '● Urgent', warning: '▲ Worth a look', good: '✓ Opportunity' };
async function loadSuggestions() {
  const list = await api(`/api/suggestions?x=1${acctQS()}`);
  const showBrand = !account && me.accounts.length > 1;
  $('#sugCount').textContent = list.length ? `${list.length} waiting` : '';
  $('#suggestions').innerHTML = list.length ? list.map((s) => `
    <div class="suggestion" data-id="${s.id}">
      <span class="chip chip-${s.severity}">${CHIP[s.severity]}</span>${showBrand ? `<span class="brand-tag">${esc(s.account_name)}</span>` : ''}
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.reason)}</p>
      <div class="row">
        <button class="btn btn-primary" data-act="approve">${s.action.kind === 'manual' ? 'Mark done' : 'Approve'}</button>
        <button class="btn btn-ghost" data-act="dismiss">Dismiss</button>
      </div>
    </div>`).join('')
    : `<div class="empty"><div class="big">🎉</div><b>All caught up</b><p class="muted">No suggestions right now. Check back after the next sync.</p></div>`;
}
$('#suggestions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const card = btn.closest('.suggestion');
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  const r = await api(`/api/suggestions/${card.dataset.id}/${btn.dataset.act}`, { method: 'POST' });
  toast(r.message);
  if (r.ok) { card.classList.add('leaving'); setTimeout(refresh, 220); } else card.querySelectorAll('button').forEach((b) => (b.disabled = false));
});

async function loadActivity() {
  const rows = await api('/api/activity');
  $('#activity').innerHTML = rows.length ? rows.map((a) => `<li><span class="when">${ago(a.ts)}</span><span><span class="who">${esc(a.actor)}</span> · ${esc(a.message)}</span></li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
}

// ---------- Page ----------
let lastDaily = [];
const drawCharts = () => {
  barChart($('#leadsChart'), lastDaily);
  lineChart($('#cplChart'), lastDaily, {
    key: 'cpl', label: 'Cost per lead', target: target.cpl, tick: (v) => `$${Math.round(v)}`,
    tip: (r) => `${shortDate(r.date)}<br><b>${r.cpl == null ? 'No leads' : fmt.money(r.cpl) + ' per lead'}</b> · ${fmt.int(r.leads)} leads`,
  });
  drawTrends(lastDaily);
};
let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => lastDaily.length && drawCharts(), 120); });

async function loadOverview() {
  const o = await api(`/api/overview?days=${days}${acctQS()}`);
  target = o.target;
  renderKpis(o.totals, o.previous);
  lastDaily = o.daily;
  drawCharts();
  $('#leadsSub').textContent = `${fmt.int(o.totals.leads)} total`;
  renderCampaigns(o.campaigns);
  const t = o.totals, onTarget = t.cpl != null && t.cpl <= target.cpl;
  if (!t.spend && !o.previous.spend) {
    $('#headline').textContent = me.accounts.length
      ? 'Waiting for your first campaign to spend. Numbers appear within an hour of launch.'
      : 'Waiting for the first sync with Facebook.';
    return;
  }
  $('#headline').textContent =`${fmt.int(t.leads)} leads at ${fmt.money(t.cpl)} each over the last ${days} days. ${onTarget ? 'Nicely under your target.' : `That's above your ${fmt.money(target.cpl)} target.`}`;
}

// ---------- AI review ----------
let aiBusy = false;
function aiHead(sub, button) {
  return `<div class="ai-head"><span class="ai-badge" aria-hidden="true">✦</span>
    <div><h2>AI review</h2><div class="sub">${sub}</div></div><span class="spacer"></span>${button ?? ''}</div>`;
}
const scope = () => (account ? acctById().get(account)?.name ?? 'this brand' : me.accounts.length > 1 ? 'all brands' : 'your ads');
function renderInsight(state) {
  const el = $('#aiCard');
  if (!state.enabled) {
    el.innerHTML = aiHead('Plain-English weekly review and new ad copy, written by Claude')
      + `<div class="ai-empty"><p>Turn this on by adding an Anthropic API key (<code>ANTHROPIC_API_KEY</code>) to the settings file. A review costs a few cents.</p></div>`;
    return;
  }
  const genBtn = (label) => `<button class="btn btn-ai" id="aiGen" ${aiBusy ? 'disabled' : ''}>${aiBusy ? '<span class="dots">Writing</span>' : label}</button>`;
  const ins = state.insight;
  if (!ins) {
    el.innerHTML = aiHead(`Nothing written yet for ${esc(scope())}`, '')
      + `<div class="ai-empty"><p>Claude reads the last 7 days against the week before and your targets, then writes what's working, what isn't, what to do this week, and new ad copy to test. It takes about a minute.</p>${genBtn('✦ Write this week’s review')}</div>`;
    return;
  }
  const c = ins.content;
  const list = (items) => items.length ? items.map((t) => `<li>${esc(t)}</li>`).join('') : '<li class="muted">Nothing stood out.</li>';
  el.innerHTML = aiHead(`Week of ${shortDate(ins.period_start)} – ${shortDate(ins.period_end)} · ${esc(scope())}`, genBtn('↻ Rewrite'))
    + `<div class="ai-headline">${esc(c.headline)}</div><p class="ai-summary">${esc(c.summary)}</p>
    <div class="ai-grid">
      <div class="ai-box"><h3 class="good-ink">✓ Working</h3><ul>${list(c.wins)}</ul></div>
      <div class="ai-box"><h3 class="crit-ink">▲ Needs attention</h3><ul>${list(c.concerns)}</ul></div>
      <div class="ai-box"><h3>→ Do this week</h3><ol>${c.actions.map((a) => `<li><b>${esc(a.title)}</b><span class="camp">${esc(a.campaign)}</span>${esc(a.why)}</li>`).join('')}</ol></div>
    </div>
    ${c.copy_ideas.length ? `<h3 style="font-size:14px;margin-top:20px">New ad copy to test</h3>
      <div class="copy-ideas">${c.copy_ideas.map((x, i) => `
        <div class="ad-mock"><span class="angle">${esc(x.angle)}</span>
          <div class="primary">${esc(x.primary_text)}</div><div class="hl">${esc(x.headline)}</div>
          <div class="foot"><span>${esc(x.campaign)}</span><button class="btn btn-ghost" data-copy="${i}">Copy</button></div></div>`).join('')}</div>` : ''}
    <div class="ai-foot">Written ${ago(ins.created_at)} by ${esc(ins.created_by)}. Advice only: nothing changes in Facebook unless you do it. Double-check claims and offers before running new copy.</div>`;
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const x = c.copy_ideas[Number(b.dataset.copy)];
    try { await navigator.clipboard.writeText(`${x.primary_text}\n\nHeadline: ${x.headline}`); b.textContent = 'Copied ✓'; }
    catch { b.textContent = 'Select & copy'; }
  }));
}
let lastInsightState = null;
let localGen = false; // a review this browser asked for is still being written
async function loadInsight() {
  const state = await api(`/api/insight?x=1${acctQS()}`);
  aiBusy = localGen || state.generating;
  lastInsightState = state;
  renderInsight(state);
}
$('#aiCard').addEventListener('click', async (e) => {
  if (e.target.closest('#aiGen') == null || aiBusy) return;
  aiBusy = localGen = true;
  const forAccount = account;
  if (lastInsightState) renderInsight(lastInsightState); // show "Writing…" right away
  const r = await api('/api/insight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: forAccount || null }) });
  aiBusy = localGen = false;
  if (!r.ok) toast(r.error);
  if (forAccount === account) loadInsight();
  loadActivity();
});

// ---------- Ad Studio ----------
const CTA_LABEL = { GET_QUOTE: 'Get quote', LEARN_MORE: 'Learn more', CONTACT_US: 'Contact us', SIGN_UP: 'Sign up', GET_OFFER: 'Get offer', CALL_NOW: 'Call now', SHOP_NOW: 'Shop now', APPLY_NOW: 'Apply now' };
let shots = []; // [{type, data, url}]
let studioPoll = null;
const studioAccount = () => account || (me.accounts.length === 1 ? me.accounts[0].id : '');

// Shrink screenshots in the browser before upload (max 1600px, JPEG).
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
      resolve({ type: 'image/jpeg', data: url.split(',')[1], url });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
function renderThumbs() {
  $('#thumbs').innerHTML = shots.map((s, i) => `<figure><img src="${s.url}" alt="Competitor ad screenshot ${i + 1}"><button type="button" data-rm="${i}" aria-label="Remove">✕</button></figure>`).join('');
}
$('#shots').addEventListener('change', async (e) => {
  for (const f of [...e.target.files].slice(0, 4 - shots.length)) { try { shots.push(await shrink(f)); } catch { toast(`Couldn't read ${f.name}`); } }
  e.target.value = '';
  renderThumbs();
});
$('#thumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { shots.splice(Number(b.dataset.rm), 1); renderThumbs(); } });

function charCount(text, limit) {
  const n = [...(text ?? '')].length;
  return `<span class="chars ${n > limit ? 'over' : ''}">${n}/${limit}</span>`;
}
function renderPlan(p) {
  const out = $('#studioOut');
  if (!p) { out.innerHTML = ''; return; }
  if (p.status === 'running') {
    const secs = Math.round((Date.now() - new Date(p.created_at)) / 1000);
    out.innerHTML = `<div class="progress"><b>Researching ${esc(p.request.competitors.join(', '))}…</b>
      <div class="muted small">Searching the web, reading their sites${p.request.images ? ' and your screenshots' : ''}, then writing ${p.request.count} ads. ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} so far.</div>
      <div class="bar"><span></span></div></div>`;
    return;
  }
  if (p.status === 'failed') { out.innerHTML = `<div class="progress"><b class="crit-ink">That didn't work.</b><p class="muted">${esc(p.error)}</p></div>`; return; }
  const r = p.result;
  const brand = acctById().get(p.account_id)?.name ?? 'Your brand';
  const list = (a) => (a?.length ? a.map(esc).join('; ') : '–');
  out.innerHTML = `<div class="plan">
    <p class="ai-summary">${esc(r.summary)}</p>
    <h3>New ads to test</h3>
    <div class="fb-ads">${r.ads.map((a, i) => `
      <article class="fb-ad" data-ad="${i}">
        <div class="angle">${esc(a.angle)}</div>
        <div class="who"><span class="av">${esc(brand[0])}</span><div>${esc(brand)}<small>Sponsored</small></div></div>
        <div class="ptext" contenteditable="true" data-f="primary_text" aria-label="Primary text">${esc(a.primary_text)}</div>
        <div class="img"><div><b>Image idea</b>${esc(a.image_idea)}</div></div>
        <div class="bar"><div><div class="hl" contenteditable="true" data-f="headline" aria-label="Headline">${esc(a.headline)}</div>
          <div class="desc" contenteditable="true" data-f="description" aria-label="Description">${esc(a.description)}</div></div>
          <span class="cta">${esc(CTA_LABEL[a.cta] ?? a.cta)}</span></div>
        <div class="meta"><b>Why it wins:</b> ${esc(a.why_it_wins)}<br><b>Audience:</b> ${esc(a.audience)}<br>
          ${a.long_text ? `<details style="margin:6px 0"><summary>Longer version to test</summary><div contenteditable="true" data-f="long_text" style="white-space:pre-line;margin-top:4px">${esc(a.long_text)}</div></details>` : ''}
          Primary text ${charCount(a.primary_text, 125)} · Headline ${charCount(a.headline, 40)} · Description ${charCount(a.description, 30)}</div>
        <div class="tools"><button class="btn btn-ghost" type="button" data-copyad="${i}">Copy ad</button></div>
      </article>`).join('')}</div>
    <p class="muted small">Click any text to edit it before copying. Text in [brackets] is for you to fill in; Claude doesn't invent prices or guarantees.</p>
    <h3>What competitors are doing</h3>
    <div class="comp-grid">${r.competitors.map((c) => `
      <div class="comp-card"><h4>${esc(c.name)}</h4><p class="pos">${esc(c.positioning)}</p>
        <dl><dt>Offers</dt><dd>${list(c.offers)}</dd><dt>Strong at</dt><dd>${list(c.strengths)}</dd><dt>Weak spots</dt><dd>${list(c.weaknesses)}</dd></dl></div>`).join('')}</div>
    <h3>Openings for you</h3>
    <ol class="ai-box" style="padding:14px 16px 14px 34px;margin:0">${r.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ol>
    ${r.sources?.length ? `<h3>Sources</h3><ul class="sources">${r.sources.slice(0, 15).map((s) => `<li><a href="${esc(/^https?:\/\//.test(s.url) ? s.url : '#')}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join('')}</ul>` : ''}
    <div class="ai-foot">Written ${ago(p.created_at)} by ${esc(p.created_by)}. Competitor details come from public web pages and may be out of date; double-check before relying on them.</div>
  </div>`;
}
$('#studioOut').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copyad]'); if (!b) return;
  const card = b.closest('.fb-ad');
  const get = (f) => card.querySelector(`[data-f="${f}"]`).innerText.trim();
  const long = card.querySelector('[data-f="long_text"]');
  const text = `${get('primary_text')}\n\nHeadline: ${get('headline')}\nDescription: ${get('description')}\nButton: ${card.querySelector('.cta').textContent}`
    + (long ? `\n\nLonger version:\n${long.innerText.trim()}` : '');
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓'; } catch { b.textContent = 'Select & copy'; }
});

async function loadStudio(selectId) {
  const acct = studioAccount();
  const s = await api(`/api/studio?x=1${acct ? `&account=${encodeURIComponent(acct)}` : ''}`);
  const form = $('#studioForm');
  form.querySelector('#studioGo').disabled = !s.enabled || !acct;
  $('#studioNote').textContent = !s.enabled ? 'Turn on AI (ANTHROPIC_API_KEY) to use the Ad Studio.'
    : !acct ? 'Pick a brand at the top first.' : 'Takes 2–4 minutes and about $1 in Claude usage. You can keep using the dashboard meanwhile.';
  if (!form.elements.competitors.value) form.elements.competitors.value = s.competitors || '';
  const hist = $('#planHistory');
  hist.hidden = s.plans.length < 2;
  hist.innerHTML = s.plans.map((p) => `<option value="${p.id}">${new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${esc(p.request.competitors.slice(0, 2).join(', '))}${p.request.competitors.length > 2 ? '…' : ''} · ${p.status}</option>`).join('');
  const show = s.plans.find((p) => p.id === selectId) ?? s.plans[0];
  if (show) hist.value = show.id;
  renderPlan(show);
  clearTimeout(studioPoll);
  if (show?.status === 'running') studioPoll = setTimeout(() => loadStudio(show.id), 5000);
}
$('#planHistory').addEventListener('change', (e) => loadStudio(Number(e.target.value)));
$('#studioForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, btn = $('#studioGo');
  btn.disabled = true;
  const body = {
    account: studioAccount(), competitors: f.elements.competitors.value, offer: f.elements.offer.value,
    destination: f.elements.destination.value, audience: f.elements.audience.value, count: f.elements.count.value,
    pasted: f.elements.pasted.value, images: shots.map(({ type, data }) => ({ type, data })),
  };
  const r = await api('/api/studio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  btn.disabled = false;
  if (!r.ok) { toast(r.error); return; }
  toast('Researching your competitors. This takes a few minutes.');
  loadStudio(r.id);
});

// ---------- Connection problems ----------
async function loadHealth() {
  const { problems } = await api('/api/health');
  const el = $('#health');
  el.hidden = !problems.length;
  el.innerHTML = problems.map((p) => `
    <div class="health-item"><span class="icon" aria-hidden="true">!</span>
      <div><b>${esc(p.label)}: needs attention</b>${p.since ? ` <span class="muted" style="font-size:12px">since ${esc(ago(p.since))}</span>` : ''}
        <p>${esc(p.msg)}</p><p class="fix">How to fix: ${esc(p.fix)}</p></div></div>`).join('');
}

function renderAccountPicker() {
  if (account && !me.accounts.some((a) => a.id === account)) account = '';
  const sel = $('#accountSel');
  sel.innerHTML = (me.accounts.length > 1 ? `<option value="">All brands</option>` : '')
    + me.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (me.accounts.length === 1) account = me.accounts[0].id;
  sel.value = account;
  sel.closest('.brand-pick').hidden = me.accounts.length === 0;
}
$('#accountSel').addEventListener('change', (e) => {
  account = e.target.value; store.set('account', account);
  loadOverview(); loadSuggestions(); loadInsight();
  $('#studioForm').elements.competitors.value = ''; loadStudio();
});

// ---------- Targets & limits ----------
const LIMIT_FIELDS = [
  { key: 'target_cpl', label: 'Target cost per lead', pre: '$', step: '1', help: 'What a lead is worth paying.' },
  { key: 'daily_cap', label: 'Daily spend cap', pre: '$', step: '10', help: 'Budget increases never push this brand above it.' },
  { key: 'max_change_pct', label: 'Max budget move', post: '%', step: '1', help: 'Biggest change one suggestion can make (5–50).' },
  { key: 'min_spend', label: 'Judge after', pre: '$', step: '10', help: 'Spend needed in 7 days before a campaign is judged.' },
];
function renderLimits() {
  const list = account ? me.accounts.filter((a) => a.id === account) : me.accounts;
  $('#limitsBody').innerHTML = list.map((a) => `
    <form class="acct-form" data-id="${esc(a.id)}">
      <h3><span>${esc(a.name)}</span>
        <label class="switch"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''}> Suggestions on</label></h3>
      <div class="fields">${LIMIT_FIELDS.map((f) => `
        <label class="field"><span>${f.label}</span>
          <div class="input-wrap">${f.pre ? `<span class="unit pre">${f.pre}</span>` : ''}
            <input type="number" min="0" step="${f.step}" name="${f.key}" value="${a[f.key]}" required class="${f.pre ? 'has-pre' : ''} ${f.post ? 'has-post' : ''}">
            ${f.post ? `<span class="unit post">${f.post}</span>` : ''}</div>
          <small>${f.help}</small></label>`).join('')}
      </div>
      <label class="field" style="margin-top:12px"><span>What this brand sells, to whom, and its website</span>
        <textarea name="context" maxlength="1500" placeholder="e.g. Steel buildings for farms, shops and garages in the Midwest. Customers are farmers and small business owners. We offer free quotes and fast delivery.">${esc(a.context ?? '')}</textarea>
        <small>Helps the AI review write ad copy that fits. Don't include anything you wouldn't put in an ad.</small></label>
      <div class="actions"><span class="muted" data-status style="font-size:13px"></span><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`).join('');
}
$('#limitsBtn').addEventListener('click', () => { renderLimits(); $('#limits').showModal(); });
$('#limitsBody').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = form.querySelector('button[type=submit]'), status = form.querySelector('[data-status]');
  const body = Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, Number(form.elements[f.key].value)]));
  body.enabled = form.elements.enabled.checked;
  body.context = form.elements.context.value;
  btn.disabled = true; status.textContent = 'Saving…';
  const r = await api(`/api/accounts/${encodeURIComponent(form.dataset.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  btn.disabled = false;
  if (!r.ok) { status.textContent = r.error; return; }
  status.textContent = r.changed ? `Saved ✓ ${r.created} suggestion${r.created === 1 ? '' : 's'} updated` : 'No changes';
  me = await api('/api/me');
  await Promise.all([loadOverview(), loadSuggestions(), loadActivity()]);
});

async function refresh() {
  me = await api('/api/me');
  const h = new Date().getHours();
  $('#greeting').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}, ${me.name} 👋`;
  $('#source').textContent = me.dataSource === 'meta' ? '● Live Facebook data' : '◌ Sample data';
  $('#synced').textContent = `Synced ${ago(me.lastSync)}`;
  renderAccountPicker();
  await Promise.all([loadOverview(), loadSuggestions(), loadActivity(), loadInsight(), loadHealth(), loadStudio()]);
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  days = Number(b.dataset.days);
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadOverview();
}));
$('#syncBtn').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = '↻ Syncing…';
  const r = await api('/api/sync', { method: 'POST' });
  toast(r.ok ? `Synced. ${r.created} new suggestion${r.created === 1 ? '' : 's'}.` : `Sync failed: ${r.error}`);
  e.target.disabled = false; e.target.textContent = '↻ Sync now';
  refresh();
});
$('#emailBtn').addEventListener('click', async () => {
  const btn = $('#emailBtn'); btn.disabled = true; btn.textContent = 'Sending…';
  const r = await api('/api/email/send', { method: 'POST' });
  btn.disabled = false; btn.textContent = 'Send email now';
  toast(r.sent ? `Email sent to ${r.to} ✓` : r.reason);
  loadActivity();
});

refresh();
