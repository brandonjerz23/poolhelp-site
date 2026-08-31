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
  if (!v && required) throw new Error(`missing env: ${name}`);
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
 * The custom-header requirement is the CSRF control: a cross-origin page can
 * send a form POST with cookies attached, but it cannot set x-ph-admin without
 * a preflight, and this API answers no CORS preflight.
 */
function requireAdmin(req, res) {
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
  return session;
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
      const status = err instanceof HttpError ? err.status : 500;
      console.error('[admin]', req.url, status, err.message, err.detail ?? '');
      if (!res.writableEnded) {
        json(res, status >= 400 && status < 600 ? status : 500, {
          error: status === 500 ? 'server_error' : 'upstream_error',
        });
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
  isAdminEmail,
  rpc,
  gotrue,
  revenuecat,
  rcConfigured,
  HttpError,
  handler,
};
