/**
 * Dashboard summary: product metrics from Postgres, money from RevenueCat.
 *
 * RevenueCat is treated as optional and failure-tolerant. It is a third party
 * on a 25 req/min budget, and the product half of this page is still worth
 * seeing when the money half is unreachable — so a RevenueCat problem
 * degrades to a labelled gap, never a failed dashboard.
 */

const { json, requireAdmin, rpc, revenuecat, rcConfigured, handler, env } = require('../_lib');

/** Metric ids worth surfacing, in display order, from /metrics/overview. */
const HEADLINE = [
  'active_subscriptions',
  'active_trials',
  'mrr',
  'revenue',
  'new_customers',
  'active_users',
];

async function revenue() {
  if (!rcConfigured()) return { state: 'not_configured' };
  try {
    const project = env('REVENUECAT_PROJECT_ID');
    const data = await revenuecat('v2', `/projects/${project}/metrics/overview`);
    const byId = new Map((data.metrics || []).map((m) => [m.id, m]));
    const metrics = [];
    for (const id of HEADLINE) {
      const m = byId.get(id);
      if (m) metrics.push({ id: m.id, name: m.name, value: m.value, unit: m.unit, period: m.period });
    }
    // Anything RevenueCat added that isn't in HEADLINE still shows, after it.
    for (const m of data.metrics || []) {
      if (!HEADLINE.includes(m.id)) {
        metrics.push({ id: m.id, name: m.name, value: m.value, unit: m.unit, period: m.period });
      }
    }
    return { state: 'ok', currency: data.currency, metrics };
  } catch (err) {
    console.error('[admin] revenuecat overview', err.message, err.detail ?? '');
    return { state: 'unavailable', status: err.status || 0 };
  }
}

module.exports = handler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const [product, money] = await Promise.all([rpc('admin_overview'), revenue()]);
  return json(res, 200, { product, revenue: money });
});
