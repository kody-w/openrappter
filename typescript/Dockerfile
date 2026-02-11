# OpenRappter Docker Image
# Node 22 with pnpm for optimal performance

FROM node:22-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# ---
FROM base AS deps

# Install production dependencies
RUN pnpm install --frozen-lockfile --prod

# ---
FROM base AS build

# Install all dependencies including dev
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm run build

# ---
FROM node:22-alpine AS runtime

# Install pnpm for running
RUN corepack enable && corepack prepare pnpm@latest --activate

# Create non-root user for security
RUN addgroup -g 1001 -S openrappter && \
    adduser -S openrappter -u 1001 -G openrappter

WORKDIR /app

# Copy built artifacts
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/bin ./bin

# Create data directories
RUN mkdir -p /app/data /app/config /app/logs && \
    chown -R openrappter:openrappter /app

# Switch to non-root user
USER openrappter

# Environment variables
ENV NODE_ENV=production
ENV OPENRAPPTER_DATA_DIR=/app/data
ENV OPENRAPPTER_CONFIG_DIR=/app/config
ENV OPENRAPPTER_LOG_DIR=/app/logs

# Expose gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:18789/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Default command - start gateway
CMD ["node", "dist/index.js", "gateway", "--bind", "all"]
