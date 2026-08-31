/**
 * Admin sign-in.
 *
 * Credentials are checked by Supabase (real password hashing, its own
 * throttling), then the email must be on the ADMIN_EMAILS allowlist. What the
 * browser gets back is OUR signed cookie, not the Supabase token — so an admin
 * session cannot be replayed against the database, and an app user who signs
 * in here without being on the allowlist gets nothing at all.
 */

const {
  SESSION_TTL_S,
  env,
  json,
  readJsonBody,
  sign,
  sessionCookie,
  isAdminEmail,
  handler,
} = require('../_lib');

// Per-isolate throttle. Lambda instances come and go, so this is a speed bump
// on top of Supabase's own auth rate limiting, not the primary control.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function throttled(ip) {
  const now = Date.now();
  const hits = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  attempts.set(ip, hits);
  if (attempts.size > 500) attempts.clear(); // crude bound; this is not a store
  return hits.length > MAX_ATTEMPTS;
}

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  // Blocks login-CSRF: a cross-site form cannot set this header.
  if (req.headers['x-ph-admin'] !== '1') return json(res, 400, { error: 'bad_request' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (throttled(ip)) return json(res, 429, { error: 'too_many_attempts' });

  const { email, password } = await readJsonBody(req);
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return json(res, 400, { error: 'bad_request' });
  }

  // One generic failure for every path below. Distinguishing "wrong password"
  // from "not an admin" would tell an attacker which accounts are worth
  // attacking.
  const deny = () => json(res, 401, { error: 'invalid_credentials' });

  const r = await fetch(`${env('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env('SUPABASE_ANON_KEY'), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return deny();

  const data = await r.json();
  const user = data && data.user;
  if (!user || !user.email || !isAdminEmail(user.email)) return deny();

  const now = Math.floor(Date.now() / 1000);
  const token = sign({ sub: user.id, email: user.email, iat: now, exp: now + SESSION_TTL_S });

  return json(
    res,
    200,
    { ok: true, email: user.email },
    { 'set-cookie': sessionCookie(token, SESSION_TTL_S) },
  );
});
