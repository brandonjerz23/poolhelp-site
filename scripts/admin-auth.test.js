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
