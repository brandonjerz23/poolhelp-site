/**
 * Live status of everything the app depends on, so "is it me or is it them?"
 * is one page load rather than four dashboards.
 *
 * Every probe is free: no Anthropic call, no RevenueCat write. The AI-proxy
 * probe deliberately sends a request the worker must REJECT, which proves the
 * cost-control validator is deployed and not just that the worker is up.
 */

const { json, requireAdmin, configured, env, revenuecat, rcConfigured, handler } = require('../_lib');

const TIMEOUT_MS = 6000;

async function timed(fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, detail: err.name === 'TimeoutError' ? 'timed out' : err.message, ms: Date.now() - started };
  }
}

const withTimeout = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

async function checkSupabase() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await withTimeout(`${env('SUPABASE_URL')}/rest/v1/`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  return { ok: r.ok, detail: `HTTP ${r.status}` };
}

/** Worker is up if it answers its own 404 contract for an unknown path. */
async function checkProxyAlive() {
  const r = await withTimeout(env('AI_PROXY_URL'));
  return { ok: r.status === 404, detail: `HTTP ${r.status}` };
}

/**
 * Cost controls: a disallowed model must be refused. A 400 means validate.ts
 * is live; a 402 means the paygate rejected us first (also healthy); a 200
 * would mean an unvalidated request reached Anthropic, which is an alarm.
 */
async function checkProxyValidation() {
  const r = await withTimeout(`${env('AI_PROXY_URL')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
  });
  if (r.status === 400) return { ok: true, detail: 'rejects disallowed models' };
  if (r.status === 402) return { ok: true, detail: 'paygate active (402)' };
  if (r.status === 429) return { ok: true, detail: 'rate limited (429)' };
  return { ok: false, detail: `unexpected HTTP ${r.status} — validator may not be deployed` };
}

async function checkRevenueCat() {
  const data = await revenuecat('v2', `/projects/${env('REVENUECAT_PROJECT_ID')}`);
  return { ok: true, detail: data && data.name ? `project ${data.name}` : 'reachable' };
}

module.exports = handler(async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const cfg = configured();
  const checks = {};

  const jobs = [
    ['supabase', cfg.supabase, checkSupabase],
    ['aiProxy', cfg.aiProxy, checkProxyAlive],
    ['aiProxyCostControls', cfg.aiProxy, checkProxyValidation],
    ['revenuecat', rcConfigured(), checkRevenueCat],
  ];

  await Promise.all(
    jobs.map(async ([name, enabled, fn]) => {
      checks[name] = enabled ? await timed(fn) : { ok: null, detail: 'not configured' };
    }),
  );

  return json(res, 200, { configured: cfg, checks, checkedAt: new Date().toISOString() });
});
