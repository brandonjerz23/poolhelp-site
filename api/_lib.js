/**
 * Shared plumbing for the /admin API.
 *
 * Deliberately dependency-free: the rest of this repo is static HTML with no
 * build step, and an admin panel holding a service_role key is the last place
 * that wants a node_modules tree to keep patched. Everything here is `fetch`
 * plus node:crypto.
 *
 * THREAT MODEL. SUPABASE_SERVICE_ROLE_KEY bypasses RLS on every table — it is
 * the keys to the whole database. It must never leave this process. So:
 *   - it is read only inside these functions, never sent to the browser;
 *   - every route calls requireAdmin() BEFORE touching it;
 *   - the browser's session is our own signed cookie, not a Supabase token,
 *     so an admin cookie is useless against Supabase directly.
 */

const crypto = require('node:crypto');

const COOKIE = 'ph_admin';
const SESSION_TTL_S = 8 * 60 * 60;
/**
 * Cap on every outbound call. Without it a hung Supabase or RevenueCat holds
 * the function open until Vercel's own limit, turning one slow dependency into
 * a dashboard that appears frozen rather than one that reports a failure.
 */
const UPSTREAM_TIMEOUT_MS = 8000;

// ── env ─────────────────────────────────────────────────────────────────────

function env(name, required = true) {
  const v = process.env[name];
  // A ConfigError, not a bare Error: the console has been deployed with a
  // secret missing before, and "server_error" told the owner nothing. The
  // handler turns this into 503 + the variable NAME (never a value).
  if (!v && required) throw new ConfigError(name);
  return v || '';
}

/** Which integrations are wired, for the health screen. Never returns values. */
function configured() {
  return {
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    supabaseAuth: Boolean(process.env.SUPABASE_ANON_KEY),
    admins: Boolean(process.env.ADMIN_EMAILS),
    sessionSecret: Boolean(process.env.ADMIN_SESSION_SECRET),
    revenuecat: Boolean(process.env.REVENUECAT_V2_KEY && process.env.REVENUECAT_PROJECT_ID),
    aiProxy: Boolean(process.env.AI_PROXY_URL),
    readToken: Boolean(process.env.ADMIN_READ_TOKEN),
  };
}

// ── http helpers ────────────────────────────────────────────────────────────

function json(res, status, body, headers) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // An admin surface must never be cached by a CDN or a shared proxy.
  res.setHeader('cache-control', 'no-store, private');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel pre-parsed
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON');
  }
}

function query(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ── session ─────────────────────────────────────────────────────────────────

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', env('ADMIN_SESSION_SECRET')).update(body).digest('base64url');
  return `v1.${body}.${mac}`;
}

/** Returns the payload, or null for anything that isn't a valid live session. */
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, body, mac] = parts;
  let expected;
  try {
    expected = crypto.createHmac('sha256', env('ADMIN_SESSION_SECRET')).update(body).digest('base64url');
  } catch {
    return null;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function sessionCookie(token, maxAge) {
  const bits = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    // Strict, not Lax: nothing should ever navigate INTO an admin action from
    // another site, and this is half the CSRF story (the header check is the
    // other half).
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  return bits.join('; ');
}

/**
 * Gate every route. Returns the session, or writes the error and returns null
 * — callers must `if (!session) return;`.
 *
 * Two credentials, two privilege levels, enforced HERE rather than in the
 * prose of a bot's prompt:
 *   - the owner's signed cookie          → full session   (readOnly: false)
 *   - `Authorization: Bearer <token>`    → bot session    (readOnly: true)
 * A bearer that is present but wrong is a 401, never a fall-through to the
 * cookie. Mutating routes call requireWrite() and refuse bot sessions.
 *
 * The custom-header requirement is the CSRF control for the cookie path: a
 * cross-origin page can send a form POST with cookies attached, but it cannot
 * set x-ph-admin without a preflight, and this API answers no CORS preflight.
 * A bearer token is never attached by a browser on its own, so that path needs
 * no CSRF header.
 */
function requireAdmin(req, res) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s/i.test(auth)) {
    if (!bearerOk(auth.replace(/^Bearer\s+/i, '').trim())) {
      json(res, 401, { error: 'unauthorized' });
      return null;
    }
    return { sub: 'read-token', email: 'bot', readOnly: true };
  }

  if (req.headers['x-ph-admin'] !== '1') {
    json(res, 400, { error: 'bad_request' });
    return null;
  }
  const session = verify(parseCookies(req)[COOKIE]);
  if (!session) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  // The allowlist is re-read on every request, so removing an address from
  // ADMIN_EMAILS revokes access immediately instead of at cookie expiry.
  if (!isAdminEmail(session.email)) {
    json(res, 403, { error: 'forbidden' });
    return null;
  }
  return { ...session, readOnly: false };
}

/** Constant-time check of the read-only bot token. Unset token admits nobody. */
function bearerOk(token) {
  const expected = process.env.ADMIN_READ_TOKEN || '';
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The write gate. Returns true for the owner's session; for a bot session it
 * writes 403 and returns false — callers must `if (!requireWrite(...)) return;`.
 * Data export counts as a write here: it is a bulk PII dump and belongs to a
 * human decision, not a scheduled job.
 */
function requireWrite(session, res) {
  if (session && session.readOnly) {
    json(res, 403, { error: 'read_only_token' });
    return false;
  }
  return true;
}

function isAdminEmail(email) {
  if (!email) return false;
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(String(email).toLowerCase());
}

// ── supabase ────────────────────────────────────────────────────────────────

/** Call one of the admin_* SECURITY DEFINER functions as service_role. */
async function rpc(fn, args) {
  const url = `${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`;
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args || {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw asUpstreamError(err, 'supabase');
  }
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status, `supabase rpc ${fn} failed`, text.slice(0, 400));
  return text ? JSON.parse(text) : null;
}

/** GoTrue admin API (user deletion, password-reset links). */
async function gotrue(path, init = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  let r;
  try {
    r = await fetch(`${env('SUPABASE_URL')}/auth/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw asUpstreamError(err, 'supabase auth');
  }
  const text = await r.text();
  const body = text ? safeParse(text) : null;
  if (!r.ok) throw new HttpError(r.status, 'supabase auth request failed', body);
  return body;
}

// ── revenuecat ──────────────────────────────────────────────────────────────

const RC_ENTITLEMENT = 'ai';

/**
 * RevenueCat REST. v2 for project-scoped reads (metrics, customer lookup),
 * v1 for the subscriber operations that only exist there (promotional grants).
 * Both accept the same `sk_` secret key.
 */
async function revenuecat(version, path, init = {}) {
  let r;
  try {
    r = await fetch(`https://api.revenuecat.com/${version}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env('REVENUECAT_V2_KEY')}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw asUpstreamError(err, 'revenuecat');
  }
  const text = await r.text();
  const body = text ? safeParse(text) : null;
  if (!r.ok) throw new HttpError(r.status, 'revenuecat request failed', body);
  return body;
}

const rcConfigured = () =>
  Boolean(process.env.REVENUECAT_V2_KEY && process.env.REVENUECAT_PROJECT_ID);

// ── errors ──────────────────────────────────────────────────────────────────

/** Turn an abort into a status the UI can explain, not an opaque 500. */
function asUpstreamError(err, what) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new HttpError(504, `${what} timed out`);
  }
  return err;
}

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** A required environment variable is absent. Names the variable, never a value. */
class ConfigError extends HttpError {
  constructor(name) {
    super(503, `missing env: ${name}`);
    this.missing = name;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Wrap a handler so a thrown error becomes JSON instead of a Vercel stack
 * page. Upstream detail is logged, never returned — a 500 body is not the
 * place to leak which env var is missing.
 */
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const raw = err instanceof HttpError ? err.status : 500;
      // A 401 from THIS api must mean exactly one thing: the admin's session is
      // invalid — the client signs the user out on sight of one. requireAdmin
      // writes its own 401 directly rather than throwing, so any 401/403
      // arriving here came from Supabase or RevenueCat, and forwarding it would
      // silently sign the admin out over someone else's bad credential. The
      // usual cause is a wrong or rotated SUPABASE_SERVICE_ROLE_KEY, where
      // "you were logged out" is the single most misleading thing to report.
      const status = raw === 401 || raw === 403 ? 502 : raw;
      console.error('[admin]', req.url, raw, err.message, err.detail ?? '');
      if (!res.writableEnded) {
        const body = err instanceof ConfigError
          ? { error: 'not_configured', missing: err.missing }
          : { error: status === 500 ? 'server_error' : 'upstream_error' };
        json(res, status >= 400 && status < 600 ? status : 500, body);
      }
    }
  };
}

module.exports = {
  COOKIE,
  SESSION_TTL_S,
  RC_ENTITLEMENT,
  env,
  configured,
  json,
  readJsonBody,
  query,
  parseCookies,
  sign,
  verify,
  sessionCookie,
  requireAdmin,
  requireWrite,
  isAdminEmail,
  rpc,
  gotrue,
  revenuecat,
  rcConfigured,
  HttpError,
  ConfigError,
  handler,
};
