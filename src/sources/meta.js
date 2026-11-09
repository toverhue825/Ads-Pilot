// Live Facebook/Instagram ads via the Meta Marketing API (Graph API).
// Needs a System User access token with ads_read + ads_management on each ad account.
import { config } from '../config.js';

const GRAPH = () => `https://graph.facebook.com/${config.meta.apiVersion}`;

function assertConfigured() {
  if (!config.meta.token || !config.meta.adAccountIds.length) {
    throw new Error('META_ACCESS_TOKEN and META_AD_ACCOUNT_IDS must be set when DATA_SOURCE=meta');
  }
}

async function graphGet(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(`${GRAPH()}/${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.meta.token}` } });
  const body = await res.json();
  if (!res.ok || body.error) throw Object.assign(new Error(`Meta API: ${body.error?.message ?? res.statusText}`), { code: body.error?.code });
  return body;
}

async function graphGetAll(path, params) {
  const out = [];
  let page = await graphGet(path, params);
  out.push(...(page.data ?? []));
  while (page.paging?.next) {
    page = await graphGet(page.paging.next);
    out.push(...(page.data ?? []));
  }
  return out;
}

async function graphPost(id, params) {
  const res = await fetch(`${GRAPH()}/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.meta.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw Object.assign(new Error(`Meta API: ${body.error?.message ?? res.statusText}`), { code: body.error?.code });
  return body;
}

const dollars = (minor) => (minor ? Number(minor) / 100 : null); // Meta uses cents
const live = (s) => s !== 'DELETED' && s !== 'ARCHIVED';

export async function fetchAccounts() {
  assertConfigured();
  return Promise.all(config.meta.adAccountIds.map(async (id) => {
    const a = await graphGet(id, { fields: 'id,name,currency' });
    return { id: a.id, name: a.name, currency: a.currency };
  }));
}

export async function fetchCampaigns(accountId) {
  assertConfigured();
  const [camps, adsets] = await Promise.all([
    graphGetAll(`${accountId}/campaigns`, { fields: 'id,name,objective,status,daily_budget,lifetime_budget', limit: '200' }),
    graphGetAll(`${accountId}/adsets`, { fields: 'id,name,campaign_id,status,daily_budget', limit: '500' }),
  ]);
  return camps.filter((c) => live(c.status)).map((c) => {
    const own = adsets.filter((a) => a.campaign_id === c.id && live(a.status)).map((a) => ({
      id: a.id, campaign_id: c.id, name: a.name, status: a.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED', daily_budget: dollars(a.daily_budget),
    }));
    const level = c.daily_budget ? 'campaign' : own.some((a) => a.daily_budget) ? 'adsets' : 'none';
    return {
      id: c.id, account_id: accountId, name: c.name, objective: c.objective,
      status: c.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
      budget_level: level, daily_budget: level === 'campaign' ? dollars(c.daily_budget) : null,
      adsets: own,
    };
  });
}

export async function fetchInsights(accountId, days = 45) {
  assertConfigured();
  const until = new Date();
  until.setDate(until.getDate() - 1);
  const since = new Date(until);
  since.setDate(until.getDate() - (days - 1));
  const rows = await graphGetAll(`${accountId}/insights`, {
    level: 'campaign',
    fields: 'campaign_id,spend,impressions,clicks,frequency,actions',
    time_range: { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) },
    time_increment: '1',
    limit: '500',
  });
  return rows.map((r) => {
    const actions = new Map((r.actions ?? []).map((a) => [a.action_type, Number(a.value)]));
    const leadKey = config.meta.leadActions.find((k) => actions.has(k));
    return {
      campaign_id: r.campaign_id,
      date: r.date_start,
      spend: Number(r.spend ?? 0),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      leads: leadKey ? actions.get(leadKey) : 0,
      frequency: Number(r.frequency ?? 0),
    };
  });
}

export async function setCampaignStatus(id, status) {
  await graphPost(id, { status });
}
export async function setCampaignBudget(id, dollarsValue) {
  await graphPost(id, { daily_budget: String(Math.round(dollarsValue * 100)) });
}
export async function setAdsetBudget(id, dollarsValue) {
  await graphPost(id, { daily_budget: String(Math.round(dollarsValue * 100)) });
}
