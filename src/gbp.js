// Google Business Profile: reviews (with Claude-drafted replies a person approves), posts written by
// Claude with a photo from the content library, and profile stats (calls, directions, website clicks).
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { db, now, getMeta, setMeta, audit, brandBrief } from './db.js';
import { gbp, gbpConnected } from './google.js';
import { sign } from './tokens.js';
import { getMedia } from './library.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS gbp_reviews (
    name TEXT PRIMARY KEY,          -- accounts/x/locations/y/reviews/z
    reviewer TEXT, stars INTEGER, comment TEXT, created_at TEXT,
    reply TEXT, replied_at TEXT,
    draft TEXT, drafted_at TEXT, seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS gbp_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL, cta_type TEXT, cta_url TEXT, media_id TEXT,
    status TEXT NOT NULL,           -- draft | posted | failed
    google_name TEXT, error TEXT,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, posted_at TEXT
  );
`);

const V4 = 'https://mybusiness.googleapis.com/v4';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const loc = () => { try { return JSON.parse(getMeta('gbp_location') ?? 'null'); } catch { return null; } };

export function gbpStatus() {
  const l = loc();
  const r = db.prepare('SELECT COUNT(*) n, AVG(stars) avg, SUM(reply IS NULL) unanswered FROM gbp_reviews').get();
  return { connected: gbpConnected(), location: l, reviews: r, statsAt: getMeta('gbp_stats_at'), stats: JSON.parse(getMeta('gbp_stats') ?? 'null'), lastSync: getMeta('gbp_sync') };
}

export async function listLocations() {
  const accts = (await gbp('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')).accounts ?? [];
  const out = [];
  for (const a of accts) {
    const r = await gbp(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`);
    for (const l of r.locations ?? []) {
      const addr = l.storefrontAddress ? [l.storefrontAddress.locality, l.storefrontAddress.administrativeArea].filter(Boolean).join(', ') : '';
      out.push({ account: a.name, location: l.name, title: l.title, address: addr });
    }
  }
  return out;
}
export function chooseLocation({ account, location, title }, actor) {
  if (!/^accounts\/\d+$/.test(account) || !/^locations\/\d+$/.test(location)) throw new Error('Invalid location.');
  setMeta('gbp_location', JSON.stringify({ account, location, title: String(title ?? '').slice(0, 120) }));
  db.exec('DELETE FROM gbp_reviews');
  audit(actor, null, `Connected Google Business Profile location "${title}"`);
}

// ---------- Reviews ----------
export async function syncReviews(notify) {
  const l = loc();
  if (!l || !gbpConnected()) return { skipped: true };
  const stamp = now();
  const fresh = [];
  let pageToken = '';
  const upsert = db.prepare(`INSERT INTO gbp_reviews (name, reviewer, stars, comment, created_at, reply, replied_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET reviewer=excluded.reviewer, stars=excluded.stars, comment=excluded.comment,
      reply=excluded.reply, replied_at=excluded.replied_at, seen_at=excluded.seen_at`);
  const known = new Set(db.prepare('SELECT name FROM gbp_reviews').all().map((r) => r.name));
  for (let page = 0; page < 5; page++) {
    const r = await gbp(`${V4}/${l.account}/${l.location}/reviews?pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const rv of r.reviews ?? []) {
      const stars = STARS[rv.starRating] ?? null;
      upsert.run(rv.name, rv.reviewer?.displayName ?? 'A customer', stars, rv.comment ?? '', rv.createTime,
        rv.reviewReply?.comment ?? null, rv.reviewReply?.updateTime ?? null, stamp);
      if (!known.has(rv.name) && known.size) fresh.push({ reviewer: rv.reviewer?.displayName, stars, comment: rv.comment ?? '' });
    }
    pageToken = r.nextPageToken ?? '';
    if (!pageToken) break;
  }
  setMeta('gbp_sync', stamp);
  // Heads-up email for new 1–3 star reviews, so they get answered fast.
  const bad = fresh.filter((r) => r.stars && r.stars <= 3);
  if (bad.length && notify) {
    await notify(`⚠ New ${bad.length === 1 ? `${bad[0].stars}-star review` : `${bad.length} low reviews`} on Google`,
      bad.map((r) => `<p><b>${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)} ${esc(r.reviewer ?? '')}</b><br>${esc(r.comment || '(no text)')}</p>`).join('')
      + `<p>A suggested reply is waiting in the dashboard under Google Business.</p>`).catch(() => {});
  }
  const drafted = await draftReplies();
  return { reviews: db.prepare('SELECT COUNT(*) n FROM gbp_reviews').get().n, newReviews: fresh.length, drafted };
}

const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['replies'],
  properties: { replies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'reply'], properties: { name: { type: 'string' }, reply: { type: 'string' } } } } },
};
export async function draftReplies(limit = 15) {
  if (!config.ai.apiKey) return 0;
  const todo = db.prepare("SELECT name, reviewer, stars, comment FROM gbp_reviews WHERE reply IS NULL AND draft IS NULL ORDER BY created_at DESC LIMIT ?").all(limit);
  if (!todo.length) return 0;
  const acct = db.prepare("SELECT name, context FROM accounts ORDER BY name LIMIT 1").get();
  const l = loc();
  const prompt = `Write a reply from the business owner to each Google review below.
Business: ${l?.title ?? acct?.name ?? 'our company'}.
${brandBrief(acct)}

Guidelines:
- Warm, genuine, specific to what they wrote. Use their first name if it looks like a real name. 2-4 sentences, under 80 words.
- 4-5 stars: thank them, mention a detail they liked, no sales pitch.
- 1-3 stars: thank them for the feedback, acknowledge the issue without arguing or admitting legal fault, and invite them to contact the business directly to make it right (write "[phone or email]" where contact details go). Never blame the customer.
- Never offer discounts or anything in exchange for changing a review. Don't invent facts about their order.
- No hashtags, no emojis except possibly one at the end of a 5-star reply.

Reviews (JSON):
${JSON.stringify(todo.map((r) => ({ name: r.name, reviewer: r.reviewer, stars: r.stars, text: r.comment || '(rating only, no text)' })), null, 1)}`;
  const client = new Anthropic({ apiKey: config.ai.apiKey });
  const msg = await client.beta.messages.create({
    model: config.ai.model, max_tokens: 8000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return 0;
  const out = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const set = db.prepare('UPDATE gbp_reviews SET draft = ?, drafted_at = ? WHERE name = ? AND reply IS NULL');
  let n = 0;
  for (const r of out.replies ?? []) n += set.run(r.reply, now(), r.name).changes;
  return n;
}

export function listReviews() {
  return db.prepare(`SELECT * FROM gbp_reviews ORDER BY (reply IS NULL) DESC, created_at DESC LIMIT 60`).all();
}
export async function postReply(name, text, actor) {
  const r = db.prepare('SELECT * FROM gbp_reviews WHERE name = ?').get(name);
  if (!r) throw new Error('Review not found.');
  const comment = String(text ?? '').trim();
  if (!comment) throw new Error('The reply is empty.');
  if (/\[[^\]]+\]/.test(comment)) throw new Error('Fill in the [bracketed] part before posting.');
  if (comment.length > 4000) throw new Error('Reply is too long.');
  await gbp(`${V4}/${name}/reply`, { method: 'PUT', body: { comment } });
  db.prepare('UPDATE gbp_reviews SET reply = ?, replied_at = ?, draft = NULL WHERE name = ?').run(comment, now(), name);
  audit(actor, null, `Replied to ${r.stars}-star Google review from ${r.reviewer}`);
}

// ---------- Posts ----------
const POST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'cta_type'],
  properties: {
    summary: { type: 'string', description: 'The post text, 150-300 characters, plain and local-sounding, ends with a clear next step.' },
    cta_type: { type: 'string', enum: ['LEARN_MORE', 'CALL', 'ORDER', 'SHOP', 'SIGN_UP', 'BOOK'] },
  },
};
export async function draftPost({ topic, mediaId, accountId }, actor) {
  if (!config.ai.apiKey) throw new Error('AI is off. Add ANTHROPIC_API_KEY.');
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) ?? db.prepare('SELECT * FROM accounts ORDER BY name LIMIT 1').get();
  const m = mediaId ? getMedia(mediaId) : null;
  if (mediaId && (!m || m.kind !== 'photo')) throw new Error('Pick a photo from the library.');
  const content = [];
  const thumb = m ? db.prepare('SELECT thumb FROM media WHERE id = ?').get(m.id)?.thumb : null;
  if (thumb) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumb } });
  content.push({ type: 'text', text: `Write a Google Business Profile post for ${acct?.name ?? 'the business'}.
${brandBrief(acct)}
Topic: ${String(topic ?? '').slice(0, 500) || 'A recent project or why customers choose us'}
${m ? `It will use the photo above (${m.description ?? m.name}). Refer to what's in it naturally.` : ''}
Rules: only facts given here; put anything unknown in [brackets]; no prices or discounts unless given; no hashtags; Google forbids phone numbers in post text.` });
  const client = new Anthropic({ apiKey: config.ai.apiKey });
  const msg = await client.beta.messages.create({
    model: config.ai.model, max_tokens: 4000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: POST_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined. Try another topic.');
  const p = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const id = Number(db.prepare(`INSERT INTO gbp_posts (summary, cta_type, cta_url, media_id, status, created_at, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?)`)
    .run(p.summary, p.cta_type, acct?.website || '', m?.id ?? null, now(), actor).lastInsertRowid);
  return db.prepare('SELECT * FROM gbp_posts WHERE id = ?').get(id);
}
export function listPosts() {
  return db.prepare('SELECT * FROM gbp_posts ORDER BY id DESC LIMIT 30').all();
}
export async function publishPost(id, edits, actor) {
  const p = db.prepare('SELECT * FROM gbp_posts WHERE id = ?').get(id);
  if (!p) throw new Error('Post not found.');
  const l = loc();
  if (!l) throw new Error('Pick your Google Business location first.');
  const summary = String(edits.summary ?? p.summary).trim();
  if (/\[[^\]]+\]/.test(summary)) throw new Error('Fill in the [bracketed] part before posting.');
  if (summary.length > 1500) throw new Error('Google posts are limited to 1,500 characters.');
  const ctaUrl = String(edits.cta_url ?? p.cta_url ?? '').trim();
  const body = { languageCode: 'en-US', summary, topicType: 'STANDARD' };
  if (p.cta_type === 'CALL') body.callToAction = { actionType: 'CALL' };
  else if (/^https?:\/\//.test(ctaUrl)) body.callToAction = { actionType: p.cta_type, url: ctaUrl };
  if (p.media_id) {
    // Google fetches the photo from a link; give it a short-lived signed link to this server.
    const token = sign({ mid: p.media_id }, 2 * 3600e3);
    body.media = [{ mediaFormat: 'PHOTO', sourceUrl: `${config.baseUrl}/m/${token}` }];
  }
  try {
    const r = await gbp(`${V4}/${l.account}/${l.location}/localPosts`, { method: 'POST', body });
    db.prepare("UPDATE gbp_posts SET status = 'posted', summary = ?, cta_url = ?, google_name = ?, posted_at = ?, error = NULL WHERE id = ?")
      .run(summary, ctaUrl, r.name ?? null, now(), id);
    audit(actor, null, 'Published a Google Business Profile post');
  } catch (e) {
    db.prepare("UPDATE gbp_posts SET error = ? WHERE id = ?").run(e.message.slice(0, 400), id);
    throw e;
  }
}

// ---------- Stats ----------
const METRICS = ['CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'];
export async function syncStats() {
  const l = loc();
  if (!l || !gbpConnected()) return null;
  const end = new Date(); end.setDate(end.getDate() - 2); // Google's numbers lag a couple of days
  const start = new Date(end); start.setDate(end.getDate() - 55);
  const d = (x, p) => `dailyRange.${p}.year=${x.getFullYear()}&dailyRange.${p}.month=${x.getMonth() + 1}&dailyRange.${p}.day=${x.getDate()}`;
  const url = `https://businessprofileperformance.googleapis.com/v1/${l.location}:fetchMultiDailyMetricsTimeSeries?`
    + METRICS.map((m) => `dailyMetrics=${m}`).join('&') + `&${d(start, 'startDate')}&${d(end, 'endDate')}`;
  const r = await gbp(url);
  const series = (r.multiDailyMetricTimeSeries ?? []).flatMap((x) => x.dailyMetricTimeSeries ?? []);
  const split = new Date(end); split.setDate(end.getDate() - 27);
  const sum = (metrics, from, to) => series.filter((s) => metrics.includes(s.dailyMetric))
    .flatMap((s) => s.timeSeries?.datedValues ?? [])
    .filter((v) => { const t = new Date(v.date.year, v.date.month - 1, v.date.day); return t >= from && t <= to; })
    .reduce((a, v) => a + Number(v.value ?? 0), 0);
  const prevEnd = new Date(split); prevEnd.setDate(split.getDate() - 1);
  const views = METRICS.filter((m) => m.startsWith('BUSINESS_IMPRESSIONS'));
  const block = (from, to) => ({ calls: sum(['CALL_CLICKS'], from, to), website: sum(['WEBSITE_CLICKS'], from, to), directions: sum(['BUSINESS_DIRECTION_REQUESTS'], from, to), views: sum(views, from, to) });
  const stats = { current: block(split, end), previous: block(start, prevEnd), through: end.toISOString().slice(0, 10) };
  setMeta('gbp_stats', JSON.stringify(stats));
  setMeta('gbp_stats_at', now());
  return stats;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
