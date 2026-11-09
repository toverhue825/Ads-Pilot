// Creates an Ad Studio ad in Facebook as a PAUSED campaign → ad set → ad, so nothing spends
// until someone turns it on in Ads Manager. Live Facebook mode only.
import { config } from './config.js';
import { db, now, audit } from './db.js';

const GRAPH = () => `https://graph.facebook.com/${config.meta.apiVersion}`;

db.exec(`
  CREATE TABLE IF NOT EXISTS fb_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL, plan_id INTEGER, ad_index INTEGER,
    campaign_id TEXT, adset_id TEXT, ad_id TEXT,
    name TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL
  );
`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
for (const c of ['page_id', 'website', 'pixel_id', 'lead_form_id']) {
  if (!hasCol('accounts', c)) db.exec(`ALTER TABLE accounts ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
}

// Meta errors carry a friendlier user-facing message; prefer it.
function metaError(body, status) {
  const e = body?.error ?? {};
  const msg = [e.error_user_title, e.error_user_msg || e.message].filter(Boolean).join(': ') || `HTTP ${status}`;
  return Object.assign(new Error(msg), { code: e.code, subcode: e.error_subcode });
}
async function get(path, params = {}, token = config.meta.token) {
  const url = new URL(`${GRAPH()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok || body.error) throw metaError(body, res.status);
  return body;
}
async function post(path, params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(`${GRAPH()}/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.meta.token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const body = await res.json();
  if (!res.ok || body.error) throw metaError(body, res.status);
  return body;
}
async function del(id) {
  await fetch(`${GRAPH()}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${config.meta.token}` } }).catch(() => {});
}

// Options for the brand's publishing settings: Pages, pixels and lead forms the token can see.
export async function publishOptions(accountId) {
  const out = { pages: [], pixels: [], forms: [], notes: [] };
  if (config.dataSource !== 'meta') { out.notes.push('Publishing works with live Facebook data only.'); return out; }
  let pageTokens = new Map();
  try {
    const r = await get('me/accounts', { fields: 'id,name,access_token', limit: '100' });
    out.pages = r.data.map((p) => ({ id: p.id, name: p.name }));
    pageTokens = new Map(r.data.filter((p) => p.access_token).map((p) => [p.id, p.access_token]));
    if (!out.pages.length) out.notes.push('No Facebook Pages are assigned to the system user yet.');
  } catch (e) { out.notes.push(`Couldn't list Pages (${e.message}). You can type the Page ID instead.`); }
  try {
    const r = await get(`${accountId}/adspixels`, { fields: 'id,name', limit: '50' });
    out.pixels = r.data.map((p) => ({ id: p.id, name: p.name }));
  } catch (e) { out.notes.push(`Couldn't list pixels (${e.message}).`); }
  const acct = db.prepare('SELECT page_id FROM accounts WHERE id = ?').get(accountId);
  const pageToken = acct?.page_id && pageTokens.get(acct.page_id);
  if (pageToken) {
    try {
      const r = await get(`${acct.page_id}/leadgen_forms`, { fields: 'id,name,status', limit: '50' }, pageToken);
      out.forms = r.data.filter((f) => f.status !== 'ARCHIVED').map((f) => ({ id: f.id, name: f.name }));
    } catch (e) { out.notes.push(`Couldn't list lead forms (${e.message}). You can type the form ID instead.`); }
  }
  return out;
}

const CTA_OK = new Set(['GET_QUOTE', 'LEARN_MORE', 'CONTACT_US', 'SIGN_UP', 'GET_OFFER', 'CALL_NOW', 'SHOP_NOW', 'APPLY_NOW']);

// draft: { planId, adIndex, primary_text, headline, description, cta, mode: 'form'|'website', dailyBudget, image: {type,data} }
export async function createPausedAd(accountId, draft, actor) {
  if (config.dataSource !== 'meta') throw new Error('Publishing works with live Facebook data only.');
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acct) throw new Error('Unknown brand.');
  if (!acct.page_id) throw new Error('Pick the Facebook Page for this brand first (⚙ Targets & limits → Facebook publishing).');
  const budget = Number(draft.dailyBudget);
  if (!(budget >= 5)) throw new Error('Daily budget must be at least $5.');
  if (budget > acct.daily_cap) throw new Error(`Daily budget can't be more than this brand's $${acct.daily_cap}/day cap.`);
  if (!draft.image?.data) throw new Error('Add an image for the ad.');
  const lengths = [['Primary text', draft.primary_text, 2000], ['Headline', draft.headline, 255], ['Description', draft.description, 255]];
  for (const [label, v, max] of lengths) if (!v || v.length > max) throw new Error(`${label} is missing or too long.`);
  if (/\[[^\]]+\]/.test(`${draft.primary_text} ${draft.headline} ${draft.description}`)) {
    throw new Error('The ad still has [bracketed] placeholders. Fill them in or remove them first.');
  }
  const cta = CTA_OK.has(draft.cta) ? draft.cta : 'LEARN_MORE';

  let objective, adset;
  const base = {
    billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: String(Math.round(budget * 100)),
    targeting: { geo_locations: { countries: ['US'] }, age_min: 25, targeting_automation: { advantage_audience: 1 } },
    status: 'PAUSED',
  };
  if (draft.mode === 'form') {
    if (!acct.lead_form_id) throw new Error('Pick the lead form for this brand first (⚙ Targets & limits → Facebook publishing).');
    objective = 'OUTCOME_LEADS';
    adset = { ...base, optimization_goal: 'LEAD_GENERATION', destination_type: 'ON_AD', promoted_object: { page_id: acct.page_id } };
  } else {
    if (!/^https?:\/\//.test(acct.website)) throw new Error('Add the brand website (starting with https://) first (⚙ Targets & limits → Facebook publishing).');
    if (acct.pixel_id) {
      objective = 'OUTCOME_LEADS';
      adset = { ...base, optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', promoted_object: { pixel_id: acct.pixel_id, custom_event_type: 'LEAD' } };
    } else {
      objective = 'OUTCOME_TRAFFIC';
      adset = { ...base, optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE' };
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `Ads Pilot · ${draft.headline.slice(0, 40)} · ${stamp}`;
  const made = {};
  try {
    const up = await post(`${accountId}/adimages`, { bytes: draft.image.data });
    const imageHash = Object.values(up.images ?? {})[0]?.hash;
    if (!imageHash) throw new Error('Facebook did not accept the image.');

    made.campaign = (await post(`${accountId}/campaigns`, {
      name, objective, status: 'PAUSED', special_ad_categories: [], buying_type: 'AUCTION', is_adset_budget_sharing_enabled: false,
    })).id;
    made.adset = (await post(`${accountId}/adsets`, { ...adset, name: `${name} · ad set`, campaign_id: made.campaign })).id;

    const link = draft.mode === 'form' ? (acct.website || `https://www.facebook.com/${acct.page_id}`) : acct.website;
    const creative = (await post(`${accountId}/adcreatives`, {
      name: `${name} · creative`,
      object_story_spec: {
        page_id: acct.page_id,
        link_data: {
          link, message: draft.primary_text, name: draft.headline, description: draft.description, image_hash: imageHash,
          call_to_action: { type: cta, value: draft.mode === 'form' ? { lead_gen_form_id: acct.lead_form_id } : { link } },
        },
      },
    })).id;
    made.ad = (await post(`${accountId}/ads`, { name: `${name} · ad`, adset_id: made.adset, creative: { creative_id: creative }, status: 'PAUSED' })).id;
  } catch (e) {
    // Remove the half-built campaign so nothing incomplete is left in the account.
    if (made.campaign) await del(made.campaign);
    throw e;
  }

  db.prepare(`INSERT INTO fb_drafts (account_id, plan_id, ad_index, campaign_id, adset_id, ad_id, name, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(accountId, draft.planId ?? null, draft.adIndex ?? null, made.campaign, made.adset, made.ad, name, now(), actor);
  audit(actor, made.campaign, `Created paused campaign "${name}" ($${budget}/day, ${draft.mode === 'form' ? 'lead form' : 'website'})`);
  const act = accountId.replace(/^act_/, '');
  return {
    campaignId: made.campaign, name,
    link: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}&selected_campaign_ids=${made.campaign}`,
  };
}
