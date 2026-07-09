# Subpath Deployment Technical Specifications

## Overview

This document provides detailed technical specifications for implementing subpath deployment support in iHub Apps. It serves as the definitive reference for developers implementing the changes.

## Core Architecture Components

### 1. Base Path Configuration System

#### Environment Variables Schema
```typescript
interface SubpathConfig {
  // Client-side build-time configuration
  VITE_BASE_PATH?: string;           // e.g., "/ai-hub", "/apps/ihub"
  
  // Server-side runtime configuration
  BASE_PATH?: string;                // Must match VITE_BASE_PATH for consistency
  AUTO_DETECT_BASE_PATH?: boolean;   // Enable header-based detection
  BASE_PATH_HEADER?: string;         // Default: "X-Forwarded-Prefix"
}
```

#### Validation Rules
- Base paths must start with `/` or be empty string
- Base paths must not end with `/` (except for root `/`)
- Base paths must not contain `..` or other dangerous sequences
- Maximum length: 100 characters
- Valid characters: alphanumeric, hyphen, underscore, forward slash

### 2. Client-Side Utilities

#### File: `/client/src/utils/basePath.js`
```javascript
/**
 * Base path utilities for client-side routing and API calls
 */

/**
 * Get the configured base path for the application
 * @returns {string} Base path (e.g., "/ai-hub" or "")
 */
export const getBasePath = () => {
  const basePath = import.meta.env.VITE_BASE_PATH || '';
  return basePath.endsWith('/') && basePath !== '/' ? basePath.slice(0, -1) : basePath;
};

/**
 * Build a complete path with base path prefix
 * @param {string} path - Relative or absolute path
 * @returns {string} Complete path with base path
 */
export const buildPath = (path) => {
  if (!path) return getBasePath() || '/';
  
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  
  if (!basePath) return cleanPath;
  return `${basePath}${cleanPath}`;
};

/**
 * Build API endpoint URL with base path
 * @param {string} endpoint - API endpoint (e.g., "/health", "users")
 * @returns {string} Complete API URL
 */
export const buildApiPath = (endpoint) => {
  const basePath = getBasePath();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  if (!basePath) return `/api${cleanEndpoint}`;
  return `${basePath}/api${cleanEndpoint}`;
};

/**
 * Build asset URL with base path
 * @param {string} asset - Asset path (e.g., "/favicon.ico", "images/logo.png")
 * @returns {string} Complete asset URL
 */
export const buildAssetPath = (asset) => {
  if (asset.startsWith('http://') || asset.startsWith('https://')) {
    return asset; // External URL, return as-is
  }
  
  const basePath = getBasePath();
  const cleanAsset = asset.startsWith('/') ? asset : `/${asset}`;
  
  if (!basePath) return cleanAsset;
  return `${basePath}${cleanAsset}`;
};

/**
 * Check if current deployment is using a subpath
 * @returns {boolean} True if deployed at subpath
 */
export const isSubpathDeployment = () => {
  return getBasePath() !== '';
};

/**
 * Get the current pathname relative to base path
 * @param {string} fullPathname - Full pathname from window.location
 * @returns {string} Relative pathname
 */
export const getRelativePathname = (fullPathname) => {
  const basePath = getBasePath();
  if (!basePath || fullPathname === basePath) return '/';
  
  if (fullPathname.startsWith(basePath + '/')) {
    return fullPathname.substring(basePath.length);
  }
  
  return fullPathname;
};
```

### 3. Server-Side Utilities

#### File: `/server/utils/basePath.js`
```javascript
/**
 * Base path utilities for server-side routing and URL generation
 */
import config from '../config.js';

/**
 * Get the configured base path from environment or configuration
 * @returns {string} Base path
 */
export const getBasePath = () => {
  let basePath = process.env.BASE_PATH || '';
  
  // Auto-detection from request headers (if enabled)
  if (process.env.AUTO_DETECT_BASE_PATH === 'true' && global.currentRequest) {
    const headerName = process.env.BASE_PATH_HEADER || 'X-Forwarded-Prefix';
    const detectedPath = global.currentRequest.headers[headerName.toLowerCase()];
    if (detectedPath) {
      basePath = detectedPath;
    }
  }
  
  return basePath.endsWith('/') && basePath !== '/' ? basePath.slice(0, -1) : basePath;
};

/**
 * Build server route path with base path
 * @param {string} path - Route path
 * @returns {string} Complete route path
 */
export const buildServerPath = (path) => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  
  if (!basePath) return cleanPath;
  return `${basePath}${cleanPath}`;
};

/**
 * Build public URL for client consumption
 * @param {string} path - Path to make public
 * @param {Object} req - Express request object
 * @returns {string} Complete public URL
 */
export const buildPublicUrl = (path, req) => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  
  if (!basePath) return cleanPath;
  return `${basePath}${cleanPath}`;
};

/**
 * Extract relative path from request URL
 * @param {string} requestPath - Full request path
 * @returns {string} Path relative to base path
 */
export const getRelativeRequestPath = (requestPath) => {
  const basePath = getBasePath();
  if (!basePath) return requestPath;
  
  if (requestPath.startsWith(basePath)) {
    return requestPath.substring(basePath.length) || '/';
  }
  
  return requestPath;
};

/**
 * Middleware to detect base path from headers
 * @param {Object} req - Express request
 * @param {Object} res - Express response  
 * @param {Function} next - Next middleware
 */
export const basePathDetectionMiddleware = (req, res, next) => {
  if (process.env.AUTO_DETECT_BASE_PATH === 'true') {
    global.currentRequest = req;
  }
  next();
};
```

### 4. React Router Integration

#### Updated App.jsx
```jsx
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { getBasePath } from './utils/basePath';
// ... other imports

function App() {
  const basename = getBasePath();
  
  return (
    <AppProviders>
      <AuthProvider>
        <AdminAuthProvider>
          <TeamsWrapper>
            <BrowserRouter basename={basename}>
              {/* Global components */}
              <MarkdownRenderer />
              <DocumentTitle />

              <Routes>
                {/* All existing routes remain the same */}
                <Route path="/" element={<Layout />}>
                  <Route index element={<SafeAppsList />} />
                  {/* ... all other routes unchanged */}
                </Route>
              </Routes>
            </BrowserRouter>
          </TeamsWrapper>
        </AdminAuthProvider>
      </AuthProvider>
    </AppProviders>
  );
}

export default App;
```

### 5. API Client Updates

#### Updated client.js
```javascript
import axios from 'axios';
import { buildApiPath } from '../utils/basePath';
import { getSessionId, shouldRenewSession, renewSession } from '../utils/sessionManager';

// Use dynamic API URL based on base path
const API_URL = import.meta.env.VITE_API_URL || buildApiPath('');

const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: API_REQUEST_TIMEOUT,
  withCredentials: true,
  validateStatus: function (status) {
    return (status >= 200 && status < 300) || status === 304;
  }
});

// ... rest of the configuration remains the same
```

### 6. Server Route Registration

#### Updated server.js route registration
```javascript
import { buildServerPath } from './utils/basePath.js';

// Register routes with base path
function registerRoutes(app) {
  const basePath = getBasePath();
  
  // API routes
  registerChatRoutes(app, buildServerPath('/api'));
  registerAdminRoutes(app, buildServerPath('/api/admin'));
  registerGeneralRoutes(app, buildServerPath('/api'));
  registerModelRoutes(app, buildServerPath('/api'));
  registerToolRoutes(app, buildServerPath('/api'));
  registerPageRoutes(app, buildServerPath('/api'));
  registerSessionRoutes(app, buildServerPath('/api'));
  registerMagicPromptRoutes(app, buildServerPath('/api'));
  registerShortLinkRoutes(app, buildServerPath('/s'));
  registerOpenAIProxyRoutes(app, buildServerPath('/v1'));
  registerAuthRoutes(app, buildServerPath('/api/auth'));
  registerSwaggerRoutes(app, buildServerPath('/api'));
}
```

### 7. Static File Serving Updates

#### Updated staticRoutes.js
```javascript
import { buildServerPath } from '../utils/basePath.js';

export default function registerStaticRoutes(app, { isPackaged, rootDir }) {
  // ... existing static path logic
  
  // Serve static files at base path
  const basePath = getBasePath();
  if (basePath) {
    app.use(basePath, express.static(staticPath));
  } else {
    app.use(express.static(staticPath));
  }

  // Serve uploads with base path
  app.use(buildServerPath('/uploads'), express.static(uploadsPath));
  
  // Serve docs with base path and authentication
  app.use(buildServerPath('/docs'), authRequired, express.static(docsPath));

  // SPA routing with base path support
  app.get('*', (req, res, next) => {
    const relativePath = getRelativeRequestPath(req.path);
    
    // Don't serve SPA for API routes
    if (relativePath.startsWith('/api') || relativePath.startsWith('/docs')) {
      return next();
    }
    
    res.sendFile(indexPath);
  });
}
```

### 8. Build Configuration Updates

#### Updated vite.config.js
```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
  envDir: '../',
  server: {
    proxy: {
      '/api/': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => {
          const basePath = process.env.VITE_BASE_PATH || '';
          return basePath + path;
        }
      },
      '/s/': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => {
          const basePath = process.env.VITE_BASE_PATH || '';
          return basePath + path;
        }
      },
      '/docs': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => {
          const basePath = process.env.VITE_BASE_PATH || '';
          return basePath + path;
        }
      },
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => {
          const basePath = process.env.VITE_BASE_PATH || '';
          return basePath + path;
        }
      }
    }
  }
});
```

## Configuration Examples

### 1. Environment Configuration

#### Development (.env)
```bash
# Client build configuration
VITE_BASE_PATH=""

# Server runtime configuration
BASE_PATH=""
AUTO_DETECT_BASE_PATH=false
```

#### Production Subpath (.env.production)
```bash
# Client build configuration  
VITE_BASE_PATH="/ai-hub"

# Server runtime configuration
BASE_PATH="/ai-hub"
AUTO_DETECT_BASE_PATH=false
```

#### Auto-Detection (.env.proxy)
```bash
# Client build configuration (still needed for assets)
VITE_BASE_PATH="/ai-hub"

# Server runtime configuration with auto-detection
BASE_PATH=""
AUTO_DETECT_BASE_PATH=true
BASE_PATH_HEADER="X-Forwarded-Prefix"
```

### 2. Docker Configuration

#### Docker Compose with Subpath
```yaml
version: '3.8'
services:
  ihub-apps:
    build:
      context: .
      args:
        BASE_PATH: "/ai-hub"
    environment:
      - BASE_PATH=/ai-hub
      - VITE_BASE_PATH=/ai-hub
    labels:
      - "traefik.http.routers.ihub.rule=PathPrefix(`/ai-hub`)"
      - "traefik.http.middlewares.ihub-strip.stripprefix.prefixes=/ai-hub"
```

### 3. Reverse Proxy Configuration

#### Nginx Configuration
```nginx
location /ai-hub/ {
    proxy_pass http://ihub-backend/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /ai-hub;
    
    # Handle WebSocket connections
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

#### Apache Configuration
```apache
<Location /ai-hub>
    ProxyPass http://localhost:3000/
    ProxyPassReverse http://localhost:3000/
    ProxyPreserveHost On
    ProxyAddHeaders On
    RequestHeader set X-Forwarded-Prefix "/ai-hub"
</Location>
```

### 4. Kubernetes Ingress
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ihub-apps-ingress
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

## Testing Strategy

### 1. Unit Tests

#### Base Path Utilities Tests
```javascript
// Test file: /client/src/utils/__tests__/basePath.test.js
import { getBasePath, buildPath, buildApiPath, buildAssetPath } from '../basePath';

describe('basePath utilities', () => {
  beforeEach(() => {
    // Reset environment
    delete import.meta.env.VITE_BASE_PATH;
  });

  describe('getBasePath', () => {
    it('returns empty string when no base path configured', () => {
      expect(getBasePath()).toBe('');
    });

    it('returns configured base path', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub';
      expect(getBasePath()).toBe('/ai-hub');
    });

    it('removes trailing slash', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub/';
      expect(getBasePath()).toBe('/ai-hub');
    });

    it('preserves root slash', () => {
      import.meta.env.VITE_BASE_PATH = '/';
      expect(getBasePath()).toBe('/');
    });
  });

  describe('buildPath', () => {
    it('works with no base path', () => {
      expect(buildPath('/apps')).toBe('/apps');
      expect(buildPath('apps')).toBe('/apps');
    });

    it('works with base path', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub';
      expect(buildPath('/apps')).toBe('/ai-hub/apps');
      expect(buildPath('apps')).toBe('/ai-hub/apps');
    });

    it('handles empty path', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub';
      expect(buildPath('')).toBe('/ai-hub/');
    });
  });

  describe('buildApiPath', () => {
    it('builds API paths correctly', () => {
      expect(buildApiPath('/health')).toBe('/api/health');
      expect(buildApiPath('health')).toBe('/api/health');
    });

    it('builds API paths with base path', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub';
      expect(buildApiPath('/health')).toBe('/ai-hub/api/health');
      expect(buildApiPath('health')).toBe('/ai-hub/api/health');
    });
  });

  describe('buildAssetPath', () => {
    it('handles relative assets', () => {
      expect(buildAssetPath('favicon.ico')).toBe('/favicon.ico');
      expect(buildAssetPath('/favicon.ico')).toBe('/favicon.ico');
    });

    it('handles assets with base path', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub';
      expect(buildAssetPath('favicon.ico')).toBe('/ai-hub/favicon.ico');
      expect(buildAssetPath('/favicon.ico')).toBe('/ai-hub/favicon.ico');
    });

    it('preserves external URLs', () => {
      import.meta.env.VITE_BASE_PATH = '/ai-hub';
      expect(buildAssetPath('https://example.com/image.png')).toBe('https://example.com/image.png');
      expect(buildAssetPath('http://example.com/image.png')).toBe('http://example.com/image.png');
    });
  });
});
```

### 2. Integration Tests

#### API Endpoint Tests
```javascript
// Test file: /server/tests/subpath-integration.test.js
import request from 'supertest';
import app from '../server.js';

describe('Subpath Integration Tests', () => {
  describe('with no base path', () => {
    beforeEach(() => {
      process.env.BASE_PATH = '';
    });

    it('serves API at /api/health', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);
    });

    it('serves static files at root', async () => {
      const response = await request(app)
        .get('/favicon.ico')
        .expect(200);
    });
  });

  describe('with base path /ai-hub', () => {
    beforeEach(() => {
      process.env.BASE_PATH = '/ai-hub';
    });

    it('serves API at /ai-hub/api/health', async () => {
      const response = await request(app)
        .get('/ai-hub/api/health')
        .expect(200);
    });

    it('serves static files at /ai-hub/', async () => {
      const response = await request(app)
        .get('/ai-hub/favicon.ico')
        .expect(200);
    });

    it('returns 404 for root path API', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(404);
    });
  });
});
```

### 3. End-to-End Tests

#### Playwright E2E Tests
```javascript
// Test file: /tests/e2e/subpath-deployment.spec.js
import { test, expect } from '@playwright/test';

test.describe('Subpath Deployment', () => {
  test.beforeEach(async ({ page }) => {
    // Set base path for testing
    await page.addInitScript(() => {
      window.importMeta = { env: { VITE_BASE_PATH: '/ai-hub' } };
    });
  });

  test('should navigate correctly with base path', async ({ page }) => {
    await page.goto('/ai-hub/');
    
    // Verify we're on the apps list page
    await expect(page.locator('h1')).toContainText('AI Applications');
    
    // Click on an app
    await page.click('[data-testid="app-card"]:first-child');
    
    // Verify URL includes base path
    expect(page.url()).toContain('/ai-hub/apps/');
  });

  test('should make API calls with correct base path', async ({ page }) => {
    // Monitor network requests
    const apiRequests = [];
    page.on('request', request => {
      if (request.url().includes('/api/')) {
        apiRequests.push(request.url());
      }
    });

    await page.goto('/ai-hub/');
    
    // Wait for API calls to complete
    await page.waitForLoadState('networkidle');
    
    // Verify API calls use correct base path
    const healthRequest = apiRequests.find(url => url.includes('/health'));
    expect(healthRequest).toContain('/ai-hub/api/health');
  });

  test('should load static assets from correct base path', async ({ page }) => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));

    await page.goto('/ai-hub/');
    await page.waitForLoadState('networkidle');

    // Check that favicon loads from correct path
    const faviconRequest = requests.find(url => url.includes('favicon.ico'));
    expect(faviconRequest).toContain('/ai-hub/favicon.ico');
  });
});
```

## Implementation Checklist

### Phase 1: Infrastructure ✅
- [ ] Create client-side base path utilities
- [ ] Create server-side base path utilities  
- [ ] Add environment variable processing
- [ ] Create configuration validation
- [ ] Add unit tests for utilities

### Phase 2: Client-Side Updates
- [ ] Update React Router with basename
- [ ] Update API client base URL
- [ ] Update all Link components
- [ ] Update programmatic navigation
- [ ] Update asset references
- [ ] Test client-side routing

### Phase 3: Server-Side Updates  
- [ ] Update route registration
- [ ] Update static file serving
- [ ] Update middleware configuration
- [ ] Update authentication flows
- [ ] Update API response URLs
- [ ] Test server-side routing

### Phase 4: Build Configuration
- [ ] Update Vite configuration
- [ ] Update Docker configuration
- [ ] Update proxy configurations
- [ ] Test build process
- [ ] Test deployment scenarios

### Phase 5: Testing & Documentation
- [ ] Create integration tests
- [ ] Create E2E tests
- [ ] Update deployment documentation
- [ ] Create migration guide
- [ ] Test all scenarios

## Troubleshooting Guide

### Common Issues

#### 1. Assets Not Loading
**Symptoms**: CSS, JS, or image files return 404
**Causes**: 
- Base path not configured in Vite
- Asset references using absolute paths
- Static file serving not configured for base path

**Solutions**:
- Verify `VITE_BASE_PATH` environment variable
- Check Vite `base` configuration
- Ensure static files are served at correct path

#### 2. API Calls Failing
**Symptoms**: API requests return 404 or CORS errors
**Causes**:
- Server routes not registered with base path
- Client API base URL misconfigured
- CORS configuration missing subpath origins

**Solutions**:
- Verify server `BASE_PATH` environment variable
- Check API client base URL configuration
- Update CORS allowed origins

#### 3. Authentication Issues
**Symptoms**: Login redirects fail, sessions not maintained
**Causes**:
- Cookie path not configured for subpath
- Authentication redirect URLs incorrect
- Session middleware not aware of base path

**Solutions**:
- Configure cookie path with base path
- Update authentication redirect URLs
- Verify session configuration

#### 4. Routing Issues
**Symptoms**: Page refreshes return 404, navigation breaks
**Causes**:
- React Router basename not configured
- Server SPA routing not handling subpath
- Link components using absolute paths

**Solutions**:
- Set React Router basename
- Update server SPA routing logic
- Use buildPath() for all navigation

## Security Considerations

### Path Traversal Prevention
- Validate base path configuration
- Sanitize user-provided paths
- Prevent `../` sequences in paths

### Cookie Security
- Set cookie path to base path
- Maintain secure cookie flags
- Prevent cookie leakage across subpaths

### CORS Configuration
- Update allowed origins for subpath
- Maintain strict CORS policies
- Validate Origin headers

## Performance Considerations

### Asset Optimization
- No performance impact from base path
- Asset bundling remains efficient
- CDN compatibility maintained

### API Performance
- No additional latency from path transformation
- Route resolution remains fast
- Caching strategies unaffected

### Memory Usage
- Minimal memory overhead
- Configuration loaded once at startup
- No runtime path computation overhead

This technical specification provides the complete blueprint for implementing subpath deployment support while maintaining security, performance, and backward compatibility.