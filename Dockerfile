# ── Stage 1: install production dependencies and generate the Prisma client ───
# The prisma CLI is a regular dependency (the container applies migrations at
# start), so `--omit=dev` still gets it. The schema must be present first,
# because @prisma/client's postinstall runs `prisma generate`.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

# ── Stage 2: the runtime image ────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# NODE_ENV=production is what error.middleware.js's stack-trace gate
# (`config.isProd`) relies on: a container run with no override must not leak
# stack traces to clients.
ENV NODE_ENV=production

# Only what runs: production node_modules from stage 1, then the source. No test
# tooling, no compilers, no devDependencies in the final image.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# The app writes local uploads here when R2 is not configured. Owned by the
# unprivileged user, so the process never needs root to do its job.
RUN mkdir -p public/uploads && chown -R node:node public

# Run as the unprivileged `node` user that the base image provides (uid 1000),
# not root: a bug in a dependency then cannot, for example, rewrite the image's
# own files or bind privileged ports.
USER node

EXPOSE 8080

# Lets Docker and orchestrators see a wedged process. The app answers /api/health
# with the database status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/api/health" || exit 1

# Pending migrations are applied by src/index.js (utils/applyMigrations.js) before the server
# listens: it runs through Neon's direct host, which `migrate deploy` needs. Running it here too
# would use the raw (pooled) DATABASE_URL and fail, so the container just starts the app.
CMD ["node", "src/index.js"]
