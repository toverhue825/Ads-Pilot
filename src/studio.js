// Ad Studio: Claude researches competitors on the web (plus any Ad Library screenshots
// you upload) and writes original Facebook ads for your brand. Advice only: nothing is
// created in Facebook from here.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { db, now, audit, brandBrief } from './db.js';
import { windows, campaignTotals } from './metrics.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS ad_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL,          -- running | done | failed
    request TEXT NOT NULL,         -- JSON (without images)
    result TEXT,                   -- JSON
    error TEXT,
    model TEXT, input_tokens INTEGER, output_tokens INTEGER, searches INTEGER
  );
`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
if (!hasCol('accounts', 'competitors')) db.exec("ALTER TABLE accounts ADD COLUMN competitors TEXT NOT NULL DEFAULT ''");
// Anything left "running" when the server restarted will never finish.
db.prepare("UPDATE ad_plans SET status = 'failed', error = 'Interrupted by a server restart. Please run it again.' WHERE status = 'running'").run();

const SYSTEM = `You are a senior direct-response copywriter and paid-social strategist. You research a company's competitors and write Facebook/Instagram ads that win against them.

How to work:
1. Research each named competitor with web search: their website, what they sell, prices or offers they advertise, guarantees, financing, delivery claims, reviews and common complaints. Keep it efficient: a few searches per competitor at most.
2. If the user attached screenshots or text of competitor ads (from the Meta Ad Library), study the hooks, offers, formats and calls to action they use.
3. Find the gaps: what customers want that competitors don't say well, and where the brand can credibly stand out.
4. Write original ads for the brand. Learn from what works for competitors, but never copy their wording, and never name or disparage competitors in ad copy.

Rules for the ads:
- Use the brand facts for specifics (turnaround times, warranties, delivery, financing, service area): they are true and approved for ads. Only claim what the brand facts, description, offer, or brand's own website support. Never invent prices, discounts, guarantees, delivery times, warranties, certifications or awards. Prefer writing around a missing fact over using a placeholder; use [brackets] only when the ad truly needs a fact that isn't provided.
- Follow Meta advertising policy: no personal attributes ("Are you a farmer?" style call-outs about the viewer), no fake urgency, no before/after or misleading claims.
- Length limits (count characters carefully; Facebook cuts off anything longer): primary_text 125 characters or fewer, with the hook first. headline 40 or fewer. description 30 or fewer. long_text is an optional fuller version of the primary text (up to about 400 characters) for testing a "See more" style; leave it empty if not useful.
- If the brand description includes a website, read it to learn the brand's real offers before writing.
- Vary the angles (price/value, speed, durability, financing, use case, local/trust, seasonal) so the user can test them against each other.
- Write plainly for owners who aren't marketers.

When you are done researching, call save_ad_plan exactly once with the full result. Put the URLs you relied on in sources.`;

const CTAS = ['GET_QUOTE', 'LEARN_MORE', 'CONTACT_US', 'SIGN_UP', 'GET_OFFER', 'CALL_NOW', 'SHOP_NOW', 'APPLY_NOW'];
const str = { type: 'string' };
const strs = { type: 'array', items: str };
const SAVE_TOOL = {
  name: 'save_ad_plan',
  description: 'Save the finished competitor research and ad variations. Call once, at the end.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['summary', 'competitors', 'gaps', 'ads', 'sources'],
    properties: {
      summary: { type: 'string', description: '2-3 sentences: how competitors advertise and the strategy these ads take.' },
      competitors: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['name', 'positioning', 'offers', 'strengths', 'weaknesses'],
          properties: {
            name: str,
            positioning: { type: 'string', description: 'How they sell themselves, one sentence.' },
            offers: { ...strs, description: 'Offers, prices, promos or guarantees they advertise (only what you found).' },
            strengths: strs,
            weaknesses: { ...strs, description: 'Gaps or complaints the brand can exploit (without naming them in ads).' },
          },
        },
      },
      gaps: { ...strs, description: 'The biggest openings for the brand, most valuable first.' },
      ads: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['angle', 'why_it_wins', 'primary_text', 'long_text', 'headline', 'description', 'cta', 'image_idea', 'audience'],
          properties: {
            angle: { type: 'string', description: 'Short label, e.g. "Speed: up in weeks, not months".' },
            why_it_wins: { type: 'string', description: 'One sentence: which competitor gap this exploits.' },
            primary_text: { type: 'string', description: '125 characters or fewer.' },
            long_text: { type: 'string', description: 'Optional fuller version, up to ~400 characters, or empty string.' },
            headline: { type: 'string', description: '40 characters or fewer.' },
            description: { type: 'string', description: '30 characters or fewer.' },
            cta: { type: 'string', enum: CTAS },
            image_idea: { type: 'string', description: 'What the image or video should show.' },
            audience: { type: 'string', description: 'Who to target in Ads Manager (interests, location radius, etc.).' },
          },
        },
      },
      sources: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: str, url: str } },
      },
    },
  },
};

const running = new Map(); // planId -> true

export function listPlans(accountId) {
  return db.prepare(`SELECT id, account_id, created_at, created_by, status, request, result, error FROM ad_plans
    WHERE ${accountId ? 'account_id = ?' : '1=1'} ORDER BY id DESC LIMIT 10`).all(...(accountId ? [accountId] : []))
    .map((r) => ({ ...r, request: JSON.parse(r.request), result: r.result ? JSON.parse(r.result) : null }));
}
export function getPlan(id) {
  const r = db.prepare('SELECT * FROM ad_plans WHERE id = ?').get(id);
  return r ? { ...r, request: JSON.parse(r.request), result: r.result ? JSON.parse(r.result) : null } : null;
}

// Starts the job and returns its id right away; the dashboard polls for the result (it takes a few minutes).
export function startPlan(req, actor) {
  if (!config.ai.apiKey) throw new Error('AI is off. Add ANTHROPIC_API_KEY to turn on the Ad Studio.');
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.accountId);
  if (!acct) throw new Error('Pick a brand first.');
  const competitors = req.competitors.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (!competitors.length) throw new Error('Name at least one competitor.');
  if ([...running.values()].length >= 2) throw new Error('Two ad plans are already being written. Try again in a few minutes.');

  db.prepare('UPDATE accounts SET competitors = ? WHERE id = ?').run(competitors.join(', '), acct.id);
  const request = {
    competitors, offer: req.offer ?? '', destination: req.destination ?? '', audience: req.audience ?? '',
    count: Math.min(6, Math.max(2, Number(req.count) || 4)), pasted: (req.pasted ?? '').slice(0, 6000),
    images: (req.images ?? []).length,
  };
  const id = Number(db.prepare(`INSERT INTO ad_plans (account_id, created_at, created_by, status, request) VALUES (?, ?, ?, 'running', ?)`)
    .run(acct.id, now(), actor, JSON.stringify(request)).lastInsertRowid);
  running.set(id, true);
  audit(actor, null, `Started Ad Studio for ${acct.name} vs ${competitors.join(', ')}`);

  run(id, acct, request, req.images ?? [])
    .catch((e) => {
      const msg = e instanceof Anthropic.AuthenticationError ? 'Anthropic rejected the API key.'
        : e instanceof Anthropic.RateLimitError ? 'Claude is busy right now. Try again in a minute.'
        : e instanceof Anthropic.APIError ? `Claude API error ${e.status ?? ''}: ${e.message}` : e.message;
      db.prepare("UPDATE ad_plans SET status = 'failed', error = ? WHERE id = ?").run(msg.slice(0, 500), id);
      console.error('[studio] failed:', msg);
    })
    .finally(() => running.delete(id));
  return id;
}

async function run(id, acct, request, images) {
  const client = new Anthropic({ apiKey: config.ai.apiKey });
  const { cur } = windows(30);
  const ownCampaigns = campaignTotals(cur, acct.id).filter((c) => c.spend > 0)
    .map((c) => `${c.name}: $${c.spend.toFixed(0)} spent, ${c.leads} leads${c.cpl ? `, $${c.cpl.toFixed(2)} per lead` : ''}`);

  const brief = [
    `Brand: ${acct.name}`,
    brandBrief(acct),
    `Target cost per lead: $${acct.target_cpl}`,
    `Competitors to research: ${request.competitors.join(', ')}`,
    request.offer && `Offer or promotion to feature: ${request.offer}`,
    request.destination && `Where the ad sends people: ${request.destination}`,
    request.audience && `Audience notes: ${request.audience}`,
    ownCampaigns.length ? `The brand's own campaigns, last 30 days:\n- ${ownCampaigns.join('\n- ')}` : 'The brand has no ad results yet.',
    request.pasted && `Competitor ads the user copied from the Meta Ad Library:\n${request.pasted}`,
    `Write ${request.count} ad variations with different angles.`,
  ].filter(Boolean).join('\n\n');

  const content = [
    ...images.slice(0, 4).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } })),
    { type: 'text', text: (images.length ? `The ${images.length} image(s) above are screenshots of competitor ads from the Meta Ad Library.\n\n` : '') + brief },
  ];
  const messages = [{ role: 'user', content }];
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 12, user_location: { type: 'approximate', country: 'US' } },
    SAVE_TOOL,
  ];

  let inTok = 0, outTok = 0, searches = 0, nudged = false, model = config.ai.model;
  for (let turn = 0; turn < 8; turn++) {
    const stream = client.beta.messages.stream({
      model: config.ai.model,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high' }, // research + persuasion: worth the extra thinking
      system: SYSTEM,
      tools,
      messages,
    });
    const msg = await stream.finalMessage();
    model = msg.model;
    inTok += msg.usage?.input_tokens ?? 0;
    outTok += msg.usage?.output_tokens ?? 0;
    searches += msg.usage?.server_tool_use?.web_search_requests ?? 0;

    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rewording the offer or audience notes.');
    if (msg.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try asking for fewer ads.');
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }

    const call = msg.content.find((b) => b.type === 'tool_use' && b.name === 'save_ad_plan');
    if (call) {
      const plan = call.input;
      if (!Array.isArray(plan?.ads) || !plan.ads.length) throw new Error('Claude returned no ads. Try again.');
      db.prepare(`UPDATE ad_plans SET status = 'done', result = ?, model = ?, input_tokens = ?, output_tokens = ?, searches = ? WHERE id = ?`)
        .run(JSON.stringify(plan), model, inTok, outTok, searches, id);
      audit('Ad Studio', null, `Wrote ${plan.ads.length} ads for ${acct.name} (${searches} web searches)`);
      return;
    }
    if (nudged) throw new Error('Claude finished without saving the ads. Try again.');
    // Ended without the tool call (forced tool choice isn't available on this model): ask once.
    nudged = true;
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({ role: 'user', content: 'Please call save_ad_plan now with the complete result.' });
  }
  throw new Error('The research took too many steps. Try fewer competitors.');
}
