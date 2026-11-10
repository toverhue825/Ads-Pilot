import { db } from './db.js';

const isoDate = (d) => d.toISOString().slice(0, 10);

// Window [start, end] of `days` ending at the latest data day, plus the equal-length window before it.
export function windows(days) {
  const latest = db.prepare('SELECT MAX(date) AS d FROM insights').get()?.d;
  const end = latest ? new Date(latest + 'T00:00:00Z') : new Date();
  const start = new Date(end); start.setUTCDate(end.getUTCDate() - (days - 1));
  const pEnd = new Date(start); pEnd.setUTCDate(start.getUTCDate() - 1);
  const pStart = new Date(pEnd); pStart.setUTCDate(pEnd.getUTCDate() - (days - 1));
  return { cur: [isoDate(start), isoDate(end)], prev: [isoDate(pStart), isoDate(pEnd)] };
}

export function derive(t) {
  const spend = t.spend ?? 0, leads = t.leads ?? 0, clicks = t.clicks ?? 0, impressions = t.impressions ?? 0;
  return {
    spend, leads, clicks, impressions,
    frequency: t.frequency ?? 0,
    cpl: leads ? spend / leads : null,
    ctr: impressions ? clicks / impressions : null,
    cpc: clicks ? spend / clicks : null,
    cpm: impressions ? (spend / impressions) * 1000 : null,
    cvr: clicks ? leads / clicks : null,
  };
}

const TOTALS = (p = '') => `SUM(${p}spend) AS spend, SUM(${p}leads) AS leads, SUM(${p}clicks) AS clicks,
  SUM(${p}impressions) AS impressions, AVG(NULLIF(${p}frequency, 0)) AS frequency`; // Google Ads has no frequency (stored as 0)

// accountId = null means all accounts.
const acctFilter = (accountId) => (accountId ? 'AND campaign_id IN (SELECT id FROM campaigns WHERE account_id = ?)' : '');
const acctArgs = (accountId) => (accountId ? [accountId] : []);

export function accountTotals([a, b], accountId = null) {
  return derive(db.prepare(`SELECT ${TOTALS()} FROM insights WHERE date BETWEEN ? AND ? ${acctFilter(accountId)}`)
    .get(a, b, ...acctArgs(accountId)));
}

export function campaignTotals([a, b], accountId = null) {
  const rows = db.prepare(`
    SELECT c.id, c.account_id, c.name, c.status, c.budget_level, c.daily_budget, ${TOTALS('i.')}
    FROM campaigns c LEFT JOIN insights i ON i.campaign_id = c.id AND i.date BETWEEN ? AND ?
    ${accountId ? 'WHERE c.account_id = ?' : ''}
    GROUP BY c.id ORDER BY spend DESC`).all(a, b, ...acctArgs(accountId));
  return rows.map((r) => ({
    id: r.id, account_id: r.account_id, name: r.name, status: r.status,
    budget_level: r.budget_level, daily_budget: r.daily_budget, ...derive(r),
  }));
}

export function daily([a, b], accountId = null) {
  return db.prepare(`SELECT date, ${TOTALS()} FROM insights WHERE date BETWEEN ? AND ? ${acctFilter(accountId)} GROUP BY date ORDER BY date`)
    .all(a, b, ...acctArgs(accountId)).map((r) => ({ date: r.date, ...derive(r) }));
}
