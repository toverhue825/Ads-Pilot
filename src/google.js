// Google connections.
//  - Drive (content library): a service account. You share one Drive folder with its email address;
//    it can only see that folder, read-only.
//  - Business Profile: OAuth. Someone who manages the profile clicks "Connect" once; we keep the
//    refresh token, encrypted with APP_SECRET.
import crypto from 'node:crypto';
import { JWT, OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { getMeta, setMeta } from './db.js';

// ---------- Drive (service account) ----------
let jwt = null;
export function driveConfigured() {
  return Boolean(config.google.serviceAccountJson && config.google.driveFolderId);
}
export function serviceAccountEmail() {
  try { return JSON.parse(config.google.serviceAccountJson).client_email ?? null; } catch { return null; }
}
function driveClient() {
  if (jwt) return jwt;
  let key;
  try { key = JSON.parse(config.google.serviceAccountJson); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file contents.'); }
  jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  return jwt;
}
export async function drive(path, params = {}, { raw = false } = {}) {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await driveClient().request({ url: url.toString(), responseType: raw ? 'arraybuffer' : 'json', validateStatus: () => true });
  if (res.status >= 400) {
    const msg = res.data?.error?.message ?? (raw ? `HTTP ${res.status}` : JSON.stringify(res.data).slice(0, 200));
    throw Object.assign(new Error(`Google Drive: ${msg}`), { status: res.status });
  }
  return raw ? Buffer.from(res.data) : res.data;
}

// Authorized GET of any Google URL (e.g. a Drive thumbnail link) as bytes; null on failure.
export async function driveBytes(url) {
  try {
    const res = await driveClient().request({ url, responseType: 'arraybuffer', validateStatus: () => true });
    return res.status < 400 ? Buffer.from(res.data) : null;
  } catch { return null; }
}

// ---------- Business Profile (OAuth) ----------
// One Google sign-in covers Business Profile and Google Ads.
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const gbpConfigured = () => Boolean(config.google.oauthClientId && config.google.oauthClientSecret);
const redirectUri = () => `${config.baseUrl}/google/callback`;
const oauth = () => new OAuth2Client(config.google.oauthClientId, config.google.oauthClientSecret, redirectUri());

// Encrypt the refresh token at rest (AES-256-GCM, key derived from APP_SECRET).
const keyBytes = () => crypto.createHash('sha256').update(`gbp:${config.appSecret}`).digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function gbpAuthUrl(state) {
  return oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [GBP_SCOPE, ADS_SCOPE], include_granted_scopes: true, state });
}
export async function gbpFinishAuth(code) {
  const { tokens } = await oauth().getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a long-term token. Remove the app at myaccount.google.com/permissions and connect again.');
  setMeta('gbp_refresh', seal(tokens.refresh_token));
}
export function gbpConnected() {
  return Boolean(getMeta('gbp_refresh'));
}
export function gbpDisconnect() {
  setMeta('gbp_refresh', '');
}
// Google Ads API call as the signed-in Google user. Returns parsed JSON; throws with Google's message.
export async function googleAdsRequest(path, { method = 'GET', body } = {}) {
  const sealed = getMeta('gbp_refresh');
  if (!sealed) throw new Error('Google is not connected. Click "Connect with Google" in the Google Business tab.');
  const client = oauth();
  client.setCredentials({ refresh_token: open(sealed) });
  const headers = { 'developer-token': config.googleAds.developerToken };
  if (config.googleAds.loginCustomerId) headers['login-customer-id'] = config.googleAds.loginCustomerId;
  const res = await client.request({
    url: `https://googleads.googleapis.com/${config.googleAds.apiVersion}/${path}`, method, data: body, headers, validateStatus: () => true,
  });
  if (res.status >= 400) {
    const err = Array.isArray(res.data) ? res.data[0]?.error : res.data?.error;
    const detail = err?.details?.flatMap((d) => d.errors ?? []).map((e) => e.message).filter(Boolean).join('; ');
    let msg = detail || err?.message || `HTTP ${res.status}`;
    if (/DEVELOPER_TOKEN_NOT_APPROVED|only approved for use with test accounts/i.test(JSON.stringify(res.data))) msg = 'The Google Ads developer token is only approved for test accounts. Apply for Basic access in the Manager account API Center.';
    if (/USER_PERMISSION_DENIED|login-customer-id/i.test(JSON.stringify(res.data))) msg += ' (Check GOOGLE_ADS_LOGIN_CUSTOMER_ID is your Manager account ID and that the signed-in Google user has access.)';
    if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(res.data))) msg = 'The Google sign-in is missing Google Ads permission. Click "Connect with Google" again.';
    throw Object.assign(new Error(`Google Ads: ${msg}`), { status: res.status });
  }
  return res.data;
}

export async function gbp(url, { method = 'GET', body } = {}) {
  const sealed = getMeta('gbp_refresh');
  if (!sealed) throw new Error('Google Business Profile is not connected.');
  const client = oauth();
  client.setCredentials({ refresh_token: open(sealed) });
  const res = await client.request({ url, method, data: body, validateStatus: () => true });
  if (res.status >= 400) {
    const e = res.data?.error ?? {};
    let msg = e.message ?? `HTTP ${res.status}`;
    if (res.status === 429 || /quota|has not been used|is disabled/i.test(msg)) {
      msg += ' (Google Business Profile API access may not be approved or enabled yet.)';
    }
    throw Object.assign(new Error(`Google Business Profile: ${msg}`), { status: res.status });
  }
  return res.data;
}
