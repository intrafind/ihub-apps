# Multi-stage build for AI Hub Apps
# Uses hardened AWS Linux base image as requested

FROM public.ecr.aws/lambda/nodejs:20 AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY client/package*.json ./client/
COPY server/package*.json ./server/

# Install all dependencies (including dev dependencies for build)
RUN npm run install:all

# Copy source code
COPY . .

# Build the application and create binary
RUN chmod +x build.sh && \
    ./build.sh --binary

# Production stage - use Node.js official Alpine image for better compatibility
FROM node:20-alpine

# Install additional packages for functionality
RUN apk add --no-cache curl

# Set working directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=node:node /app/dist /app/
COPY --from=builder --chown=node:node /app/dist-bin /app/dist-bin

# Create directories for external mounts with proper permissions and set up binary
RUN mkdir -p /app/data /app/logs /app/config && \
    chown -R node:node /app && \
    (cp /app/dist-bin/ai-hub-apps-* /app/ai-hub-apps 2>/dev/null && chmod +x /app/ai-hub-apps) || echo "Binary not found, will use Node.js"

# Switch to non-root user
USER node

# Create symbolic links for configuration override
RUN ln -sf /app/config/platform.json /app/contents/config/platform.json || true && \
    ln -sf /app/config/apps.json /app/contents/config/apps.json || true && \
    ln -sf /app/config/models.json /app/contents/config/models.json || true && \
    ln -sf /app/config/groups.json /app/contents/config/groups.json || true && \
    ln -sf /app/config/ui.json /app/contents/config/ui.json || true

# Switch to non-root user
USER aihub

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Set default environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info \
    CONFIG_DIR=/app/config \
    DATA_DIR=/app/data \
    LOG_DIR=/app/logs

# Default command - use binary if available, fallback to Node.js
CMD ["/bin/sh", "-c", "if [ -x /app/ai-hub-apps ]; then exec /app/ai-hub-apps; else exec node /app/server/start-prod.js; fi"]