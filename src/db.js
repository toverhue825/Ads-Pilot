import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

const SCHEMA_VERSION = '2';

db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
if (version !== SCHEMA_VERSION) {
  // Version 1 only ever held sample data, so it is safe to rebuild.
  db.exec('DROP TABLE IF EXISTS campaigns; DROP TABLE IF EXISTS adsets; DROP TABLE IF EXISTS insights; DROP TABLE IF EXISTS suggestions; DROP TABLE IF EXISTS accounts; DROP TABLE IF EXISTS ai_insights;');
}

db.exec(`
  -- One row per Facebook ad account (brand). Limits are per brand and editable in the dashboard.
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,           -- act_123...
    name TEXT NOT NULL,
    currency TEXT,
    target_cpl REAL NOT NULL,
    max_change_pct REAL NOT NULL,
    daily_cap REAL NOT NULL,
    min_spend REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    objective TEXT,
    status TEXT NOT NULL,          -- ACTIVE | PAUSED
    budget_level TEXT NOT NULL,    -- campaign | adsets | none
    daily_budget REAL,             -- dollars; for budget_level=adsets this is the sum of active ad set budgets
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS adsets (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    daily_budget REAL
  );

  CREATE TABLE IF NOT EXISTS insights (
    campaign_id TEXT NOT NULL,
    date TEXT NOT NULL,            -- YYYY-MM-DD
    spend REAL NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    leads INTEGER NOT NULL DEFAULT 0,
    frequency REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, date)
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    type TEXT NOT NULL,            -- pause | budget_down | budget_up | refresh_creative | review_targeting
    severity TEXT NOT NULL,        -- good | warning | critical
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    action TEXT NOT NULL,          -- JSON: {kind, from, to} ; kind=manual means no API change
    status TEXT NOT NULL DEFAULT 'pending', -- pending | applying | applied | dismissed | failed | expired
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    result TEXT,
    emailed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    campaign_id TEXT,
    message TEXT NOT NULL
  );
`);
db.exec(`
  -- Claude-written summaries and ad copy ideas. account_id NULL = all brands.
  CREATE TABLE IF NOT EXISTS ai_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    period_start TEXT, period_end TEXT,
    content TEXT NOT NULL,         -- JSON
    model TEXT,
    input_tokens INTEGER, output_tokens INTEGER
  );
`);
// Switching between sample and live Facebook data: start clean so fake brands don't linger.
// (Databases from before this check have no record, but sample brands give them away.)
const lastSource = db.prepare("SELECT value FROM meta WHERE key = 'data_source'").get()?.value
  ?? (db.prepare("SELECT 1 FROM accounts WHERE id LIKE 'act_sample%' LIMIT 1").get() ? 'sample' : null);
if (lastSource && lastSource !== config.dataSource) {
  db.exec('DELETE FROM suggestions; DELETE FROM insights; DELETE FROM adsets; DELETE FROM campaigns; DELETE FROM accounts; DELETE FROM ai_insights;');
  console.log(`[db] data source changed ${lastSource} -> ${config.dataSource}; cleared old data`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('data_source', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(config.dataSource);

// Additive columns (safe on existing databases).
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasCol('accounts', 'context')) db.exec("ALTER TABLE accounts ADD COLUMN context TEXT NOT NULL DEFAULT ''");
// Brand facts: specifics the AI may state in ads (turnaround, warranty, delivery, financing…).
if (!hasCol('accounts', 'facts')) db.exec("ALTER TABLE accounts ADD COLUMN facts TEXT NOT NULL DEFAULT ''");

// Multi-platform: Facebook (meta) and Google Ads (google).
if (!hasCol('accounts', 'platform')) db.exec("ALTER TABLE accounts ADD COLUMN platform TEXT NOT NULL DEFAULT 'meta'");
if (!hasCol('campaigns', 'ext')) db.exec("ALTER TABLE campaigns ADD COLUMN ext TEXT"); // platform-specific JSON (e.g. Google budget resource)
db.exec(`
  -- Google Ads search terms (last 30 days) for "wasted spend" suggestions.
  CREATE TABLE IF NOT EXISTS search_terms (
    campaign_id TEXT NOT NULL, term TEXT NOT NULL,
    cost REAL NOT NULL, clicks INTEGER NOT NULL, conversions REAL NOT NULL, updated_at TEXT,
    PRIMARY KEY (campaign_id, term)
  );
`);

// One line for prompts: what the brand is + the facts it can safely claim.
export function brandBrief(acct) {
  const about = acct?.context?.trim() || '(not provided)';
  const facts = acct?.facts?.trim();
  return `About the brand: ${about}\nBrand facts (true; use these for specifics like times, warranties, prices, service area; never invent others):\n${facts || '(none provided)'}`;
}

db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);

export const now = () => new Date().toISOString();

export function audit(actor, campaignId, message) {
  db.prepare('INSERT INTO audit_log (ts, actor, campaign_id, message) VALUES (?, ?, ?, ?)')
    .run(now(), actor, campaignId ?? null, message);
}

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
