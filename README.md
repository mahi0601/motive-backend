<div align="center">
  <img src="assets/logo-animated.svg" width="120" height="120" alt="Motive logo" />

  # Motive API

  The backend for Motive — a Notion/Todoist-style productivity app.

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
- One-time Stripe Pro upgrade, verified via webhook signature
- Optional integrations — Cloudflare R2 storage, Sentry, Resend email, Logtail — each off by default

The frontend lives in a sibling repo — [Motive](https://github.com/mahi0601/Motive).

## Quick start

```bash
npm install                  # postinstall runs `prisma generate` automatically
cp .env.example .env         # then fill in at minimum DATABASE_URL and JWT_SECRET
npx prisma migrate deploy    # apply migrations to your DATABASE_URL
npm run dev                  # nodemon, http://localhost:8080
```

Only `DATABASE_URL` and `JWT_SECRET` are required — the process exits at boot without them (`src/config/env.js`). Everything else in `.env.example` is optional: missing it just disables that one feature rather than breaking anything else.

`npm run lint` · `npm test` — both stay clean before every deploy (and run in CI against a throwaway Postgres container).

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
2. **Subscribe it to both** `checkout.session.completed` **and** `checkout.session.async_payment_succeeded` (`src/services/payment.service.js` — `RELEVANT_EVENT_TYPES`). The second is what makes delayed-notification methods (UPI, etc.) actually grant Pro.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, the secret key into `STRIPE_SECRET_KEY`.
4. Dashboard → Settings → Payment methods: enable whichever methods you want to accept — this app requests `automatic_payment_methods`, so what renders at checkout is entirely a Dashboard setting.
5. Prices are inline (`PRO_UPGRADE_PRICE_USD_CENTS`, `PRO_UPGRADE_PRICE_INR_PAISE`); only `usd`/`inr` are accepted.

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
