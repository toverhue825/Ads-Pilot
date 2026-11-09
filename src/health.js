// Connection health: remembers whether Facebook, Claude and email last worked,
// shows problems on the dashboard, and emails an alert when something breaks or recovers.
import { config } from './config.js';
import { getMeta, setMeta, audit } from './db.js';

export const COMPONENTS = {
  facebook: 'Facebook connection',
  ai: 'AI review (Claude)',
  email: 'Email sending',
};

const read = (name) => { try { return JSON.parse(getMeta(`health_${name}`) ?? 'null'); } catch { return null; } };
const write = (name, v) => setMeta(`health_${name}`, JSON.stringify(v));

// Plain-English cause and fix for common failures.
export function explain(name, err) {
  const msg = String(err?.message ?? err ?? 'Unknown error');
  const code = err?.code;
  if (name === 'facebook') {
    if (code === 190 || /access token|session has expired|has been invalidated/i.test(msg))
      return { msg: 'Facebook rejected the access token (expired, revoked, or changed).', fix: 'In Business Settings → System users → SbdAgent, generate a new token, then paste it into META_ACCESS_TOKEN in Render (Environment) and save.', urgent: true };
    if (code === 200 || code === 10 || /permission|not authorized|does not have/i.test(msg))
      return { msg: 'The Facebook token lost access to the ad account.', fix: 'In Business Settings → System users → SbdAgent → Assigned assets, give the ad account Full control again.', urgent: true };
    if ([4, 17, 32, 613, 80004].includes(code) || /rate limit|too many calls/i.test(msg))
      return { msg: 'Facebook is temporarily limiting requests.', fix: 'Nothing to do; it retries every hour.', urgent: false };
    return { msg: `Facebook sync failed: ${msg.slice(0, 200)}`, fix: 'If it keeps happening, check that the ad account is active and the token is valid (npm run check-meta).', urgent: false };
  }
  if (name === 'ai') {
    if (/api key|authentication/i.test(msg)) return { msg: 'Anthropic rejected the API key.', fix: 'Create a new key at console.anthropic.com → API Keys and update ANTHROPIC_API_KEY in Render.', urgent: true };
    if (/credit|billing|balance/i.test(msg)) return { msg: 'The Anthropic account is out of credit.', fix: 'Add credit or billing at console.anthropic.com → Billing.', urgent: true };
    return { msg: `The weekly AI review failed: ${msg.slice(0, 200)}`, fix: 'Try "Write this week\'s review" on the dashboard. If it keeps failing, check the Anthropic console.', urgent: false };
  }
  if (name === 'email') {
    return { msg: msg.slice(0, 240), fix: 'Check SMTP_PASS (your Resend key) and EMAIL_FROM / EMAIL_TO in Render. Resend → Logs shows why a message was refused.', urgent: true };
  }
  return { msg, fix: '', urgent: false };
}

let notifier = null; // set by server.js (avoids an import loop with email.js)
export const setNotifier = (fn) => { notifier = fn; };

export async function recordOk(name) {
  const prev = read(name);
  write(name, { ok: true, at: new Date().toISOString() });
  if (prev && !prev.ok) {
    audit('system', null, `${COMPONENTS[name]} is working again`);
    if (prev.alerted && notifier && name !== 'email') {
      await notifier(`✓ Ads Pilot: ${COMPONENTS[name]} is working again`, `<p>${COMPONENTS[name]} recovered at ${new Date().toLocaleString('en-US', { timeZone: process.env.TZ || undefined })}. Nothing more to do.</p>`).catch(() => {});
    }
  }
}

// Failures that might be a blip (e.g. a rate limit) only alert after 2 in a row.
export async function recordFail(name, err) {
  const prev = read(name);
  const info = explain(name, err);
  const failures = prev && !prev.ok ? (prev.failures ?? 1) + 1 : 1;
  const next = {
    ok: false, at: new Date().toISOString(), since: prev && !prev.ok ? prev.since : new Date().toISOString(),
    failures, msg: info.msg, fix: info.fix, alerted: prev?.alerted && !prev.ok ? prev.alerted : null,
  };
  const shouldAlert = (info.urgent || failures >= 2)
    && (!next.alerted || Date.now() - new Date(next.alerted) > 24 * 3600e3); // at most once a day per problem
  if (!prev || prev.ok) audit('system', null, `${COMPONENTS[name]} problem: ${info.msg}`);
  if (shouldAlert && notifier && name !== 'email') {
    try {
      await notifier(`⚠ Ads Pilot: ${COMPONENTS[name]} needs attention`,
        `<p><b>${escapeHtml(info.msg)}</b></p><p>How to fix: ${escapeHtml(info.fix)}</p><p style="color:#6b6880">Open the dashboard: <a href="${config.baseUrl}">${config.baseUrl}</a></p>`);
      next.alerted = new Date().toISOString();
    } catch { /* email itself is down; the dashboard banner still shows */ }
  }
  write(name, next);
  return next;
}

// What the dashboard banner shows.
export function problems() {
  const out = [];
  for (const name of Object.keys(COMPONENTS)) {
    const h = read(name);
    if (h && !h.ok) out.push({ name, label: COMPONENTS[name], msg: h.msg, fix: h.fix, since: h.since });
  }
  // Data hasn't refreshed in a while even though nothing reported an error (e.g. the server was asleep).
  const last = getMeta('last_sync');
  const staleHours = last ? (Date.now() - new Date(last)) / 3600e3 : Infinity;
  if (config.dataSource === 'meta' && staleHours > 3 && !out.some((p) => p.name === 'facebook')) {
    out.push({ name: 'stale', label: 'Data is out of date', msg: last ? `Last successful sync was ${Math.round(staleHours)} hours ago.` : 'No successful sync yet.', fix: 'Click "Sync now". If that fails, the message will say why.', since: last });
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
