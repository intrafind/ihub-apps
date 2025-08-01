# =============================================================================
# iHub Apps - Multi-Stage Docker Build
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies Installation
# -----------------------------------------------------------------------------
FROM node:20-alpine AS dependencies

# Install system dependencies required for build
RUN apk add --update --no-cache \
    dumb-init \
    git \
    python3 \
    make \
    g++

# Create app directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./
COPY client/package*.json ./client/
COPY server/package*.json ./server/

# Install all dependencies (including dev dependencies for build)
RUN npm run install:all

# -----------------------------------------------------------------------------
# Stage 2: Build Stage
# -----------------------------------------------------------------------------
FROM dependencies AS builder

# Copy source code
COPY . .

# Build the complete application (client + server) - skip docs for Docker
RUN npm run build:docker

# -----------------------------------------------------------------------------
# Stage 3: Development Runtime (for development container)
# -----------------------------------------------------------------------------
FROM dependencies AS development

# Copy source code for development
COPY . .

# Create required directories with proper permissions
RUN mkdir -p \
    /app/contents/data \
    /app/contents/uploads \
    /app/contents/config \
    /app/contents/pages \
    /app/contents/sources \
    /app/logs

# Expose ports for development (server + vite)
EXPOSE 3000 5173

# Development command with hot reload
CMD ["npm", "run", "dev"]

# -----------------------------------------------------------------------------
# Stage 4: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Set production environment
ENV NODE_ENV=production

# Install runtime dependencies
RUN apk add --update --no-cache \
    dumb-init \
    curl \
    tini

# Create non-root user for security
RUN addgroup -S aihub && \
    adduser -S -D -H -s /sbin/nologin -G aihub aihub

# Create app directory
WORKDIR /app

# Copy built application from builder stage (this contains everything: server, public, contents)
COPY --from=builder --chown=aihub:aihub /app/dist ./

# Create required directories with proper permissions (these will be mounted from volumes)
RUN mkdir -p \
    /app/contents/data \
    /app/contents/uploads \
    /app/contents/config \
    /app/contents/pages \
    /app/contents/sources \
    /app/logs && \
    chown -R aihub:aihub /app/contents /app/logs

# Create health check script
COPY --chown=aihub:aihub <<EOF /app/healthcheck.js
import http from 'http';

const options = {
  hostname: 'localhost',
  port: process.env.PORT || 3000,
  path: '/api/health',
  timeout: 5000
};

const request = http.request(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    console.log(\`Health check failed with status: \${res.statusCode}\`);
    process.exit(1);
  }
});

request.on('error', (err) => {
  console.log(\`Health check error: \${err.message}\`);
  process.exit(1);
});

request.on('timeout', () => {
  console.log('Health check timeout');
  request.destroy();
  process.exit(1);
});

request.end();
EOF

# Copy entrypoint script
COPY --chown=aihub:aihub docker/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Switch to non-root user
USER aihub

# Health check configuration
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node /app/healthcheck.js

# Expose port
EXPOSE 3000

# Define volumes for data persistence
VOLUME ["/app/contents/data", "/app/contents/uploads", "/app/logs"]

# Use tini as PID 1 to handle signals properly
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]

# Start the application (we're already in /app and copied dist to ./, so server is at ./server/server.js)
CMD ["node", "server/server.js"]