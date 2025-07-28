# Docker Support Technical Specification for AI Hub Apps

**Document Version:** 1.0  
**Date:** 2025-07-28  
**Author:** Claude Code  
**Purpose:** Enable containerized deployment for both local development and production environments

## Executive Summary

This specification defines comprehensive Docker support for AI Hub Apps, enabling:

- Consistent development environments across team members
- Simplified production deployment with container orchestration
- Clear data separation for configuration, runtime data, and user content
- Scalable multi-container architecture supporting clustering and load balancing

## Business Value

- **Deployment Consistency**: Eliminate "works on my machine" issues
- **Scalability**: Enable horizontal scaling with container orchestration
- **Development Velocity**: Faster onboarding with containerized environments
- **Infrastructure Flexibility**: Deploy on any Docker-compatible platform
- **Data Management**: Clear separation of concerns for different data types

## Current Architecture Analysis

### Application Structure

AI Hub Apps consists of:

- **Node.js Express Server** with clustering support (port 3000)
- **React/Vite Client** served as static files
- **File-based Configuration System** with hot reloading
- **Multi-mode Authentication** (anonymous, local, OIDC, proxy)
- **Real-time Chat** with EventSource streaming

### Data Classification

Based on analysis of the `/contents` directory structure, data is classified into five distinct categories:

1. **Configuration Data** (`/contents/config/`)
   - Static configuration files (platform.json, groups.json, ui.json)
   - Model definitions and app configurations
   - Requires read-only access in production
   - Hot-reloadable without restart

2. **Runtime Data** (`/contents/data/`)
   - Dynamic operational data (feedback.jsonl, usage.json, shortlinks.json)
   - User interaction logs and analytics
   - Requires persistent read-write access
   - Critical for application state

3. **User Uploads** (`/contents/uploads/`)
   - User-generated files and assets
   - Document uploads and processed files
   - Requires persistent read-write access
   - Security-sensitive (file validation needed)

4. **Content & Pages** (`/contents/pages/`, `/contents/sources/`)
   - Markdown content and React components
   - Knowledge base and documentation
   - Semi-static but may be updated via admin interface
   - Supports both .md and .jsx files

5. **Localization & Templates** (`/contents/locales/`, `/contents/prompts/`)
   - Translation files and prompt templates
   - App definitions and model configurations
   - Mostly static, occasionally updated
   - Critical for application functionality

## Docker Architecture Design

### Multi-Stage Build Strategy

```dockerfile
# Stage 1: Dependencies and Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY client/package*.json ./client/
COPY server/package*.json ./server/
RUN npm run install:all
COPY . .
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./
COPY --from=builder /app/server/node_modules ./server/node_modules
EXPOSE 3000
CMD ["node", "server/server.js"]
```

### Volume Mapping Strategy

#### Development Environment

```yaml
version: '3.8'
services:
  ai-hub-dev:
    build:
      context: .
      target: development
    ports:
      - '3000:3000'
      - '5173:5173' # Vite dev server
    volumes:
      # Live code updates
      - ./server:/app/server:ro
      - ./client/src:/app/client/src:ro
      - ./shared:/app/shared:ro

      # Data volumes (persistent)
      - ai-hub-data:/app/contents/data
      - ai-hub-uploads:/app/contents/uploads
      - ai-hub-logs:/app/logs

      # Configuration (bind mounts for easy editing)
      - ./contents/config:/app/contents/config:ro
      - ./contents/apps:/app/contents/apps:ro
      - ./contents/models:/app/contents/models:ro
      - ./contents/pages:/app/contents/pages:rw
      - ./contents/locales:/app/contents/locales:ro
      - ./contents/prompts:/app/contents/prompts:ro
      - ./contents/sources:/app/contents/sources:rw
    environment:
      - NODE_ENV=development
    env_file:
      - .env
```

#### Production Environment

```yaml
version: '3.8'
services:
  ai-hub-app:
    image: ai-hub-apps:latest
    ports:
      - '3000:3000'
    volumes:
      # Persistent data volumes
      - ai-hub-config:/app/contents/config:ro
      - ai-hub-data:/app/contents/data:rw
      - ai-hub-uploads:/app/contents/uploads:rw
      - ai-hub-logs:/app/logs:rw
      - ai-hub-pages:/app/contents/pages:rw
      - ai-hub-sources:/app/contents/sources:rw

      # Static content (read-only)
      - ai-hub-apps:/app/contents/apps:ro
      - ai-hub-models:/app/contents/models:ro
      - ai-hub-locales:/app/contents/locales:ro
      - ai-hub-prompts:/app/contents/prompts:ro
    environment:
      - NODE_ENV=production
    env_file:
      - .env.production
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  ai-hub-config:
  ai-hub-data:
  ai-hub-uploads:
  ai-hub-logs:
  ai-hub-pages:
  ai-hub-sources:
  ai-hub-apps:
  ai-hub-models:
  ai-hub-locales:
  ai-hub-prompts:
```

## Environment Configuration

### Base Environment Variables

```bash
# Application Configuration
NODE_ENV=production
PORT=3000
WORKERS=4

# LLM API Keys
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_API_KEY=your_google_key
MISTRAL_API_KEY=your_mistral_key

# Authentication
JWT_SECRET=your_jwt_secret_here
ADMIN_SECRET=your_admin_secret_here

# Optional Features
ENABLE_TELEMETRY=false
LOG_LEVEL=info
CORS_ORIGIN=*

# File Storage
MAX_UPLOAD_SIZE=50mb
UPLOAD_PATH=/app/contents/uploads

# Database (if using external persistence)
# DATABASE_URL=postgresql://user:pass@db:5432/aihub
```

### Development vs Production Differences

| Aspect          | Development           | Production        |
| --------------- | --------------------- | ----------------- |
| Build Target    | `development`         | `runtime`         |
| Hot Reload      | Enabled (bind mounts) | Disabled          |
| Logging         | Debug level           | Info/Error only   |
| Clustering      | Single worker         | Multi-worker      |
| Health Checks   | Optional              | Required          |
| Resource Limits | Unlimited             | CPU/Memory limits |
| Security        | Relaxed CORS          | Strict policies   |

## Build Strategies

### Standard Docker Build

```bash
# Build production image
docker build -t ai-hub-apps:latest .

# Build development image
docker build --target development -t ai-hub-apps:dev .

# Multi-platform build
docker buildx build --platform linux/amd64,linux/arm64 -t ai-hub-apps:latest .
```

### Docker Compose Profiles

```yaml
version: '3.8'
services:
  ai-hub-app:
    profiles: ['production']
    # ... production config

  ai-hub-dev:
    profiles: ['development']
    # ... development config

  nginx:
    profiles: ['production']
    image: nginx:alpine
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - ai-hub-app
```

### Helm Chart Structure (Kubernetes)

```
helm-chart/
├── Chart.yaml
├── values.yaml
├── values-dev.yaml
├── values-prod.yaml
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── configmap.yaml
    ├── secrets.yaml
    └── pvc.yaml
```

## Security Considerations

### Container Security

- **Non-root User**: Run application as non-privileged user
- **Read-only Root**: Mount root filesystem as read-only
- **Security Scanning**: Integrate Trivy/Clair for vulnerability scanning
- **Resource Limits**: Set CPU/memory limits to prevent resource exhaustion

### Data Security

- **Volume Encryption**: Encrypt persistent volumes at rest
- **Network Policies**: Restrict container-to-container communication
- **Secret Management**: Use Docker secrets or external secret managers
- **File Permissions**: Proper ownership and permissions for mounted volumes

### Example Security-Hardened Dockerfile

```dockerfile
FROM node:20-alpine AS runtime

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Set proper permissions
WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/dist ./
COPY --from=builder --chown=nextjs:nodejs /app/server/node_modules ./server/node_modules

# Create required directories with proper permissions
RUN mkdir -p /app/contents/data /app/contents/uploads /app/logs && \
    chown -R nextjs:nodejs /app/contents /app/logs

# Switch to non-root user
USER nextjs

# Make root filesystem read-only
VOLUME ["/app/contents/data", "/app/contents/uploads", "/app/logs"]

EXPOSE 3000
CMD ["node", "server/server.js"]
```

## Performance Optimizations

### Multi-Stage Builds

- **Minimal Runtime Image**: Only include production dependencies
- **Layer Caching**: Optimize layer order for maximum cache efficiency
- **Alpine Base**: Use lightweight Alpine Linux base images

### Container Optimizations

```dockerfile
# Optimize package installation
RUN npm ci --only=production --silent && \
    npm cache clean --force && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Enable compression
ENV NODE_OPTIONS="--max-old-space-size=1024"
```

### Load Balancing & Scaling

```yaml
version: '3.8'
services:
  ai-hub-app:
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 30s
        failure_action: rollback
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
```

## Migration Path from Current Setup

### Phase 1: Container Preparation

1. **Create Dockerfile** with multi-stage build
2. **Add docker-compose.yml** for development
3. **Update npm scripts** to include Docker commands
4. **Validate container functionality** with existing data

### Phase 2: Development Integration

1. **Team adoption** of containerized development
2. **CI/CD pipeline** integration for automated builds
3. **Volume structure validation** with real workloads
4. **Performance testing** against bare metal deployment

### Phase 3: Production Deployment

1. **Production docker-compose** configuration
2. **Container orchestration** setup (Docker Swarm/Kubernetes)
3. **Monitoring integration** (Prometheus/Grafana)
4. **Backup strategies** for persistent volumes

### Migration Scripts

```bash
#!/bin/bash
# migrate-to-docker.sh

echo "Migrating AI Hub Apps to Docker..."

# Backup current data
cp -r contents/data contents/data.backup
cp -r contents/uploads contents/uploads.backup

# Create Docker volumes and migrate data
docker volume create ai-hub-data
docker volume create ai-hub-uploads
docker volume create ai-hub-logs

# Copy existing data to volumes
docker run --rm -v "$(pwd)/contents/data:/source:ro" \
           -v "ai-hub-data:/dest" \
           alpine sh -c "cp -r /source/* /dest/"

docker run --rm -v "$(pwd)/contents/uploads:/source:ro" \
           -v "ai-hub-uploads:/dest" \
           alpine sh -c "cp -r /source/* /dest/"

echo "Migration completed successfully!"
```

## Implementation Deliverables

### Core Files

1. **`Dockerfile`** - Multi-stage container build
2. **`docker-compose.yml`** - Development environment
3. **`docker-compose.prod.yml`** - Production environment
4. **`.dockerignore`** - Build optimization
5. **`docker-entrypoint.sh`** - Container initialization script

### Configuration Files

1. **`nginx.conf`** - Reverse proxy configuration
2. **`healthcheck.js`** - Container health monitoring
3. **`migrate-to-docker.sh`** - Migration automation script

### Documentation Updates

1. **`DOCKER.md`** - Docker deployment guide
2. **`DEVELOPMENT.md`** - Updated development workflow
3. **`DEPLOYMENT.md`** - Production deployment procedures

## Success Metrics

### Technical Metrics

- **Build Time**: < 5 minutes for production builds
- **Container Size**: < 500MB for production image
- **Startup Time**: < 30 seconds for container initialization
- **Memory Usage**: < 512MB per container instance

### Operational Metrics

- **Deployment Frequency**: Enable daily deployments
- **Rollback Time**: < 2 minutes for production rollbacks
- **Developer Onboarding**: < 30 minutes for new team members
- **Environment Consistency**: 100% parity between dev/staging/prod

## Risk Assessment

### High Risk

- **Data Loss**: Volume mapping misconfiguration could cause data loss
- **Security Vulnerabilities**: Container escape or privilege escalation
- **Performance Degradation**: Increased resource overhead from containerization

### Medium Risk

- **Complex Configuration**: Multiple volume mounts may confuse operators
- **Network Issues**: Container networking complexity in production
- **Backup Challenges**: Container volume backup procedures

### Mitigation Strategies

- **Comprehensive Testing**: Automated tests for all container configurations
- **Documentation**: Clear operational procedures and troubleshooting guides
- **Monitoring**: Detailed observability for container health and performance
- **Rollback Plans**: Quick rollback procedures to non-containerized deployment

## Next Steps

1. **Create Initial Implementation** - Basic Dockerfile and compose files
2. **Development Testing** - Validate with current development team
3. **Production Piloting** - Deploy to staging environment
4. **Team Training** - Docker workflows and troubleshooting
5. **Full Migration** - Production deployment and monitoring setup

This specification provides a comprehensive foundation for implementing Docker support in AI Hub Apps while maintaining the existing functionality and ensuring smooth migration from the current deployment model.
