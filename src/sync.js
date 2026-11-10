import { config } from './config.js';
import { db, now, audit, setMeta } from './db.js';
import { recordOk, recordFail } from './health.js';
import * as sample from './sources/sample.js';
import * as meta from './sources/meta.js';
import * as googleads from './sources/googleads.js';

// Facebook (or sample data) is the main source; Google Ads joins when it's connected.
export const source = config.dataSource === 'meta' ? meta : sample;
const isGoogle = (campaignId) => String(campaignId).startsWith('g_');

function currentState() {
  return {
    campaigns: new Map(db.prepare('SELECT id, status, daily_budget FROM campaigns').all().map((c) => [c.id, c])),
    adsets: new Map(db.prepare('SELECT id, status, daily_budget FROM adsets').all().map((a) => [a.id, a])),
  };
}

async function pull(src, state, platform) {
  const accounts = await src.fetchAccounts();
  return Promise.all(accounts.map(async (a) => ({
    account: { ...a, platform: a.platform ?? platform },
    campaigns: await src.fetchCampaigns(a.id, state),
    insights: await src.fetchInsights(a.id, 45),
  })));
}

export async function syncAll() {
  const state = currentState();
  // Facebook errors fail the sync (the caller records them); Google Ads errors are recorded separately
  // so one platform being down never hides the other.
  const perAccount = await pull(source, state, 'meta');
  let googleError = null;
  if (googleads.ready()) {
    try {
      perAccount.push(...await pull(googleads, state, 'google'));
      await recordOk('gads');
    } catch (e) {
      googleError = e.message;
      console.error('[google ads] sync failed:', e.message);
      await recordFail('gads', e).catch(() => {});
    }
  }

  // New accounts start with the defaults from .env; limits edited in the dashboard are kept.
  const upA = db.prepare(`
    INSERT INTO accounts (id, name, currency, target_cpl, max_change_pct, daily_cap, min_spend, platform, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, currency=excluded.currency, platform=excluded.platform`);
  const upC = db.prepare(`
    INSERT INTO campaigns (id, account_id, name, objective, status, budget_level, daily_budget, ext, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, name=excluded.name, objective=excluded.objective,
      status=excluded.status, budget_level=excluded.budget_level, daily_budget=excluded.daily_budget, ext=excluded.ext, updated_at=excluded.updated_at`);
  const upS = db.prepare(`
    INSERT INTO adsets (id, campaign_id, name, status, daily_budget) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET campaign_id=excluded.campaign_id, name=excluded.name, status=excluded.status, daily_budget=excluded.daily_budget`);
  const upI = db.prepare(`
    INSERT INTO insights (campaign_id, date, spend, impressions, clicks, leads, frequency) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id, date) DO UPDATE SET spend=excluded.spend, impressions=excluded.impressions,
      clicks=excluded.clicks, leads=excluded.leads, frequency=excluded.frequency`);

  db.exec('BEGIN');
  try {
    const ts = now();
    for (const { account: a, campaigns, insights } of perAccount) {
      upA.run(a.id, a.name, a.currency ?? 'USD', config.targetCpl, config.maxBudgetChangePct, config.dailySpendCap, config.minSpendToJudge, a.platform, ts);
      for (const c of campaigns) {
        const budget = c.budget_level === 'adsets'
          ? c.adsets.filter((s) => s.status === 'ACTIVE').reduce((sum, s) => sum + (s.daily_budget ?? 0), 0)
          : c.daily_budget;
        upC.run(c.id, a.id, c.name, c.objective, c.status, c.budget_level, budget, c.ext ?? null, ts);
        for (const s of c.adsets) upS.run(s.id, c.id, s.name, s.status, s.daily_budget);
      }
      for (const r of insights) upI.run(r.campaign_id, r.date, r.spend, r.impressions, r.clicks, r.leads, r.frequency);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setMeta('last_sync', now());
  return {
    accounts: perAccount.length, campaigns: perAccount.reduce((n, p) => n + p.campaigns.length, 0),
    rows: perAccount.reduce((n, p) => n + p.insights.length, 0), googleError,
  };
}

// Push an approved change to Facebook or Google Ads (or just the DB in sample mode), then record it.
export async function applyAction(campaignId, action, actor) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!c) throw new Error('Campaign not found');
  const g = isGoogle(campaignId);

  if (action.kind === 'pause') {
    if (g) await googleads.setCampaignStatus(c, 'PAUSED'); else await source.setCampaignStatus(campaignId, 'PAUSED');
    db.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run('PAUSED', now(), campaignId);
    audit(actor, campaignId, `Paused "${c.name}"${g ? ' (Google Ads)' : ''}`);
    return;
  }

  if (action.kind === 'negatives') {
    if (!g) throw new Error('Negative keywords apply to Google Ads campaigns only.');
    await googleads.addNegativeKeywords(c, action.terms);
    db.prepare('DELETE FROM search_terms WHERE campaign_id = ? AND term IN (SELECT value FROM json_each(?))').run(campaignId, JSON.stringify(action.terms));
    audit(actor, campaignId, `Added ${action.terms.length} negative keyword(s) to "${c.name}": ${action.terms.join(', ')}`);
    return;
  }

  if (action.kind === 'budget') {
    if (c.budget_level === 'campaign') {
      if (g) await googleads.setCampaignBudget(c, action.to); else await source.setCampaignBudget(campaignId, action.to);
      db.prepare('UPDATE campaigns SET daily_budget = ?, updated_at = ? WHERE id = ?').run(action.to, now(), campaignId);
      audit(actor, campaignId, `Changed "${c.name}" daily budget $${action.from} → $${action.to}${g ? ' (Google Ads)' : ''}`);
      return;
    }
    if (c.budget_level === 'adsets') {
      // Scale every active ad set by the same percentage so their mix stays the same.
      const scale = action.to / action.from;
      const sets = db.prepare("SELECT * FROM adsets WHERE campaign_id = ? AND status = 'ACTIVE' AND daily_budget IS NOT NULL").all(campaignId);
      if (!sets.length) throw new Error('No active ad sets with a daily budget to change.');
      let total = 0;
      for (const s of sets) {
        const to = Math.max(1, Math.round(s.daily_budget * scale));
        await source.setAdsetBudget(s.id, to);
        db.prepare('UPDATE adsets SET daily_budget = ? WHERE id = ?').run(to, s.id);
        total += to;
      }
      db.prepare('UPDATE campaigns SET daily_budget = ?, updated_at = ? WHERE id = ?').run(total, now(), campaignId);
      audit(actor, campaignId, `Changed "${c.name}" ad set budgets $${action.from} → $${total}/day total (${sets.length} ad sets, ${scale > 1 ? '+' : ''}${Math.round((scale - 1) * 100)}% each)`);
      return;
    }
    throw new Error('This campaign has no daily budget to change (it may use a lifetime or shared budget).');
  }

  audit(actor, campaignId, `Marked "${c.name}" task done: ${action.note ?? 'manual change'}`);
}
