# Subpath Deployment Examples and Migration Guide

## Overview

This guide provides practical examples for deploying iHub Apps at subpaths and migrating existing root-path deployments. It includes configuration examples for common deployment scenarios and troubleshooting guidance.

## Deployment Scenarios

### Scenario 1: Basic Subpath Deployment with Docker

#### Objective
Deploy iHub Apps at `https://company.com/ai-hub/` using Docker and Nginx reverse proxy.

#### Configuration Files

##### docker-compose.yml
```yaml
version: '3.8'
services:
  ihub-apps:
    build:
      context: .
      dockerfile: docker/Dockerfile
      args:
        - BASE_PATH=/ai-hub
    environment:
      - BASE_PATH=/ai-hub
      - VITE_BASE_PATH=/ai-hub
      - NODE_ENV=production
    volumes:
      - ./contents:/app/contents
      - ./logs:/app/logs
    networks:
      - ihub-network
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/ssl/certs:ro
    depends_on:
      - ihub-apps
    networks:
      - ihub-network
    restart: unless-stopped

networks:
  ihub-network:
    driver: bridge
```

##### nginx.conf
```nginx
events {
    worker_connections 1024;
}

http {
    upstream ihub {
        server ihub-apps:3000;
    }

    server {
        listen 80;
        server_name company.com;
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl;
        server_name company.com;

        ssl_certificate /etc/ssl/certs/company.com.crt;
        ssl_certificate_key /etc/ssl/certs/company.com.key;

        # Main application location
        location /ai-hub/ {
            proxy_pass http://ihub/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-Prefix /ai-hub;
            
            # WebSocket support
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            
            # CRITICAL: Disable buffering for Server-Sent Events (SSE)
            proxy_buffering off;
            proxy_request_buffering off;
            
            # Timeouts for long-running streaming requests (15 minutes)
            proxy_connect_timeout 60s;
            proxy_send_timeout 900s;
            proxy_read_timeout 900s;
        }

        # Serve other company content at root
        location / {
            root /var/www/company-website;
            index index.html;
            try_files $uri $uri/ /index.html;
        }
    }
}
```

##### Deployment Commands
```bash
# Build and start services
docker-compose up -d --build

# Verify deployment
curl -I https://company.com/ai-hub/api/health

# Check logs
docker-compose logs -f ihub-apps
```

### Scenario 2: Kubernetes Deployment with Ingress

#### Objective
Deploy iHub Apps in Kubernetes at `/ai-hub` path with automatic SSL and load balancing.

#### Configuration Files

##### deployment.yaml
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ihub-apps
  namespace: ai-tools
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ihub-apps
  template:
    metadata:
      labels:
        app: ihub-apps
    spec:
      containers:
      - name: ihub-apps
        image: ihub-apps:latest
        env:
        - name: BASE_PATH
          value: "/ai-hub"
        - name: VITE_BASE_PATH
          value: "/ai-hub"
        - name: NODE_ENV
          value: "production"
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /ai-hub/api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ai-hub/api/health
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 5
        volumeMounts:
        - name: contents-volume
          mountPath: /app/contents
      volumes:
      - name: contents-volume
        persistentVolumeClaim:
          claimName: ihub-contents-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: ihub-apps-service
  namespace: ai-tools
spec:
  selector:
    app: ihub-apps
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: ClusterIP
```

##### ingress.yaml
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ihub-apps-ingress
  namespace: ai-tools
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header X-Forwarded-Prefix /ai-hub;
      proxy_set_header Accept-Encoding "";
    nginx.ingress.kubernetes.io/proxy-body-size: 50m
spec:
  tls:
  - hosts:
    - company.com
    secretName: company-com-tls
  rules:
  - host: company.com
    http:
      paths:
      - path: /ai-hub(/|$)(.*)
        pathType: Prefix
        backend:
          service:
            name: ihub-apps-service
            port:
              number: 80
```

##### pvc.yaml
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ihub-contents-pvc
  namespace: ai-tools
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: fast-ssd
```

##### Deployment Commands
```bash
# Create namespace
kubectl create namespace ai-tools

# Apply configurations
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f ingress.yaml

# Verify deployment
kubectl get pods -n ai-tools
kubectl get ingress -n ai-tools

# Check application
curl -I https://company.com/ai-hub/api/health
```

### Scenario 3: Apache HTTP Server with mod_proxy

#### Objective
Deploy iHub Apps behind Apache HTTP Server with SSL termination at `/ai-hub`.

#### Configuration Files

##### httpd.conf (Apache Configuration)
```apache
# Enable required modules
LoadModule rewrite_module modules/mod_rewrite.so
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule ssl_module modules/mod_ssl.so
LoadModule headers_module modules/mod_headers.so

# Main server configuration
ServerName company.com
Listen 80
Listen 443

# HTTP to HTTPS redirect
<VirtualHost *:80>
    ServerName company.com
    RewriteEngine On
    RewriteCond %{HTTPS} off
    RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

# HTTPS Virtual Host
<VirtualHost *:443>
    ServerName company.com
    
    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/ssl/certs/company.com.crt
    SSLCertificateKeyFile /etc/ssl/private/company.com.key
    
    # Security headers
    Header always set Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    Header always set X-Frame-Options DENY
    Header always set X-Content-Type-Options nosniff
    
    # iHub Apps proxy configuration
    <Location /ai-hub>
        ProxyPass http://localhost:3000/ timeout=30
        ProxyPassReverse http://localhost:3000/
        ProxyPreserveHost On
        ProxyAddHeaders On
        RequestHeader set X-Forwarded-Prefix "/ai-hub"
        
        # WebSocket support
        RewriteEngine on
        RewriteCond %{HTTP:Upgrade} websocket [NC]
        RewriteCond %{HTTP:Connection} upgrade [NC]
        RewriteRule ^/?(.*) "ws://localhost:3000/$1" [P,L]
    </Location>
    
    # Company website at root
    DocumentRoot /var/www/html/company-website
    <Directory /var/www/html/company-website>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

##### systemd service file (ihub-apps.service)
```ini
[Unit]
Description=iHub Apps Service
After=network.target

[Service]
Type=simple
User=ihub
WorkingDirectory=/opt/ihub-apps
Environment=NODE_ENV=production
Environment=BASE_PATH=/ai-hub
Environment=VITE_BASE_PATH=/ai-hub
ExecStart=/usr/bin/node server/server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

##### Deployment Commands
```bash
# Install iHub Apps
sudo mkdir -p /opt/ihub-apps
sudo cp -r * /opt/ihub-apps/
sudo chown -R ihub:ihub /opt/ihub-apps

# Start service
sudo systemctl daemon-reload
sudo systemctl enable ihub-apps
sudo systemctl start ihub-apps

# Configure Apache
sudo systemctl reload httpd

# Verify deployment
curl -I https://company.com/ai-hub/api/health
```

### Scenario 4: Cloud Load Balancer (AWS ALB)

#### Objective
Deploy iHub Apps using AWS Application Load Balancer with path-based routing.

#### Configuration Files

##### docker-compose.yml (ECS Task)
```yaml
version: '3.8'
services:
  ihub-apps:
    image: your-registry/ihub-apps:latest
    environment:
      - BASE_PATH=/ai-hub
      - VITE_BASE_PATH=/ai-hub
      - NODE_ENV=production
    ports:
      - "3000:3000"
    logging:
      driver: awslogs
      options:
        awslogs-group: /ecs/ihub-apps
        awslogs-region: us-east-1
        awslogs-stream-prefix: ecs
```

##### ALB Configuration (Terraform)
```hcl
resource "aws_lb" "main" {
  name               = "company-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets           = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "ihub_apps" {
  name     = "ihub-apps-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
  
  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/ai-hub/api/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "main" {
  load_balancer_arn = aws_lb.main.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/html"
      message_body = "<h1>Welcome to Company Portal</h1>"
      status_code  = "200"
    }
  }
}

resource "aws_lb_listener_rule" "ihub_apps" {
  listener_arn = aws_lb_listener.main.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ihub_apps.arn
  }

  condition {
    path_pattern {
      values = ["/ai-hub/*"]
    }
  }
}
```

## Migration Guide

### Migration Scenario 1: Root Path to Subpath

#### Current State
- iHub Apps deployed at `https://ihub.company.com/`
- Users access directly at root domain

#### Target State  
- iHub Apps deployed at `https://company.com/ai-hub/`
- Integrated into main company portal

#### Migration Steps

##### Phase 1: Preparation (1 week before migration)
1. **Backup Current Configuration**
   ```bash
   # Create backup of current deployment
   tar -czf ihub-backup-$(date +%Y%m%d).tar.gz contents/ logs/
   ```

2. **Test Subpath Deployment in Staging**
   ```bash
   # Set up staging environment with subpath
   export BASE_PATH="/ai-hub"
   export VITE_BASE_PATH="/ai-hub"
   
   # Build and test
   npm run build
   npm run start
   ```

3. **Update Bookmarks and Documentation**
   - Notify users of upcoming URL change
   - Update documentation with new URLs
   - Prepare redirect configuration

##### Phase 2: Deployment (Migration day)
1. **Deploy New Configuration**
   ```bash
   # Stop current service
   systemctl stop ihub-apps
   
   # Update environment configuration
   echo 'BASE_PATH="/ai-hub"' >> /etc/systemd/system/ihub-apps.service.d/override.conf
   echo 'VITE_BASE_PATH="/ai-hub"' >> /etc/systemd/system/ihub-apps.service.d/override.conf
   
   # Rebuild with new base path
   VITE_BASE_PATH="/ai-hub" npm run build
   
   # Start service
   systemctl daemon-reload
   systemctl start ihub-apps
   ```

2. **Configure Reverse Proxy**
   ```nginx
   # Add to nginx configuration
   location /ai-hub/ {
       proxy_pass http://localhost:3000/;
       proxy_set_header X-Forwarded-Prefix /ai-hub;
       # ... other proxy settings
   }
   
   # Add redirect from old domain
   server {
       server_name ihub.company.com;
       return 301 https://company.com/ai-hub$request_uri;
   }
   ```

3. **Verify Migration**
   ```bash
   # Test new URL
   curl -I https://company.com/ai-hub/api/health
   
   # Test redirect from old URL
   curl -I https://ihub.company.com/
   
   # Check application functionality
   # - Login/authentication
   # - App navigation
   # - File uploads
   # - API calls
   ```

##### Phase 3: Cleanup (1 week after migration)
1. **Monitor and Validate**
   - Monitor application logs for errors
   - Check user feedback
   - Validate all features working

2. **Update DNS and Certificates**
   ```bash
   # Update DNS records
   # Remove ihub.company.com if no longer needed
   
   # Update SSL certificates
   # Ensure company.com certificate covers new deployment
   ```

3. **Remove Redirects** (after 30 days)
   ```nginx
   # Remove temporary redirects once users have adjusted
   # Keep monitoring for any remaining old URL usage
   ```

### Migration Scenario 2: Multiple Subpaths (Multi-tenancy)

#### Current State
- Single iHub Apps instance
- All users share same deployment

#### Target State
- Multiple iHub Apps instances at different subpaths
- `/ai-hub/team-a/`, `/ai-hub/team-b/`, etc.

#### Migration Steps

##### 1. Prepare Multi-tenant Configuration
```yaml
# docker-compose-multitenant.yml
version: '3.8'
services:
  ihub-team-a:
    image: ihub-apps:latest
    environment:
      - BASE_PATH=/ai-hub/team-a
      - VITE_BASE_PATH=/ai-hub/team-a
      - CONTENTS_DIR=./contents-team-a
    volumes:
      - ./contents-team-a:/app/contents
    ports:
      - "3001:3000"

  ihub-team-b:
    image: ihub-apps:latest
    environment:
      - BASE_PATH=/ai-hub/team-b
      - VITE_BASE_PATH=/ai-hub/team-b
      - CONTENTS_DIR=./contents-team-b
    volumes:
      - ./contents-team-b:/app/contents
    ports:
      - "3002:3000"

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx-multitenant.conf:/etc/nginx/nginx.conf
    depends_on:
      - ihub-team-a
      - ihub-team-b
```

##### 2. Configure Nginx for Multiple Subpaths
```nginx
# nginx-multitenant.conf
upstream team-a {
    server ihub-team-a:3000;
}

upstream team-b {
    server ihub-team-b:3000;
}

server {
    listen 80;
    server_name company.com;

    location /ai-hub/team-a/ {
        proxy_pass http://team-a/;
        proxy_set_header X-Forwarded-Prefix /ai-hub/team-a;
        # ... other proxy settings
    }

    location /ai-hub/team-b/ {
        proxy_pass http://team-b/;
        proxy_set_header X-Forwarded-Prefix /ai-hub/team-b;
        # ... other proxy settings
    }
}
```

##### 3. Migrate Data by Team
```bash
# Prepare team-specific configurations
mkdir -p contents-team-a contents-team-b

# Copy and customize configurations
cp -r contents/* contents-team-a/
cp -r contents/* contents-team-b/

# Customize team-specific settings
# Edit contents-team-a/config/platform.json
# Edit contents-team-b/config/platform.json
```

## Troubleshooting Common Issues

### Issue 1: Static Assets Return 404

#### Symptoms
- CSS and JavaScript files fail to load
- Images show broken links
- Favicon missing

#### Diagnosis
```bash
# Check network requests in browser developer tools
# Look for requests to wrong paths (e.g., /favicon.ico instead of /ai-hub/favicon.ico)

# Check server logs
docker logs ihub-apps | grep "404"

# Test asset URLs directly
curl -I https://company.com/ai-hub/favicon.ico
```

#### Solutions
```bash
# 1. Verify Vite base configuration
cat client/vite.config.js
# Should contain: base: process.env.VITE_BASE_PATH || '/'

# 2. Check environment variables
echo $VITE_BASE_PATH
echo $BASE_PATH

# 3. Rebuild with correct base path
VITE_BASE_PATH="/ai-hub" npm run build

# 4. Verify static file serving
# Check server/routes/staticRoutes.js for base path handling
```

### Issue 2: API Calls Return 404

#### Symptoms
- API endpoints return 404 Not Found
- Authentication fails
- Data doesn't load

#### Diagnosis
```bash
# Check API call URLs in browser network tab
# Should be /ai-hub/api/* not /api/*

# Test API endpoint directly
curl -I https://company.com/ai-hub/api/health

# Check server route registration
grep -r "buildServerPath" server/routes/
```

#### Solutions
```javascript
// 1. Verify API client configuration
// client/src/api/client.js should use buildApiPath()
import { buildApiPath } from '../utils/basePath';
const API_URL = import.meta.env.VITE_API_URL || buildApiPath('');

// 2. Check server route registration
// server/server.js should use buildServerPath()
registerChatRoutes(app, buildServerPath('/api'));

// 3. Update proxy configuration if using reverse proxy
location /ai-hub/api/ {
    proxy_pass http://backend/api/;
    proxy_set_header X-Forwarded-Prefix /ai-hub;
}
```

### Issue 3: Authentication Redirects Break

#### Symptoms
- Login redirects to wrong URL
- Session cookies not set
- Authentication loops

#### Diagnosis
```bash
# Check cookie settings in browser developer tools
# Verify cookie path matches base path

# Check authentication redirect URLs
grep -r "redirect" server/routes/auth.js

# Test authentication flow
curl -v -X POST https://company.com/ai-hub/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}'
```

#### Solutions
```javascript
// 1. Update cookie configuration
// server/middleware/authRequired.js
res.cookie('authToken', token, {
  path: getBasePath() || '/',
  httpOnly: true,
  secure: true
});

// 2. Update authentication redirects
// server/routes/auth.js
const redirectUrl = buildPublicUrl('/apps', req);
res.redirect(redirectUrl);

// 3. Configure reverse proxy for authentication
# nginx.conf
proxy_cookie_path / /ai-hub/;
proxy_set_header X-Forwarded-Prefix /ai-hub;
```

### Issue 4: WebSocket Connections Fail

#### Symptoms
- Real-time features don't work
- Chat streaming fails
- Connection upgrade errors

#### Diagnosis
```bash
# Check WebSocket upgrade requests in browser network tab
# Look for failed upgrade requests

# Test WebSocket connection
wscat -c wss://company.com/ai-hub/api/chat/stream

# Check proxy WebSocket configuration
```

#### Solutions
```nginx
# 1. Nginx WebSocket configuration
location /ai-hub/ {
    proxy_pass http://backend/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Prefix /ai-hub;
}
```

```apache
# 2. Apache WebSocket configuration
<Location /ai-hub>
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://localhost:3000/$1" [P,L]
</Location>
```

### Issue 5: Performance Degradation

#### Symptoms
- Slower page loads
- Increased latency
- Timeout errors

#### Diagnosis
```bash
# Check response times
curl -w "%{time_total}\n" -o /dev/null -s https://company.com/ai-hub/api/health

# Monitor server resources
top -p $(pgrep node)

# Check proxy timeouts
grep timeout /etc/nginx/nginx.conf
```

#### Solutions
```nginx
# 1. Optimize proxy timeouts and buffering
location /ai-hub/ {
    proxy_pass http://backend/;
    
    # Connection timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 900s;
    proxy_read_timeout 900s;
    
    # CRITICAL: Disable buffering for Server-Sent Events (SSE)
    # Only enable buffering for static assets, not for streaming endpoints
    proxy_buffering off;
    proxy_request_buffering off;
}
```

```bash
# 2. Enable compression
gzip on;
gzip_types text/css application/javascript application/json;

# 3. Configure caching headers
location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## Best Practices

### 1. Configuration Management
- Use environment variables for all path configuration
- Document all required environment variables
- Provide default values for development

### 2. Testing Strategy
- Test both root path and subpath deployments
- Automate testing of different deployment scenarios
- Include end-to-end testing in CI/CD pipeline

### 3. Monitoring and Logging
- Monitor application health at new paths
- Set up alerts for 404 errors on critical endpoints
- Log configuration values at startup

### 4. Documentation
- Keep deployment documentation up to date
- Provide examples for common reverse proxy configurations
- Document troubleshooting steps for common issues

### 5. Security
- Validate and sanitize base path configuration
- Ensure cookie security with subpath deployment
- Review CORS configuration for subpath origins

This comprehensive guide provides the practical knowledge needed to successfully deploy iHub Apps at subpaths and migrate existing deployments.