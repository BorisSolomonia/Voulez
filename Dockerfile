# Wolt Sync System - Production Dockerfile
# =========================================
# Build: docker build -t wolt-sync .
# Run:   docker run -d --env-file .env -p 3000:3000 wolt-sync

# Build Stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production Stage
FROM node:18-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S wolt -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist
COPY ecosystem.config.js ./

# Create directories for logs and state
RUN mkdir -p logs state && \
    chown -R wolt:nodejs /app

# Switch to non-root user
USER wolt

# Expose health check port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Default command (can be overridden)
CMD ["node", "dist/index.js"]
