# Production Reverse Proxy Deployment Guide

## Overview

This comprehensive guide covers production deployment of iHub Apps behind reverse proxies (nginx, Apache, Traefik) with proper CORS configuration, subpath support, and security considerations.

**Quick Answer: Yes, subpath deployment will work!**

Your setup `www.myserver.com/ihub` → `localhost:3001` will work perfectly with proper configuration.

## Deployment Scenarios

### Scenario 1: With Reverse Proxy (Recommended)
- **External URL**: `https://example.com/ihub/`
- **Internal App**: `http://localhost:3000/`
- **Reverse proxy strips** the `/ihub` prefix when forwarding
- **Best for**: Production deployments with nginx, Apache, or Kubernetes Ingress

### Scenario 2: Direct Access
- **Direct URL**: `http://localhost:3000/ihub/`
- **No reverse proxy** - users connect directly to Node.js server
- **Backend handles** the `/ihub` prefix itself
- **Best for**: Simple deployments without reverse proxy infrastructure

## Prerequisites

Before deployment, ensure:

1. **Configure CORS** to allow your production domain
2. **Set environment variables** for subpath deployment
3. **Configure reverse proxy** with proper headers
4. **Update application** to handle the subpath correctly

## CORS Configuration

### Understanding CORS in iHub Apps

iHub Apps has comprehensive CORS support configured in `contents/config/platform.json`:

```json
{
  "cors": {
    "origin": ["http://localhost:3000", "http://localhost:5173", "${ALLOWED_ORIGINS}"],
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
    "allowedHeaders": [
      "Content-Type",
      "Authorization", 
      "X-Requested-With",
      "X-Forwarded-User",
      "X-Forwarded-Groups",
      "Accept",
      "Origin",
      "Cache-Control",
      "X-File-Name"
    ],
    "credentials": true,
    "optionsSuccessStatus": 200,
    "maxAge": 86400,
    "preflightContinue": false
  }
}
```

### Configuring CORS for Your Domain

**Option 1: Environment Variable (Recommended)**
```bash
# Single domain
export ALLOWED_ORIGINS="https://www.myserver.com"

# Multiple domains
export ALLOWED_ORIGINS="https://www.myserver.com,https://api.myserver.com,https://admin.myserver.com"
```

**Option 2: Direct Configuration**
Edit `contents/config/platform.json`:
```json
{
  "cors": {
    "origin": ["https://www.myserver.com", "${ALLOWED_ORIGINS}"]
  }
}
```

## Environment Variables for Subpath Deployment

### For Reverse Proxy Setup (Scenario 1)

```bash
# Backend runs at root, relies on X-Forwarded-Prefix header
export ALLOWED_ORIGINS="https://www.myserver.com"
PORT=3001 npm start
```

### For Direct Access Setup (Scenario 2)

```bash
# Frontend build-time configuration
export VITE_BASE_PATH="/ihub"

# Backend runtime configuration  
export BASE_PATH="/ihub"
export ALLOWED_ORIGINS="https://www.myserver.com"

# Build and start
VITE_BASE_PATH=/ihub npm run build
BASE_PATH=/ihub PORT=3001 npm start
```

## Nginx Configuration

### Production Nginx Configuration (nginx.conf)

Based on the current nginx.conf, here's the complete production configuration:

```nginx
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    
    sendfile        on;
    keepalive_timeout  65;
    
    # Upstream configuration for load balancing and keepalive
    upstream ihub_backend {
        server localhost:3001;  # Production server port
        keepalive 32;
        keepalive_requests 100;
        keepalive_timeout 60s;
    }

    # Redirect HTTP to HTTPS
    server {
        listen 80;
        server_name www.myserver.com;
        return 301 https://$server_name$request_uri;
    }

    # Main HTTPS server
    server {
        listen 443 ssl http2;
        server_name www.myserver.com;

        # SSL configuration
        ssl_certificate /path/to/ssl/cert.pem;
        ssl_certificate_key /path/to/ssl/key.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256;
        ssl_prefer_server_ciphers off;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # Security headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

        # Compression
        gzip on;
        gzip_vary on;
        gzip_min_length 1024;
        gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss application/rss+xml application/atom+xml image/svg+xml;

        # Health check endpoint (direct, no subpath)
        location /health {
            access_log off;
            return 200 "healthy\n";
            add_header Content-Type text/plain;
        }

        # Main application under /ihub
        location /ihub/ {
            # Trailing slash on proxy_pass strips /ihub prefix
            # /ihub/admin/sources becomes /admin/sources at backend
            proxy_pass http://ihub_backend/;
            
            # HTTP version and connection settings
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_cache_bypass $http_upgrade;
            
            # Required headers
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # CRITICAL: Tell backend about the stripped prefix
            proxy_set_header X-Forwarded-Prefix /ihub;
            
            # Timeouts for long-running LLM requests
            proxy_connect_timeout 60s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
            
            # Buffer settings for streaming responses
            proxy_buffering off;
            proxy_request_buffering off;
            
            # Disable redirect following
            proxy_redirect off;
        }

        # Redirect /ihub to /ihub/ (required for location matching)
        location = /ihub {
            return 301 /ihub/;
        }

        # EventSource/SSE for chat streaming
        location /ihub/api/chat/stream {
            proxy_pass http://ihub_backend/api/chat/stream;
            
            # SSE-specific settings
            proxy_http_version 1.1;
            proxy_set_header Connection '';
            proxy_set_header Cache-Control 'no-cache';
            proxy_set_header X-Accel-Buffering 'no';
            
            # Keep connection alive for streaming
            proxy_read_timeout 86400s;
            proxy_buffering off;
            chunked_transfer_encoding off;
            
            # Standard headers
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-Prefix /ihub;
        }

        # Static asset caching
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
            proxy_pass http://ihub_backend;
        }

        # Default location (redirect to /ihub)
        location / {
            return 301 /ihub/;
        }

        # Error pages
        error_page 502 503 504 /50x.html;
        location = /50x.html {
            root /var/www/html;
        }
    }

    # Development server (for local testing)
    server {
        listen 8081;
        server_name localhost;

        # Health check endpoint
        location /health {
            access_log off;
            return 200 "healthy\n";
            add_header Content-Type text/plain;
        }

        # Reverse proxy for /ihub subpath (development)
        location /ihub/ {
            proxy_pass http://localhost:3000/;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-Prefix /ihub;
            proxy_cache_bypass $http_upgrade;
            proxy_redirect off;
            
            # Timeouts for LLM requests
            proxy_read_timeout 300s;
            proxy_send_timeout 300s;
        }

        # Redirect /ihub to /ihub/
        location = /ihub {
            return 301 /ihub/;
        }

        # Default location
        location / {
            return 301 /ihub/;
        }
    }
}
```

### Apache Configuration Alternative

For Apache reverse proxy:

```apache
<VirtualHost *:443>
    ServerName www.myserver.com
    
    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /path/to/cert.pem
    SSLCertificateKeyFile /path/to/key.pem
    
    # Enable necessary modules
    # a2enmod proxy proxy_http proxy_wstunnel headers ssl
    
    # Preserve Host header
    ProxyPreserveHost On
    
    # WebSocket support
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/ihub/(.*) ws://localhost:3001/$1 [P,L]
    
    # Main proxy configuration
    ProxyPass /ihub/ http://localhost:3001/
    ProxyPassReverse /ihub/ http://localhost:3001/
    
    # Set forwarded headers
    RequestHeader set X-Forwarded-Prefix "/ihub"
    RequestHeader set X-Forwarded-Proto "https"
    
    # Timeout for long-running requests
    ProxyTimeout 300
</VirtualHost>
```

## How It Works

### Reverse Proxy Flow (Scenario 1)

1. User visits `https://www.myserver.com/ihub/admin/sources`
2. Nginx receives `/ihub/admin/sources`
3. Nginx strips `/ihub` and forwards `/admin/sources` to backend
4. Nginx adds header `X-Forwarded-Prefix: /ihub`
5. Backend serves `index.html` for SPA route
6. Frontend JavaScript detects it's at `/ihub/` from browser URL
7. React Router uses `/ihub` as basename
8. All API calls go to `/ihub/api/*` which nginx properly forwards

### Backend Implementation Details

#### Base Path Detection (server/utils/basePath.js)

```javascript
export const getBasePath = () => {
  // Option 1: From environment variable (direct access)
  let basePath = process.env.BASE_PATH || '';
  
  // Option 2: From reverse proxy header (if enabled)
  if (process.env.AUTO_DETECT_BASE_PATH === 'true' && global.currentRequest) {
    const headerName = process.env.BASE_PATH_HEADER || 'x-forwarded-prefix';
    const detectedPath = global.currentRequest.headers[headerName.toLowerCase()];
    if (detectedPath && isValidBasePath(detectedPath)) {
      basePath = detectedPath;
    }
  }
  
  return basePath;
};
```

### Frontend Implementation Details

#### Runtime Base Path Detection (client/src/utils/runtimeBasePath.js)

```javascript
export const detectBasePath = () => {
  const pathname = window.location.pathname;
  
  // Remove any React route parts to find the base
  const knownRoutes = ['/apps', '/admin', '/auth', '/login', '/chat'];
  for (const route of knownRoutes) {
    const routeIndex = pathname.indexOf(route);
    if (routeIndex > 0) {
      // Everything before the route is the base path
      return pathname.substring(0, routeIndex);
    }
  }
  
  // If at root or unknown route, detect from current location
  return pathname.replace(/\/[^/]*$/, '');
};
```

## Docker Deployment

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  ihub-apps:
    build:
      context: .
      args:
        BASE_PATH: /ihub
        VITE_BASE_PATH: /ihub
    environment:
      - ALLOWED_ORIGINS=https://www.myserver.com
      - PORT=3000
    ports:
      - "3001:3000"
    volumes:
      - ./contents:/app/contents
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - ihub-apps
    restart: unless-stopped
```

## Kubernetes Deployment

### Ingress Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ihub-apps-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header X-Forwarded-Prefix /ihub;
spec:
  rules:
  - host: www.myserver.com
    http:
      paths:
      - path: /ihub(/|$)(.*)
        pathType: Prefix
        backend:
          service:
            name: ihub-apps-service
            port:
              number: 3000
```

## Traefik Configuration

```yaml
http:
  routers:
    ihub:
      rule: "Host(`www.myserver.com`) && PathPrefix(`/ihub`)"
      service: ihub-service
      middlewares:
        - ihub-stripprefix
        - ihub-headers

  middlewares:
    ihub-stripprefix:
      stripPrefix:
        prefixes:
          - "/ihub"
    ihub-headers:
      headers:
        customRequestHeaders:
          X-Forwarded-Prefix: "/ihub"

  services:
    ihub-service:
      loadBalancer:
        servers:
          - url: "http://localhost:3001"
```

## Security Considerations

### 1. Header Security

Always strip potentially dangerous headers from client requests:

```nginx
# Remove headers that could be spoofed
proxy_set_header X-Forwarded-User "";
proxy_set_header X-Forwarded-Groups "";
proxy_set_header X-Admin-Token "";
```

### 2. Rate Limiting

Implement rate limiting at the proxy level:

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

location /ihub/api/ {
    limit_req zone=api burst=20 nodelay;
    # ... proxy configuration ...
}
```

### 3. Content Security Policy

Add CSP headers for additional security:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';" always;
```

## Authentication Considerations

### Proxy Authentication Headers

If using proxy authentication, ensure your reverse proxy sets the correct headers:

```nginx
location /ihub/ {
    # ... other proxy settings ...
    
    # Authentication headers
    proxy_set_header X-Forwarded-User $remote_user;
    proxy_set_header X-Forwarded-Groups $http_x_user_groups;
    
    # Strip client-provided auth headers for security
    proxy_set_header Authorization "";
}
```

### JWT Authentication

For JWT-based authentication with reverse proxy:

```nginx
# Extract JWT from cookie or header
map $http_cookie $auth_token {
    default "";
    "~*jwt=([^;]+)" $1;
}

location /ihub/ {
    # ... other proxy settings ...
    
    # Forward JWT token
    proxy_set_header Authorization "Bearer $auth_token";
}
```

## Testing Your Setup

### Verification Steps

1. **Test Direct Backend Access:**
   ```bash
   curl http://localhost:3001/health
   ```

2. **Test Through Proxy:**
   ```bash
   curl https://www.myserver.com/ihub/health
   ```

3. **Check Headers:**
   ```bash
   curl -I https://www.myserver.com/ihub/api/health
   ```

4. **Verify CORS:**
   ```bash
   curl -H "Origin: https://www.myserver.com" \
        -H "Access-Control-Request-Method: GET" \
        -H "Access-Control-Request-Headers: Content-Type" \
        -X OPTIONS \
        https://www.myserver.com/ihub/api/health
   ```

### For Direct Access Setup

```bash
# Test backend with BASE_PATH
curl http://localhost:3001/ihub/api/health

# Should NOT work without prefix
curl http://localhost:3001/api/health  # Should return 404
```

## Troubleshooting

### Common Issues and Solutions

#### 1. CORS Errors

**Symptom:** Browser console shows CORS errors
```
Access to fetch at 'https://www.myserver.com/ihub/api' from origin 'https://www.myserver.com' has been blocked by CORS policy
```

**Solution:**
- Verify `ALLOWED_ORIGINS` environment variable is set
- Check `contents/config/platform.json` CORS configuration
- Ensure nginx isn't adding conflicting CORS headers

#### 2. Assets Not Loading

**Symptom:** CSS, JS, or images return 404

**Solution:**
- Verify `VITE_BASE_PATH` was set during build
- Check that `BASE_PATH` matches at runtime
- Inspect browser network tab for actual request paths

#### 3. API Calls Failing

**Symptom:** API requests fail or go to wrong path

**Solution:**
- Verify `X-Forwarded-Prefix` header is set in proxy
- Check API client configuration uses correct base path
- Test with: `curl -H "X-Forwarded-Prefix: /ihub" http://localhost:3001/api/health`

#### 4. Blank Page on Direct Navigation

**Symptom:** Works from home page, blank on direct URL like `/ihub/admin/sources`

**Solution:** Ensure SPA fallback route is registered AFTER all API routes:
```javascript
// Register API routes first
app.use('/api', apiRoutes);

// Static files
app.use(express.static(staticPath));

// Catch-all MUST be last
app.get('*', (req, res) => {
  res.sendFile(indexPath);
});
```

#### 5. WebSocket/SSE Not Working

**Symptom:** Real-time chat updates not working

**Solution:**
- Ensure proxy handles `Upgrade` headers
- Disable buffering for SSE endpoints
- Check proxy timeout settings (should be high for streaming)

## Performance Optimization

### 1. Enable Compression

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss application/rss+xml application/atom+xml image/svg+xml;
```

### 2. Static Asset Caching

```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

### 3. Connection Pooling

```nginx
upstream ihub_backend {
    server localhost:3001;
    keepalive 32;
    keepalive_requests 100;
    keepalive_timeout 60s;
}
```

## Quick Decision Guide

### Choose Reverse Proxy Setup When:
- Using nginx, Apache, Traefik, or Kubernetes Ingress
- Want clean internal routes without prefix
- Have multiple apps on same domain
- Need advanced load balancing or SSL termination

### Choose Direct Access Setup When:
- No reverse proxy available
- Simple deployment scenario
- Want complete control in Node.js
- Testing or development environments

## Summary

To successfully deploy iHub Apps at `www.myserver.com/ihub`:

1. ✅ **Set CORS origin** to include your domain via `ALLOWED_ORIGINS`
2. ✅ **Configure subpath** appropriately for your deployment scenario
3. ✅ **Update nginx.conf** to proxy to correct port (3001 for production)
4. ✅ **Set proper headers** including `X-Forwarded-Prefix`
5. ✅ **Handle WebSocket/SSE** for real-time chat features
6. ✅ **Implement security** best practices (rate limiting, SSL, CSP)
7. ✅ **Enable performance** optimizations (compression, caching)

Both deployment scenarios work perfectly with the runtime base path detection system!