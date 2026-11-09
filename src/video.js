// Video Studio: turns an ad angle into a shot-by-shot video plan built from clips already in the
// content library, lists what still needs filming, and tracks each video through production.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { db, now, audit, brandBrief } from './db.js';
import { catalogForPrompt, getMedia } from './library.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'script',   -- idea | script | filming | editing | ready | live
    request TEXT NOT NULL, plan TEXT,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT
  );
`);
export const STAGES = ['idea', 'script', 'filming', 'editing', 'ready', 'live'];

const SYSTEM = `You are a short-form video director for Facebook and Instagram ads. You plan videos that a small business team can actually make: with clips they already have, phone footage they can shoot this week, and a simple editor like CapCut.

Rules:
- The first 2-3 seconds must stop the scroll: motion, a bold visual, or a striking on-screen line. Never open on a logo.
- Assume most people watch muted: every key point must also be on-screen text, short and large.
- Use clips from the library by their exact file id when one fits (put it in media_id). If nothing fits, leave media_id empty and describe the shot to film; also list it in missing_shots.
- Keep claims to what the brand description and offer support. Put any fact you don't have in [brackets].
- No competitor names. Follow Meta ad policy (no personal attributes, no fake urgency).
- Beat timings must add up to the requested length.`;

const S = { type: 'string' };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'hook', 'beats', 'caption', 'cta', 'music', 'missing_shots', 'editing_notes'],
  properties: {
    title: { type: 'string', description: 'Short working title.' },
    hook: { type: 'string', description: 'The opening idea in one line.' },
    beats: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['start', 'end', 'visual', 'media_id', 'on_screen_text', 'voiceover'],
        properties: {
          start: { type: 'number', description: 'Seconds' }, end: { type: 'number', description: 'Seconds' },
          visual: { type: 'string', description: 'What is on screen, camera move, crop.' },
          media_id: { type: 'string', description: 'Library file id to use, or empty string if it must be filmed.' },
          on_screen_text: S, voiceover: { type: 'string', description: 'Spoken line, or empty string for none.' },
        },
      },
    },
    caption: { type: 'string', description: 'Ad primary text to post with the video, 125 characters or fewer.' },
    cta: { type: 'string', description: 'Final call to action shown on screen.' },
    music: { type: 'string', description: 'Music mood and pace.' },
    missing_shots: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['shot', 'how'], properties: { shot: S, how: { type: 'string', description: 'Phone filming tips: angle, distance, light, length.' } } },
    },
    editing_notes: { type: 'string', description: 'Practical notes for whoever edits (pace, transitions, text style, captions).' },
  },
};

export function listVideos(accountId) {
  return db.prepare(`SELECT * FROM videos ${accountId ? 'WHERE account_id = ?' : ''} ORDER BY id DESC LIMIT 60`)
    .all(...(accountId ? [accountId] : []))
    .map((v) => ({ ...v, request: JSON.parse(v.request), plan: v.plan ? JSON.parse(v.plan) : null }));
}

export function setVideoStatus(id, status, actor) {
  if (!STAGES.includes(status)) throw new Error('Unknown stage.');
  const v = db.prepare('SELECT title FROM videos WHERE id = ?').get(id);
  if (!v) throw new Error('Video not found.');
  db.prepare('UPDATE videos SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  audit(actor, null, `Moved video "${v.title}" to ${status}`);
}

export async function planVideo(accountId, req, actor) {
  if (!config.ai.apiKey) throw new Error('AI is off. Add ANTHROPIC_API_KEY to use the Video Studio.');
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acct) throw new Error('Pick a brand first.');
  const length = [15, 30, 45, 60].includes(Number(req.length)) ? Number(req.length) : 30;
  const format = req.format === 'square' ? 'square 1:1 (Feed)' : 'vertical 9:16 (Reels/Stories)';
  const idea = String(req.idea ?? '').trim();
  if (!idea) throw new Error('Describe the video idea or pick an ad angle.');
  const catalog = catalogForPrompt();

  const brief = [
    `Brand: ${acct.name}`,
    brandBrief(acct),
    `Video idea / ad angle: ${idea}`,
    req.offer && `Offer to feature: ${req.offer}`,
    `Length: ${length} seconds. Format: ${format}.`,
    catalog.length
      ? `Content library (file id | type | description | tags):\n${catalog.join('\n')}`
      : 'The content library is empty, so every shot must be filmed. Plan shots a small team can get with a phone in one site visit.',
  ].filter(Boolean).join('\n\n');

  const client = new Anthropic({ apiKey: config.ai.apiKey });
  const msg = await client.beta.messages.create({
    model: config.ai.model, max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: brief }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this one. Try rewording the idea.');
  if (msg.stop_reason === 'max_tokens') throw new Error('The plan was cut off. Try a shorter video.');
  const plan = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  // Drop references to files that don't exist (so a typo can't point at nothing).
  for (const b of plan.beats) if (b.media_id && !getMedia(b.media_id)) b.media_id = '';

  const status = plan.missing_shots.length ? 'filming' : 'editing';
  const id = Number(db.prepare(`INSERT INTO videos (account_id, title, status, request, plan, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(acct.id, plan.title, status, JSON.stringify({ idea, offer: req.offer ?? '', length, format }),
    JSON.stringify(plan), now(), actor, now()).lastInsertRowid);
  audit(actor, null, `Planned video "${plan.title}" (${length}s, ${plan.missing_shots.length} shot(s) to film)`);
  return listVideos(acct.id).find((v) => v.id === id);
}
