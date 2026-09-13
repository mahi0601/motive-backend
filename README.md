# Motive API

Node.js + Express + Prisma backend for Motive, a Notion/Todoist-style productivity app. Postgres (hosted on Neon) via Prisma ORM, JWT access/refresh auth, Socket.io for realtime notifications, Stripe for a one-time Pro upgrade, optional Google OAuth login, optional Cloudflare R2 file storage, optional Sentry error tracking, optional Resend transactional email.

The frontend (React/Vite + Capacitor Android) lives in a **sibling repo**: [`../Motive`](../Motive). Two repos, two independent deploy targets — this API on Render, the frontend on Netlify.

## Local setup

```bash
npm install                  # postinstall runs `prisma generate` automatically
cp .env.example .env         # then fill in at minimum DATABASE_URL and JWT_SECRET
npx prisma migrate deploy    # apply migrations to your DATABASE_URL
npm run dev                  # nodemon, http://localhost:8080
```

Only `DATABASE_URL` and `JWT_SECRET` are required — the process exits at boot without them (`src/config/env.js`), and `JWT_SECRET` must be ≥32 chars in production. Everything else in `.env.example` is optional: missing it just disables that one feature (Google login, Stripe, R2, Sentry, Resend) rather than breaking anything else. Read the comments in `.env.example` — they document exactly what each one gates and where to get it.

`npm test` runs the Jest suite (`npm run dev` + manual/curl verification covers everything else not yet under test): the workspace-scoped authorization permission matrix (`tests/permissions.test.js` — the highest-risk surface in the codebase, since a gap there is a cross-tenant data leak rather than a wrong number somewhere), plus regression coverage for auth (JWT rotation/revocation), Stripe payment/webhook idempotency, recurring-task spawning, and Momentum's timezone/date-bucketing math. Shared fixtures live in `tests/helpers/fixtures.js`. Locally this runs against the real dev database (no separate test DB configured for local use); every fixture is created fresh with a unique email and torn down in `afterAll`, and `--runInBand` (see `jest.config.js`) keeps test files from racing each other over the same connection pool. CI (`.github/workflows/ci.yml`) instead spins up a throwaway `postgres:16` service container, runs `prisma migrate deploy` against it, then the same `npm test` — fully self-contained, no Neon/account access needed for CI.

## Deploying (Render)

`render.yaml` is a Render Blueprint: `npm ci && npx prisma migrate deploy` on build, `node src/index.js` to start, health check at `/api/health`, `autoDeploy: true` (pushes to `master` deploy automatically — migrations included).

**16 env vars are `sync: false` in the blueprint**, meaning Render won't set them for you — paste each into the service's dashboard once:

| Var | Where to get it |
|---|---|
| `DATABASE_URL` | Neon dashboard → Connect → **pooled** connection string |
| `FRONTEND_URL` | The deployed frontend's real origin (Netlify) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard — see the Stripe section below first |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend dashboard — `EMAIL_FROM` needs a domain you've verified there |
| `SENTRY_DSN` | A Sentry project (Node platform) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | Cloudflare R2 — see below |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud Console — see below |

(`JWT_SECRET` is `generateValue: true` — Render generates it automatically, nothing to do.)

### Stripe — the one that's easy to half-configure

1. Webhook endpoint URL: `https://<your-api-host>/api/payments/webhook`, content type `application/json` (the route reads the raw body to verify the signature — anything else fails).
2. **Subscribe it to both** `checkout.session.completed` **and** `checkout.session.async_payment_succeeded` (`src/services/payment.service.js` — `RELEVANT_EVENT_TYPES`). The second one is what makes delayed-notification methods (UPI, etc.) actually grant Pro — without that subscription, Stripe just never sends the event and the payment silently never completes on our end.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, the secret key into `STRIPE_SECRET_KEY`.
4. Dashboard → Settings → Payment methods: enable whichever methods you want to accept (cards, wallets, UPI). This app requests `automatic_payment_methods`, so what actually renders at checkout is entirely a Dashboard setting, not code. UPI only ever appears for an India-registered Stripe account.
5. Nothing to create product/price-side — prices are inline (`PRO_UPGRADE_PRICE_USD_CENTS`, `PRO_UPGRADE_PRICE_INR_PAISE`), only `usd`/`inr` are accepted.

### Google OAuth

1. Google Cloud Console → OAuth consent screen, then **one** OAuth client, type **Web application**.
2. Authorized redirect URI: `https://<your-api-host>/api/auth/google/callback` — must match `GOOGLE_REDIRECT_URI` exactly.
3. **You do not need an Android OAuth client, an SHA-1 fingerprint, or to register `com.motive.app://` anywhere in Google's console.** The Android app's native sign-in opens the system browser, completes the exact same web flow above, and only *after* that succeeds does this backend redirect to the app's custom scheme — Google never sees it. Registering one is the most common wasted step here.
4. Requested scopes (`openid email profile`) are non-sensitive, so publishing status only affects the test-user cap, not a verification review.

### Cloudflare R2 (uploads)

Effectively required in production — Render's disk is ephemeral, so without R2 configured, uploaded attachments vanish on every deploy/restart. Create a bucket, an S3-compatible access key pair scoped to it, enable public read access (the `r2.dev` subdomain or a custom domain) for `R2_PUBLIC_URL`. **All five** `R2_*` vars must be set — any single one missing silently falls back to local disk with no error.

### Sentry / Resend

Sentry: create a Node project, paste the DSN. That's the entire requirement — no sourcemap/release config on the backend side.
Resend: verify your sending domain (SPF/DKIM), then set `EMAIL_FROM` to an address on that domain. Left on the shared sandbox sender, password-reset email is dev-only — delivery to real users isn't reliable, and a missing key fails silently (`forgotPassword` always returns the same generic response either way, by design).

## Database

Migrations live in `prisma/migrations/`, applied via `npx prisma migrate deploy` (locally, and automatically on every Render deploy — never run `prisma migrate dev` against production). Get **both** connection strings from Neon while you're there (pooled → `DATABASE_URL`; keep the direct one on hand too — this app currently runs migrations against the pooled URL, which works but isn't Prisma's documented recommendation).

## Project layout

```
src/
  config/       env loading + validation, Prisma client, Sentry init
  controllers/  thin HTTP layer — parses req, calls a service, shapes the response
  services/     business logic (this is what to read first for any feature)
  routes/       Express routers
  middlewares/  auth, validation, rate limiting, error handling
  sockets/      Socket.io notification push
prisma/         schema.prisma + migrations/
```

Response shape is a consistent envelope (`{ success, ...data }` / `{ success: false, message }`) across every endpoint — see `middlewares/error.middleware.js` and any controller for the pattern.
