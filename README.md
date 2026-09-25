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
| `ADMIN_READ_TOKEN` | no | `openssl rand -base64 32`; a read-only credential for bots (see below) |

RevenueCat and the AI proxy are optional: without them those panels say so and
everything else still works.

A missing **required** variable is reported as `503 {"error":"not_configured","missing":"<NAME>"}`
and the page names the variable — never its value — so a half-configured
deploy explains itself instead of showing `server_error`.

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

### Bots and the read-only token

Automation (a cost watchdog, a support-triage bot) must never hold the same
credential as the owner: the owner's cookie also authorizes comping a
subscription and deleting an account. So bots get a **separate** credential,
`ADMIN_READ_TOKEN`, sent as `Authorization: Bearer <token>` (no CSRF header
needed — browsers never attach a bearer on their own):

```
curl -s https://poolhelp.app/api/admin/overview/ -H "Authorization: Bearer $ADMIN_READ_TOKEN"
```

The distinction is enforced in code (`requireWrite()` in `api/_lib.js`), not in
any bot's instructions:

| Route | Owner cookie | Bearer token |
| --- | --- | --- |
| `session/`, `overview/`, `users/`, `user/?id=`, `health/` | yes | yes |
| `user/?id=&export=1` (bulk PII export) | yes | **403** |
| `POST user/` (comp, revoke, recovery link) | yes | **403** |
| `DELETE user/` | yes | **403** |

A bearer that is present but wrong is a 401 and never falls through to the
cookie. Leaving `ADMIN_READ_TOKEN` unset refuses every bearer. Rotate it by
setting a new value; there is nothing else to invalidate.

### Running locally

`vercel dev` does **not** read a root `.env.local` for plain functions in a
no-framework project, and it overwrites `.vercel/.env.development.local` with
the linked project's (empty) development environment on every start. What
works is inline process env, which the function runner inherits:

```
SUPABASE_URL=https://example.invalid ADMIN_EMAILS=you@example.com \
ADMIN_SESSION_SECRET=dev ADMIN_READ_TOKEN=dev-token npx vercel dev
```

Unit tests need nothing: `node --test scripts/`.

## Issue autofix

`.github/workflows/issue-autofix.yml` runs Claude Code unattended whenever you
or a collaborator opens an issue (or anyone adds the `autofix` label to one).
A confidently fixable defect becomes a **draft PR** whose body starts with
`Fixes #<n>`; anything else gets a triage comment and the `needs-human` label.
Nothing merges itself.

- **Setup**: one *repository* secret (Settings → Secrets and variables →
  Actions), either `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, bills
  against your subscription) or `ANTHROPIC_API_KEY` (bills per token). The
  workflow declares no environment, so an environment secret is not visible to
  it. It takes effect once merged to the default branch. Also tick **Allow
  GitHub Actions to create and approve pull requests** under Settings →
  Actions → General → Workflow permissions; without it the agent can push its
  branch but not open the PR, and leaves a one-click PR link on the issue
  instead.
- **Model**: Fable 5.1 (`--model fable`). With an API key, Fable bills per
  token at twice Opus 5, capped at 15 USD per run. With a subscription token
  it draws on your plan limits, except on plans where Fable bills to usage
  credits: headless runs never ask first, so keep usage credits off in
  claude.ai → Settings → Usage unless you want that. Fall back with
  `--model opus`.
- **Guardrails** (`scripts/issue-autofix-prompt.md`): issue text is untrusted
  input; the agent may not touch `.github/`, `scripts/`, add dependencies,
  weaken `api/_lib.js` or the `vercel.json` headers, or hand-edit the generated
  legal pages; `node --test scripts/` must pass; 150 turns, 15 USD and 45
  minutes per run, one run per issue at a time.
- **Re-run**: add the `autofix` label, or Actions → Issue autofix → Run
  workflow with the issue number. An issue that already has an
  `autofix/issue-<n>` branch is skipped.
