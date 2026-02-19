# Multi-stage build
# Stage 1: Build TypeScript
FROM node:22-slim AS builder
WORKDIR /app
COPY typescript/package*.json ./typescript/
RUN cd typescript && npm ci
COPY typescript/ ./typescript/
RUN cd typescript && npm run build

# Stage 2: Production
FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/typescript/dist ./dist
COPY --from=builder /app/typescript/package*.json ./
COPY --from=builder /app/typescript/node_modules ./node_modules
# Install runtime deps only
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg git curl \
    && rm -rf /var/lib/apt/lists/*
# Copy Python package
COPY python/ ./python/
RUN cd python && pip3 install --break-system-packages .
# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:18790/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
EXPOSE 18790
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
