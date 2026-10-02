<div align="center">
  <img src="assets/logo-animated.svg" width="120" height="120" alt="Clientglass logo" />

  # Clientglass API

  The backend for Clientglass — client-ready project delivery for small agencies: a task board your team runs, and a live status page your client opens without an account.

  [![CI](https://github.com/mahi0601/motive-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/mahi0601/motive-backend/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

  [Frontend repo](https://github.com/mahi0601/Motive)
</div>

<br>

Node.js + Express + Prisma, Postgres (Neon), JWT auth, Socket.io, Stripe.

## Features

- Workspace-scoped multi-tenancy with a permission matrix enforced on every route
- JWT access/refresh auth with rotation and revocation, plus optional Google OAuth
- Realtime notifications over Socket.io
- Public client status page per workspace: branding, milestone, client sign-off and responses, no client account
- Stripe subscription billing, verified via webhook signature
- Optional integrations — Cloudflare R2 storage, Sentry, Resend email, Logtail — each off by default

The frontend lives in a sibling repo — [Clientglass](https://github.com/mahi0601/Motive).

## Quick start

```bash
npm install                  # postinstall runs `prisma generate` automatically
cp .env.example .env         # then fill in at minimum DATABASE_URL and JWT_SECRET
npx prisma migrate deploy    # apply migrations to your DATABASE_URL
npm run dev                  # nodemon, http://localhost:8080
```

Only `DATABASE_URL` and `JWT_SECRET` are required — the process exits at boot without them (`src/config/env.js`). Everything else in `.env.example` is optional: missing it just disables that one feature rather than breaking anything else.

`npm run lint` · `npm test` — both stay clean before every deploy (and run in CI against a throwaway Postgres container).

### Testing

The suite writes real rows, so it needs a real Postgres — and it **refuses to run against a Neon database** (`jest.setup.js`). Point `DATABASE_URL` at a local or throwaway instance for the run:

```bash
DATABASE_URL="postgresql://user@127.0.0.1:5432/motive_test" npx prisma migrate deploy
DATABASE_URL="postgresql://user@127.0.0.1:5432/motive_test" npm test
```

Set `ALLOW_REMOTE_TEST_DB=1` only if you deliberately want to run against a hosted database you are happy to have test rows written to.

<br>

<details>
<summary><strong>Deployment, integrations, and database details</strong></summary>

<br>

### Deploying (Render)

`render.yaml` is a Render Blueprint: `npm ci && npx prisma migrate deploy` on build, `node src/index.js` to start, health check at `/api/health`, `autoDeploy: true`.

**17 env vars are `sync: false`** in the blueprint, meaning Render won't set them for you:

| Var | Where to get it |
|---|---|
| `DATABASE_URL` | Neon dashboard → Connect → **pooled** connection string |
| `FRONTEND_URL` | The deployed frontend's real origin |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard — see Stripe below |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend dashboard — needs a verified sending domain |
| `SENTRY_DSN` | A Sentry project (Node platform) |
| `LOGTAIL_SOURCE_TOKEN` | Optional — a Better Stack (Logtail) source |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | Cloudflare R2 — see below |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud Console — see below |

(`JWT_SECRET` is `generateValue: true` — Render generates it automatically.)

### Stripe — the one that's easy to half-configure

1. Webhook endpoint: `https://<your-api-host>/api/payments/webhook`, content type `application/json` (the route reads the raw body to verify the signature).
2. **Subscribe it to these events** (`src/services/payment.service.js`): `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`. The first two grant Pro when a checkout is paid; the `customer.subscription.*` events keep it in step with renewals and cancellations — without them a cancelled subscriber would stay Pro forever.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, the secret key into `STRIPE_SECRET_KEY`.
4. Dashboard → Settings → Payment methods: enable whichever methods you want to accept. Checkout then offers those that are valid for a recurring payment in the buyer's currency.
5. Dashboard → Settings → Billing → **Customer portal**: turn it on (and allow cancelling subscriptions). The app's "Manage billing" button opens it; it fails until it's enabled.
6. Clientglass is a **monthly subscription** in two paid plans, **Studio** and **Agency** (plus Free), priced by active client — see `src/utils/plans.js` for the limits. Prices are inline, per plan and currency: `STUDIO_PRICE_USD_CENTS` / `STUDIO_PRICE_INR_PAISE` / `AGENCY_PRICE_USD_CENTS` / `AGENCY_PRICE_INR_PAISE` (monthly amounts; the defaults are placeholders). The buyer's plan travels in the checkout metadata and the webhook stores it on the user; only `usd`/`inr` are accepted. Keep the frontend's `src/config/plans.js` (what the pricing page shows) in step with whatever you charge. Everyone who was Pro before tiers or subscriptions is treated as Agency (the migration sets it, and `proLifetime` users stay Agency regardless of any subscription). A Studio subscriber moves to Agency in the app (`POST /api/payments/change-plan`): the existing subscription is repriced with proration, in its own currency, rather than a second checkout. Only that upgrade is offered; a downgrade is not (it needs a decision on clients over the new limit), and it is refused unless the subscription is active and not set to end.

### Google OAuth

1. Google Cloud Console → OAuth consent screen, then **one** OAuth client, type **Web application**.
2. Authorized redirect URI: `https://<your-api-host>/api/auth/google/callback`, matching `GOOGLE_REDIRECT_URI` exactly.
3. **No Android OAuth client, SHA-1 fingerprint, or `com.motive.app://` registration needed** — the Android app's native sign-in opens the system browser and completes the same web flow; Google never sees the custom scheme.

### Cloudflare R2 (uploads)

Effectively required in production — Render's disk is ephemeral, so without R2 uploaded attachments vanish on every deploy/restart. **All five** `R2_*` vars must be set; any single one missing silently falls back to local disk with no error.

### Logging

`src/config/logger.js` (pino) is the one place a log line becomes both a structured stdout entry *and*, for a genuinely unexpected error, a Sentry report. Pretty-printed locally, plain JSON in production. Optionally also ships to Better Stack (Logtail) if `LOGTAIL_SOURCE_TOKEN` is set.

### Database

Migrations live in `prisma/migrations/`, applied via `npx prisma migrate deploy` — never run `prisma migrate dev` against production. Get both connection strings from Neon (pooled → `DATABASE_URL`, keep the direct one on hand too).

### Project layout

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

Response shape is a consistent envelope (`{ success, ...data }` / `{ success: false, message }`) across every endpoint.

</details>

## Contributing

Issues and pull requests are welcome. Fork, branch off `master`, keep `lint` / `test` clean, open a PR.

## License

[MIT](LICENSE) © Bipasha Bhattacharjee
