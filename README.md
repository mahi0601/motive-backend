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
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard — optional, INR for buyers in India; see Razorpay below |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MODE` | PayPal developer dashboard — optional, USD; see PayPal below |
| `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_MODE` | Cashfree dashboard — optional, INR; see Cashfree below |
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

### Razorpay — INR for buyers in India (optional)

Stripe is invite-only for new Indian accounts, so INR checkout can run on Razorpay. Leave the three `RAZORPAY_*` variables empty and INR uses Stripe if it is configured; USD always uses Stripe. `GET /api/payments/options` says which provider takes each currency, and the billing card says "unavailable" up front when neither does.

1. Dashboard → Account & Settings → API keys: use **test** keys (`rzp_test_…`) until a payment works end to end, and put them in `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`. Test mode works before KYC is finished.
2. Dashboard → Settings → Webhooks → add `https://<your-api-host>/api/payments/razorpay/webhook`, choose a secret yourself (it is **not** the key secret) and put it in `RAZORPAY_WEBHOOK_SECRET`. Subscribe it to `subscription.authenticated`, `activated`, `charged`, `pending`, `halted`, `cancelled`, `completed` and `updated`. The body is verified with an HMAC-SHA256 signature over the raw bytes (`X-Razorpay-Signature`) and each event is processed once (`X-Razorpay-Event-Id`).
3. Plans are created on demand and remembered (`ProviderPlan`), one per plan and amount, from the same `*_PRICE_INR_PAISE` values. Changing a price makes a new plan and never edits one that existing subscribers are on.
4. How it differs from Stripe, so support questions have answers: a Razorpay payment link has **no redirect back**, so after paying the app asks `POST /api/payments/sync` (and the webhook usually lands first); there is **no customer portal**, so a subscriber cancels in the app (`POST /api/payments/cancel`, at the end of the period, and a cancelled subscription cannot be resumed: they subscribe again); and there is **no in-app Studio to Agency switch** (a UPI subscription cannot be edited and Razorpay documents no proration), so that button is hidden and the card says to cancel at period end and subscribe to Agency, or contact support. Access follows the subscription: `active` and `pending` (a failed charge being retried) keep it on; `halted`, `cancelled`, `completed` and `expired` end it; `created` and `authenticated` grant nothing.
5. Recurring card payments in India are subject to RBI rules and UPI AutoPay has a per-charge limit; which methods a buyer is offered depends on your Razorpay account activation and their bank. Do not promise a method in the UI that has not been tested in your account.

### Several gateways, one "Pay with" choice

Stripe, Razorpay, PayPal and Cashfree are separate gateways behind one registry (`src/services/gateways/`). A gateway is offered for a currency only when it supports it **and** its keys are set, in the order `PAYMENT_PROVIDER_ORDER_USD` (default `stripe,paypal`) / `PAYMENT_PROVIDER_ORDER_INR` (default `razorpay,cashfree,stripe`); the first is preselected, and the billing card shows a "Pay with" choice only when there is more than one. `GET /api/payments/options` lists them; with none for a currency the card says so up front. Each gateway maps its own statuses onto one shared rule set (`src/services/subscriptionState.js`): nobody gets access before paying; a charge being retried keeps access; ended statuses revoke it; a lifetime buyer never loses Pro. Adding a gateway is a service file with a checkout call, a verified webhook and the same state mapping, then one entry in the registry.

| | Stripe | Razorpay | PayPal | Cashfree |
|---|---|---|---|---|
| Currencies | USD, INR | INR | USD | INR |
| Hosted billing page | yes | no | no | no |
| In-app Studio to Agency switch | yes (prorated) | no | no | no |
| Cancel | in Stripe's portal | in the app, at period end | in the app (access kept to the paid-until date) | in the app (access kept to the paid-until date) |
| Checkout hand-off | redirect | redirect | redirect | script (SDK) |
| Extra buyer data | none | none | none | **mobile number**, passed through, never stored |

PayPal and Cashfree stop billing the moment a subscriber cancels, so the app records the date their paid period ends and keeps Pro on until then; `src/jobs/cleanup.js` (every six hours) ends it, so access can outlast the date by up to six hours.

### PayPal — USD (optional)

1. https://developer.paypal.com → create an app (**Sandbox** first) and put its client id and secret in `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. `PAYPAL_MODE` is `sandbox` unless it is exactly `live`, so a typo can never charge real money.
2. Add a webhook to that app: URL `https://<your-api-host>/api/payments/paypal/webhook`, events `BILLING.SUBSCRIPTION.*` and `PAYMENT.SALE.COMPLETED`. Copy its **webhook id** into `PAYPAL_WEBHOOK_ID` (an id, not a secret).
3. A webhook is only a pointer: it is verified by asking PayPal to check its own signature, then the subscription is **re-read from PayPal** and that is applied, so a forged or reordered payload cannot grant access. Each event is processed once (event id).
4. PayPal does not take INR in India, so it is offered for USD only. Product and plan are created on demand and remembered (`ProviderPlan`), one per price. Status map: `ACTIVE` paid (past due if a charge has failed); `APPROVAL_PENDING` / `APPROVED` not paid; `SUSPENDED`, `CANCELLED`, `EXPIRED` ended.

### Cashfree — INR (optional)

1. Cashfree dashboard → API keys (**sandbox** first) into `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET`. `CASHFREE_MODE` is `sandbox` unless it is exactly `production`; `CASHFREE_API_VERSION` is sent as `x-api-version`.
2. Webhook URL `https://<your-api-host>/api/payments/cashfree/webhook`. Cashfree signs it with HMAC-SHA256 over `timestamp + raw body` using the client secret, so there is no separate secret. Messages older than ten minutes are rejected when the timestamp is a number.
3. Checkout needs the buyer's **mobile number**. It goes to Cashfree and is never stored here (add it to the privacy policy). Creating a subscription returns a session id and the browser opens Cashfree's checkout with its script (`https://sdk.cashfree.com/js/v3/cashfree.js`): a Content-Security-Policy must allow that host (see the frontend README).
4. A mandate can be `ACTIVE` before its first debit, so **access is granted only on evidence of a successful payment** (a signed payment-success event, or a successful payment on the subscription's list), never on a status alone; and an unknown status never takes access from someone already paying. Amounts are sent in rupees; `CASHFREE_MAX_CYCLES` (default 120) is the number of monthly debits the mandate allows.
5. **Verify in the Cashfree sandbox before going live**, because Cashfree's docs do not settle these: when the first charge happens relative to authorization, the exact shape of the payments list, what the buyer's return URL carries, and whether cancelling is immediate. The app does not depend on any of them being a particular way, but confirm the plan turns on after the first payment and that cancelling behaves as the Cancel text says.

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
