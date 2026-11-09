// Content library: mirrors one shared Google Drive folder (photos + video clips), keeps small
// thumbnails, and has Claude describe and tag each file so the team (and the Video Studio) can find them.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { db, now, setMeta, getMeta, audit } from './db.js';
import { drive, driveBytes, driveConfigured } from './google.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,           -- Drive file id
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,            -- photo | video
    folder TEXT NOT NULL DEFAULT '',
    size INTEGER, width INTEGER, height INTEGER, duration_ms INTEGER,
    modified_at TEXT, web_link TEXT,
    thumb TEXT,                    -- small JPEG as base64 (for the dashboard and for Claude)
    description TEXT, tags TEXT,   -- tags = JSON array
    quality TEXT, best_for TEXT,   -- best_for = JSON array
    tagged_at TEXT, seen_at TEXT
  );
`);

const FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis))';
const kindOf = (mime) => (mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : null);

async function listFolder(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const r = await drive('files', {
      q: `'${folderId}' in parents and trashed = false`, fields: FIELDS, pageSize: '200',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(r.files ?? []));
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

async function fetchThumb(link) {
  if (!link) return null;
  // Drive thumbnail links accept a size suffix; 400px is plenty for cards and for Claude.
  const bytes = await driveBytes(link.replace(/=s\d+$/, '=s400'));
  return bytes ? bytes.toString('base64') : null;
}

let syncing = false;
export async function syncLibrary() {
  if (!driveConfigured()) return { skipped: true };
  if (syncing) return { busy: true };
  syncing = true;
  try {
    const stamp = now();
    const upsert = db.prepare(`
      INSERT INTO media (id, name, mime, kind, folder, size, width, height, duration_ms, modified_at, web_link, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, mime=excluded.mime, folder=excluded.folder, size=excluded.size,
        width=excluded.width, height=excluded.height, duration_ms=excluded.duration_ms, web_link=excluded.web_link, seen_at=excluded.seen_at,
        thumb = CASE WHEN media.modified_at = excluded.modified_at THEN media.thumb ELSE NULL END,
        tagged_at = CASE WHEN media.modified_at = excluded.modified_at THEN media.tagged_at ELSE NULL END,
        modified_at=excluded.modified_at`);
    let count = 0;
    const thumbs = [];
    // Walk the folder tree (max 4 levels, to keep it quick).
    const queue = [{ id: config.google.driveFolderId, path: '', depth: 0 }];
    while (queue.length) {
      const { id, path, depth } = queue.shift();
      for (const f of await listFolder(id)) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (depth < 4) queue.push({ id: f.id, path: path ? `${path}/${f.name}` : f.name, depth: depth + 1 });
          continue;
        }
        const kind = kindOf(f.mimeType);
        if (!kind) continue;
        const m = f.imageMediaMetadata ?? f.videoMediaMetadata ?? {};
        upsert.run(f.id, f.name, f.mimeType, kind, path, Number(f.size ?? 0) || null, m.width ?? null, m.height ?? null,
          Number(f.videoMediaMetadata?.durationMillis ?? 0) || null, f.modifiedTime, f.webViewLink ?? null, stamp);
        thumbs.push([f.id, f.thumbnailLink]);
        count++;
      }
    }
    // Files no longer in the folder.
    const removed = db.prepare('DELETE FROM media WHERE seen_at IS NOT ? ').run(stamp).changes;
    // Thumbnails for anything new or changed (Drive may still be processing brand-new videos; we retry next sync).
    const need = new Set(db.prepare('SELECT id FROM media WHERE thumb IS NULL').all().map((r) => r.id));
    const setThumb = db.prepare('UPDATE media SET thumb = ? WHERE id = ?');
    for (const [id, link] of thumbs) if (need.has(id)) { const t = await fetchThumb(link); if (t) setThumb.run(t, id); }
    setMeta('library_sync', now());
    const tagged = await tagNew();
    return { files: count, removed, tagged };
  } finally {
    syncing = false;
  }
}

// ---------- AI tagging ----------
const TAG_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'description', 'tags', 'best_for', 'quality'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string', description: 'One plain sentence: what is shown (building type, size if visible, setting, angle, people, time of day).' },
          tags: { type: 'array', items: { type: 'string' }, description: '4-10 short lowercase tags, e.g. "garage", "red iron", "drone", "interior", "customer", "construction", "sunset".' },
          best_for: { type: 'array', items: { type: 'string', enum: ['video opener', 'b-roll', 'testimonial', 'product shot', 'before/after', 'process', 'google post', 'ad image', 'background'] } },
          quality: { type: 'string', enum: ['great', 'ok', 'poor'], description: 'How usable it is in an ad (sharpness, lighting, framing).' },
        },
      },
    },
  },
};

export async function tagNew(limit = 40) {
  if (!config.ai.apiKey) return 0;
  const todo = db.prepare("SELECT id, name, kind, folder, duration_ms, thumb FROM media WHERE tagged_at IS NULL AND thumb IS NOT NULL ORDER BY modified_at DESC LIMIT ?").all(limit);
  if (!todo.length) return 0;
  const client = new Anthropic({ apiKey: config.ai.apiKey });
  const setTags = db.prepare('UPDATE media SET description = ?, tags = ?, best_for = ?, quality = ?, tagged_at = ? WHERE id = ?');
  let done = 0;
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const content = [];
    for (const m of batch) {
      content.push({ type: 'text', text: `File id ${m.id}: "${m.name}" (${m.kind}${m.duration_ms ? `, ${Math.round(m.duration_ms / 1000)}s` : ''}${m.folder ? `, folder "${m.folder}"` : ''})${m.kind === 'video' ? ' — this image is the video thumbnail' : ''}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.thumb } });
    }
    content.push({ type: 'text', text: 'These are photos and video clips from a steel/metal building company\'s marketing library. Describe and tag each one, keyed by its file id. Only describe what is visible; don\'t guess sizes or locations you can\'t see.' });
    try {
      const msg = await client.beta.messages.create({
        model: config.ai.model, max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: TAG_SCHEMA } },
        messages: [{ role: 'user', content }],
      });
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') continue;
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      for (const it of JSON.parse(text).items ?? []) {
        if (!batch.some((m) => m.id === it.id)) continue;
        setTags.run(it.description, JSON.stringify(it.tags), JSON.stringify(it.best_for), it.quality, now(), it.id);
        done++;
      }
    } catch (e) {
      console.error('[library] tagging failed:', e.message);
      break; // try again next sync
    }
  }
  if (done) audit('Library', null, `Tagged ${done} new file(s) in the content library`);
  return done;
}

// ---------- Reading the library ----------
const shape = (r) => ({ ...r, tags: JSON.parse(r.tags ?? '[]'), best_for: JSON.parse(r.best_for ?? '[]') });
export function searchLibrary({ q = '', kind = '', limit = 120 } = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const where = ['1=1'], args = [];
  if (kind === 'photo' || kind === 'video') { where.push('kind = ?'); args.push(kind); }
  for (const w of words) { where.push("(lower(name) LIKE ? OR lower(IFNULL(description,'')) LIKE ? OR lower(IFNULL(tags,'')) LIKE ? OR lower(folder) LIKE ?)"); args.push(...Array(4).fill(`%${w}%`)); }
  return db.prepare(`SELECT id, name, mime, kind, folder, width, height, duration_ms, modified_at, web_link, description, tags, best_for, quality, tagged_at
    FROM media WHERE ${where.join(' AND ')} ORDER BY modified_at DESC LIMIT ?`).all(...args, limit).map(shape);
}
export function libraryStatus() {
  const c = db.prepare("SELECT COUNT(*) n, SUM(kind='photo') photos, SUM(kind='video') videos, SUM(tagged_at IS NOT NULL) tagged FROM media").get();
  return { configured: driveConfigured(), lastSync: getMeta('library_sync'), ...c };
}
export function getThumb(id) {
  return db.prepare('SELECT thumb FROM media WHERE id = ?').get(id)?.thumb ?? null;
}
export function getMedia(id) {
  const r = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  return r ? shape(r) : null;
}
// Compact catalog for prompts (Video Studio, Google posts).
export function catalogForPrompt(limit = 150) {
  return db.prepare(`SELECT id, kind, name, folder, duration_ms, description, tags, quality FROM media
    WHERE tagged_at IS NOT NULL AND quality != 'poor' ORDER BY modified_at DESC LIMIT ?`).all(limit)
    .map((m) => `${m.id} | ${m.kind}${m.duration_ms ? ` ${Math.round(m.duration_ms / 1000)}s` : ''} | ${m.description} | tags: ${JSON.parse(m.tags ?? '[]').join(', ')}`);
}
// Best library photos for an image idea (simple keyword match on Claude's descriptions and tags).
const STOP = new Set(['with', 'from', 'that', 'this', 'your', 'their', 'into', 'over', 'shot', 'photo', 'image', 'show', 'shows', 'card', 'text', 'overlay', 'option', 'clean']);
export function suggestPhotos(text, limit = 6) {
  const words = [...new Set(String(text).toLowerCase().match(/[a-z0-9×x]{3,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 25);
  const rows = db.prepare(`SELECT id, name, description, tags, best_for, quality, width, height FROM media
    WHERE kind = 'photo' AND tagged_at IS NOT NULL AND quality != 'poor'`).all();
  return rows.map((r) => {
    const tags = JSON.parse(r.tags ?? '[]').map((t) => t.toLowerCase());
    const desc = (r.description ?? '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (tags.some((t) => t.includes(w))) score += 2;
      else if (desc.includes(w)) score += 1;
    }
    if (r.quality === 'great') score += 2;
    if (JSON.parse(r.best_for ?? '[]').some((b) => b === 'ad image' || b === 'product shot')) score += 1;
    if (r.width && r.height && r.width < 600) score -= 3; // too small for an ad
    return { id: r.id, description: r.description ?? r.name, quality: r.quality, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

// A Facebook-ready image (JPEG/PNG under ~8 MB) for a library photo, as base64.
// iPhone HEIC and very large files are converted via Drive's own JPEG preview.
export async function adReadyImage(id) {
  const m = getMedia(id);
  if (!m || m.kind !== 'photo') throw new Error('Pick a photo from the library.');
  if (/^image\/(jpeg|png)$/.test(m.mime) && (!m.size || m.size < 8e6)) {
    const bytes = await drive(`files/${id}`, { alt: 'media', supportsAllDrives: 'true' }, { raw: true });
    return { type: m.mime, data: bytes.toString('base64') };
  }
  const meta = await drive(`files/${id}`, { fields: 'thumbnailLink', supportsAllDrives: 'true' });
  const bytes = meta.thumbnailLink && await driveBytes(meta.thumbnailLink.replace(/=s\d+$/, '=s2000'));
  if (!bytes) throw new Error("Couldn't convert that photo. Try a JPG or PNG version.");
  return { type: 'image/jpeg', data: bytes.toString('base64') };
}

// Full-size file bytes (for publishing a photo to Google or Facebook). Images only, up to 15 MB.
export async function downloadImage(id) {
  const m = getMedia(id);
  if (!m || m.kind !== 'photo') throw new Error('That file is not a photo in the library.');
  if (m.size && m.size > 15e6) throw new Error('That photo is over 15 MB.');
  return { mime: m.mime, bytes: await drive(`files/${id}`, { alt: 'media', supportsAllDrives: 'true' }, { raw: true }) };
}
