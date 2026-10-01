# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** through GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. Please use accounts and data you own, and do not access, change or delete other people's data.

We aim to acknowledge a report within 5 business days and to tell you what we plan to do about it. This is a small project, so these are targets, not guarantees.

## Scope

This repository is Motive's API (Express, Prisma, Postgres, Socket.io). The web app lives in the companion `Motive` repository; report issues in either there or here.

## What we already do

Sessions with rotating refresh tokens and reuse detection, per-request session checks, rate limits on credential endpoints, DOMPurify on rich text, a security event trail (`SecurityEvent`), secret scanning (gitleaks) and CodeQL in CI, Dependabot, and request logs and Sentry reports scrubbed of tokens. See `docs/incident.md` for how we respond when something goes wrong.
