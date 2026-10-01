# If something goes wrong

One page, for the person on call. Work top to bottom; stop when you have contained it.

## 1. Contain

| Situation | Do this |
|---|---|
| A user's account may be taken over | Revoke their sessions: `UPDATE "Session" SET "revokedAt" = now() WHERE "userId" = '<id>';` and bump `UPDATE "User" SET "tokenVersion" = "tokenVersion" + 1 WHERE id = '<id>';` (live sockets drop on their next check; an API restart drops them at once). Then have them reset their password. |
| Refresh tokens or `JWT_SECRET` may have leaked | Change `JWT_SECRET` in Render and redeploy. Every token becomes invalid, so everyone signs in again. |
| A status-page or invite link leaked | Owner: Settings → regenerate the status link. Invites: revoke and re-send from Members. |
| Stripe key leaked | Roll the key in the Stripe dashboard, update `STRIPE_SECRET_KEY` and the webhook secret in Render, redeploy. Check the dashboard for charges you do not recognise. |
| R2 or Resend key leaked | Create a new key in that dashboard, update Render, redeploy, then delete the old one. |
| Database credential leaked | Reset the role password in Neon, update `DATABASE_URL`, redeploy. |
| Google OAuth secret leaked | Reset it in Google Cloud, update `GOOGLE_CLIENT_SECRET`, redeploy. |
| A malicious deploy | In Render, roll back to the previous deploy. Turn Auto-Deploy off while you investigate. |

## 2. Find out what happened

- `SecurityEvent` is the trail: sign-ins, failed sign-ins, logout-everywhere, password resets, Google links, refresh-token reuse, member and role changes, share links, plan changes, exports and deletions. It holds ids (not emails) and a truncated IP, and is kept 180 days.
  `SELECT "createdAt", type, "actorId", "targetUserId", ip FROM "SecurityEvent" WHERE "targetUserId" = '<id>' OR "actorId" = '<id>' ORDER BY "createdAt" DESC;`
- The same events are in Render/Better Stack logs with `security: true`.
- `Session.lastUsedAt` and `uaHash` show which devices a session belongs to.
- Neon keeps a short history window on the free plan; a restore needs to be started promptly.

## 3. Tell people

If personal data of real people may have been exposed, decide quickly who must be told. Under the GDPR and UK GDPR a personal data breach generally has to be reported to the regulator within 72 hours of becoming aware of it, unless it is unlikely to put people at risk, and affected people may need to be told as well. Other laws and any contracts with schools or districts may add duties. Get qualified advice early; this page is not legal advice.

## 4. Afterwards

Write down what happened, what you changed, and what would have caught it sooner. Add a test for the cause.
