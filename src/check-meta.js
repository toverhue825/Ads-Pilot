// Checks the Facebook connection and shows what the dashboard will see.
// Run: npm run check-meta
// Never prints the access token.
import { config } from './config.js';

const GRAPH = `https://graph.facebook.com/${config.meta.apiVersion}`;
const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);
const info = (s) => console.log(`    ${s}`);

async function get(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.meta.token}` } });
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message} (code ${body.error.code})`);
  return body;
}

console.log('\nChecking Facebook connection…\n');

if (!config.meta.token) {
  bad('META_ACCESS_TOKEN is empty in .env');
  process.exit(1);
}

// 1) Who is this token, and what can it do?
try {
  const me = await get('me', { fields: 'id,name' });
  ok(`Token works. It belongs to: ${me.name}`);
  const perms = await get('me/permissions');
  const granted = new Set(perms.data.filter((p) => p.status === 'granted').map((p) => p.permission));
  for (const p of ['ads_read', 'ads_management']) {
    granted.has(p) ? ok(`Permission ${p}`) : bad(`Missing permission ${p}. Regenerate the token with it ticked.`);
  }
} catch (e) {
  bad(`Token rejected: ${e.message}`);
  process.exit(1);
}

// 2) Which ad accounts can it see?
let accounts = [];
try {
  accounts = (await get('me/adaccounts', { fields: 'id,name,currency,account_status', limit: '50' })).data;
  if (!accounts.length) bad('The token can’t see any ad accounts. In Business Settings, assign the ad account(s) to the system user.');
  else {
    ok(`Can see ${accounts.length} ad account(s):`);
    for (const a of accounts) info(`${a.id}  ${a.name}  (${a.currency})${config.meta.adAccountIds.includes(a.id) ? '   ← selected in .env' : ''}`);
  }
} catch (e) {
  bad(`Couldn't list ad accounts: ${e.message}`);
}

if (!config.meta.adAccountIds.length) {
  bad('META_AD_ACCOUNT_IDS is empty. Copy the act_… id(s) above into .env (comma-separated for several brands) and run this again.');
  process.exit(1);
}

for (const acct of config.meta.adAccountIds) {
  console.log(`\n── ${acct}  ${accounts.find((a) => a.id === acct)?.name ?? ''}`);
  if (accounts.length && !accounts.some((a) => a.id === acct)) {
    bad(`${acct} isn't in the list above. Check the id, or assign this ad account to the system user.`);
    continue;
  }

  // Campaigns and where their budgets live.
  try {
    const camps = (await get(`${acct}/campaigns`, { fields: 'id,name,status,daily_budget,lifetime_budget', limit: '100' })).data
      .filter((c) => c.status === 'ACTIVE' || c.status === 'PAUSED');
    ok(`${camps.length} active/paused campaign(s):`);
    for (const c of camps) {
      const budget = c.daily_budget ? `$${(c.daily_budget / 100).toFixed(2)}/day (campaign budget)`
        : c.lifetime_budget ? 'lifetime budget (budget suggestions skipped)' : 'budget set on ad sets';
      info(`${c.status.padEnd(6)}  ${c.name}  –  ${budget}`);
    }
  } catch (e) {
    bad(`Couldn't read campaigns: ${e.message}`);
  }

  // What counts as a lead in this account? Show every result type from the last 30 days.
  try {
    const ins = (await get(`${acct}/insights`, { fields: 'spend,actions', date_preset: 'last_30d' })).data[0];
    if (!ins) bad('No spend in the last 30 days, so there is nothing to show yet.');
    else {
      ok(`Last 30 days spend: $${Number(ins.spend).toFixed(2)}. Result types Facebook recorded:`);
      const actions = (ins.actions ?? []).sort((a, b) => b.value - a.value);
      for (const a of actions) info(`${String(a.value).padStart(7)}  ${a.action_type}${config.meta.leadActions.includes(a.action_type) ? '   ← counted as a lead' : ''}`);
      const used = config.meta.leadActions.find((k) => actions.some((a) => a.action_type === k));
      used ? ok(`Leads will be counted from: ${used}`) : bad('None of these match META_LEAD_ACTIONS. Pick the right one from the list and set it in .env.');
    }
  } catch (e) {
    bad(`Couldn't read insights: ${e.message}`);
  }
}

console.log('\nWhen everything above is ✓, set DATA_SOURCE=meta in .env, delete the data folder, and run npm start.\n');
