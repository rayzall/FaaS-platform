# ─── Build stage ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY apps/frontend/package*.json ./apps/frontend/
COPY packages/shared-types/package*.json ./packages/shared-types/

RUN npm ci --workspace=apps/frontend --workspace=packages/shared-types --include-workspace-root

COPY packages/shared-types ./packages/shared-types
COPY apps/frontend ./apps/frontend

RUN npm run build --workspace=packages/shared-types
RUN npm run build --workspace=apps/frontend

# ─── Production stage (nginx) ─────────────────────────────────
FROM nginx:1.25-alpine AS runner

COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html

# SPA routing — serve index.html for all routes
RUN echo 'server { \
  listen 3000; \
  root /usr/share/nginx/html; \
  index index.html; \
  location / { try_files $uri $uri/ /index.html; } \
  location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ { \
    expires 1y; add_header Cache-Control "public, immutable"; \
  } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
