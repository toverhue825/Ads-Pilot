// Google Ads via the Google Ads API (REST). Same shape as the Facebook source so the dashboard,
// suggestions and AI review treat both platforms alike. IDs are prefixed so they never collide:
//   account  gads_<customerId>     campaign  g_<campaignId>
import { config } from '../config.js';
import { db, now } from '../db.js';
import { googleAdsRequest, gbpConfigured, gbpConnected } from '../google.js';

export const PLATFORM = 'google';
export const ready = () => Boolean(gbpConfigured() && gbpConnected() && config.googleAds.developerToken && config.googleAds.customerIds.length);
const cid = (accountId) => accountId.replace(/^gads_/, '');
const micros = (v) => Number(v ?? 0) / 1e6;
const isoDay = (d) => d.toISOString().slice(0, 10);

// GAQL search with paging. Returns all rows.
async function search(customerId, query) {
  const rows = [];
  let pageToken;
  for (let i = 0; i < 20; i++) {
    const r = await googleAdsRequest(`customers/${customerId}/googleAds:search`, { method: 'POST', body: { query, ...(pageToken ? { pageToken } : {}) } });
    rows.push(...(r.results ?? []));
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return rows;
}

export async function fetchAccounts() {
  const out = [];
  for (const id of config.googleAds.customerIds) {
    const [row] = await search(id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1');
    out.push({ id: `gads_${id}`, name: `Google Ads · ${row?.customer?.descriptiveName || id}`, currency: row?.customer?.currencyCode ?? 'USD', platform: PLATFORM });
  }
  return out;
}

export async function fetchCampaigns(accountId) {
  const rows = await search(cid(accountId), `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared
    FROM campaign WHERE campaign.status != 'REMOVED'`);
  return rows.map((r) => {
    const shared = Boolean(r.campaignBudget?.explicitlyShared);
    return {
      id: `g_${r.campaign.id}`, account_id: accountId, name: r.campaign.name,
      objective: r.campaign.advertisingChannelType, status: r.campaign.status === 'ENABLED' ? 'ACTIVE' : 'PAUSED',
      // A shared budget feeds several campaigns, so budget suggestions skip it.
      budget_level: shared ? 'none' : 'campaign', daily_budget: shared ? null : micros(r.campaignBudget?.amountMicros),
      ext: JSON.stringify({ customerId: cid(accountId), campaignId: r.campaign.id, budget: r.campaignBudget?.resourceName ?? null, channel: r.campaign.advertisingChannelType }),
      adsets: [],
    };
  });
}

export async function fetchInsights(accountId, days = 45) {
  const until = new Date(); until.setDate(until.getDate() - 1);
  const since = new Date(until); since.setDate(until.getDate() - (days - 1));
  const rows = await search(cid(accountId), `
    SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM campaign WHERE segments.date BETWEEN '${isoDay(since)}' AND '${isoDay(until)}'`);
  // Also refresh the search terms used for "wasted spend" suggestions.
  await fetchSearchTerms(accountId).catch((e) => console.error('[google ads] search terms:', e.message));
  return rows.map((r) => ({
    campaign_id: `g_${r.campaign.id}`, date: r.segments.date,
    spend: micros(r.metrics.costMicros), impressions: Number(r.metrics.impressions ?? 0), clicks: Number(r.metrics.clicks ?? 0),
    leads: Math.round(Number(r.metrics.conversions ?? 0)), frequency: 0, // Google Ads has no frequency for search
  }));
}

async function fetchSearchTerms(accountId) {
  const rows = await search(cid(accountId), `
    SELECT campaign.id, search_term_view.search_term, metrics.cost_micros, metrics.clicks, metrics.conversions
    FROM search_term_view WHERE segments.date DURING LAST_30_DAYS AND metrics.cost_micros > 0
    ORDER BY metrics.cost_micros DESC LIMIT 300`);
  const ids = [...new Set(rows.map((r) => `g_${r.campaign.id}`))];
  db.exec('BEGIN');
  try {
    for (const id of ids) db.prepare('DELETE FROM search_terms WHERE campaign_id = ?').run(id);
    const ins = db.prepare('INSERT OR REPLACE INTO search_terms (campaign_id, term, cost, clicks, conversions, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(`g_${r.campaign.id}`, r.searchTermView.searchTerm, micros(r.metrics.costMicros), Number(r.metrics.clicks ?? 0), Number(r.metrics.conversions ?? 0), now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- Changes (only after someone approves a suggestion) ----------
const extOf = (campaignRow) => JSON.parse(campaignRow.ext ?? '{}');

export async function setCampaignStatus(campaignRow, status) {
  const x = extOf(campaignRow);
  await googleAdsRequest(`customers/${x.customerId}/campaigns:mutate`, {
    method: 'POST',
    body: { operations: [{ update: { resourceName: `customers/${x.customerId}/campaigns/${x.campaignId}`, status: status === 'PAUSED' ? 'PAUSED' : 'ENABLED' }, updateMask: 'status' }] },
  });
}

export async function setCampaignBudget(campaignRow, dollars) {
  const x = extOf(campaignRow);
  if (!x.budget) throw new Error('This Google Ads campaign has no budget to change.');
  await googleAdsRequest(`customers/${x.customerId}/campaignBudgets:mutate`, {
    method: 'POST',
    body: { operations: [{ update: { resourceName: x.budget, amountMicros: String(Math.round(dollars * 1e6)) }, updateMask: 'amount_micros' }] },
  });
}

// Adds search terms as exact-match negative keywords on the campaign.
export async function addNegativeKeywords(campaignRow, terms) {
  const x = extOf(campaignRow);
  const ops = terms.slice(0, 20).map((text) => ({
    create: { campaign: `customers/${x.customerId}/campaigns/${x.campaignId}`, negative: true, keyword: { text: String(text).slice(0, 80), matchType: 'EXACT' } },
  }));
  await googleAdsRequest(`customers/${x.customerId}/campaignCriteria:mutate`, { method: 'POST', body: { operations: ops, partialFailure: true } });
}
