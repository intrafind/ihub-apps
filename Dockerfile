# Use AWS hardened base image - Amazon Linux 2023 with Node.js 20
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# Set metadata
LABEL maintainer="AI Hub Apps Team"
LABEL description="AI Hub Apps - AI-powered applications platform"

# Install required packages (curl-minimal is already available)
RUN dnf update -y && \
    dnf install -y shadow-utils tar gzip xz && \
    dnf clean all && \
    rm -rf /var/cache/dnf

# Install Node.js 20 LTS manually
RUN curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | tar -xJ -C /opt && \
    ln -s /opt/node-v20.18.0-linux-x64/bin/node /usr/local/bin/node && \
    ln -s /opt/node-v20.18.0-linux-x64/bin/npm /usr/local/bin/npm && \
    ln -s /opt/node-v20.18.0-linux-x64/bin/npx /usr/local/bin/npx

# Verify Node.js version
RUN node --version && npm --version

# Create non-root user for security
RUN groupadd -r aihub && \
    useradd -r -g aihub -s /bin/bash -m aihub

# Set working directory
WORKDIR /app

# Create volume mount points for external configuration
RUN mkdir -p /app/contents/config \
             /app/contents/models \
             /app/contents/apps \
             /app/contents/pages \
             /app/public \
             /app/logs \
             /app/data && \
    chown -R aihub:aihub /app

# Copy package files for dependency installation
COPY --chown=aihub:aihub package*.json ./
COPY --chown=aihub:aihub server/package*.json ./server/
COPY --chown=aihub:aihub client/package*.json ./client/

# Install dependencies
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && \
    cd server && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && \
    cd ../client && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && \
    npm cache clean --force

# Copy application files
COPY --chown=aihub:aihub . .

# Build the application
RUN npm run prod:build

# Build binary using version from package.json
RUN export VERSION=$(node -p "require('./package.json').version") && ./build.sh --binary

# Switch to non-root user
USER aihub

# Set environment variables with defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV CONFIG_PATH=/app/contents/config
ENV LOGS_PATH=/app/logs
ENV DATA_PATH=/app/data

# Environment variables for API keys (to be provided at runtime)
# Note: These are set to empty by default for security - provide actual keys at runtime
ENV OPENAI_API_KEY= \
    ANTHROPIC_API_KEY= \
    GOOGLE_API_KEY= \
    MISTRAL_API_KEY=

# Expose port
EXPOSE 3000

# Create volume mount points  
VOLUME ["/app/contents/config", "/app/contents/models", "/app/contents/apps", "/app/contents/pages", "/app/public", "/app/logs", "/app/data"]

# Health check (curl should be available from installation above)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Start command - use binary with dynamic version
CMD ["/bin/bash", "-c", "export VERSION=$(node -p \"require('./package.json').version\") && echo \"Starting with binary executable...\" && chmod +x /app/dist-bin/ai-hub-apps-v${VERSION}-linux && /app/dist-bin/ai-hub-apps-v${VERSION}-linux"]