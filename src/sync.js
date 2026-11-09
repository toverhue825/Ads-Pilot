import { config } from './config.js';
import { db, now, audit, setMeta } from './db.js';
import * as sample from './sources/sample.js';
import * as meta from './sources/meta.js';

export const source = config.dataSource === 'meta' ? meta : sample;

function currentState() {
  return {
    campaigns: new Map(db.prepare('SELECT id, status, daily_budget FROM campaigns').all().map((c) => [c.id, c])),
    adsets: new Map(db.prepare('SELECT id, status, daily_budget FROM adsets').all().map((a) => [a.id, a])),
  };
}

export async function syncAll() {
  const state = currentState();
  const accounts = await source.fetchAccounts();
  const perAccount = await Promise.all(accounts.map(async (a) => ({
    account: a,
    campaigns: await source.fetchCampaigns(a.id, state),
    insights: await source.fetchInsights(a.id, 45),
  })));

  // New accounts start with the defaults from .env; limits edited in the dashboard are kept.
  const upA = db.prepare(`
    INSERT INTO accounts (id, name, currency, target_cpl, max_change_pct, daily_cap, min_spend, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, currency=excluded.currency`);
  const upC = db.prepare(`
    INSERT INTO campaigns (id, account_id, name, objective, status, budget_level, daily_budget, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, name=excluded.name, objective=excluded.objective,
      status=excluded.status, budget_level=excluded.budget_level, daily_budget=excluded.daily_budget, updated_at=excluded.updated_at`);
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
      upA.run(a.id, a.name, a.currency ?? 'USD', config.targetCpl, config.maxBudgetChangePct, config.dailySpendCap, config.minSpendToJudge, ts);
      for (const c of campaigns) {
        const budget = c.budget_level === 'adsets'
          ? c.adsets.filter((s) => s.status === 'ACTIVE').reduce((sum, s) => sum + (s.daily_budget ?? 0), 0)
          : c.daily_budget;
        upC.run(c.id, a.id, c.name, c.objective, c.status, c.budget_level, budget, ts);
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
  return { accounts: accounts.length, campaigns: perAccount.reduce((n, p) => n + p.campaigns.length, 0), rows: perAccount.reduce((n, p) => n + p.insights.length, 0) };
}

// Push an approved change to Facebook (or just the DB in sample mode), then record it.
export async function applyAction(campaignId, action, actor) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!c) throw new Error('Campaign not found');

  if (action.kind === 'pause') {
    await source.setCampaignStatus(campaignId, 'PAUSED');
    db.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run('PAUSED', now(), campaignId);
    audit(actor, campaignId, `Paused "${c.name}"`);
    return;
  }

  if (action.kind === 'budget') {
    if (c.budget_level === 'campaign') {
      await source.setCampaignBudget(campaignId, action.to);
      db.prepare('UPDATE campaigns SET daily_budget = ?, updated_at = ? WHERE id = ?').run(action.to, now(), campaignId);
      audit(actor, campaignId, `Changed "${c.name}" daily budget $${action.from} → $${action.to}`);
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
    throw new Error('This campaign has no daily budget to change (it may use a lifetime budget).');
  }

  audit(actor, campaignId, `Marked "${c.name}" task done: ${action.note ?? 'manual change'}`);
}
