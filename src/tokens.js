import crypto from 'node:crypto';
import { config } from './config.js';

const b64 = (s) => Buffer.from(s).toString('base64url');
const sig = (data) => crypto.createHmac('sha256', config.appSecret).update(data).digest('base64url');

// Signed, expiring token: used for email approval links and the login cookie.
export function sign(payload, ttlMs) {
  const data = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${data}.${sig(data)}`;
}

export function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, s] = token.split('.');
  const expected = sig(data);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
