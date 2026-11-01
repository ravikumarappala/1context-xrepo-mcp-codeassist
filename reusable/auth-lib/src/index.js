// Shared token helpers for every Acme service.
// DEMO ONLY: an HMAC-signed token so the sample runs offline. Use your identity provider's tokens in real systems.
import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

/** Create a token for a user. */
export function signToken({ sub, ttlSec = 3600 }, secret) {
  const payload = b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${payload}.${sign(payload, secret)}`;
}

/** Verify a token and return its claims, or throw. Services authorize by the token's user, never by an ID in the URL. */
export function verifyToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new Error('malformed token');
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('bad signature');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (claims.exp < Date.now() / 1000) throw new Error('token expired');
  return claims;
}

/** Read "Authorization: Bearer <token>" and return the user id, or null. */
export function userFromRequest(headers, secret) {
  const m = /^Bearer (.+)$/.exec(headers?.authorization || '');
  if (!m) return null;
  try { return verifyToken(m[1], secret).sub; } catch { return null; }
}
