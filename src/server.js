import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, now, audit, getMeta, setMeta } from './db.js';
import { syncAll, applyAction } from './sync.js';
import { runEngine, refreshAccountSuggestions } from './engine.js';
import { buildDigest, sendDigest, sendAlert } from './email.js';
import { recordOk, recordFail, problems, setNotifier } from './health.js';
import { sign, verify } from './tokens.js';
import { aiEnabled, generateInsight, latestInsight } from './ai.js';
import { windows, accountTotals, campaignTotals, daily } from './metrics.js';

const app = express();
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

app.set('trust proxy', 1); // behind Render's proxy: use the real visitor IP
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); // keeps approval links out of other sites' logs
  if (config.baseUrl.startsWith('https')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));

app.get('/healthz', (_req, res) => res.send('ok')); // for the host's uptime check

// Slow down password guessing: 10 wrong tries per IP per 15 minutes.
const failures = new Map();
const tooMany = (ip) => {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60e3) { failures.delete(ip); return false; }
  return f.count >= 10;
};
const recordFailure = (ip) => {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60e3) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
};

// ---------- Login (shared team password + your name, so the log shows who approved what) ----------
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((c) => {
  const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
}));
const user = (req) => verify(cookies(req).session)?.name ?? null;

app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.post('/login', (req, res) => {
  if (tooMany(req.ip)) return res.redirect('/login?error=locked');
  const pw = String(req.body.password ?? '');
  const name = String(req.body.name ?? '').trim().slice(0, 60);
  const ok = name && pw.length === config.dashboardPassword.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(config.dashboardPassword));
  if (!ok) { recordFailure(req.ip); return res.redirect('/login?error=1'); }
  failures.delete(req.ip);
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(sign({ name }, 30 * 864e5))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
  res.redirect('/');
});
app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

// ---------- One-click email review (token in the link is the authorization) ----------
function reviewPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"></head>
  <body class="review-body"><main class="review-card">${body}</main></body></html>`;
}

app.get('/review/:token', (req, res) => {
  const t = verify(req.params.token);
  if (!t) return res.status(410).send(reviewPage('Link expired', `<h1>This link has expired</h1><p>Open the <a href="/">dashboard</a> to see current suggestions.</p>`));
  const s = db.prepare('SELECT s.*, c.name AS campaign_name FROM suggestions s JOIN campaigns c ON c.id = s.campaign_id WHERE s.id = ?').get(t.sid);
  if (!s) return res.status(404).send(reviewPage('Not found', '<h1>Suggestion not found</h1>'));
  if (s.status !== 'pending') {
    return res.send(reviewPage('Already handled', `<h1>Already handled</h1><p>“${esc(s.title)}” was <b>${esc(s.status)}</b>${s.decided_by ? ` by ${esc(s.decided_by)}` : ''}.</p><p><a href="/">Open the dashboard</a></p>`));
  }
  const approve = t.decision === 'approve';
  const manual = JSON.parse(s.action).kind === 'manual';
  res.send(reviewPage(s.title, `
    <span class="chip chip-${esc(s.severity)}">${esc(s.severity === 'good' ? '✓ Opportunity' : s.severity === 'critical' ? '● Urgent' : '▲ Worth a look')}</span>
    <h1>${esc(s.title)}</h1>
    <p class="muted">${esc(s.reason)}</p>
    <form method="post" action="/review/${encodeURIComponent(req.params.token)}">
      <label class="field"><span>Your name</span><input name="name" required maxlength="60" placeholder="e.g. Travis"></label>
      <button class="btn ${approve ? 'btn-primary' : 'btn-ghost'} btn-lg" type="submit">
        ${approve ? (manual ? 'Yes, mark it done' : 'Yes, apply this change') : 'Yes, dismiss it'}
      </button>
    </form>`));
});

app.post('/review/:token', async (req, res) => {
  const t = verify(req.params.token);
  if (!t) return res.status(410).send(reviewPage('Link expired', '<h1>This link has expired</h1>'));
  const name = String(req.body.name ?? '').trim().slice(0, 60) || 'email';
  const r = await decide(t.sid, t.decision, `${name} (email)`);
  res.send(reviewPage('Done', `<h1>${r.ok ? (t.decision === 'approve' ? 'Done ✓' : 'Dismissed') : 'Could not apply'}</h1>
    <p class="muted">${esc(r.message)}</p><p><a class="btn btn-primary" href="/">Open the dashboard</a></p>`));
});

// ---------- Everything below needs a login ----------
app.use((req, res, next) => {
  if (user(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  if (req.method === 'GET' && /\.(css|svg|png|ico)$/.test(req.path)) return next(); // login page styling
  return res.redirect('/login');
});
app.use(express.static(PUBLIC));

async function decide(id, decision, actor) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return { ok: false, message: 'Suggestion not found.' };
  if (s.status !== 'pending') return { ok: false, message: `Already ${s.status}.` };
  // Claim it first so two people clicking at once can't apply it twice.
  const claimed = db.prepare("UPDATE suggestions SET status = 'applying' WHERE id = ? AND status = 'pending'").run(id);
  if (!claimed.changes) return { ok: false, message: 'Someone else is handling this one.' };

  if (decision === 'dismiss') {
    db.prepare("UPDATE suggestions SET status='dismissed', decided_at=?, decided_by=? WHERE id=?").run(now(), actor, id);
    audit(actor, s.campaign_id, `Dismissed: ${s.title}`);
    return { ok: true, message: 'Dismissed. No changes were made.' };
  }
  try {
    await applyAction(s.campaign_id, JSON.parse(s.action), actor);
    db.prepare("UPDATE suggestions SET status='applied', decided_at=?, decided_by=?, result='ok' WHERE id=?").run(now(), actor, id);
    return { ok: true, message: config.dataSource === 'meta' ? 'Change sent to Facebook.' : 'Change applied (sample data mode, nothing sent to Facebook).' };
  } catch (e) {
    db.prepare("UPDATE suggestions SET status='failed', decided_at=?, decided_by=?, result=? WHERE id=?").run(now(), actor, e.message, id);
    audit(actor, s.campaign_id, `FAILED: ${s.title} (${e.message})`);
    return { ok: false, message: e.message };
  }
}

const listAccounts = () => db.prepare('SELECT * FROM accounts ORDER BY name').all();
const pickAccount = (q) => (q && db.prepare('SELECT id FROM accounts WHERE id = ?').get(String(q)) ? String(q) : null);

app.get('/api/me', (req, res) => res.json({ name: user(req), dataSource: config.dataSource, lastSync: getMeta('last_sync'), accounts: listAccounts(), aiEnabled: aiEnabled() }));

// ---------- AI insights ----------
const generating = new Set(); // one review per brand at a time
app.get('/api/insight', (req, res) => {
  const accountId = pickAccount(req.query.account);
  res.json({ enabled: aiEnabled(), generating: generating.has(accountId ?? 'all'), insight: latestInsight(accountId) });
});
app.post('/api/insight', async (req, res) => {
  const accountId = pickAccount(req.body.account);
  const key = accountId ?? 'all';
  if (generating.has(key)) return res.status(409).json({ ok: false, error: 'A review is already being written. It takes about a minute.' });
  generating.add(key);
  try {
    const insight = await generateInsight(accountId, user(req));
    await recordOk('ai');
    res.json({ ok: true, insight });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    generating.delete(key);
  }
});

app.get('/api/overview', (req, res) => {
  const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const accountId = pickAccount(req.query.account);
  const w = windows(days);
  const campaigns = campaignTotals(w.cur, accountId);
  const accts = accountId ? listAccounts().filter((a) => a.id === accountId) : listAccounts();
  // One brand: its own target. All brands: targets blended by how much each brand spent.
  const spendBy = new Map();
  for (const c of campaigns) spendBy.set(c.account_id, (spendBy.get(c.account_id) ?? 0) + c.spend);
  const totalSpend = [...spendBy.values()].reduce((s, v) => s + v, 0);
  const targetCpl = accts.length === 1 || !totalSpend
    ? accts[0]?.target_cpl ?? config.targetCpl
    : accts.reduce((s, a) => s + a.target_cpl * (spendBy.get(a.id) ?? 0), 0) / totalSpend;
  const dailyCap = accts.reduce((s, a) => s + a.daily_cap, 0);
  res.json({
    range: w, days, accountId,
    target: { cpl: targetCpl, blended: accts.length > 1 && new Set(accts.map((a) => a.target_cpl)).size > 1, dailyCap },
    totals: accountTotals(w.cur, accountId), previous: accountTotals(w.prev, accountId),
    daily: daily(w.cur, accountId),
    campaigns,
  });
});

app.get('/api/suggestions', (req, res) => {
  const accountId = pickAccount(req.query.account);
  const rows = db.prepare(`SELECT s.*, c.name AS campaign_name, a.name AS account_name FROM suggestions s
    JOIN campaigns c ON c.id = s.campaign_id JOIN accounts a ON a.id = c.account_id
    WHERE s.status = 'pending' ${accountId ? 'AND c.account_id = ?' : ''}
    ORDER BY CASE s.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, s.id`).all(...(accountId ? [accountId] : []));
  res.json(rows.map((r) => ({ ...r, action: JSON.parse(r.action) })));
});

// Per-brand limits, editable from the dashboard.
const LIMITS = {
  target_cpl: { label: 'Target cost per lead', min: 1, max: 10000 },
  max_change_pct: { label: 'Max budget change %', min: 5, max: 50 },
  daily_cap: { label: 'Daily spend cap', min: 1, max: 1000000 },
  min_spend: { label: 'Minimum spend before judging', min: 0, max: 100000 },
};
app.post('/api/accounts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: 'Account not found' });
  const changes = [];
  for (const [k, rule] of Object.entries(LIMITS)) {
    if (req.body[k] === undefined) continue;
    const v = Number(req.body[k]);
    if (!Number.isFinite(v) || v < rule.min || v > rule.max) return res.status(400).json({ ok: false, error: `${rule.label} must be between ${rule.min} and ${rule.max}` });
    if (v !== a[k]) changes.push([k, v, `${rule.label} ${a[k]} → ${v}`]);
  }
  if (req.body.context !== undefined) {
    const v = String(req.body.context).trim().slice(0, 1500);
    if (v !== (a.context ?? '')) changes.push(['context', v, 'Brand description updated']);
  }
  if (req.body.enabled !== undefined) {
    const v = req.body.enabled ? 1 : 0;
    if (v !== a.enabled) changes.push(['enabled', v, v ? 'Suggestions turned on' : 'Suggestions turned off']);
  }
  if (!changes.length) return res.json({ ok: true, changed: 0 });
  for (const [k, v] of changes) db.prepare(`UPDATE accounts SET ${k} = ?, updated_at = ? WHERE id = ?`).run(v, now(), a.id);
  audit(user(req), null, `${a.name}: ${changes.map((c) => c[2]).join(', ')}`);
  // Only limits affect the rule-based suggestions; the description is for the AI review.
  const r = changes.some(([k]) => k !== 'context') ? refreshAccountSuggestions(a.id) : { created: 0 };
  res.json({ ok: true, changed: changes.length, created: r.created });
});

app.post('/api/suggestions/:id/:decision', async (req, res) => {
  if (!['approve', 'dismiss'].includes(req.params.decision)) return res.status(400).json({ error: 'bad decision' });
  res.json(await decide(Number(req.params.id), req.params.decision, user(req)));
});

app.get('/api/activity', (_req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 25').all());
});

app.post('/api/sync', async (req, res) => {
  try {
    const r = await syncAll();
    const e = runEngine();
    await recordOk('facebook');
    audit(user(req), null, `Synced ${r.accounts} account(s), ${r.campaigns} campaigns; ${e.created} new suggestion(s)`);
    res.json({ ok: true, ...r, ...e });
  } catch (err) {
    const h = await recordFail('facebook', err);
    res.status(500).json({ ok: false, error: `${h.msg} ${h.fix}` });
  }
});

app.get('/api/health', (_req, res) => res.json({ problems: problems() }));

app.get('/email/preview', (_req, res) => res.send(buildDigest().html));
app.post('/api/email/send', async (req, res) => {
  try {
    const r = await sendDigest(user(req), { force: true });
    if (r.sent) await recordOk('email'); else if (r.failed) await recordFail('email', new Error(r.reason));
    res.json(r);
  } catch (e) { res.status(500).json({ sent: false, reason: e.message }); }
});

// ---------- Scheduler ----------
setNotifier(sendAlert);
async function cycle() {
  try {
    const r = await syncAll();
    const e = runEngine();
    await recordOk('facebook');
    console.log(`[sync] ${r.accounts} accounts, ${r.campaigns} campaigns, ${r.rows} rows, ${e.created} new suggestions`);
  } catch (err) {
    console.error('[sync] failed:', err.message);
    await recordFail('facebook', err).catch((e) => console.error('[health]', e.message));
  }
}
setInterval(cycle, config.syncIntervalMinutes * 60e3);
setInterval(async () => {
  const d = new Date();
  const today = d.toLocaleDateString('en-CA'); // local date (YYYY-MM-DD), so "once a day" follows TZ, not UTC
  if (d.getHours() >= config.digestHour && getMeta('last_digest') !== today) {
    setMeta('last_digest', today);
    // Weekly AI review (all brands), written just before that day's email so the email can include it.
    if (aiEnabled() && d.getDay() === config.ai.weeklyDay && accountTotals(windows(14).cur).spend > 0) {
      try { await generateInsight(null, 'scheduler'); await recordOk('ai'); console.log('[ai] weekly review written'); }
      catch (e) { console.error('[ai] failed:', e.message); await recordFail('ai', e).catch(() => {}); }
    }
    try {
      const r = await sendDigest();
      if (r.sent) await recordOk('email'); else if (r.failed) await recordFail('email', new Error(r.reason));
      console.log('[digest]', r);
    } catch (e) { console.error('[digest] failed:', e.message); }
  }
}, 60e3);

await cycle();
app.listen(config.port, () => console.log(`Ads Pilot running at http://localhost:${config.port} (data: ${config.dataSource})`));
