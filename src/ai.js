// AI insights: Claude reads the last 7 days of numbers (vs the 7 before) and writes
// a plain-English summary, recommended next steps, and fresh ad copy ideas.
// It only advises; it never changes anything in Facebook.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { db, now, audit } from './db.js';
import { windows, accountTotals, campaignTotals } from './metrics.js';

export const aiEnabled = () => Boolean(config.ai.apiKey);
const client = () => new Anthropic({ apiKey: config.ai.apiKey });

const SYSTEM = `You are a senior paid-social strategist reviewing a company's Facebook and Instagram lead-generation ads.
The people reading your output own the business and are not ad specialists. Write plainly, in short sentences, with specific numbers.

How to work:
- Judge everything against the brand's target cost per lead. Cost per lead and number of leads matter most; CTR, click-to-lead rate, CPM and frequency explain why.
- Compare the last 7 days to the 7 days before. Call out what changed and the likely reason.
- Only state facts the data supports. If a cause is a guess, say "likely" or "possibly". Don't invent numbers.
- Recommended actions should be things a person can do in Ads Manager this week (new creative, audience changes, landing page or lead form fixes, budget shifts, testing an offer). The dashboard already makes simple pause/budget suggestions; add judgment it can't, rather than repeating them.
- Ad copy ideas: write for campaigns that are tired (high frequency or falling click-through rate) or over target. Use the brand description for what is sold and to whom. Never invent prices, discounts, guarantees or claims the description doesn't support. Keep Facebook limits in mind: headline under 40 characters, primary text under 125 characters works best.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'wins', 'concerns', 'actions', 'copy_ideas'],
  properties: {
    headline: { type: 'string', description: 'One sentence, the single most important takeaway.' },
    summary: { type: 'string', description: '2–4 sentences on overall performance vs target and the prior week.' },
    wins: { type: 'array', items: { type: 'string' }, description: 'What is working, with numbers. 0–3 items.' },
    concerns: { type: 'array', items: { type: 'string' }, description: 'What is not working and likely why. 0–3 items.' },
    actions: {
      type: 'array',
      description: 'Top recommended actions for this week, most valuable first. 2–4 items.',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'why', 'campaign'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          campaign: { type: 'string', description: 'Exact campaign name, or "All campaigns".' },
        },
      },
    },
    copy_ideas: {
      type: 'array',
      description: 'New ad copy to test. 0–4 items.',
      items: {
        type: 'object', additionalProperties: false, required: ['campaign', 'angle', 'headline', 'primary_text'],
        properties: {
          campaign: { type: 'string', description: 'Exact campaign name this is for.' },
          angle: { type: 'string', description: 'The idea behind it in a few words, e.g. "Urgency: winter is coming".' },
          headline: { type: 'string' },
          primary_text: { type: 'string' },
        },
      },
    },
  },
};

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
function campaignRow(c, p) {
  return {
    name: c.name, status: c.status,
    daily_budget: c.daily_budget, budget_set_on: c.budget_level,
    last_7d: { spend: r2(c.spend), leads: c.leads, cost_per_lead: r2(c.cpl), ctr_pct: r2(c.ctr * 100), click_to_lead_pct: r2(c.cvr * 100), cpm: r2(c.cpm), frequency: r2(c.frequency) },
    prior_7d: p ? { spend: r2(p.spend), leads: p.leads, cost_per_lead: r2(p.cpl), ctr_pct: r2(p.ctr * 100), frequency: r2(p.frequency) } : null,
  };
}

// Everything Claude sees, as JSON. accountId null = every enabled brand.
function buildInput(accountId) {
  const { cur, prev } = windows(7);
  const accounts = db.prepare(`SELECT * FROM accounts WHERE enabled = 1 ${accountId ? 'AND id = ?' : ''} ORDER BY name`)
    .all(...(accountId ? [accountId] : []));
  const pending = db.prepare(`SELECT s.title FROM suggestions s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.status = 'pending' AND c.account_id = ?`);
  return {
    period: { last_7d: cur, prior_7d: prev },
    brands: accounts.map((a) => {
      const before = new Map(campaignTotals(prev, a.id).map((c) => [c.id, c]));
      const t = accountTotals(cur, a.id), tp = accountTotals(prev, a.id);
      return {
        brand: a.name,
        description: a.context || '(not provided)',
        target_cost_per_lead: a.target_cpl,
        daily_spend_cap: a.daily_cap,
        totals: { last_7d: { spend: r2(t.spend), leads: t.leads, cost_per_lead: r2(t.cpl) }, prior_7d: { spend: r2(tp.spend), leads: tp.leads, cost_per_lead: r2(tp.cpl) } },
        campaigns: campaignTotals(cur, a.id).filter((c) => c.spend > 0 || c.status === 'ACTIVE').map((c) => campaignRow(c, before.get(c.id))),
        dashboard_suggestions_waiting: pending.all(a.id).map((s) => s.title),
      };
    }),
  };
}

export async function generateInsight(accountId, actor) {
  if (!aiEnabled()) throw new Error('AI insights are off. Add ANTHROPIC_API_KEY to .env to turn them on.');
  const input = buildInput(accountId);
  if (!input.brands.length) throw new Error('No brands with suggestions turned on.');

  let response;
  try {
    // Server-side fallback: if Claude's safety classifiers decline (rare for ad data),
    // the API retries on Anthropic's recommended fallback model instead of failing.
    response = await client().beta.messages.create({
      model: config.ai.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: config.ai.effort, format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Here is the ad performance data as JSON. Write this week's review${input.brands.length > 1 ? ' covering all brands; name the brand when it matters' : ''}.\n\n${JSON.stringify(input, null, 1)}`,
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check ANTHROPIC_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is busy (rate limited). Try again in a minute.');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`Claude request was rejected: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to write this review. Try again, or check the brand description.');
  if (response.stop_reason === 'max_tokens') throw new Error('The review was cut off. Try again.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let content;
  try { content = JSON.parse(text); } catch { throw new Error('Claude returned an unreadable answer. Try again.'); }

  const info = db.prepare(`INSERT INTO ai_insights (account_id, created_at, created_by, period_start, period_end, content, model, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    accountId, now(), actor, input.period.last_7d[0], input.period.last_7d[1],
    JSON.stringify(content), response.model, response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null,
  );
  audit(actor, null, `Generated AI review${accountId ? ` for ${input.brands[0].brand}` : ' for all brands'}`);
  return getInsight(Number(info.lastInsertRowid));
}

function shape(row) {
  return row ? { ...row, content: JSON.parse(row.content) } : null;
}
export function getInsight(id) {
  return shape(db.prepare('SELECT * FROM ai_insights WHERE id = ?').get(id));
}
export function latestInsight(accountId) {
  return shape(db.prepare(`SELECT * FROM ai_insights WHERE ${accountId ? 'account_id = ?' : 'account_id IS NULL'} ORDER BY id DESC LIMIT 1`)
    .get(...(accountId ? [accountId] : [])));
}
