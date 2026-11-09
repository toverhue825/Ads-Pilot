import nodemailer from 'nodemailer';
import { config } from './config.js';
import { db, now, audit } from './db.js';
import { sign } from './tokens.js';
import { windows, accountTotals } from './metrics.js';
import { latestInsight } from './ai.js';

// The latest all-brands AI review, if written in the last 8 days.
function aiBlock() {
  const ins = latestInsight(null);
  if (!ins || Date.now() - new Date(ins.created_at) > 8 * 864e5) return '';
  const c = ins.content;
  const li = (items) => items.map((t) => `<li style="margin:0 0 6px">${esc(t)}</li>`).join('');
  return `
    <tr><td style="padding:0 0 14px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0ff;border:1px solid #e0d9fb;border-radius:14px">
        <tr><td style="padding:18px 20px">
          <div style="font-size:12px;font-weight:700;color:#6250d6;letter-spacing:.02em">✦ WEEKLY AI REVIEW</div>
          <div style="font-size:16px;font-weight:700;color:#1d1b2e;margin:8px 0 6px">${esc(c.headline)}</div>
          <div style="font-size:14px;color:#52514e;line-height:1.5">${esc(c.summary)}</div>
          ${c.actions.length ? `<div style="font-size:13px;font-weight:700;color:#1d1b2e;margin:14px 0 6px">Do this week</div>
            <ol style="margin:0;padding-left:20px;font-size:14px;color:#52514e;line-height:1.45">${li(c.actions.map((a) => `${a.title}: ${a.why}`))}</ol>` : ''}
          ${c.copy_ideas.length ? `<div style="font-size:13px;color:#6b6880;margin-top:10px">${c.copy_ideas.length} new ad copy idea${c.copy_ideas.length > 1 ? 's' : ''} are waiting in the dashboard.</div>` : ''}
        </td></tr>
      </table>
    </td></tr>`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '–' : `$${n.toFixed(2)}`);
const LINK_TTL = 3 * 864e5;

const BADGE = {
  critical: { bg: '#fdecec', fg: '#b42323', label: '● Urgent' },
  warning: { bg: '#fff4dc', fg: '#8a5a00', label: '▲ Worth a look' },
  good: { bg: '#e6f6e6', fg: '#006300', label: '✓ Opportunity' },
};

export function reviewLink(suggestionId, decision) {
  return `${config.baseUrl}/review/${sign({ sid: suggestionId, decision }, LINK_TTL)}`;
}

export function buildDigest() {
  const items = db.prepare(`SELECT s.*, c.name AS campaign_name, a.name AS account_name FROM suggestions s
    JOIN campaigns c ON c.id = s.campaign_id JOIN accounts a ON a.id = c.account_id
    WHERE s.status = 'pending' ORDER BY CASE s.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, s.id`).all();
  const multi = new Set(items.map((s) => s.account_name)).size > 1 || db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n > 1;
  const t = accountTotals(windows(7).cur);

  const cards = items.map((s) => {
    const b = BADGE[s.severity];
    const manual = JSON.parse(s.action).kind === 'manual';
    return `
    <tr><td style="padding:0 0 14px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e8e6f0;border-radius:14px">
        <tr><td style="padding:18px 20px">
          <span style="display:inline-block;background:${b.bg};color:${b.fg};font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px">${b.label}</span>
          ${multi ? `<span style="font-size:12px;color:#6b6880;margin-left:6px">${esc(s.account_name)}</span>` : ''}
          <div style="font-size:16px;font-weight:700;color:#1d1b2e;margin:10px 0 6px">${esc(s.title)}</div>
          <div style="font-size:14px;color:#52514e;line-height:1.5;margin-bottom:14px">${esc(s.reason)}</div>
          <a href="${reviewLink(s.id, 'approve')}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">${manual ? 'Mark done' : 'Approve'}</a>
          &nbsp;
          <a href="${reviewLink(s.id, 'dismiss')}" style="display:inline-block;color:#52514e;text-decoration:none;font-size:14px;padding:10px 12px">Dismiss</a>
        </td></tr>
      </table>
    </td></tr>`;
  }).join('');

  const kpi = (label, value) => `<td style="padding:10px;text-align:center"><div style="font-size:12px;color:#6b6880">${label}</div><div style="font-size:20px;font-weight:700;color:#1d1b2e">${value}</div></td>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f6f5fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
    <tr><td style="background:linear-gradient(120deg,#2a78d6,#6250d6);background-color:#2a78d6;border-radius:16px;padding:22px 24px;color:#fff">
      <div style="font-size:13px;opacity:.85">Ads Pilot · daily suggestions</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${items.length ? `${items.length} suggestion${items.length > 1 ? 's' : ''} waiting for you` : 'All clear today 🎉'}</div>
    </td></tr>
    <tr><td style="padding:14px 0">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e8e6f0;border-radius:14px"><tr>
        ${kpi('Leads (7d)', t.leads)}${kpi('Cost per lead', money(t.cpl))}${kpi('Spend (7d)', money(t.spend))}
      </tr></table>
    </td></tr>
    ${aiBlock()}
    ${cards}
    <tr><td style="padding:8px 4px;font-size:12px;color:#898781;line-height:1.5">
      Numbers above are all brands combined. Buttons open a confirm page, so link scanners in your inbox can't approve anything by accident. Links expire in 3 days.
      <br><a href="${config.baseUrl}" style="color:#2a78d6">Open the dashboard</a>
    </td></tr>
  </table></td></tr></table></body></html>`;

  return { html, count: items.length, ids: items.map((s) => s.id), subject: items.length ? `Ads Pilot: ${items.length} suggestion${items.length > 1 ? 's' : ''} to review` : 'Ads Pilot: all clear today' };
}

export async function sendDigest(actor = 'scheduler', { force = false } = {}) {
  const d = buildDigest();
  // Send when there's something to approve, or a fresh AI review nobody has been emailed yet.
  const freshAi = latestInsight(null);
  const aiUnsent = freshAi && Date.now() - new Date(freshAi.created_at) < 864e5 && db.prepare("SELECT value FROM meta WHERE key = 'ai_emailed'").get()?.value !== String(freshAi.id);
  // force = someone clicked "Send email now": send whatever the digest holds, even if nothing is pending.
  if (!d.count && !aiUnsent && !force) return { sent: false, reason: 'No pending suggestions' };
  const missing = missingSettings();
  if (missing.length) return { sent: false, reason: `Email isn't set up yet: fill in ${missing.join(', ')} in .env` };

  const subject = !d.count && aiUnsent ? `Ads Pilot: your weekly AI review` : d.subject;
  try {
    await transport().sendMail({ from: config.emailFrom, to: config.emailTo, subject, html: d.html });
  } catch (e) {
    return { sent: false, failed: true, reason: explainSmtpError(e) };
  }
  if (aiUnsent) db.prepare("INSERT INTO meta (key, value) VALUES ('ai_emailed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(freshAi.id));
  const mark = db.prepare('UPDATE suggestions SET emailed_at = ? WHERE id = ?');
  for (const id of d.ids) mark.run(now(), id);
  audit(actor, null, `Emailed ${d.count} suggestion(s)${aiUnsent ? ' and the AI review' : ''} to ${config.emailTo}`);
  return { sent: true, count: d.count, to: config.emailTo };
}

const missingSettings = () => [['SMTP_HOST', config.smtp.host], ['SMTP_PASS', config.smtp.pass], ['EMAIL_FROM', config.emailFrom], ['EMAIL_TO', config.emailTo]]
  .filter(([, v]) => !v || v.includes('example.com')).map(([k]) => k);

const transport = () => nodemailer.createTransport({
  host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  connectionTimeout: 15000,
});

// Short alert email (connection problems). Throws if email itself isn't working.
export async function sendAlert(subject, bodyHtml) {
  if (missingSettings().length) throw new Error('Email not set up');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
    <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e8e6f0;border-radius:14px;padding:22px 24px;color:#1d1b2e;font-size:15px;line-height:1.5">
    <div style="font-size:13px;color:#6b6880;margin-bottom:8px">Ads Pilot · connection alert</div>${bodyHtml}</div></body></html>`;
  await transport().sendMail({ from: config.emailFrom, to: config.emailTo, subject, html });
}

// Turn mail-server errors into something a person can act on.
function explainSmtpError(e) {
  const msg = String(e.response ?? e.message ?? e);
  if (e.code === 'EAUTH') return `The email server rejected the login. Check SMTP_USER and SMTP_PASS. (${msg.slice(0, 120)})`;
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(e.code)) return `Couldn't reach the email server ${config.smtp.host}:${config.smtp.port}. Check SMTP_HOST and SMTP_PORT.`;
  if (/domain.*not verified|not verified|verify a domain|testing emails/i.test(msg)) return `The sending address isn't allowed yet. Verify your domain with the email service, or check EMAIL_FROM. (${msg.slice(0, 160)})`;
  if (e.code === 'EENVELOPE') return `The email address looks wrong. Check EMAIL_FROM and EMAIL_TO. (${msg.slice(0, 120)})`;
  return `Email failed: ${msg.slice(0, 200)}`;
}
