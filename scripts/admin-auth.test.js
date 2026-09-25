/**
 * Tests for the admin session layer — the only thing standing between the
 * public internet and a service_role key.
 *
 *   node --test scripts/
 *
 * Zero dependencies: node:test ships with Node 18+.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.ADMIN_SESSION_SECRET = 'test-secret-do-not-use';
process.env.ADMIN_EMAILS = 'owner@example.com, Second@Example.com';

const lib = require('../api/_lib');

const future = () => Math.floor(Date.now() / 1000) + 3600;

/** Minimal stand-in for a Node response, capturing what a handler wrote. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writableEnded: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
      this.writableEnded = true;
    },
  };
}

const reqWith = (cookie, header = '1') => ({
  headers: { cookie, ...(header === null ? {} : { 'x-ph-admin': header }) },
});

test('a signed session round-trips', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  const payload = lib.verify(token);
  assert.equal(payload.email, 'owner@example.com');
});

test('a tampered payload is rejected', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  const [v, body, mac] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({ sub: 'u1', email: 'attacker@evil.com', exp: future() }),
  ).toString('base64url');
  assert.equal(lib.verify(`${v}.${forged}.${mac}`), null);
  assert.ok(body); // original body was non-empty
});

test('a tampered signature is rejected', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  const [v, body] = token.split('.');
  assert.equal(lib.verify(`${v}.${body}.${'A'.repeat(43)}`), null);
});

test('a session signed with a different secret is rejected', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  process.env.ADMIN_SESSION_SECRET = 'a-different-secret';
  try {
    assert.equal(lib.verify(token), null);
  } finally {
    process.env.ADMIN_SESSION_SECRET = 'test-secret-do-not-use';
  }
});

test('an expired session is rejected', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(lib.verify(token), null);
});

test('malformed tokens return null rather than throwing', () => {
  for (const bad of [undefined, null, '', 'x', 'v1.x', 'v2.a.b', 'v1..', {}, 'v1.!!!.???']) {
    assert.equal(lib.verify(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('the allowlist is case-insensitive and tolerates spacing', () => {
  assert.equal(lib.isAdminEmail('owner@example.com'), true);
  assert.equal(lib.isAdminEmail('OWNER@EXAMPLE.COM'), true);
  assert.equal(lib.isAdminEmail('second@example.com'), true);
  assert.equal(lib.isAdminEmail('nobody@example.com'), false);
  assert.equal(lib.isAdminEmail(''), false);
  assert.equal(lib.isAdminEmail(null), false);
});

test('an empty allowlist admits nobody', () => {
  const saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = '';
  try {
    assert.equal(lib.isAdminEmail('owner@example.com'), false);
  } finally {
    process.env.ADMIN_EMAILS = saved;
  }
});

test('requireAdmin refuses a request without the CSRF header', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  const res = fakeRes();
  assert.equal(lib.requireAdmin(reqWith(`ph_admin=${token}`, null), res), null);
  assert.equal(res.statusCode, 400);
});

test('requireAdmin refuses a request with no session', () => {
  const res = fakeRes();
  assert.equal(lib.requireAdmin(reqWith(''), res), null);
  assert.equal(res.statusCode, 401);
});

test('requireAdmin refuses a valid session whose email left the allowlist', () => {
  // The revocation path: the cookie is cryptographically fine, but the address
  // is no longer an admin, so access ends now rather than at cookie expiry.
  const token = lib.sign({ sub: 'u1', email: 'removed@example.com', exp: future() });
  const res = fakeRes();
  assert.equal(lib.requireAdmin(reqWith(`ph_admin=${token}`), res), null);
  assert.equal(res.statusCode, 403);
});

test('requireAdmin admits a valid allowlisted session', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  const res = fakeRes();
  const session = lib.requireAdmin(reqWith(`ph_admin=${token}`), res);
  assert.equal(session.email, 'owner@example.com');
  assert.equal(res.writableEnded, false);
});

test('the session cookie carries the hardening flags', () => {
  const cookie = lib.sessionCookie('abc', 3600);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
    assert.ok(cookie.includes(flag), `missing ${flag}`);
  }
});

test('cookie parsing survives junk and finds the session among others', () => {
  const token = lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() });
  const req = reqWith(`other=1; ph_admin=${token}; junk; trailing=x`);
  const res = fakeRes();
  assert.equal(lib.requireAdmin(req, res).email, 'owner@example.com');
});

test('admin responses are never cacheable', () => {
  const res = fakeRes();
  lib.json(res, 200, { ok: true });
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.headers['x-robots-tag'], /noindex/);
});

// ── route-level gates ───────────────────────────────────────────────────────

/** Drive a real route handler with a fake req/res. */
async function call(handlerPath, req) {
  const res = fakeRes();
  await require(handlerPath)({ method: 'POST', headers: {}, ...req }, res);
  return res;
}

test('logout refuses a request without the CSRF header', async () => {
  // Otherwise any page on the internet could silently sign an admin out.
  const res = await call('../api/admin/logout', { headers: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('logout with the CSRF header clears the cookie', async () => {
  const res = await call('../api/admin/logout', { headers: { 'x-ph-admin': '1' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
});

test('logout rejects non-POST', async () => {
  const res = await call('../api/admin/logout', { method: 'GET', headers: { 'x-ph-admin': '1' } });
  assert.equal(res.statusCode, 405);
});

test('session route refuses without header, then without a cookie', async () => {
  const bare = await call('../api/admin/session', { method: 'GET', headers: {} });
  assert.equal(bare.statusCode, 400);
  const noCookie = await call('../api/admin/session', { method: 'GET', headers: { 'x-ph-admin': '1' } });
  assert.equal(noCookie.statusCode, 401);
});

test('an upstream 401 is not forwarded as a lost admin session', async () => {
  // The client signs the admin out on any 401. A wrong service_role key must
  // therefore never surface as one, or a misconfiguration reads as "logged out".
  const { HttpError, handler, json } = lib;
  const res = fakeRes();
  await handler(async () => {
    throw new HttpError(401, 'supabase rpc failed');
  })({ url: '/api/admin/overview', headers: {} }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'upstream_error');
  assert.ok(json); // helper is exported

  const forbidden = fakeRes();
  await handler(async () => {
    throw new HttpError(403, 'revenuecat forbidden');
  })({ url: '/api/admin/overview', headers: {} }, forbidden);
  assert.equal(forbidden.statusCode, 502);
});

test('other upstream statuses still pass through', async () => {
  const { HttpError, handler } = lib;
  for (const [thrown, expected] of [[404, 404], [429, 429], [500, 500]]) {
    const res = fakeRes();
    await handler(async () => {
      throw new HttpError(thrown, 'upstream');
    })({ url: '/x', headers: {} }, res);
    assert.equal(res.statusCode, expected);
  }
});

// ── read-only bot token ─────────────────────────────────────────────────────
// The bot review's top structural finding: privilege was enforced in a
// prompt, not a credential. These pin the credential.

const BOT = 'bot-token-for-tests-0123456789abcdef';
const UUID = '11111111-1111-4111-8111-111111111111';

test('a valid bearer token yields a read-only session and needs no CSRF header', () => {
  process.env.ADMIN_READ_TOKEN = BOT;
  const res = fakeRes();
  const s = lib.requireAdmin({ headers: { authorization: `Bearer ${BOT}` } }, res);
  assert.equal(s.readOnly, true);
  assert.equal(res.writableEnded, false);
});

test('a wrong bearer is 401 and never falls through to a valid cookie', () => {
  process.env.ADMIN_READ_TOKEN = BOT;
  const cookie = `ph_admin=${lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() })}`;
  const res = fakeRes();
  const s = lib.requireAdmin(
    { headers: { authorization: 'Bearer nope', cookie, 'x-ph-admin': '1' } }, res);
  assert.equal(s, null);
  assert.equal(res.statusCode, 401);
});

test('with no ADMIN_READ_TOKEN configured, every bearer is refused', () => {
  delete process.env.ADMIN_READ_TOKEN;
  for (const t of ['', 'x', BOT]) {
    const res = fakeRes();
    assert.equal(lib.requireAdmin({ headers: { authorization: `Bearer ${t}` } }, res), null);
    assert.equal(res.statusCode, 401);
  }
  process.env.ADMIN_READ_TOKEN = BOT;
});

test("the owner's cookie session is not read-only", () => {
  const cookie = `ph_admin=${lib.sign({ sub: 'u1', email: 'owner@example.com', exp: future() })}`;
  const s = lib.requireAdmin({ headers: { cookie, 'x-ph-admin': '1' } }, fakeRes());
  assert.equal(s.readOnly, false);
});

test('bot token cannot grant, delete, or export — refused before any upstream call', async () => {
  // No SUPABASE_* env is set in this test process, so if the write gate were
  // missing these would surface as 503 not_configured, not 403.
  process.env.ADMIN_READ_TOKEN = BOT;
  const user = require('../api/admin/user');
  const h = { authorization: `Bearer ${BOT}` };

  const grant = fakeRes();
  await user({ method: 'POST', headers: h, body: { id: UUID, action: 'grant' } }, grant);
  assert.equal(grant.statusCode, 403); assert.equal(grant.body.error, 'read_only_token');

  const del = fakeRes();
  await user({ method: 'DELETE', headers: h, body: { id: UUID, confirmEmail: 'x' } }, del);
  assert.equal(del.statusCode, 403);

  const exp = fakeRes();
  await user({ method: 'GET', headers: h, query: { id: UUID, export: '1' } }, exp);
  assert.equal(exp.statusCode, 403);
});

test('bot token IS admitted to reads — and a missing secret is named, not a bare 500', async () => {
  process.env.ADMIN_READ_TOKEN = BOT;
  delete process.env.SUPABASE_URL;
  const user = require('../api/admin/user');
  const res = fakeRes();
  await user({ method: 'GET', headers: { authorization: `Bearer ${BOT}` }, query: { id: UUID } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.equal(res.body.missing, 'SUPABASE_URL');
});

test('session route reports the bot session as read-only with no expiry', async () => {
  process.env.ADMIN_READ_TOKEN = BOT;
  const res = fakeRes();
  await require('../api/admin/session')({ method: 'GET', headers: { authorization: `Bearer ${BOT}` } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.readOnly, true);
  assert.equal(res.body.expiresAt, null);
});
