// Suggestion engine: plain, explainable rules on the last 7 days vs the 7 before.
// Each brand (ad account) uses its own target and limits. Nothing changes until a person approves it.
import { db, now } from './db.js';
import { windows, campaignTotals } from './metrics.js';

const money = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const roundBudget = (n) => Math.max(5, Math.round(n));

function suggestForAccount(acct, cur, prev) {
  const current = campaignTotals(cur, acct.id);
  const before = new Map(campaignTotals(prev, acct.id).map((c) => [c.id, c]));
  const target = acct.target_cpl;
  const step = acct.max_change_pct / 100;
  const level = (c) => (c.budget_level === 'adsets' ? ' (split across its ad sets)' : '');

  const totalBudget = current.filter((c) => c.status === 'ACTIVE').reduce((s, c) => s + (c.daily_budget ?? 0), 0);
  let headroom = Math.max(0, acct.daily_cap - totalBudget);

  const out = [];
  for (const c of current) {
    if (c.status !== 'ACTIVE' || c.spend < acct.min_spend) continue;
    const p = before.get(c.id);
    const add = (s) => out.push({ campaign_id: c.id, ...s });

    // 1) Spending with nothing to show for it.
    if (c.leads === 0 && c.spend >= target * 2) {
      add({
        type: 'pause', severity: 'critical', title: `Pause "${c.name}"`,
        reason: `Spent ${money(c.spend)} in the last 7 days with 0 leads (target is ${money(target)} per lead).`,
        action: { kind: 'pause' },
      });
      continue;
    }

    // 2) Far too expensive per lead.
    if (c.cpl != null && c.cpl > target * 2 && c.spend >= target * 3) {
      add({
        type: 'pause', severity: 'critical', title: `Pause "${c.name}"`,
        reason: `Cost per lead is ${money(c.cpl)}, more than double the ${money(target)} target, over ${money(c.spend)} of spend.`,
        action: { kind: 'pause' },
      });
      continue;
    }

    // 3) Expensive but salvageable → trim budget.
    if (c.cpl != null && c.cpl > target * 1.3 && c.daily_budget) {
      const to = roundBudget(c.daily_budget * (1 - step));
      add({
        type: 'budget_down', severity: 'warning', title: `Cut "${c.name}" budget to $${to}/day${level(c)}`,
        reason: `Cost per lead is ${money(c.cpl)}, ${pct(c.cpl / target - 1)} above the ${money(target)} target. Trimming ${acct.max_change_pct}% moves money toward cheaper leads.`,
        action: { kind: 'budget', from: c.daily_budget, to },
      });
    }

    // 4) Winner → scale it, within this brand's daily cap.
    if (c.cpl != null && c.cpl <= target * 0.8 && c.leads >= 5 && c.daily_budget && headroom > 0) {
      const to = roundBudget(Math.min(c.daily_budget * (1 + step), c.daily_budget + headroom));
      if (to > c.daily_budget) {
        headroom -= to - c.daily_budget;
        add({
          type: 'budget_up', severity: 'good', title: `Raise "${c.name}" budget to $${to}/day${level(c)}`,
          reason: `Cost per lead is ${money(c.cpl)}, ${pct(1 - c.cpl / target)} under the ${money(target)} target, on ${c.leads} leads. Room to grow while staying under this brand's ${money(acct.daily_cap)}/day cap.`,
          action: { kind: 'budget', from: c.daily_budget, to },
        });
      }
    }

    // 5) Ad fatigue: people have seen it too often, or clicks are falling off.
    const ctrDrop = p?.ctr && c.ctr ? 1 - c.ctr / p.ctr : 0;
    if (c.frequency > 3.5 || ctrDrop > 0.3) {
      add({
        type: 'refresh_creative', severity: 'warning', title: `Refresh the ads in "${c.name}"`,
        reason: [
          c.frequency > 3.5 ? `People see these ads ${c.frequency.toFixed(1)}× on average` : null,
          ctrDrop > 0.3 ? `click-through rate fell ${pct(ctrDrop)} week over week (${pct(p.ctr)} → ${pct(c.ctr)})` : null,
        ].filter(Boolean).join(', and ') + '. New images or copy usually bring the cost back down.',
        action: { kind: 'manual', note: 'New creative uploaded' },
      });
    }

    // 6) Ads aren't getting clicked.
    if (c.ctr != null && c.ctr < 0.008 && c.leads > 0) {
      add({
        type: 'review_targeting', severity: 'warning', title: `Review audience for "${c.name}"`,
        reason: `Only ${pct(c.ctr)} of people who see these ads click. Usually means the audience is too broad or the offer isn't landing.`,
        action: { kind: 'manual', note: 'Audience reviewed' },
      });
    }
  }
  // 7) Google Ads: search terms that cost money and never produced a lead → block them.
  if (acct.platform === 'google') {
    const floor = Math.max(10, target * 0.5);
    const rows = db.prepare(`SELECT s.campaign_id, s.term, s.cost, s.clicks FROM search_terms s
      JOIN campaigns c ON c.id = s.campaign_id WHERE c.account_id = ? AND c.status = 'ACTIVE' AND s.conversions = 0 AND s.cost >= ?
      ORDER BY s.cost DESC`).all(acct.id, floor);
    const byCampaign = new Map();
    for (const r of rows) {
      if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, []);
      if (byCampaign.get(r.campaign_id).length < 8) byCampaign.get(r.campaign_id).push(r);
    }
    for (const [campaignId, terms] of byCampaign) {
      const name = current.find((c) => c.id === campaignId)?.name ?? 'campaign';
      const total = terms.reduce((s, t) => s + t.cost, 0);
      out.push({
        campaign_id: campaignId, type: 'negatives', severity: 'warning',
        title: `Block ${terms.length} search term${terms.length > 1 ? 's' : ''} wasting money in "${name}"`,
        reason: `In the last 30 days these searches cost ${money(total)} with no leads: ${terms.map((t) => `"${t.term}" (${money(t.cost)})`).join(', ')}. Approving adds them as exact-match negative keywords so your ads stop showing for them.`,
        action: { kind: 'negatives', terms: terms.map((t) => t.term) },
      });
    }
  }
  return out;
}

export function runEngine() {
  const { cur, prev } = windows(7);
  const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1').all();
  const out = accounts.flatMap((a) => suggestForAccount(a, cur, prev));

  // Don't repeat a suggestion that is already waiting for a decision.
  const pending = db.prepare("SELECT 1 FROM suggestions WHERE campaign_id = ? AND type = ? AND status = 'pending'");
  const insert = db.prepare(`INSERT INTO suggestions (campaign_id, type, severity, title, reason, action, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let created = 0;
  for (const s of out) {
    if (pending.get(s.campaign_id, s.type)) continue;
    insert.run(s.campaign_id, s.type, s.severity, s.title, s.reason, JSON.stringify(s.action), now());
    created++;
  }

  // Suggestions older than 3 days are based on stale numbers.
  db.prepare("UPDATE suggestions SET status = 'expired' WHERE status = 'pending' AND created_at < ?")
    .run(new Date(Date.now() - 3 * 864e5).toISOString());

  return { created };
}

// After a brand's limits change, replace its waiting suggestions with ones based on the new limits.
export function refreshAccountSuggestions(accountId) {
  db.prepare(`UPDATE suggestions SET status = 'expired' WHERE status = 'pending'
    AND campaign_id IN (SELECT id FROM campaigns WHERE account_id = ?)`).run(accountId);
  return runEngine();
}
