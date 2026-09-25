/**
 * One user: the support view, plus the actions support actually needs.
 *
 * GET    ?id=<uuid>            → account, pools, recent activity, subscription
 * GET    ?id=<uuid>&export=1   → full data export (data-subject requests)
 * POST   {id, action}          → grant / revoke entitlement, recovery link
 * DELETE {id, confirmEmail}    → delete the account and all its rows
 *
 * The RevenueCat customer id IS the Supabase user id: the app calls
 * Purchases.logIn(session.user.id) on sign-in (src/services/purchases.ts).
 * That identity is the only reason a single screen can show a person's data
 * and their subscription together. Anonymous, never-signed-in buyers live
 * under $RCAnonymousID:… and have no Supabase row, so they are not listed
 * here — RevenueCat's own dashboard is the place for those.
 */

const {
  RC_ENTITLEMENT,
  json,
  query,
  readJsonBody,
  requireAdmin,
  requireWrite,
  rpc,
  gotrue,
  revenuecat,
  rcConfigured,
  handler,
} = require('../_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RevenueCat's documented promotional durations. */
const DURATIONS = new Set([
  'daily', 'three_day', 'weekly', 'two_week', 'monthly',
  'two_month', 'three_month', 'six_month', 'yearly', 'lifetime',
]);

/** Flatten the v1 subscriber payload to what the panel shows. */
async function subscription(userId) {
  if (!rcConfigured()) return { state: 'not_configured' };
  try {
    const data = await revenuecat('v1', `/subscribers/${encodeURIComponent(userId)}`);
    const sub = data && data.subscriber;
    if (!sub) return { state: 'none' };

    const ent = (sub.entitlements || {})[RC_ENTITLEMENT];
    const now = Date.now();
    // A null expires_date means lifetime, which is active, not expired.
    const active = Boolean(ent) && (!ent.expires_date || Date.parse(ent.expires_date) > now);
    const productId = ent && ent.product_identifier;
    const purchase = productId ? (sub.subscriptions || {})[productId] : null;

    return {
      state: ent ? (active ? 'active' : 'expired') : 'none',
      entitlement: RC_ENTITLEMENT,
      product: productId || null,
      expiresAt: ent ? ent.expires_date : null,
      purchasedAt: ent ? ent.purchase_date : null,
      store: purchase ? purchase.store : null,
      // The sandbox flag matters: a TestFlight tester holding a sandbox
      // entitlement looks identical to a paying customer without it.
      sandbox: purchase ? Boolean(purchase.is_sandbox) : null,
      periodType: purchase ? purchase.period_type : null,
      unsubscribedAt: purchase ? purchase.unsubscribe_detected_at : null,
      billingIssueAt: purchase ? purchase.billing_issues_detected_at : null,
      firstSeen: sub.first_seen || null,
      managementUrl: sub.management_url || null,
    };
  } catch (err) {
    // 404 is the normal answer for someone who never reached the paywall.
    if (err.status === 404) return { state: 'none' };
    console.error('[admin] revenuecat subscriber', err.message, err.detail ?? '');
    return { state: 'unavailable', status: err.status || 0 };
  }
}

module.exports = handler(async (req, res) => {
  const session = requireAdmin(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    const q = query(req);
    if (!UUID.test(q.id || '')) return json(res, 400, { error: 'bad_user_id' });

    if (q.export === '1') {
      if (!requireWrite(session, res)) return;
      const data = await rpc('admin_user_export', { p_uid: q.id });
      return json(res, 200, data);
    }
    const [detail, sub] = await Promise.all([
      rpc('admin_user_detail', { p_uid: q.id }),
      subscription(q.id),
    ]);
    if (!detail || !detail.account) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { ...detail, subscription: sub });
  }

  if (req.method === 'POST') {
    if (!requireWrite(session, res)) return;
    const body = await readJsonBody(req);
    if (!UUID.test(body.id || '')) return json(res, 400, { error: 'bad_user_id' });

    if (body.action === 'recovery_link') {
      const detail = await rpc('admin_user_detail', { p_uid: body.id });
      const email = detail && detail.account && detail.account.email;
      if (!email) return json(res, 404, { error: 'not_found' });
      // generate_link RETURNS a link and sends nothing. Mailing a password
      // reset unprompted is a message sent on the owner's behalf; handing
      // them a link to paste into a reply is not.
      const link = await gotrue('/admin/generate_link', {
        method: 'POST',
        body: JSON.stringify({ type: 'recovery', email }),
      });
      return json(res, 200, { ok: true, link: link.action_link || link.properties?.action_link });
    }

    if (body.action === 'grant') {
      if (!rcConfigured()) return json(res, 409, { error: 'revenuecat_not_configured' });
      const duration = DURATIONS.has(body.duration) ? body.duration : 'monthly';
      await revenuecat(
        'v1',
        `/subscribers/${encodeURIComponent(body.id)}/entitlements/${RC_ENTITLEMENT}/promotional`,
        { method: 'POST', body: JSON.stringify({ duration }) },
      );
      return json(res, 200, { ok: true, granted: duration });
    }

    if (body.action === 'revoke') {
      if (!rcConfigured()) return json(res, 409, { error: 'revenuecat_not_configured' });
      await revenuecat(
        'v1',
        `/subscribers/${encodeURIComponent(body.id)}/entitlements/${RC_ENTITLEMENT}/revoke_promotionals`,
        { method: 'POST', body: '{}' },
      );
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: 'unknown_action' });
  }

  if (req.method === 'DELETE') {
    if (!requireWrite(session, res)) return;
    const body = await readJsonBody(req);
    if (!UUID.test(body.id || '')) return json(res, 400, { error: 'bad_user_id' });

    // Irreversible, and it cascades to every row the person ever synced. The
    // typed email must match the account on the server too — a UI-only
    // confirmation is a suggestion, not a guard.
    const detail = await rpc('admin_user_detail', { p_uid: body.id });
    const email = detail && detail.account && detail.account.email;
    if (!email) return json(res, 404, { error: 'not_found' });
    if (String(body.confirmEmail || '').trim().toLowerCase() !== email.toLowerCase()) {
      return json(res, 400, { error: 'confirmation_mismatch' });
    }

    await gotrue(`/admin/users/${body.id}`, { method: 'DELETE' });
    console.warn('[admin] deleted user', body.id);
    return json(res, 200, { ok: true, deleted: body.id });
  }

  return json(res, 405, { error: 'method_not_allowed' });
});
