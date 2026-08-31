# poolhelp.app

Product site for PoolHelp (iOS). Static HTML, deployed on Vercel.

- `/` marketing page · `/privacy` · `/terms` · `/safety` · `/support`
- Legal pages are GENERATED from the app repo's markdown (the same text the
  app renders in-app). To update: edit `PRIVACY.md` / `TERMS.md` / `SAFETY.md`
  in the PoolHelp repo, then `python3 scripts/build-legal.py ../PoolHelp`,
  commit, push — Vercel redeploys.
- Screenshots in `assets/img` come from the App Store screenshot set.

## Admin console — `/admin`

An authenticated dashboard for running PoolHelp: product metrics, user
management, subscription support and service health, in one page. Static HTML
plus a handful of Vercel Functions — no framework and **no dependencies**, so
there is no `node_modules` to keep patched on the surface that holds the
service-role key.

```
admin/index.html          the console (login + dashboard)
admin/admin.css|.js       its assets — deliberately NOT under /assets, which
                          is served immutable for a year
api/_lib.js               session signing, auth gate, upstream clients
api/admin/*.js            one route per screen
scripts/admin-auth.test.js   node --test scripts/
```

### How access works

1. Credentials go to Supabase (real password hashing, its own throttling).
2. The returned email must appear in `ADMIN_EMAILS`, or the attempt fails with
   the same generic error as a wrong password — so this page never reveals
   which accounts are admins.
3. The browser gets **our own** HMAC-signed `HttpOnly; Secure; SameSite=Strict`
   cookie, not the Supabase token. An admin cookie is therefore useless against
   Supabase directly, and app users signing in here get nothing.
4. Every API route re-checks the allowlist, so removing an address from
   `ADMIN_EMAILS` revokes access immediately rather than at cookie expiry.

CSRF is covered twice: `SameSite=Strict`, plus a required `x-ph-admin: 1`
header that a cross-origin page cannot set without a preflight this API never
answers.

### Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | yes | publishable key; used only to check the password |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **secret** — full database access, server-side only |
| `ADMIN_EMAILS` | yes | comma-separated allowlist |
| `ADMIN_SESSION_SECRET` | yes | `openssl rand -base64 48`; rotating it signs everyone out |
| `REVENUECAT_V2_KEY` | no | `sk_…` with `charts_metrics:overview:read` |
| `REVENUECAT_PROJECT_ID` | no | RevenueCat project id |
| `AI_PROXY_URL` | no | the Cloudflare worker, for the health checks |

RevenueCat and the AI proxy are optional: without them those panels say so and
everything else still works.

### Where the data comes from

Metrics are computed in Postgres by `admin_overview()`, `admin_users()`,
`admin_user_detail()` and `admin_user_export()` — `SECURITY DEFINER` functions
in the app repo's `supabase/migrations/`, executable by `service_role` **only**.
They read `auth.users`, so those grants are the whole security model; never
grant them to `anon` or `authenticated`.

Subscription data comes from RevenueCat, joined on user id: the app calls
`Purchases.logIn(session.user.id)`, so a RevenueCat customer id **is** a
Supabase user id. Buyers who never signed in live under `$RCAnonymousID:…` and
have no Supabase row — look those up in RevenueCat's own dashboard.
