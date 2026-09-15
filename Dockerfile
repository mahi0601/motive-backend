FROM node:20-alpine

WORKDIR /app

# Prisma's postinstall (`prisma generate`) needs the schema and the `prisma`
# CLI (a devDependency), so install with dev deps present and the schema
# already copied, rather than the old `--only=production` + copy-after order.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# Set *after* npm ci, not before — `npm ci` needs devDependencies present
# (see the comment above) and NODE_ENV=production during install would
# skip them. This is what error.middleware.js's stack-trace-in-response gate
# (`config.isProd`, i.e. NODE_ENV === 'production' exactly) actually relies
# on — Render's render.yaml already sets this correctly via envVars, but a
# container run from this Dockerfile with no explicit override previously
# leaked stack traces to clients.
ENV NODE_ENV=production

EXPOSE 8080

# Applies pending migrations before the app starts — needed since this image
# has no separate release/build step like Render's.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]

