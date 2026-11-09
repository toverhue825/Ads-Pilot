// Realistic fake data so the dashboard can be built and tested before Meta access is set up.
// Two sample brands; each campaign has a "personality" so the suggestion engine has something to react to.

const ACCOUNTS = [
  { id: 'act_sample_a', name: 'Sample Brand A', currency: 'USD' },
  { id: 'act_sample_b', name: 'Sample Brand B', currency: 'USD' },
];

// budgetLevel 'adsets' = budget lives on the ad sets (Facebook "ABO"), like many real accounts.
const PROFILES = [
  { acct: 'act_sample_a', id: 'c_quote', name: 'Lead Form – Quote Requests', budget: 120, cpc: 1.35, ctr: 0.021, cvr: 0.055, freq: 1.8, trend: 0 },
  { acct: 'act_sample_a', id: 'c_retarget', name: 'Retargeting – Website Visitors', budget: 60, cpc: 1.10, ctr: 0.028, cvr: 0.085, freq: 2.4, trend: 0, budgetLevel: 'adsets', adsets: ['Visited pricing page', 'Visited 30 days'] },
  { acct: 'act_sample_a', id: 'c_lookalike', name: 'Lookalike – Past Customers', budget: 90, cpc: 1.95, ctr: 0.012, cvr: 0.016, freq: 1.6, trend: 0 },
  { acct: 'act_sample_a', id: 'c_seasonal', name: 'Seasonal Promo – Fall Offer', budget: 80, cpc: 1.25, ctr: 0.024, cvr: 0.035, freq: 3.2, trend: -0.04 },
  { acct: 'act_sample_a', id: 'c_video', name: 'Video – Brand Awareness', budget: 50, cpc: 2.60, ctr: 0.006, cvr: 0.0, freq: 2.0, trend: 0 },
  { acct: 'act_sample_b', id: 'c_b_quote', name: 'Building Quotes – Lead Form', budget: 150, cpc: 2.10, ctr: 0.016, cvr: 0.03, freq: 1.9, trend: 0, budgetLevel: 'adsets', adsets: ['Farm & Ag', 'Commercial', 'Garages'] },
  { acct: 'act_sample_b', id: 'c_b_retarget', name: 'Retargeting – Quote Abandoners', budget: 40, cpc: 1.40, ctr: 0.025, cvr: 0.09, freq: 2.9, trend: 0 },
  { acct: 'act_sample_b', id: 'c_b_broad', name: 'Broad – Metal Buildings', budget: 100, cpc: 1.80, ctr: 0.011, cvr: 0.012, freq: 1.4, trend: 0 },
];

// Deterministic PRNG so numbers are stable between restarts.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const isoDate = (d) => d.toISOString().slice(0, 10);
const seedOf = (str) => str.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);

export async function fetchAccounts() {
  return ACCOUNTS;
}

export async function fetchCampaigns(accountId, state) {
  return PROFILES.filter((p) => p.acct === accountId).map((p) => {
    const s = state.campaigns.get(p.id);
    const status = s?.status ?? 'ACTIVE';
    if (p.budgetLevel === 'adsets') {
      const adsets = p.adsets.map((name, i) => {
        const id = `${p.id}_as${i}`;
        return { id, campaign_id: p.id, name, status: 'ACTIVE', daily_budget: state.adsets.get(id)?.daily_budget ?? Math.round(p.budget / p.adsets.length) };
      });
      return { id: p.id, account_id: accountId, name: p.name, objective: 'LEADS', status, budget_level: 'adsets', adsets };
    }
    return { id: p.id, account_id: accountId, name: p.name, objective: 'LEADS', status, budget_level: 'campaign', daily_budget: s?.daily_budget ?? p.budget, adsets: [] };
  });
}

export async function fetchInsights(accountId, days = 45) {
  const rows = [];
  const today = new Date();
  for (const p of PROFILES.filter((x) => x.acct === accountId)) {
    const r = rng(seedOf(p.id));
    for (let i = days; i >= 1; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const age = days - i;
      const weekendDip = d.getDay() === 0 || d.getDay() === 6 ? 0.82 : 1;
      const noise = 0.8 + r() * 0.4;
      // A campaign with a negative trend tires out: CTR decays and frequency climbs.
      const tired = p.trend ? Math.max(0, age - days + 18) : 0;
      const decay = Math.max(0.35, 1 + p.trend * tired);
      const ctr = p.ctr * decay * (0.9 + r() * 0.2);
      const spend = +(p.budget * weekendDip * (0.88 + r() * 0.14)).toFixed(2);
      const clicks = Math.round(spend / (p.cpc * noise));
      const impressions = Math.round(clicks / ctr);
      const leads = Math.max(0, Math.round(clicks * p.cvr * decay * (0.6 + r() * 0.8)));
      const frequency = +(p.freq + tired * 0.09 + r() * 0.3).toFixed(2);
      rows.push({ campaign_id: p.id, date: isoDate(d), spend, impressions, clicks, leads, frequency });
    }
  }
  return rows;
}

// Sample mode: changes are only recorded in the database.
export async function setCampaignStatus() {}
export async function setCampaignBudget() {}
export async function setAdsetBudget() {}
