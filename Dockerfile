FROM node:20-alpine

WORKDIR /app

# Prisma's postinstall (`prisma generate`) needs the schema and the `prisma`
# CLI (a devDependency), so install with dev deps present and the schema
# already copied, rather than the old `--only=production` + copy-after order.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

EXPOSE 8080

# Applies pending migrations before the app starts — needed since this image
# has no separate release/build step like Render's.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]

