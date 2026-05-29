# ─── Build stage ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (workspaces hoist node_modules to root)
COPY package*.json ./
COPY apps/api-gateway/package*.json ./apps/api-gateway/
COPY packages/shared-types/package*.json ./packages/shared-types/

RUN npm ci --workspace=apps/api-gateway --workspace=packages/shared-types --include-workspace-root

# Copy source
COPY packages/shared-types ./packages/shared-types
COPY apps/api-gateway ./apps/api-gateway

# Build shared types
RUN npm run build --workspace=packages/shared-types

# Generate Prisma client
RUN cd apps/api-gateway && npx prisma generate

# Build API
RUN npm run build --workspace=apps/api-gateway

# ─── Production stage ─────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache curl wget openssl

WORKDIR /app

ENV NODE_ENV=production

# Copy hoisted node_modules and built artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared-types ./packages/shared-types
COPY --from=builder /app/apps/api-gateway/dist ./apps/api-gateway/dist
COPY --from=builder /app/apps/api-gateway/prisma ./apps/api-gateway/prisma
COPY --from=builder /app/apps/api-gateway/package.json ./apps/api-gateway/

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

WORKDIR /app/apps/api-gateway

EXPOSE 3001

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
