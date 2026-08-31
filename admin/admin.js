/* PoolHelp admin console.
 *
 * No framework and no build step, matching the rest of this repo.
 *
 * XSS NOTE: every string rendered here is attacker-controllable — a pool named
 * `<img src=x onerror=…>` syncs straight from a phone into this page, and it
 * would run with an admin session attached. So all interpolation goes through
 * esc(), and anything dynamic that isn't escaped must use textContent. */

(() => {
  'use strict';

  // ── utilities ─────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  const esc = (v) =>
    v == null
      ? ''
      : String(v).replace(/[&<>"']/g, (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
        );

  const nf = new Intl.NumberFormat('en-US');
  const num = (n) => (typeof n === 'number' && isFinite(n) ? nf.format(n) : '—');

  function money(value, currency) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: value % 1 === 0 ? 0 : 2,
      }).format(value);
    } catch {
      return num(value);
    }
  }

  function ago(iso) {
    if (!iso) return 'never';
    const then = Date.parse(iso);
    if (!isFinite(then)) return '—';
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const full = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  let toastTimer;
  function toast(message) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message; // never innerHTML: messages can echo server text
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4200);
  }

  // ── api ───────────────────────────────────────────────────────────────────

  /** x-ph-admin is the CSRF control the server requires on every route. */
  async function api(path, options = {}) {
    // vercel.json sets trailingSlash, which applies to functions too: calling
    // /api/admin/users costs a 308 to /api/admin/users/ on every request, and
    // not every HTTP client replays a body across that redirect. Ask for the
    // canonical URL directly. The slash goes before the query string.
    const [route, qs] = String(path).split('?');
    const res = await fetch(`/api/admin/${route}/${qs ? `?${qs}` : ''}`, {
      ...options,
      credentials: 'same-origin',
      headers: { 'x-ph-admin': '1', 'content-type': 'application/json', ...(options.headers || {}) },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (res.status === 401) {
      showAuth();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ── sparkline ─────────────────────────────────────────────────────────────

  /** 30-day series → area + line + emphasised endpoint. */
  function sparkline(series, label) {
    const points = Array.isArray(series) ? series : [];
    if (points.length < 2) return '<div class="empty">Not enough history yet.</div>';

    const W = 300;
    const H = 58;
    const values = points.map((p) => Number(p.n) || 0);
    const max = Math.max(1, ...values);
    const x = (i) => (i / (points.length - 1)) * W;
    const y = (v) => H - (v / max) * (H - 6) - 3;

    const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${line} L${W},${H} L0,${H} Z`;
    const lastX = x(points.length - 1).toFixed(1);
    const lastY = y(values[values.length - 1]).toFixed(1);
    const total = values.reduce((a, b) => a + b, 0);

    return `
      <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
           role="img" aria-label="${esc(label)}: ${total} over the last 30 days">
        <path class="area" d="${area}"></path>
        <path class="line" d="${line}" vector-effect="non-scaling-stroke"></path>
        <circle cx="${lastX}" cy="${lastY}" r="2.6"></circle>
      </svg>`;
  }

  const kpi = (label, value, sub, accent) => `
    <div class="kpi${accent ? ' accent' : ''}">
      <span class="k">${esc(label)}</span>
      <span class="v num">${esc(value)}</span>
      ${sub ? `<span class="s">${esc(sub)}</span>` : ''}
    </div>`;

  function mixBars(mix) {
    const entries = Object.entries(mix || {});
    if (!entries.length) return '<div class="empty">No pools yet.</div>';
    const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
    return `<div class="mix">${entries
      .sort((a, b) => b[1] - a[1])
      .map(
        ([k, n]) => `
        <div class="row">
          <span>${esc(k)}</span>
          <span class="bar"><i style="width:${((n / total) * 100).toFixed(1)}%"></i></span>
          <span class="n num">${num(n)}</span>
        </div>`,
      )
      .join('')}</div>`;
  }

  // ── overview ──────────────────────────────────────────────────────────────

  async function renderOverview() {
    const host = $('panel-overview');
    try {
      const { product, revenue } = await api('overview');
      const u = product.users;
      const d = product.data;

      // Signed-in accounts that never synced a row: the backup pitch landed
      // but sync did not, which is a bug signal rather than a vanity metric.
      const notSyncing = Math.max(0, u.total - u.syncing);

      host.innerHTML = `
        <div class="kpis">
          ${kpi('Accounts', num(u.total), `${num(u.new30d)} new in 30d`, true)}
          ${kpi('Active 30d', num(u.active30d), `${num(u.active7d)} in the last 7d`)}
          ${kpi('Syncing', num(u.syncing), notSyncing ? `${num(notSyncing)} never synced` : 'all accounts')}
          ${kpi('Pools', num(d.pools), `avg ${num(product.pools.avgGallons)} gal`)}
          ${kpi('Water tests', num(d.tests), `${num(d.tests30d)} in 30d`)}
          ${kpi('Chemical doses', num(d.chemicalLog), `${num(d.reminders)} reminders`)}
        </div>

        <div class="panel-row two">
          <div class="panel">
            <h2>Signups · 30 days</h2>
            ${sparkline(product.series.signups, 'Signups')}
          </div>
          <div class="panel">
            <h2>Water tests logged · 30 days</h2>
            ${sparkline(product.series.tests, 'Water tests')}
          </div>
        </div>

        <div class="panel-row two">
          <div class="panel">
            <h2>Subscriptions</h2>
            ${revenuePanel(revenue)}
          </div>
          <div class="panel">
            <h2>Pool mix</h2>
            ${mixBars(product.pools.mix)}
            <p class="note">${num(product.pools.swg)} of ${num(d.pools)} run a salt-water generator.</p>
          </div>
        </div>

        <p class="note">Updated ${esc(full(product.generatedAt))}.</p>`;
    } catch (err) {
      if (err.message !== 'unauthorized') {
        host.innerHTML = `<div class="panel"><div class="empty">Couldn't load metrics — ${esc(err.message)}</div></div>`;
      }
    }
  }

  function revenuePanel(revenue) {
    if (!revenue || revenue.state === 'not_configured') {
      return `<div class="empty">RevenueCat isn't connected.<br>
        Set <span class="mono">REVENUECAT_V2_KEY</span> and <span class="mono">REVENUECAT_PROJECT_ID</span> to see live subscription numbers.</div>`;
    }
    if (revenue.state === 'unavailable') {
      return `<div class="empty">RevenueCat is unreachable right now${revenue.status ? ` (HTTP ${esc(revenue.status)})` : ''}.<br>Product metrics above are unaffected.</div>`;
    }
    if (!revenue.metrics || !revenue.metrics.length) {
      return '<div class="empty">No subscription metrics reported yet.</div>';
    }
    return `<div class="kpis">${revenue.metrics
      .map((m) => {
        const isMoney = /^[A-Z]{3}$/.test(m.unit || '');
        const value = isMoney ? money(m.value, m.unit) : num(m.value);
        return kpi(m.name || m.id, value, m.period || '');
      })
      .join('')}</div>`;
  }

  // ── users ─────────────────────────────────────────────────────────────────

  const usersState = { search: '', sort: 'created_at', offset: 0, limit: 25, total: 0 };

  function subPill(sub) {
    if (!sub) return '';
    if (sub.state === 'active') {
      return sub.sandbox
        ? '<span class="pill warn">Sandbox</span>'
        : '<span class="pill ok">Subscribed</span>';
    }
    if (sub.state === 'expired') return '<span class="pill">Lapsed</span>';
    if (sub.state === 'unavailable') return '<span class="pill warn">RC unreachable</span>';
    if (sub.state === 'not_configured') return '<span class="pill plain">RC off</span>';
    return '<span class="pill plain">Free</span>';
  }

  async function renderUsers() {
    const host = $('usersBody');
    try {
      const params = new URLSearchParams({
        search: usersState.search,
        sort: usersState.sort,
        limit: String(usersState.limit),
        offset: String(usersState.offset),
      });
      const data = await api(`users?${params}`);
      usersState.total = data.total;

      if (!data.users.length) {
        host.innerHTML = `<div class="panel"><div class="empty">${
          usersState.search ? 'No accounts match that search.' : 'No accounts yet.'
        }</div></div>`;
        return;
      }

      const rows = data.users
        .map(
          (u) => `
        <tr tabindex="0" data-id="${esc(u.id)}">
          <td>
            <div class="email">${esc(u.email || '(no email)')}</div>
            <div class="mono" style="color:var(--ink-3)">${esc(u.id.slice(0, 8))}</div>
          </td>
          <td>${u.confirmed ? '' : '<span class="pill warn">Unconfirmed</span>'}
              <span class="pill plain">${esc(u.provider || 'email')}</span></td>
          <td class="r num">${num(u.pools)}</td>
          <td class="r num">${num(u.tests)}</td>
          <td class="r num">${num(u.chemicalLog)}</td>
          <td title="${esc(full(u.lastSignInAt))}">${esc(ago(u.lastSignInAt))}</td>
          <td title="${esc(full(u.lastSync))}">${esc(ago(u.lastSync))}</td>
          <td title="${esc(full(u.createdAt))}">${esc(ago(u.createdAt))}</td>
        </tr>`,
        )
        .join('');

      const from = usersState.offset + 1;
      const to = usersState.offset + data.users.length;

      host.innerHTML = `
        <div class="panel">
          <div class="tablewrap">
            <table class="utable">
              <thead><tr>
                <th>Account</th><th>Status</th>
                <th class="r">Pools</th><th class="r">Tests</th><th class="r">Doses</th>
                <th>Signed in</th><th>Synced</th><th>Joined</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div class="toolbar" style="margin:14px 0 0">
            <span class="note" style="margin:0">Showing ${from}–${to} of ${num(data.total)}</span>
            <span style="margin-left:auto"></span>
            <button class="btn sm" id="prevPage" type="button" ${usersState.offset === 0 ? 'disabled' : ''}>Previous</button>
            <button class="btn sm" id="nextPage" type="button" ${to >= data.total ? 'disabled' : ''}>Next</button>
          </div>
        </div>`;

      host.querySelectorAll('tbody tr').forEach((tr) => {
        const open = () => openUser(tr.dataset.id);
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        });
      });
      $('prevPage')?.addEventListener('click', () => {
        usersState.offset = Math.max(0, usersState.offset - usersState.limit);
        renderUsers();
      });
      $('nextPage')?.addEventListener('click', () => {
        usersState.offset += usersState.limit;
        renderUsers();
      });
    } catch (err) {
      if (err.message !== 'unauthorized') {
        host.innerHTML = `<div class="panel"><div class="empty">Couldn't load users — ${esc(err.message)}</div></div>`;
      }
    }
  }

  // ── user drawer ───────────────────────────────────────────────────────────

  function closeDrawer() {
    $('drawerHost').innerHTML = '';
    document.removeEventListener('keydown', onDrawerKey);
  }
  function onDrawerKey(e) {
    if (e.key === 'Escape') closeDrawer();
  }

  async function openUser(id) {
    const host = $('drawerHost');
    host.innerHTML = `<div class="scrim"></div><aside class="drawer"><div class="skeleton">Loading account…</div></aside>`;
    host.querySelector('.scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', onDrawerKey);

    let data;
    try {
      data = await api(`user?id=${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.message !== 'unauthorized') {
        host.querySelector('.drawer').innerHTML = `<div class="empty">Couldn't load — ${esc(err.message)}</div>`;
      }
      return;
    }

    const a = data.account;
    const c = data.counts || {};
    const s = data.subscription || {};

    const readings = (r) =>
      Object.entries(r || {})
        .map(([k, v]) => `${k.toUpperCase()} ${v}`)
        .join(' · ');

    host.querySelector('.drawer').innerHTML = `
      <div class="head">
        <h2>${esc(a.email || '(no email)')}</h2>
        <button class="btn sm close" id="drawerClose" type="button">Close</button>
      </div>
      <div class="actions">${subPill(s)}
        ${a.confirmed ? '' : '<span class="pill warn">Unconfirmed</span>'}
        <span class="pill plain">${esc(a.provider || 'email')}</span></div>

      <section>
        <h3>Account</h3>
        <dl class="kv">
          <dt>User id</dt><dd class="mono">${esc(a.id)}</dd>
          <dt>Joined</dt><dd>${esc(full(a.createdAt))}</dd>
          <dt>Last sign-in</dt><dd>${esc(ago(a.lastSignInAt))}</dd>
          <dt>Last sync</dt><dd>${esc(ago(c.lastSync))}</dd>
          <dt>Synced rows</dt><dd class="num">${num(
            (c.pools || 0) + (c.tests || 0) + (c.chemicalLog || 0) + (c.reminders || 0),
          )}${c.deleted ? ` (+${num(c.deleted)} deleted)` : ''}</dd>
        </dl>
      </section>

      <section>
        <h3>Subscription</h3>
        ${subscriptionBlock(s)}
      </section>

      <section>
        <h3>Pools · ${num(c.pools)}</h3>
        <div class="stack">${
          data.pools.length
            ? data.pools
                .map(
                  (p) => `<div class="item">
                    <div class="t">${esc(p.name || 'Untitled pool')}</div>
                    <div class="d">${esc(p.type || '—')} · ${esc(p.surface || '—')} · ${num(p.gallons)} gal${
                      p.hasSWG ? ' · SWG' : ''
                    }${p.location ? ` · ${esc(p.location)}` : ''}</div>
                  </div>`,
                )
                .join('')
            : '<div class="empty">No pools synced.</div>'
        }</div>
      </section>

      <section>
        <h3>Recent water tests</h3>
        <div class="stack">${
          data.recentTests.length
            ? data.recentTests
                .slice(0, 6)
                .map(
                  (t) => `<div class="item">
                    <div class="t">${esc(ago(t.date))}</div>
                    <div class="d mono">${esc(readings(t.readings)) || 'no readings'}</div>
                  </div>`,
                )
                .join('')
            : '<div class="empty">No tests logged.</div>'
        }</div>
      </section>

      <section>
        <h3>Recent chemical doses</h3>
        <div class="stack">${
          data.recentChemicals.length
            ? data.recentChemicals
                .slice(0, 6)
                .map(
                  (x) => `<div class="item">
                    <div class="t">${esc(x.product || 'Chemical')}</div>
                    <div class="d">${num(x.amount)} ${esc(x.unit || '')} · ${esc(ago(x.date))} · ${esc(x.source || '')}</div>
                  </div>`,
                )
                .join('')
            : '<div class="empty">No doses logged.</div>'
        }</div>
      </section>

      <section>
        <h3>Support actions</h3>
        <div class="actions">
          <button class="btn sm" data-act="grant" type="button">Comp 1 month</button>
          <button class="btn sm" data-act="revoke" type="button">Revoke comp</button>
          <button class="btn sm" data-act="recovery" type="button">Password reset link</button>
          <button class="btn sm" data-act="export" type="button">Export data</button>
        </div>
        <p class="note">Comping grants the <span class="mono">ai</span> entitlement in RevenueCat.
          The reset link is generated, not emailed — send it yourself.</p>
      </section>

      <section>
        <h3>Danger zone</h3>
        <div class="danger-zone">
          <p style="font-size:13.5px;margin-bottom:10px">
            Deleting removes the account and every synced row. This cannot be undone.
            Type the email to confirm.</p>
          <input type="text" id="confirmEmail" placeholder="${esc(a.email || '')}" autocomplete="off">
          <div class="actions" style="margin-top:10px">
            <button class="btn sm danger" data-act="delete" type="button">Delete account</button>
          </div>
        </div>
      </section>`;

    $('drawerClose').addEventListener('click', closeDrawer);
    host.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => userAction(btn, a));
    });
  }

  function subscriptionBlock(s) {
    if (s.state === 'not_configured') return '<div class="empty">RevenueCat isn\'t connected.</div>';
    if (s.state === 'unavailable') return '<div class="empty">RevenueCat is unreachable right now.</div>';
    if (s.state === 'none') return '<div class="empty">No purchase on record — free plan.</div>';
    return `<dl class="kv">
      <dt>Status</dt><dd>${s.state === 'active' ? 'Active' : 'Expired'}</dd>
      <dt>Product</dt><dd class="mono">${esc(s.product || '—')}</dd>
      <dt>Store</dt><dd>${esc(s.store || '—')}${s.sandbox ? ' (sandbox)' : ''}</dd>
      <dt>Period</dt><dd>${esc(s.periodType || '—')}</dd>
      <dt>Started</dt><dd>${esc(full(s.purchasedAt))}</dd>
      <dt>${s.state === 'active' ? 'Renews' : 'Expired'}</dt><dd>${esc(full(s.expiresAt) || 'lifetime')}</dd>
      ${s.unsubscribedAt ? `<dt>Auto-renew off</dt><dd>${esc(full(s.unsubscribedAt))}</dd>` : ''}
      ${s.billingIssueAt ? `<dt>Billing issue</dt><dd>${esc(full(s.billingIssueAt))}</dd>` : ''}
    </dl>`;
  }

  async function userAction(btn, account) {
    const act = btn.dataset.act;
    const id = account.id;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';

    try {
      if (act === 'export') {
        const data = await api(`user?id=${encodeURIComponent(id)}&export=1`);
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `poolhelp-${id.slice(0, 8)}.json`;
        link.click();
        URL.revokeObjectURL(url);
        toast('Export downloaded');
      } else if (act === 'grant') {
        await api('user', {
          method: 'POST',
          body: JSON.stringify({ id, action: 'grant', duration: 'monthly' }),
        });
        toast('Comped one month');
        openUser(id);
      } else if (act === 'revoke') {
        await api('user', { method: 'POST', body: JSON.stringify({ id, action: 'revoke' }) });
        toast('Promotional entitlement revoked');
        openUser(id);
      } else if (act === 'recovery') {
        const out = await api('user', {
          method: 'POST',
          body: JSON.stringify({ id, action: 'recovery_link' }),
        });
        if (out.link) {
          await navigator.clipboard?.writeText(out.link).catch(() => {});
          toast('Reset link copied to clipboard');
        } else {
          toast('No link returned');
        }
      } else if (act === 'delete') {
        const typed = ($('confirmEmail').value || '').trim();
        if (typed.toLowerCase() !== String(account.email || '').toLowerCase()) {
          toast('Type the exact email to confirm');
          return;
        }
        await api('user', {
          method: 'DELETE',
          body: JSON.stringify({ id, confirmEmail: typed }),
        });
        toast('Account deleted');
        closeDrawer();
        renderUsers();
      }
    } catch (err) {
      if (err.message !== 'unauthorized') toast(`Failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // ── health ────────────────────────────────────────────────────────────────

  const HEALTH_LABELS = {
    supabase: ['Supabase', 'Database and auth'],
    aiProxy: ['AI proxy worker', 'Cloudflare worker reachable'],
    aiProxyCostControls: ['AI cost controls', 'Request validation is deployed'],
    revenuecat: ['RevenueCat', 'Subscription platform'],
  };

  async function renderHealth() {
    const host = $('panel-health');
    try {
      const { checks, checkedAt } = await api('health');
      const rows = Object.entries(checks)
        .map(([key, c]) => {
          const [name, hint] = HEALTH_LABELS[key] || [key, ''];
          const pill =
            c.ok === null
              ? '<span class="pill plain">Not configured</span>'
              : c.ok
                ? '<span class="pill ok">OK</span>'
                : '<span class="pill bad">Problem</span>';
          return `<div class="hrow">
            ${pill}
            <div>
              <div class="name">${esc(name)}</div>
              <div class="detail">${esc(c.detail || hint)}</div>
            </div>
            <div class="ms num">${c.ms != null ? `${esc(c.ms)} ms` : ''}</div>
          </div>`;
        })
        .join('');

      host.innerHTML = `
        <div class="panel">
          <h2>Service status</h2>
          ${rows}
          <p class="note">Checked ${esc(full(checkedAt))}. Probes are free —
            the AI proxy check sends a request the worker must reject, so it proves
            the cost-control validator is live without spending anything.</p>
        </div>`;
    } catch (err) {
      if (err.message !== 'unauthorized') {
        host.innerHTML = `<div class="panel"><div class="empty">Couldn't run checks — ${esc(err.message)}</div></div>`;
      }
    }
  }

  // ── shell ─────────────────────────────────────────────────────────────────

  const TABS = {
    overview: renderOverview,
    users: renderUsers,
    health: renderHealth,
  };
  let loaded = {};

  function selectTab(name) {
    for (const key of Object.keys(TABS)) {
      $(`tab-${key}`).setAttribute('aria-selected', String(key === name));
      $(`panel-${key}`).hidden = key !== name;
    }
    if (!loaded[name]) {
      loaded[name] = true;
      TABS[name]();
    }
  }

  function showAuth() {
    $('authView').hidden = false;
    $('appView').hidden = true;
    $('who').hidden = true;
    closeDrawer();
    loaded = {};
  }

  function showApp(email) {
    $('authView').hidden = true;
    $('appView').hidden = false;
    $('who').hidden = false;
    $('whoEmail').textContent = email;
    selectTab('overview');
  }

  async function boot() {
    try {
      const session = await api('session');
      showApp(session.email);
    } catch {
      showAuth();
    }
  }

  // Wiring
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginBtn');
    const err = $('loginErr');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const out = await api('login', {
        method: 'POST',
        body: JSON.stringify({ email: $('email').value, password: $('password').value }),
      });
      $('password').value = '';
      showApp(out.email);
    } catch (e2) {
      err.textContent =
        e2.status === 429
          ? 'Too many attempts. Wait a few minutes.'
          : 'Those credentials are not valid for an admin account.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('signOut').addEventListener('click', async () => {
    try {
      await api('logout', { method: 'POST' });
    } catch {
      /* clearing locally is what matters */
    }
    showAuth();
  });

  for (const name of Object.keys(TABS)) {
    $(`tab-${name}`).addEventListener('click', () => selectTab(name));
  }

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      usersState.search = value;
      usersState.offset = 0;
      renderUsers();
    }, 250);
  });
  $('sort').addEventListener('change', (e) => {
    usersState.sort = e.target.value;
    usersState.offset = 0;
    renderUsers();
  });
  $('refreshUsers').addEventListener('click', renderUsers);

  boot();
})();
