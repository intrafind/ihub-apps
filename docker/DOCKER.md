# Docker Support for AI Hub Apps

This document provides comprehensive guidance for running AI Hub Apps in Docker containers for both development and production environments.

## Quick Start

### Development Environment (Automatic Local Contents)

The Docker development setup **automatically** uses your local `contents/` folder - no additional configuration needed!

1. **Copy environment file:**

   ```bash
   cp .env.example .env
   # Edit .env with your API keys and configuration
   ```

2. **Start development with automatic local contents:**

   ```bash
   npm run docker:up
   ```

   This **automatically**:
   - ✅ Mounts your **entire local `contents/` folder** into the container
   - ✅ Any changes to files in `contents/` appear immediately in the container
   - ✅ No rebuilding or restarting required for content changes
   - ✅ Edit configs, apps, models, pages directly on your machine

3. **Access the application:**
   - **Main app**: http://localhost:3000 (Node.js server + static files)
   - **Vite dev server**: http://localhost:5173 (Hot reload development server)

   In development, both the Node.js server and Vite dev server run simultaneously for the best development experience.

**Volume Strategy:**

- **Local contents**: Your entire `contents/` folder is mounted read-write
- **Persistent data**: `contents/data/`, `contents/uploads/`, and logs use Docker volumes for persistence
- **Best of both**: Edit configs locally, keep runtime data persistent

### Production Environment

1. **Prepare production environment:**

   ```bash
   cp .env.production .env.production
   # Configure with production secrets (use secrets management in real deployment)
   ```

2. **Build and start production:**

   ```bash
   npm run docker:build:prod
   npm run docker:prod:up
   ```

3. **Access the production application:**
   - **Main app**: http://localhost:3000 (Node.js server with built client)

   In production, the Node.js server serves the pre-built client files directly.

## Building Docker Images Locally

### Quick Build Commands

```bash
# Build development image locally
npm run docker:build:dev

# Build production image locally
npm run docker:build:prod

# Build and start development environment
npm run docker:up:build
```

### Manual Docker Build Commands

```bash
# Development build
docker build -f docker/Dockerfile -t ai-hub-apps:dev --target development .

# Production build
docker build -f docker/Dockerfile -t ai-hub-apps:prod --target production .

# Multi-platform build (requires Docker Buildx)
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 -t ai-hub-apps:multi .
```

### Build Process Explained

The Docker build process uses **multi-stage builds**:

1. **Base Stage**: Sets up Node.js environment and creates non-root user
2. **Dependencies Stage**: Installs npm dependencies with caching
3. **Development Stage**: Includes dev dependencies and source code mounting
4. **Production Stage**: Optimized build with only production dependencies

### Build Arguments

```bash
# Build with custom arguments
docker build -f docker/Dockerfile \
  --build-arg BUILDTIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --build-arg VERSION="1.0.0" \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  -t ai-hub-apps:custom .
```

### Build Verification

```bash
# Test development build
docker run --rm -p 3000:3000 -p 5173:5173 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=test-secret \
  ai-hub-apps:dev

# Test production build (serves built client + API on port 3000)
docker run --rm -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=test-secret \
  -e NODE_ENV=production \
  ai-hub-apps:prod

# Check image details
docker image inspect ai-hub-apps:prod
```

**Expected behavior:**

- **Development**: Both Node.js server (3000) and Vite dev server (5173) should start
- **Production**: Only Node.js server (3000) should start, serving the built client files

## Docker Commands Reference

### Running Containers

````

### Development Workflow

```bash
# Start development environment
npm run docker:up

# Start with rebuilding images
npm run docker:up:build

# View logs
npm run docker:logs

# Access container shell
npm run docker:shell

# Stop development environment
npm run docker:down

# Stop and remove volumes
npm run docker:down:volumes
````

### Production Deployment

```bash
# Start production environment
npm run docker:prod:up

# View production logs
npm run docker:prod:logs

# Access production container shell
npm run docker:prod:shell

# Stop production environment
npm run docker:prod:down
```

## CI/CD and Image Publishing

### Automated Docker Builds

Docker images are automatically built and published to GitHub Container Registry (ghcr.io) in the following scenarios:

1. **On Release Creation**: When you create a GitHub release
2. **On Version Tags**: When you push a tag starting with `v` (e.g., `v1.0.0`)
3. **Manual Trigger**: Comment `@build docker images` on any issue or PR
4. **Manual Workflow**: Use GitHub Actions "Run workflow" button

### Manual Build Trigger

To manually trigger a Docker build, comment on any GitHub issue or pull request:

```
@build docker images
```

This will automatically start the CI/CD pipeline and publish new images to the registry.

### Published Images

Images are available at:

```
ghcr.io/intrafind/ai-hub-apps:latest
ghcr.io/intrafind/ai-hub-apps:v1.0.0
ghcr.io/intrafind/ai-hub-apps:main
```

### Using Published Images

```bash
# Pull and run latest image
docker run -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secret \
  ghcr.io/intrafind/ai-hub-apps:latest

# Use specific version
docker run -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secret \
  ghcr.io/intrafind/ai-hub-apps:v1.0.0
```

### Maintenance Commands

```bash
# Clean up unused Docker resources
npm run docker:clean

# Clean up everything (be careful!)
npm run docker:clean:all

# Run tests in container
npm run docker:test
```

## Volume Structure

### Development Volumes

- **Source Code**: Bind mounted for hot reloading
- **Configuration**: Bind mounted for easy editing
- **Data**: Docker volumes for persistence
- **Node Modules**: Cached volumes for performance

### Production Volumes

- **Configuration**: Initialized from host, mounted read-only
- **Data**: Persistent volumes for runtime data
- **Uploads**: Persistent volumes for user files
- **Logs**: Persistent volumes for application logs

## Environment Configuration

### Required Environment Variables

```bash
# Security (REQUIRED)
JWT_SECRET=your-secure-jwt-secret
ADMIN_SECRET=your-admin-secret

# LLM API Keys (at least one required)
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
GOOGLE_API_KEY=your-google-key
MISTRAL_API_KEY=your-mistral-key
```

### Optional Services

#### PostgreSQL Database

```bash
# Enable PostgreSQL service
docker-compose --profile database up -d

# Environment variables
DB_HOST=ai-hub-db
DB_NAME=aihub
DB_USER=aihub
DB_PASSWORD=your-db-password
```

#### Redis Cache

```bash
# Enable Redis service
docker-compose --profile cache up -d

# Environment variables
REDIS_HOST=ai-hub-redis
REDIS_PASSWORD=your-redis-password
```

#### Nginx Reverse Proxy

```bash
# Enable Nginx for development
docker-compose --profile nginx up -d

# Access via proxy
http://localhost:8080
```

## Security Considerations

### Container Security

- **Non-root user**: Containers run as UID 1000
- **Read-only filesystem**: Root filesystem is read-only
- **No privileged access**: Containers drop all capabilities
- **Resource limits**: CPU and memory limits enforced

### Data Security

- **Volume encryption**: Use encrypted volumes in production
- **Secret management**: Never store secrets in images
- **Network isolation**: Use Docker networks for service isolation
- **Regular updates**: Keep base images updated

### Production Security Checklist

- [ ] Use secrets management system (not .env files)
- [ ] Enable HTTPS with valid certificates
- [ ] Configure proper CORS settings
- [ ] Enable rate limiting and security headers
- [ ] Use read-only volumes where possible
- [ ] Implement proper backup strategy
- [ ] Monitor and log security events

## Networking

### Development Network

- **Bridge network**: `ai-hub-network`
- **Port mappings**: 3000 (app), 5173 (vite), 5432 (postgres), 6379 (redis)
- **Service discovery**: Containers communicate by service name

### Production Network

- **Isolated network**: `ai-hub-prod-network`
- **External access**: Only through reverse proxy
- **Internal communication**: Services communicate privately
- **Load balancing**: Multiple app replicas supported

## Monitoring and Logging

### Health Checks

- **Application**: `http://localhost:3000/api/health`
- **Container**: Built-in Docker health checks
- **Dependencies**: PostgreSQL and Redis health checks

### Logging

```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f ai-hub-dev

# Production logs with rotation
docker-compose -f docker-compose.prod.yml logs -f
```

### Metrics

- **Prometheus metrics**: Available at `/api/metrics`
- **Container metrics**: Docker stats and cAdvisor
- **Custom dashboards**: Grafana configurations available

## Data Management

### Backup Procedures

```bash
# Backup volumes
docker run --rm -v ai-hub-data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/data-$(date +%Y%m%d).tar.gz -C /data .

# Backup database (if using PostgreSQL)
docker-compose exec ai-hub-db pg_dump -U aihub aihub > backup-$(date +%Y%m%d).sql
```

### Migration from Non-Docker

```bash
# 1. Stop current application
npm run server:stop

# 2. Backup current data
cp -r contents/data contents/data.backup
cp -r contents/uploads contents/uploads.backup

# 3. Create Docker volumes
docker volume create ai-hub-data
docker volume create ai-hub-uploads

# 4. Copy data to volumes
docker run --rm -v $(pwd)/contents/data:/source -v ai-hub-data:/dest alpine cp -r /source/* /dest/
docker run --rm -v $(pwd)/contents/uploads:/source -v ai-hub-uploads:/dest alpine cp -r /source/* /dest/

# 5. Start Docker environment
npm run docker:up
```

## Troubleshooting

### Common Issues

#### Container fails to start

```bash
# Check logs
docker-compose logs ai-hub-dev

# Check if required environment variables are set
docker-compose config

# Verify image exists
docker images | grep ai-hub-apps
```

#### Permission issues

```bash
# Fix volume permissions
docker-compose exec ai-hub-dev chown -R aihub:nodejs /app/contents /app/logs

# Check user inside container
docker-compose exec ai-hub-dev id
```

#### Port conflicts

```bash
# Check what's using the port
lsof -i :3000

# Use different ports
AI_HUB_PORT=3001 docker-compose up -d
```

#### Volume data not persisting

```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect ai-hub-data

# Check mount points
docker-compose exec ai-hub-dev df -h
```

### Performance Optimization

#### Build Optimization

```bash
# Use BuildKit for faster builds
DOCKER_BUILDKIT=1 docker build -t ai-hub-apps:latest .

# Use multi-stage caching
docker build --target production --cache-from ai-hub-apps:latest -t ai-hub-apps:latest .
```

#### Runtime Optimization

```bash
# Adjust resource limits in docker-compose.yml
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 2G
```

## CI/CD Integration

### GitHub Actions

The repository includes a comprehensive GitHub Actions workflow that:

- Builds multi-platform Docker images
- Runs security scans with Trivy
- Publishes to GitHub Container Registry
- Supports automated deployments

### Manual Registry Push

```bash
# Tag for registry
docker tag ai-hub-apps:latest ghcr.io/yourusername/ai-hub-apps:latest

# Push to registry
docker push ghcr.io/yourusername/ai-hub-apps:latest

# Pull from registry
docker pull ghcr.io/yourusername/ai-hub-apps:latest
```

## Advanced Configuration

### Custom Dockerfile

For customized deployments, you can extend the base Dockerfile:

```dockerfile
FROM ghcr.io/yourusername/ai-hub-apps:latest

# Add custom certificates
COPY custom-ca.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Add custom configuration
COPY custom-config/ /app/contents/config/

USER aihub
```

### Kubernetes Deployment

For Kubernetes deployments, see the `concepts/docker-support/` directory for comprehensive Kubernetes manifests and Helm charts.

### Docker Swarm

```bash
# Initialize swarm
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose.prod.yml ai-hub-apps

# Scale services
docker service scale ai-hub-apps_ai-hub-app=3
```

## Support and Resources

- **Documentation**: See `docs/` directory for comprehensive guides
- **Examples**: Check `examples/` for sample configurations
- **Issues**: Report Docker-related issues on GitHub
- **Security**: Follow security best practices in production

For more detailed information, refer to the specifications in `concepts/docker-support/`.
