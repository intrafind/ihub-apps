# Docker Implementation Examples for AI Hub Apps

**Document Version:** 1.0  
**Date:** 2025-07-28  
**Author:** Claude Code  
**Purpose:** Provide concrete implementation examples for Docker support

## Core Implementation Files

### 1. Dockerfile (Multi-Stage Production Build)

```dockerfile
# =============================================================================
# AI Hub Apps - Multi-Stage Docker Build
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies Installation
# -----------------------------------------------------------------------------
FROM node:20-alpine AS dependencies

# Install dumb-init for proper signal handling
RUN apk add --update --no-cache dumb-init

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

# Build the application
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: Development Runtime (for development container)
# -----------------------------------------------------------------------------
FROM dependencies AS development

# Copy source code for development
COPY . .

# Create required directories
RUN mkdir -p /app/contents/data /app/contents/uploads /app/logs

# Expose ports for development (server + vite)
EXPOSE 3000 5173

# Development command with hot reload
CMD ["npm", "run", "dev"]

# -----------------------------------------------------------------------------
# Stage 4: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --update --no-cache dumb-init curl

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S aihub -u 1001 -G nodejs

# Create app directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=aihub:nodejs /app/dist ./

# Copy server node_modules (production only)
COPY --from=builder --chown=aihub:nodejs /app/server/node_modules ./server/node_modules

# Create required directories with proper permissions
RUN mkdir -p /app/contents/data \
             /app/contents/uploads \
             /app/contents/config \
             /app/contents/pages \
             /app/contents/sources \
             /app/logs && \
    chown -R aihub:nodejs /app/contents /app/logs

# Create health check script
COPY --chown=aihub:nodejs <<EOF /app/healthcheck.js
import http from 'http';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/health',
  timeout: 2000
};

const request = http.request(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

request.on('error', () => process.exit(1));
request.on('timeout', () => process.exit(1));
request.end();
EOF

# Switch to non-root user
USER aihub

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node /app/healthcheck.js

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server/server.js"]
```

### 2. Docker Compose - Development Environment

```yaml
# docker-compose.yml - Development Environment
version: '3.8'

services:
  # Main AI Hub Apps Development Container
  ai-hub-dev:
    build:
      context: .
      target: development
      dockerfile: Dockerfile
    container_name: ai-hub-dev
    ports:
      - '3000:3000' # Server port
      - '5173:5173' # Vite dev server port
    volumes:
      # Source code volumes for hot reload
      - ./server:/app/server:ro
      - ./client/src:/app/client/src:ro
      - ./shared:/app/shared:ro

      # Configuration files (bind mount for easy editing)
      - ./contents/config:/app/contents/config:rw
      - ./contents/apps:/app/contents/apps:rw
      - ./contents/models:/app/contents/models:rw
      - ./contents/locales:/app/contents/locales:rw
      - ./contents/prompts:/app/contents/prompts:rw

      # Content that may be edited via admin interface
      - ./contents/pages:/app/contents/pages:rw
      - ./contents/sources:/app/contents/sources:rw

      # Persistent data volumes
      - ai-hub-dev-data:/app/contents/data
      - ai-hub-dev-uploads:/app/contents/uploads
      - ai-hub-dev-logs:/app/logs

      # Node modules cache (performance optimization)
      - ai-hub-dev-node-modules:/app/node_modules
      - ai-hub-dev-client-modules:/app/client/node_modules
      - ai-hub-dev-server-modules:/app/server/node_modules
    environment:
      - NODE_ENV=development
      - LOG_LEVEL=debug
      - WORKERS=1
      - CORS_ORIGIN=http://localhost:5173
    env_file:
      - .env
    restart: unless-stopped
    networks:
      - ai-hub-network
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

  # Optional: Database for external persistence (PostgreSQL example)
  ai-hub-db:
    image: postgres:15-alpine
    container_name: ai-hub-db
    profiles: ['database']
    environment:
      POSTGRES_DB: aihub
      POSTGRES_USER: aihub
      POSTGRES_PASSWORD: ${DB_PASSWORD:-aihub123}
    volumes:
      - ai-hub-db-data:/var/lib/postgresql/data
    ports:
      - '5432:5432'
    networks:
      - ai-hub-network
    restart: unless-stopped

  # Optional: Redis for session storage and caching
  ai-hub-redis:
    image: redis:7-alpine
    container_name: ai-hub-redis
    profiles: ['cache']
    command: redis-server --appendonly yes
    volumes:
      - ai-hub-redis-data:/data
    ports:
      - '6379:6379'
    networks:
      - ai-hub-network
    restart: unless-stopped

volumes:
  ai-hub-dev-data:
  ai-hub-dev-uploads:
  ai-hub-dev-logs:
  ai-hub-dev-node-modules:
  ai-hub-dev-client-modules:
  ai-hub-dev-server-modules:
  ai-hub-db-data:
  ai-hub-redis-data:

networks:
  ai-hub-network:
    driver: bridge
```

### 3. Docker Compose - Production Environment

```yaml
# docker-compose.prod.yml - Production Environment
version: '3.8'

services:
  # Main AI Hub Apps Production Container
  ai-hub-app:
    image: ai-hub-apps:${VERSION:-latest}
    container_name: ai-hub-app
    ports:
      - '3000:3000'
    volumes:
      # Configuration volumes (mounted from host or init container)
      - ai-hub-config:/app/contents/config:ro
      - ai-hub-apps:/app/contents/apps:ro
      - ai-hub-models:/app/contents/models:ro
      - ai-hub-locales:/app/contents/locales:ro
      - ai-hub-prompts:/app/contents/prompts:ro

      # Content that may be updated via admin interface
      - ai-hub-pages:/app/contents/pages:rw
      - ai-hub-sources:/app/contents/sources:rw

      # Persistent data volumes
      - ai-hub-data:/app/contents/data:rw
      - ai-hub-uploads:/app/contents/uploads:rw
      - ai-hub-logs:/app/logs:rw
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
      - WORKERS=${WORKERS:-4}
      - CORS_ORIGIN=${CORS_ORIGIN:-https://yourdomain.com}
    env_file:
      - .env.production
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
    networks:
      - ai-hub-network
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    logging:
      driver: 'json-file'
      options:
        max-size: '10m'
        max-file: '3'

  # Configuration Initialization Container
  ai-hub-config-init:
    image: alpine:latest
    container_name: ai-hub-config-init
    volumes:
      - ./contents/config:/source:ro
      - ./contents/apps:/source-apps:ro
      - ./contents/models:/source-models:ro
      - ./contents/locales:/source-locales:ro
      - ./contents/prompts:/source-prompts:ro
      - ai-hub-config:/dest-config
      - ai-hub-apps:/dest-apps
      - ai-hub-models:/dest-models
      - ai-hub-locales:/dest-locales
      - ai-hub-prompts:/dest-prompts
    command: >
      sh -c "
        echo 'Initializing configuration volumes...'
        cp -r /source/* /dest-config/ 2>/dev/null || true
        cp -r /source-apps/* /dest-apps/ 2>/dev/null || true
        cp -r /source-models/* /dest-models/ 2>/dev/null || true
        cp -r /source-locales/* /dest-locales/ 2>/dev/null || true
        cp -r /source-prompts/* /dest-prompts/ 2>/dev/null || true
        echo 'Configuration initialization completed'
      "
    restart: 'no'

  # Reverse Proxy with SSL Termination
  ai-hub-proxy:
    image: nginx:alpine
    container_name: ai-hub-proxy
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
      - ai-hub-uploads:/var/www/uploads:ro # Serve uploads directly
    depends_on:
      ai-hub-app:
        condition: service_healthy
    networks:
      - ai-hub-network
    restart: unless-stopped
    logging:
      driver: 'json-file'
      options:
        max-size: '5m'
        max-file: '3'

volumes:
  ai-hub-config:
  ai-hub-apps:
  ai-hub-models:
  ai-hub-locales:
  ai-hub-prompts:
  ai-hub-pages:
  ai-hub-sources:
  ai-hub-data:
  ai-hub-uploads:
  ai-hub-logs:

networks:
  ai-hub-network:
    driver: bridge
```

### 4. Environment Configuration Templates

#### .env.development

```bash
# Development Environment Configuration
NODE_ENV=development
LOG_LEVEL=debug
WORKERS=1

# Server Configuration
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=http://localhost:5173

# LLM API Keys
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GOOGLE_API_KEY=your_google_key_here
MISTRAL_API_KEY=your_mistral_key_here

# Authentication
JWT_SECRET=your_jwt_secret_for_dev
ADMIN_SECRET=admin123

# File Upload
MAX_UPLOAD_SIZE=50mb
UPLOAD_PATH=/app/contents/uploads

# Development Features
ENABLE_TELEMETRY=false
DEBUG_MODE=true
HOT_RELOAD=true
```

#### .env.production

```bash
# Production Environment Configuration
NODE_ENV=production
LOG_LEVEL=info
WORKERS=4

# Server Configuration
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=https://yourdomain.com

# LLM API Keys (use secrets management in real deployment)
OPENAI_API_KEY=${OPENAI_API_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
GOOGLE_API_KEY=${GOOGLE_API_KEY}
MISTRAL_API_KEY=${MISTRAL_API_KEY}

# Authentication (use strong secrets)
JWT_SECRET=${JWT_SECRET}
ADMIN_SECRET=${ADMIN_SECRET}

# File Upload
MAX_UPLOAD_SIZE=50mb
UPLOAD_PATH=/app/contents/uploads

# Production Features
ENABLE_TELEMETRY=true
REQUEST_TIMEOUT=30000
```

### 5. Nginx Configuration

```nginx
# nginx/nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream ai-hub-backend {
        server ai-hub-app:3000;
        keepalive 32;
    }

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=uploads:10m rate=2r/s;

    # Basic security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/xml+rss application/json;

    server {
        listen 80;
        server_name _;

        # Redirect HTTP to HTTPS
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name _;

        # SSL Configuration
        ssl_certificate /etc/nginx/ssl/cert.pem;
        ssl_certificate_key /etc/nginx/ssl/key.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-SHA384;
        ssl_prefer_server_ciphers off;

        # API routes with rate limiting
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://ai-hub-backend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
            proxy_read_timeout 300s;
        }

        # Upload endpoints with stricter rate limiting
        location /api/upload {
            limit_req zone=uploads burst=5 nodelay;
            proxy_pass http://ai-hub-backend;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            client_max_body_size 50M;
            proxy_read_timeout 300s;
        }

        # Serve uploaded files directly
        location /uploads/ {
            alias /var/www/uploads/;
            expires 1y;
            add_header Cache-Control "public, immutable";
            add_header X-Content-Type-Options nosniff;
        }

        # Static files and SPA
        location / {
            proxy_pass http://ai-hub-backend;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Cache static assets
            location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
                proxy_pass http://ai-hub-backend;
                expires 1y;
                add_header Cache-Control "public, immutable";
            }
        }

        # Health check endpoint (no rate limiting)
        location /api/health {
            proxy_pass http://ai-hub-backend;
            access_log off;
        }
    }
}
```

### 6. Docker Ignore File

```gitignore
# .dockerignore
# Node modules
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build outputs
dist/
dist-bin/
client/dist/
build/

# Logs
logs/
*.log

# Runtime data
contents/data/
contents/uploads/

# Environment files
.env
.env.local
.env.development
.env.production

# Version control
.git/
.gitignore

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Documentation
docs/
README.md
*.md

# Test files
tests/
*.test.js
__tests__/
coverage/

# Example files
examples/

# Temporary files
tmp/
temp/
```

### 7. Container Entrypoint Script

```bash
#!/bin/sh
# docker-entrypoint.sh

set -e

# Function to wait for a service to be ready
wait_for_service() {
    host="$1"
    port="$2"
    timeout="${3:-30}"

    echo "Waiting for $host:$port to be ready..."
    for i in $(seq 1 $timeout); do
        if nc -z "$host" "$port" 2>/dev/null; then
            echo "$host:$port is ready"
            return 0
        fi
        echo "Waiting... ($i/$timeout)"
        sleep 1
    done

    echo "Timeout waiting for $host:$port"
    return 1
}

# Initialize directories if they don't exist
mkdir -p /app/contents/data /app/contents/uploads /app/logs

# Set proper permissions
chown -R aihub:nodejs /app/contents /app/logs 2>/dev/null || true

# Wait for external services if configured
if [ -n "$DATABASE_HOST" ]; then
    wait_for_service "$DATABASE_HOST" "${DATABASE_PORT:-5432}"
fi

if [ -n "$REDIS_HOST" ]; then
    wait_for_service "$REDIS_HOST" "${REDIS_PORT:-6379}"
fi

# Validate required environment variables
required_vars=""
if [ -z "$JWT_SECRET" ]; then
    required_vars="$required_vars JWT_SECRET"
fi

if [ -n "$required_vars" ]; then
    echo "Error: Required environment variables not set: $required_vars"
    exit 1
fi

# Run the application
echo "Starting AI Hub Apps..."
exec "$@"
```

## Usage Examples

### Development Workflow

```bash
# Start development environment
docker-compose up -d

# View logs
docker-compose logs -f ai-hub-dev

# Restart after code changes
docker-compose restart ai-hub-dev

# Run tests
docker-compose exec ai-hub-dev npm run test:all

# Access shell for debugging
docker-compose exec ai-hub-dev sh

# Clean up
docker-compose down -v
```

### Production Deployment

```bash
# Build production image
docker build -t ai-hub-apps:v1.0.0 .

# Deploy with compose
docker-compose -f docker-compose.prod.yml up -d

# Scale the application
docker-compose -f docker-compose.prod.yml up -d --scale ai-hub-app=3

# Monitor health
docker-compose -f docker-compose.prod.yml ps
docker-compose -f docker-compose.prod.yml logs -f

# Update deployment
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d --no-deps ai-hub-app
```

These implementation examples provide a complete foundation for containerizing AI Hub Apps with proper separation of concerns, security considerations, and production-ready configurations.
