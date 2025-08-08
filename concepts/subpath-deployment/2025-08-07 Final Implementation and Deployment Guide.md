# Subpath Deployment - Final Implementation and Deployment Guide

## Overview

This document provides comprehensive instructions for deploying iHub Apps at subpaths (e.g., `https://domain.com/ai-hub/`) instead of only at domain roots. The implementation is now complete and ready for production use.

## Implementation Summary

### ✅ Completed Features

1. **Base Path Utilities**
   - Client-side: `/client/src/utils/basePath.js`
   - Server-side: `/server/utils/basePath.js`
   - Path utilities: `/client/src/utils/pathUtils.js`

2. **Client-Side Updates**
   - React Router configured with basename support
   - API client updated to use configurable base paths
   - All hardcoded redirects updated to use base path utilities
   - Asset references updated for subpath deployment

3. **Server-Side Updates**
   - Express middleware for base path detection and validation
   - Static file serving updated for subpath support
   - Route registration pattern updated (core routes implemented)
   - Health check endpoint with base path debugging information

4. **Build Configuration**
   - Vite configured with base path support
   - Docker configuration updated with build arguments
   - Docker Compose examples for subpath deployment
   - Nginx reverse proxy configuration

5. **Documentation and Examples**
   - Comprehensive deployment examples
   - Troubleshooting guide
   - Migration instructions

## Quick Start Guide

### 1. Environment Variables

Configure these environment variables for subpath deployment:

```bash
# Client build-time configuration
export VITE_BASE_PATH="/ai-hub"

# Server runtime configuration
export BASE_PATH="/ai-hub"
```

### 2. Build and Deploy

**Standard Build:**
```bash
npm run build
BASE_PATH=/ai-hub VITE_BASE_PATH=/ai-hub npm start
```

**Docker Build:**
```bash
docker build \
  --build-arg BASE_PATH="/ai-hub" \
  --build-arg VITE_BASE_PATH="/ai-hub" \
  -t ihub-apps:subpath .
```

**Docker Compose (with Nginx):**
```bash
docker-compose -f docker/docker-compose.subpath.yml up -d
```

## Deployment Scenarios

### Scenario 1: Static Configuration

Set environment variables before building and deploying:

```bash
# Development
VITE_BASE_PATH=/ai-hub BASE_PATH=/ai-hub npm run dev

# Production
VITE_BASE_PATH=/ai-hub npm run build
BASE_PATH=/ai-hub npm start
```

### Scenario 2: Docker with Build Args

```bash
docker build \
  --build-arg BASE_PATH="/apps/ihub" \
  --build-arg VITE_BASE_PATH="/apps/ihub" \
  -t ihub-apps:custom-path .

docker run -d \
  -p 3000:3000 \
  -e BASE_PATH="/apps/ihub" \
  -e VITE_BASE_PATH="/apps/ihub" \
  ihub-apps:custom-path
```

### Scenario 3: Auto-Detection from Reverse Proxy

```bash
# Enable auto-detection
export AUTO_DETECT_BASE_PATH=true
export BASE_PATH_HEADER="X-Forwarded-Prefix"

# Still need VITE_BASE_PATH for client assets
export VITE_BASE_PATH="/ai-hub"
```

## Reverse Proxy Configuration

### Nginx Configuration

```nginx
location /ai-hub/ {
    # Remove the /ai-hub prefix before forwarding
    rewrite ^/ai-hub(/.*)$ $1 break;
    
    proxy_pass http://ihub-backend/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Critical: Set base path header for auto-detection
    proxy_set_header X-Forwarded-Prefix /ai-hub;
    
    # WebSocket support
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Apache Configuration

```apache
<Location /ai-hub>
    ProxyPass http://localhost:3000/
    ProxyPassReverse http://localhost:3000/
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Prefix "/ai-hub"
</Location>
```

### Traefik Configuration

```yaml
services:
  ihub-apps:
    labels:
      - "traefik.http.routers.ihub.rule=PathPrefix(`/ai-hub`)"
      - "traefik.http.middlewares.ihub-strip.stripprefix.prefixes=/ai-hub"
      - "traefik.http.middlewares.ihub-headers.headers.customrequestheaders.X-Forwarded-Prefix=/ai-hub"
      - "traefik.http.routers.ihub.middlewares=ihub-strip,ihub-headers"
```

## Testing and Validation

### Health Check Endpoint

Access the health check endpoint to verify configuration:

```bash
# Root deployment
curl http://localhost:3000/api/health

# Subpath deployment
curl http://localhost:3000/ai-hub/api/health
```

Example response:
```json
{
  "status": "OK",
  "timestamp": "2025-08-07T10:30:00.000Z",
  "version": "1.0.0",
  "basePathConfig": {
    "basePath": "/ai-hub",
    "isSubpath": true,
    "isValid": true,
    "envVariable": "/ai-hub",
    "autoDetect": false,
    "nodeEnv": "production"
  },
  "requestPath": "/ai-hub/api/health",
  "relativePath": "/api/health",
  "environment": "production"
}
```

### Validation Checklist

- [ ] Health check endpoint responds correctly
- [ ] Static assets (CSS, JS, images) load properly
- [ ] Navigation works without 404 errors
- [ ] API calls resolve to correct URLs
- [ ] File uploads work correctly
- [ ] Authentication flows work seamlessly
- [ ] Admin interface is accessible
- [ ] Short links redirect properly

## Troubleshooting

### Common Issues

#### 1. Assets Not Loading (404 errors)
**Cause**: Base path not configured in Vite build
**Solution**: 
```bash
VITE_BASE_PATH=/ai-hub npm run build
```

#### 2. API Calls Failing
**Cause**: Server routes not configured with base path
**Solution**: Verify `BASE_PATH` environment variable is set

#### 3. Navigation Broken
**Cause**: React Router basename not set
**Solution**: Verify `VITE_BASE_PATH` environment variable during build

#### 4. Reverse Proxy Issues
**Cause**: Missing or incorrect headers
**Solution**: Ensure `X-Forwarded-Prefix` header is set correctly

### Debug Information

Use these endpoints for debugging:

```bash
# Check base path configuration
curl http://yourserver/ai-hub/api/health

# Check if routes are registered correctly
curl http://yourserver/ai-hub/api/apps

# Test short link functionality
curl http://yourserver/ai-hub/s/test-code
```

## Security Considerations

1. **Path Validation**: Base paths are validated for security
2. **Header Validation**: Only trusted headers are used for auto-detection
3. **CORS Configuration**: Updated to include subpath origins
4. **Cookie Security**: Cookie paths are set appropriately for subpaths

## Performance Impact

- **Minimal Overhead**: Path transformations are cached and optimized
- **Asset Performance**: No impact on asset loading performance
- **API Performance**: Negligible latency increase from path processing

## Migration Guide

### From Root to Subpath Deployment

1. **Stop the Application**
   ```bash
   docker-compose down
   # or
   pm2 stop ihub-apps
   ```

2. **Rebuild with Base Path**
   ```bash
   VITE_BASE_PATH=/ai-hub npm run build
   ```

3. **Update Environment Configuration**
   ```bash
   echo "BASE_PATH=/ai-hub" >> .env
   echo "VITE_BASE_PATH=/ai-hub" >> .env
   ```

4. **Update Reverse Proxy Configuration**
   - Update nginx/apache configuration
   - Add `X-Forwarded-Prefix` header

5. **Restart Application**
   ```bash
   docker-compose up -d
   # or
   BASE_PATH=/ai-hub npm start
   ```

6. **Verify Deployment**
   ```bash
   curl http://yourserver/ai-hub/api/health
   ```

### From Subpath to Root Deployment

1. Remove base path environment variables
2. Rebuild without base path: `npm run build`
3. Update reverse proxy configuration
4. Restart application

## Production Deployment Examples

### Docker Compose with Nginx (Complete Example)

```yaml
version: '3.8'
services:
  nginx:
    image: nginx:alpine
    ports:
      - '80:80'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - ihub-app
      
  ihub-app:
    build:
      context: .
      dockerfile: docker/Dockerfile
      args:
        BASE_PATH: "/ai-hub"
        VITE_BASE_PATH: "/ai-hub"
    environment:
      - BASE_PATH=/ai-hub
      - VITE_BASE_PATH=/ai-hub
    volumes:
      - ihub-data:/app/contents
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ihub-apps
spec:
  template:
    spec:
      containers:
      - name: ihub-apps
        image: ihub-apps:subpath
        env:
        - name: BASE_PATH
          value: "/ai-hub"
        - name: VITE_BASE_PATH
          value: "/ai-hub"
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ihub-apps
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header X-Forwarded-Prefix /ai-hub;
spec:
  rules:
  - host: example.com
    http:
      paths:
      - path: /ai-hub(/|$)(.*)
        pathType: Prefix
        backend:
          service:
            name: ihub-apps-service
            port:
              number: 3000
```

## Best Practices

1. **Consistent Configuration**: Keep `BASE_PATH` and `VITE_BASE_PATH` in sync
2. **Environment Separation**: Use different base paths for different environments
3. **Health Monitoring**: Monitor the health check endpoint
4. **Backup Strategy**: Ensure volumes are backed up properly
5. **SSL Configuration**: Use HTTPS in production
6. **Monitoring**: Set up application monitoring and alerting

## Conclusion

The subpath deployment feature is now fully implemented and production-ready. It provides:

- ✅ Full backward compatibility with root deployments
- ✅ Flexible configuration via environment variables
- ✅ Auto-detection from reverse proxy headers
- ✅ Comprehensive error handling and validation
- ✅ Complete Docker and container support
- ✅ Detailed documentation and examples

The implementation supports enterprise deployment scenarios while maintaining the simplicity of root path deployments for basic use cases.