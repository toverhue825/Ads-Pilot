import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency). Real environment variables win.
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Trim: values pasted into a host's settings often pick up a trailing space or line break.
// Also drop invisible characters and wrapping quotes that sneak in when copying from documents or chats.
export const clean = (s) => String(s)
  .replace(/[​-‍⁠﻿]/g, '').replace(/ /g, ' ').trim()
  .replace(/^(["'“‘])(.*)(["'”’])$/s, '$2').trim();
const env = (k, d) => {
  const v = process.env[k] === undefined ? undefined : clean(process.env[k]);
  return v === undefined || v === '' ? d : v;
};
const num = (k, d) => Number(env(k, d));

export const config = {
  port: num('PORT', 3000),
  // Render sets RENDER_EXTERNAL_URL automatically, so email links work without setting BASE_URL there.
  baseUrl: env('BASE_URL', env('RENDER_EXTERNAL_URL', 'http://localhost:3000')).replace(/\/$/, ''),
  appSecret: env('APP_SECRET', 'dev-secret-change-me'),
  dashboardPassword: env('DASHBOARD_PASSWORD', 'demo'),
  dbPath: env('DB_PATH', path.resolve(process.cwd(), 'data', 'ads.db')),

  dataSource: env('DATA_SOURCE', 'sample'),
  meta: {
    token: env('META_ACCESS_TOKEN', ''),
    // One or more ad accounts, comma-separated: act_111,act_222. (META_AD_ACCOUNT_ID still works for one.)
    adAccountIds: env('META_AD_ACCOUNT_IDS', env('META_AD_ACCOUNT_ID', ''))
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.startsWith('act_') ? s : `act_${s}`)),
    apiVersion: env('META_API_VERSION', 'v23.0'),
    // Which Facebook result types count as a lead, first match wins. Run `npm run check-meta` to see yours.
    leadActions: env('META_LEAD_ACTIONS', 'lead,onsite_conversion.lead_grouped,offsite_conversion.fb_pixel_lead,leadgen_grouped')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  ai: {
    // AI insights turn on when an Anthropic API key is set.
    apiKey: env('ANTHROPIC_API_KEY', ''),
    model: env('AI_MODEL', 'claude-opus-5-5'),
    effort: env('AI_EFFORT', 'medium'),
    weeklyDay: num('AI_WEEKLY_DAY', 1), // 0=Sun … 1=Mon
  },

  google: {
    // Drive content library: a service account's JSON key (whole file contents) + the shared folder's ID.
    serviceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON', ''),
    driveFolderId: env('GOOGLE_DRIVE_FOLDER_ID', ''),
    // Google Business Profile: an OAuth client; someone who manages the profile clicks "Connect" once.
    oauthClientId: env('GOOGLE_OAUTH_CLIENT_ID', ''),
    oauthClientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET', ''),
  },

  targetCpl: num('TARGET_CPL', 45),
  maxBudgetChangePct: num('MAX_BUDGET_CHANGE_PCT', 20),
  dailySpendCap: num('DAILY_SPEND_CAP', 600),
  minSpendToJudge: num('MIN_SPEND_TO_JUDGE', 60),

  syncIntervalMinutes: num('SYNC_INTERVAL_MINUTES', 60),
  digestHour: num('DIGEST_HOUR', 8),

  smtp: {
    host: env('SMTP_HOST', ''),
    port: num('SMTP_PORT', 587),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
  },
  emailFrom: env('EMAIL_FROM', 'Ads Pilot <ads@example.com>'),
  emailTo: env('EMAIL_TO', ''),
};

if (process.env.NODE_ENV === 'production') {
  if (config.appSecret === 'dev-secret-change-me' || config.appSecret.length < 32) throw new Error('Set a long random APP_SECRET before running in production.');
  if (config.dashboardPassword === 'demo' || config.dashboardPassword.length < 12) throw new Error('Set DASHBOARD_PASSWORD to at least 12 characters before going online.');
  if (!config.baseUrl.startsWith('https://')) console.warn('[config] BASE_URL should be your https:// address so email links work.');
}
