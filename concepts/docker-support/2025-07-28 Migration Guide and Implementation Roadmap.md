# Migration Guide and Implementation Roadmap for Docker Support

**Document Version:** 1.0  
**Date:** 2025-07-28  
**Author:** Claude Code  
**Purpose:** Step-by-step migration guide and implementation roadmap for containerizing iHub Apps

## Executive Summary

This document provides a comprehensive roadmap for migrating iHub Apps from traditional deployment to a fully containerized infrastructure. The migration is designed to be incremental, minimizing disruption while providing immediate benefits at each stage.

### Migration Benefits

- **Deployment Consistency**: Eliminate environment-specific issues
- **Scalability**: Enable horizontal scaling and auto-scaling
- **Development Velocity**: Faster onboarding and development cycles
- **Infrastructure Flexibility**: Deploy on any Docker-compatible platform
- **Operational Excellence**: Improved monitoring, logging, and troubleshooting

## Pre-Migration Assessment

### Current State Analysis

#### System Requirements Verification

```bash
#!/bin/bash
# pre-migration-assessment.sh

echo "=== Pre-Migration Assessment ==="
echo "Date: $(date)"
echo "Host: $(hostname)"
echo ""

# Check current iHub Apps installation
echo "1. Current Installation Check"
if [ -f "server/server.js" ]; then
    echo "✓ iHub Apps found"
    echo "  Version: $(grep '"version"' package.json | cut -d'"' -f4)"
    echo "  Node.js: $(node --version)"
    echo "  NPM: $(npm --version)"
else
    echo "✗ iHub Apps not found in current directory"
    exit 1
fi

# Check directory structure
echo ""
echo "2. Directory Structure Analysis"
echo "Contents directory structure:"
find contents -type d -maxdepth 2 | sort

# Check data sizes
echo ""
echo "3. Data Size Analysis"
echo "Config data: $(du -sh contents/config 2>/dev/null || echo '0B')"
echo "Runtime data: $(du -sh contents/data 2>/dev/null || echo '0B')"
echo "Uploads: $(du -sh contents/uploads 2>/dev/null || echo '0B')"
echo "Logs: $(du -sh logs 2>/dev/null || echo '0B')"

# Check Docker availability
echo ""
echo "4. Docker Environment Check"
if command -v docker >/dev/null 2>&1; then
    echo "✓ Docker available: $(docker --version)"
    echo "  Docker Compose: $(docker-compose --version 2>/dev/null || echo 'Not available')"

    # Check Docker daemon
    if docker info >/dev/null 2>&1; then
        echo "✓ Docker daemon running"
    else
        echo "✗ Docker daemon not running"
    fi
else
    echo "✗ Docker not installed"
fi

# Check system resources
echo ""
echo "5. System Resources"
echo "CPU cores: $(nproc)"
echo "Memory: $(free -h | awk '/^Mem:/ {print $2}')"
echo "Disk space: $(df -h . | awk 'NR==2 {print $4}')"

# Check network connectivity
echo ""
echo "6. Network Connectivity"
echo "Testing Docker Hub connectivity..."
if curl -s https://registry-1.docker.io/v2/ >/dev/null; then
    echo "✓ Docker Hub accessible"
else
    echo "✗ Docker Hub not accessible"
fi

echo ""
echo "=== Assessment Complete ==="
```

#### Configuration Audit

```bash
#!/bin/bash
# config-audit.sh

echo "=== Configuration Audit ==="

# Check environment variables
echo "1. Environment Variables Check"
env_vars=("OPENAI_API_KEY" "ANTHROPIC_API_KEY" "GOOGLE_API_KEY" "MISTRAL_API_KEY" "JWT_SECRET")
for var in "${env_vars[@]}"; do
    if [ -n "${!var}" ]; then
        echo "✓ $var is set"
    else
        echo "✗ $var is not set"
    fi
done

# Check configuration files
echo ""
echo "2. Configuration Files Check"
config_files=("contents/config/platform.json" "contents/config/groups.json" "contents/config/ui.json")
for file in "${config_files[@]}"; do
    if [ -f "$file" ]; then
        echo "✓ $file exists ($(stat -f%z "$file" 2>/dev/null || stat -c%s "$file") bytes)"
        # Basic JSON validation
        if jq empty "$file" 2>/dev/null; then
            echo "  ✓ Valid JSON"
        else
            echo "  ✗ Invalid JSON"
        fi
    else
        echo "✗ $file missing"
    fi
done

# Check for custom modifications
echo ""
echo "3. Customization Check"
if [ -d "public" ]; then
    echo "Custom public assets found: $(ls -la public/ | wc -l) items"
fi

if find contents -name "*.custom.*" -o -name "*local*" | grep -q .; then
    echo "Custom configuration files found:"
    find contents -name "*.custom.*" -o -name "*local*"
fi

echo ""
echo "=== Audit Complete ==="
```

## Migration Phases

### Phase 1: Development Environment Containerization (Week 1-2)

#### Objectives

- Create working Docker development environment
- Validate container functionality
- Team familiarization with Docker workflows

#### Tasks

##### 1.1 Create Core Docker Files

```bash
# Create Dockerfile
cat > Dockerfile << 'EOF'
# Multi-stage Dockerfile for iHub Apps
FROM node:20-alpine AS dependencies
# ... (use implementation from previous documents)
EOF

# Create docker-compose.yml for development
cat > docker-compose.yml << 'EOF'
version: '3.8'
services:
  ai-hub-dev:
    # ... (use implementation from previous documents)
EOF

# Create .dockerignore
cat > .dockerignore << 'EOF'
node_modules/
npm-debug.log*
dist/
.git/
.env
logs/
contents/data/
contents/uploads/
EOF
```

##### 1.2 Initial Testing

```bash
#!/bin/bash
# test-development-container.sh

echo "Testing development container..."

# Build development image
echo "Building development image..."
docker build --target development -t ai-hub-apps:dev .

# Test container startup
echo "Testing container startup..."
docker run --rm -d --name ai-hub-test -p 3001:3000 \
  -e OPENAI_API_KEY=test \
  -e JWT_SECRET=test_secret \
  ai-hub-apps:dev

# Wait for startup
sleep 30

# Test health endpoint
if curl -f http://localhost:3001/api/health; then
    echo "✓ Container health check passed"
else
    echo "✗ Container health check failed"
fi

# Clean up
docker stop ai-hub-test 2>/dev/null || true

echo "Development container test complete"
```

##### 1.3 Team Migration

```bash
#!/bin/bash
# migrate-team-development.sh

echo "Migrating team to containerized development..."

# Backup current node_modules
if [ -d "node_modules" ]; then
    mv node_modules node_modules.backup
fi

if [ -d "client/node_modules" ]; then
    mv client/node_modules client/node_modules.backup
fi

if [ -d "server/node_modules" ]; then
    mv server/node_modules server/node_modules.backup
fi

# Start containerized development
docker-compose up -d

echo "Team migration complete. Access app at http://localhost:3000"
echo "Vite dev server at http://localhost:5173"
```

#### Success Criteria

- ✅ Development container builds successfully
- ✅ Application accessible via http://localhost:3000
- ✅ Hot reload functionality working
- ✅ All team members can start development environment with `docker-compose up`

### Phase 2: Data Migration and Volume Setup (Week 2-3)

#### Objectives

- Implement proper volume mapping strategy
- Migrate existing data to Docker volumes
- Validate data persistence and integrity

#### Tasks

##### 2.1 Create Volume Migration Script

```bash
#!/bin/bash
# migrate-data-to-volumes.sh

set -e

BACKUP_DIR="./migration-backup-$(date +%Y%m%d_%H%M%S)"

echo "Starting data migration to Docker volumes..."
echo "Backup directory: $BACKUP_DIR"

# Create backup
mkdir -p "$BACKUP_DIR"
if [ -d "contents/data" ]; then
    cp -r contents/data "$BACKUP_DIR/"
    echo "✓ Backed up contents/data"
fi

if [ -d "contents/uploads" ]; then
    cp -r contents/uploads "$BACKUP_DIR/"
    echo "✓ Backed up contents/uploads"
fi

if [ -d "logs" ]; then
    cp -r logs "$BACKUP_DIR/"
    echo "✓ Backed up logs"
fi

# Create Docker volumes
echo "Creating Docker volumes..."
docker volume create ai-hub-dev-data
docker volume create ai-hub-dev-uploads
docker volume create ai-hub-dev-logs

# Migrate data to volumes
echo "Migrating data to volumes..."

# Migrate data directory
if [ -d "contents/data" ]; then
    docker run --rm -v "$(pwd)/contents/data:/source:ro" \
               -v "ai-hub-dev-data:/dest" \
               alpine sh -c "cp -r /source/* /dest/ 2>/dev/null || true"
    echo "✓ Migrated contents/data to Docker volume"
fi

# Migrate uploads
if [ -d "contents/uploads" ]; then
    docker run --rm -v "$(pwd)/contents/uploads:/source:ro" \
               -v "ai-hub-dev-uploads:/dest" \
               alpine sh -c "cp -r /source/* /dest/ 2>/dev/null || true"
    echo "✓ Migrated contents/uploads to Docker volume"
fi

# Migrate logs
if [ -d "logs" ]; then
    docker run --rm -v "$(pwd)/logs:/source:ro" \
               -v "ai-hub-dev-logs:/dest" \
               alpine sh -c "cp -r /source/* /dest/ 2>/dev/null || true"
    echo "✓ Migrated logs to Docker volume"
fi

# Verify migration
echo "Verifying migration..."
docker run --rm -v "ai-hub-dev-data:/data" alpine ls -la /data
docker run --rm -v "ai-hub-dev-uploads:/uploads" alpine ls -la /uploads

echo "Data migration completed successfully!"
echo "Backup available at: $BACKUP_DIR"
```

##### 2.2 Update Docker Compose with Volumes

```yaml
# Updated docker-compose.yml with proper volume mapping
version: '3.8'
services:
  ai-hub-dev:
    build:
      context: .
      target: development
    ports:
      - '3000:3000'
      - '5173:5173'
    volumes:
      # Source code (read-only for security)
      - ./server:/app/server:ro
      - ./client/src:/app/client/src:ro
      - ./shared:/app/shared:ro

      # Configuration (editable)
      - ./contents/config:/app/contents/config:rw
      - ./contents/apps:/app/contents/apps:rw
      - ./contents/models:/app/contents/models:rw
      - ./contents/locales:/app/contents/locales:rw
      - ./contents/prompts:/app/contents/prompts:rw
      - ./contents/pages:/app/contents/pages:rw
      - ./contents/sources:/app/contents/sources:rw

      # Persistent data (Docker volumes)
      - ai-hub-dev-data:/app/contents/data:rw
      - ai-hub-dev-uploads:/app/contents/uploads:rw
      - ai-hub-dev-logs:/app/logs:rw
    environment:
      - NODE_ENV=development
    env_file:
      - .env
    restart: unless-stopped

volumes:
  ai-hub-dev-data:
    external: true
  ai-hub-dev-uploads:
    external: true
  ai-hub-dev-logs:
    external: true
```

#### Success Criteria

- ✅ All existing data migrated to Docker volumes
- ✅ Application functionality unchanged after migration
- ✅ Data persists after container restarts
- ✅ Volume backup and restore procedures tested

### Phase 3: Production Container Setup (Week 3-4)

#### Objectives

- Create production-ready Docker images
- Implement security hardening
- Setup production docker-compose configuration

#### Tasks

##### 3.1 Production Image Build

```bash
#!/bin/bash
# build-production-image.sh

set -e

VERSION=${1:-latest}
REGISTRY=${2:-""}

echo "Building production image: ai-hub-apps:$VERSION"

# Build production image
docker build --target production -t ai-hub-apps:$VERSION .

# Tag for registry if provided
if [ -n "$REGISTRY" ]; then
    docker tag ai-hub-apps:$VERSION $REGISTRY/ai-hub-apps:$VERSION
    echo "Tagged for registry: $REGISTRY/ai-hub-apps:$VERSION"
fi

# Security scan
echo "Running security scan..."
if command -v trivy >/dev/null 2>&1; then
    trivy image ai-hub-apps:$VERSION
else
    echo "Trivy not available, skipping security scan"
fi

# Test production image
echo "Testing production image..."
docker run --rm -d --name ai-hub-prod-test -p 3002:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET=test_prod_secret \
  -e OPENAI_API_KEY=test \
  ai-hub-apps:$VERSION

sleep 30

if curl -f http://localhost:3002/api/health; then
    echo "✓ Production image test passed"
else
    echo "✗ Production image test failed"
fi

docker stop ai-hub-prod-test

echo "Production image build complete: ai-hub-apps:$VERSION"
```

##### 3.2 Production Environment Setup

```bash
#!/bin/bash
# setup-production-environment.sh

set -e

echo "Setting up production environment..."

# Create production environment file
cat > .env.production << 'EOF'
NODE_ENV=production
LOG_LEVEL=info
WORKERS=4
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=https://yourdomain.com
MAX_UPLOAD_SIZE=50mb
ENABLE_TELEMETRY=true
EOF

# Create production docker-compose
cp docker-compose.prod.yml.example docker-compose.prod.yml

# Create production volumes
docker volume create ai-hub-config
docker volume create ai-hub-data
docker volume create ai-hub-uploads
docker volume create ai-hub-logs

# Initialize configuration in volumes
echo "Initializing configuration volumes..."
docker run --rm -v "$(pwd)/contents/config:/source:ro" \
           -v "ai-hub-config:/dest" \
           alpine sh -c "cp -r /source/* /dest/"

echo "Production environment setup complete"
```

#### Success Criteria

- ✅ Production image builds and passes security scans
- ✅ Production environment can start with docker-compose
- ✅ Application performs correctly under production configuration
- ✅ SSL/TLS termination working with reverse proxy

### Phase 4: CI/CD Integration (Week 4-5)

#### Objectives

- Integrate Docker builds into CI/CD pipeline
- Automate testing and deployment
- Setup container registry workflows

#### Tasks

##### 4.1 GitHub Actions Workflow

```yaml
# .github/workflows/docker-ci.yml
name: Docker CI/CD

on:
  push:
    branches: [main, develop]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Log in to Container Registry
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v2
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}

      - name: Build and push Docker image
        uses: docker/build-push-action@v4
        with:
          context: .
          target: production
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Run security scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          format: 'sarif'
          output: 'trivy-results.sarif'

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v2
        if: always()
        with:
          sarif_file: 'trivy-results.sarif'

  deploy:
    needs: build-and-test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'

    steps:
      - name: Deploy to staging
        run: |
          echo "Deploying to staging environment"
          # Add deployment steps here
```

##### 4.2 Automated Testing

```bash
#!/bin/bash
# automated-testing.sh

echo "Running automated tests for containerized application..."

# Start test environment
docker-compose -f docker-compose.test.yml up -d

# Wait for services to be ready
sleep 60

# Run API tests
echo "Running API tests..."
docker-compose -f docker-compose.test.yml exec ai-hub-test npm run test:api

# Run integration tests
echo "Running integration tests..."
docker-compose -f docker-compose.test.yml exec ai-hub-test npm run test:integration

# Run load tests
echo "Running load tests..."
docker run --rm --network host \
  loadimpact/k6 run - <<EOF
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 10 },
    { duration: '5m', target: 10 },
    { duration: '2m', target: 0 },
  ],
};

export default function() {
  let response = http.get('http://localhost:3000/api/health');
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
}
EOF

# Cleanup
docker-compose -f docker-compose.test.yml down

echo "Automated testing complete"
```

#### Success Criteria

- ✅ CI/CD pipeline builds and pushes container images
- ✅ Automated tests pass in containerized environment
- ✅ Security scanning integrated into pipeline
- ✅ Deployment automation working

### Phase 5: Production Deployment (Week 5-6)

#### Objectives

- Deploy containerized application to production
- Implement monitoring and alerting
- Establish operational procedures

#### Tasks

##### 5.1 Production Deployment

```bash
#!/bin/bash
# deploy-production.sh

set -e

VERSION=${1:-latest}
ENVIRONMENT=${2:-production}

echo "Deploying iHub Apps $VERSION to $ENVIRONMENT"

# Pull latest images
docker-compose -f docker-compose.prod.yml pull

# Update configuration
./update-production-config.sh

# Deploy with zero downtime
echo "Starting deployment..."
docker-compose -f docker-compose.prod.yml up -d --no-deps ai-hub-app

# Wait for health check
echo "Waiting for health check..."
for i in {1..30}; do
    if curl -f http://localhost:3000/api/health; then
        echo "✓ Health check passed"
        break
    fi
    echo "Waiting for service to be ready... ($i/30)"
    sleep 10
done

# Verify deployment
echo "Verifying deployment..."
docker-compose -f docker-compose.prod.yml ps
docker-compose -f docker-compose.prod.yml logs --tail=50 ai-hub-app

echo "Production deployment complete"
```

##### 5.2 Monitoring Setup

```bash
#!/bin/bash
# setup-monitoring.sh

echo "Setting up monitoring and alerting..."

# Deploy Prometheus
docker run -d --name prometheus \
  -p 9090:9090 \
  -v "$(pwd)/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus

# Deploy Grafana
docker run -d --name grafana \
  -p 3001:3000 \
  -v grafana-storage:/var/lib/grafana \
  grafana/grafana

# Setup log aggregation
docker run -d --name loki \
  -p 3100:3100 \
  grafana/loki:latest

echo "Monitoring setup complete"
echo "Prometheus: http://localhost:9090"
echo "Grafana: http://localhost:3001"
```

#### Success Criteria

- ✅ Production deployment successful with zero downtime
- ✅ Monitoring and alerting operational
- ✅ Backup and recovery procedures tested
- ✅ Performance metrics within acceptable ranges

## Rollback Procedures

### Emergency Rollback to Non-Containerized

```bash
#!/bin/bash
# emergency-rollback.sh

echo "EMERGENCY ROLLBACK: Reverting to non-containerized deployment"

# Stop containerized services
docker-compose -f docker-compose.prod.yml down

# Restore node_modules if backed up
if [ -d "node_modules.backup" ]; then
    rm -rf node_modules
    mv node_modules.backup node_modules
fi

if [ -d "client/node_modules.backup" ]; then
    rm -rf client/node_modules
    mv client/node_modules.backup client/node_modules
fi

if [ -d "server/node_modules.backup" ]; then
    rm -rf server/node_modules
    mv server/node_modules.backup server/node_modules
fi

# Restore data from volumes
docker run --rm -v "ai-hub-data:/source:ro" \
                -v "$(pwd)/contents/data:/dest" \
                alpine sh -c "cp -r /source/* /dest/ 2>/dev/null || true"

docker run --rm -v "ai-hub-uploads:/source:ro" \
                -v "$(pwd)/contents/uploads:/dest" \
                alpine sh -c "cp -r /source/* /dest/ 2>/dev/null || true"

# Start traditional deployment
npm start

echo "Rollback complete - running in traditional mode"
```

## Post-Migration Validation

### Comprehensive Testing Script

```bash
#!/bin/bash
# post-migration-validation.sh

echo "Running post-migration validation..."

# Functional tests
echo "1. Functional Tests"
curl -f http://localhost:3000/api/health || echo "FAIL: Health check"
curl -f http://localhost:3000/api/config || echo "FAIL: Config endpoint"

# Performance tests
echo "2. Performance Tests"
time curl -f http://localhost:3000/ >/dev/null || echo "FAIL: Homepage load"

# Data integrity tests
echo "3. Data Integrity Tests"
docker exec ai-hub-app ls -la /app/contents/data || echo "FAIL: Data directory"
docker exec ai-hub-app ls -la /app/contents/uploads || echo "FAIL: Uploads directory"

# Security tests
echo "4. Security Tests"
docker exec ai-hub-app whoami | grep -v root || echo "FAIL: Running as root"
docker exec ai-hub-app find /app -writable -type d | grep -E '^/app$' && echo "FAIL: Root writable"

echo "Post-migration validation complete"
```

## Training and Documentation

### Team Training Checklist

- [ ] Docker basics and concepts
- [ ] Docker Compose workflow
- [ ] Volume management and data persistence
- [ ] Container debugging and troubleshooting
- [ ] Security best practices
- [ ] Monitoring and logging
- [ ] Backup and recovery procedures

### Updated Documentation Requirements

1. **Docker Development Guide** - Daily workflows for developers
2. **Production Deployment Guide** - Operations team procedures
3. **Troubleshooting Guide** - Common issues and solutions
4. **Security Procedures** - Security policies and incident response
5. **Backup and Recovery Manual** - Data protection procedures

## Success Metrics

### Technical Metrics

- **Build Time**: < 5 minutes for production builds
- **Deployment Time**: < 10 minutes for production deployments
- **Container Startup**: < 30 seconds
- **Memory Usage**: < 2GB per container
- **CPU Usage**: < 80% under normal load

### Operational Metrics

- **Developer Onboarding**: < 30 minutes to working environment
- **Deployment Frequency**: Enable daily deployments
- **Rollback Time**: < 5 minutes for emergency rollbacks
- **Incident Resolution**: 50% faster troubleshooting with containers

### Business Metrics

- **Development Velocity**: 25% faster feature delivery
- **Infrastructure Costs**: Potential 30% reduction with efficient resource usage
- **System Reliability**: 99.9% uptime target
- **Team Satisfaction**: Improved developer experience scores

## Risk Mitigation

### Identified Risks and Mitigations

| Risk                       | Impact | Probability | Mitigation                                     |
| -------------------------- | ------ | ----------- | ---------------------------------------------- |
| Data loss during migration | High   | Low         | Comprehensive backup procedures and validation |
| Performance degradation    | Medium | Medium      | Load testing and performance monitoring        |
| Team resistance to change  | Medium | Medium      | Training programs and gradual migration        |
| Security vulnerabilities   | High   | Low         | Security scanning and hardening procedures     |
| Extended downtime          | High   | Low         | Zero-downtime deployment strategies            |

## Conclusion

This migration guide provides a comprehensive, phased approach to containerizing iHub Apps. The incremental migration strategy minimizes risk while providing immediate benefits at each stage. With proper execution of this roadmap, the organization will achieve:

- **Improved Development Experience**: Consistent environments and faster onboarding
- **Enhanced Operational Capabilities**: Better monitoring, scaling, and deployment
- **Increased Security**: Container isolation and security hardening
- **Future-Ready Infrastructure**: Foundation for cloud-native deployments and scaling

The success of this migration depends on thorough preparation, comprehensive testing, and team training. Following this guide will ensure a smooth transition to containerized infrastructure while maintaining the reliability and functionality of iHub Apps.

---

**Next Steps:**

1. Review and approve migration plan
2. Allocate resources and timeline
3. Begin Phase 1 development environment setup
4. Establish monitoring and success metrics
5. Execute migration according to roadmap
