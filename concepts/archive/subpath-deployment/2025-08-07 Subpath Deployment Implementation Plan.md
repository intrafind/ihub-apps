# Subpath Deployment Implementation Plan

## Executive Summary

This document outlines the comprehensive implementation strategy for enabling iHub Apps to be deployed at subpaths (e.g., `https://domain.com/ai-hub/`) rather than only at domain roots. The implementation introduces a configurable base path system that maintains backward compatibility while enabling flexible deployment scenarios.

## Business Objectives

- **Deployment Flexibility**: Enable deployment behind reverse proxies at arbitrary subpaths
- **Enterprise Integration**: Support integration into existing enterprise portals and websites
- **Multi-tenancy**: Allow multiple iHub instances on the same domain at different subpaths
- **Backward Compatibility**: Ensure existing root path deployments continue working unchanged

## User Stories

### Primary User Story
**As a DevOps engineer**, I want to deploy iHub Apps at a subpath like `/ai-hub/` so that I can integrate it into our existing enterprise portal without conflicts.

**Acceptance Criteria:**
- Application works correctly when deployed at any subpath
- All internal links and API calls resolve correctly
- Static assets load properly from the subpath
- Authentication and session management work seamlessly
- No breaking changes to existing root path deployments

### Secondary User Stories

**As a system administrator**, I want to configure the base path through environment variables so that I can deploy the same build artifact to different paths across environments.

**As an end user**, I want the application to function identically regardless of deployment path so that my workflow remains consistent.

## Technical Architecture Strategy

### 1. Configuration-Driven Base Path System

#### Environment Variables
```bash
# Primary configuration
VITE_BASE_PATH="/ai-hub"           # Client build-time base path
BASE_PATH="/ai-hub"                # Server runtime base path

# Alternative: Auto-detection approach
AUTO_DETECT_BASE_PATH=true         # Detect from request headers
```

#### Configuration Precedence
1. Environment variables (highest priority)
2. Configuration file settings
3. Auto-detection from request headers
4. Default root path `/` (fallback)

### 2. Base Path Abstraction Layer

#### Client-Side Utilities
```javascript
// New utility: /client/src/utils/basePath.js
export const getBasePath = () => {
  return import.meta.env.VITE_BASE_PATH || '';
};

export const buildPath = (path) => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${basePath}${cleanPath}`;
};

export const buildApiPath = (endpoint) => {
  const basePath = getBasePath();
  return `${basePath}/api${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
};
```

#### Server-Side Utilities
```javascript
// New utility: /server/utils/basePath.js
export const getBasePath = () => {
  return process.env.BASE_PATH || '';
};

export const buildServerPath = (path) => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${basePath}${cleanPath}`;
};
```

## Implementation Phases

### Phase 1: Core Infrastructure and Configuration
**Duration: 1-2 days**
**Dependencies: None**

#### Tasks:
1. **Create base path utility functions**
   - Client-side: `/client/src/utils/basePath.js`
   - Server-side: `/server/utils/basePath.js`
   - Shared constants and validation

2. **Update platform configuration schema**
   - Add `basePath` to `/contents/config/platform.json`
   - Update server configuration validation
   - Add environment variable processing

3. **Create configuration middleware**
   - Server middleware to inject base path into responses
   - Client-side context provider for base path

#### Success Criteria:
- Base path utilities are available and tested
- Configuration system recognizes base path settings
- Environment variables are processed correctly

### Phase 2: Client-Side Updates
**Duration: 2-3 days**
**Dependencies: Phase 1**

#### Tasks:
1. **Update React Router configuration**
   ```jsx
   // client/src/App.jsx
   import { getBasePath } from './utils/basePath';
   
   function App() {
     const basename = getBasePath();
     return (
       <BrowserRouter basename={basename}>
         {/* existing routes */}
       </BrowserRouter>
     );
   }
   ```

2. **Update API client base URLs**
   ```javascript
   // client/src/api/client.js
   import { buildApiPath } from '../utils/basePath';
   
   const API_URL = import.meta.env.VITE_API_URL || buildApiPath('');
   ```

3. **Update navigation and link components**
   - Replace hardcoded paths with `buildPath()` calls
   - Update React Router `Link` components
   - Update programmatic navigation calls

4. **Update asset references**
   - Update static asset paths in components
   - Update favicon and manifest references
   - Update any hardcoded asset URLs

#### Key Files to Update:
- `/client/src/App.jsx` - Router basename
- `/client/src/api/client.js` - API base URL
- `/client/src/shared/components/Layout.jsx` - Navigation links
- All component files using `Link` or `navigate()`
- `/client/index.html` - Asset references

#### Success Criteria:
- Client-side routing works with base path
- API calls resolve to correct URLs
- Static assets load properly
- No hardcoded absolute paths remain in client code

### Phase 3: Server-Side Updates
**Duration: 2-3 days**
**Dependencies: Phase 2**

#### Tasks:
1. **Update Express route registration**
   ```javascript
   // server/routes/index.js
   import { buildServerPath } from '../utils/basePath.js';
   
   export function registerRoutes(app) {
     const basePath = getBasePath();
     app.use(buildServerPath('/api'), apiRoutes);
     app.use(buildServerPath('/docs'), docsRoutes);
   }
   ```

2. **Update static file serving**
   ```javascript
   // server/routes/staticRoutes.js
   import { buildServerPath } from '../utils/basePath.js';
   
   app.use(buildServerPath('/uploads'), express.static(uploadsPath));
   ```

3. **Update middleware and authentication**
   - Update CORS configuration for subpath origins
   - Update session management for subpath cookies
   - Update authentication redirect URLs

4. **Update API response URLs**
   - Update any URLs returned in API responses
   - Update file upload URLs
   - Update shortlink generation

#### Key Files to Update:
- `/server/server.js` - Main route registration
- `/server/routes/staticRoutes.js` - Static file serving
- `/server/middleware/setup.js` - CORS and middleware setup
- `/server/routes/auth.js` - Authentication redirects
- `/server/shortLinkManager.js` - URL generation

#### Success Criteria:
- Server routes respond at correct subpaths
- Static files serve from correct URLs
- Authentication works with subpath cookies
- API responses contain correct URLs

### Phase 4: Build and Deployment Updates
**Duration: 1 day**
**Dependencies: Phase 3**

#### Tasks:
1. **Update Vite configuration**
   ```javascript
   // client/vite.config.js
   export default defineConfig({
     base: process.env.VITE_BASE_PATH || '/',
     // ... existing config
   });
   ```

2. **Update Docker configuration**
   ```dockerfile
   # docker/Dockerfile
   ARG BASE_PATH=""
   ENV BASE_PATH=$BASE_PATH
   ENV VITE_BASE_PATH=$BASE_PATH
   ```

3. **Update build scripts**
   - Update production build process
   - Update development server configuration
   - Update deployment scripts

4. **Update reverse proxy examples**
   - Nginx configuration examples
   - Apache configuration examples
   - Docker Compose with reverse proxy

#### Key Files to Update:
- `/client/vite.config.js` - Build base path
- `/docker/Dockerfile` - Environment variables
- `/docker/docker-compose.yml` - Environment configuration
- Build and deployment scripts

#### Success Criteria:
- Build process respects base path configuration
- Docker images work with subpath deployment
- Development server supports subpath testing
- Reverse proxy configurations are documented

### Phase 5: Documentation and Testing
**Duration: 1-2 days**
**Dependencies: Phase 4**

#### Tasks:
1. **Create deployment documentation**
   - Subpath deployment guide
   - Reverse proxy configuration examples
   - Troubleshooting guide

2. **Update existing documentation**
   - Installation guide updates
   - Docker deployment guide
   - Configuration reference

3. **Create automated tests**
   - Integration tests for subpath deployment
   - E2E tests with different base paths
   - Configuration validation tests

4. **Create deployment examples**
   - Docker Compose with Nginx reverse proxy
   - Kubernetes ingress examples
   - Traditional server deployment examples

#### Success Criteria:
- Complete documentation for subpath deployment
- Automated tests verify subpath functionality
- Example configurations work out-of-the-box
- Migration guide for existing deployments

## Technical Specifications

### Configuration Schema

#### Environment Variables
```bash
# Client build-time configuration
VITE_BASE_PATH="/ai-hub"              # Base path for client assets and routing

# Server runtime configuration  
BASE_PATH="/ai-hub"                   # Base path for server routes
AUTO_DETECT_BASE_PATH=false           # Enable header-based path detection
BASE_PATH_HEADER="X-Forwarded-Prefix" # Header name for auto-detection
```

#### Platform Configuration
```json
{
  "deployment": {
    "basePath": "/ai-hub",
    "autoDetect": false,
    "headerName": "X-Forwarded-Prefix"
  }
}
```

### API Changes

#### New Utility Functions
```javascript
// Client-side
export function getBasePath(): string
export function buildPath(path: string): string  
export function buildApiPath(endpoint: string): string
export function buildAssetPath(asset: string): string

// Server-side
export function getBasePath(): string
export function buildServerPath(path: string): string
export function buildPublicUrl(path: string): string
```

#### Configuration Context
```jsx
// New React context for base path
export const BasePathContext = React.createContext({
  basePath: '',
  buildPath: (path) => path,
  buildApiPath: (endpoint) => endpoint
});
```

### Backward Compatibility

#### Compatibility Matrix
| Configuration | Behavior | Impact |
|--------------|----------|---------|
| No base path set | Works as root path deployment | No change |
| Base path = "/" | Works as root path deployment | No change |
| Base path = "/subpath" | Works as subpath deployment | New functionality |
| Invalid base path | Falls back to root path + warning | Graceful degradation |

#### Migration Strategy
1. **Existing deployments**: No changes required, continue working
2. **New subpath deployments**: Set environment variables
3. **Mixed environments**: Use different environment configurations

## Risk Mitigation

### Potential Issues and Solutions

#### 1. Asset Loading Failures
**Risk**: Static assets fail to load from subpath
**Mitigation**: 
- Comprehensive testing of asset paths
- Fallback asset loading strategies
- Clear error messages for misconfiguration

#### 2. Authentication Cookie Issues
**Risk**: Authentication breaks with subpath cookies
**Mitigation**:
- Update cookie path configuration
- Test authentication flows thoroughly
- Provide configuration examples

#### 3. API CORS Problems
**Risk**: CORS issues with subpath deployments
**Mitigation**:
- Update CORS configuration for subpaths
- Document reverse proxy CORS settings
- Provide troubleshooting guide

#### 4. SEO and Deep Linking
**Risk**: Deep links break with subpath deployment
**Mitigation**:
- Test all application routes
- Update sitemap generation if applicable
- Document URL structure changes

#### 5. Third-party Integration Issues  
**Risk**: External integrations break with URL changes
**Mitigation**:
- Audit all external integrations
- Update OAuth redirect URLs
- Provide migration checklist

### Testing Strategy

#### Unit Tests
- Base path utility functions
- URL building and validation
- Configuration parsing

#### Integration Tests
- API endpoint resolution
- Authentication flows
- File upload/download

#### End-to-End Tests
- Full application workflow with subpath
- Multi-environment deployment testing
- Browser compatibility testing

#### Performance Tests
- No performance regression with base path
- Asset loading performance
- API response time validation

## Acceptance Criteria

### Functional Requirements

#### Must Have
- [ ] Application works correctly when deployed at any subpath
- [ ] All internal navigation resolves correctly
- [ ] API calls work from subpath deployment
- [ ] Static assets load properly
- [ ] Authentication and sessions work seamlessly
- [ ] File uploads/downloads work correctly
- [ ] No breaking changes to root path deployments

#### Should Have
- [ ] Auto-detection of base path from reverse proxy headers
- [ ] Comprehensive deployment documentation
- [ ] Docker configuration examples
- [ ] Performance equivalent to root path deployment

#### Could Have
- [ ] Admin interface for base path configuration
- [ ] Runtime base path changes without restart
- [ ] Multi-tenancy support with different subpaths

### Non-Functional Requirements

#### Performance
- No more than 5% performance degradation
- Asset loading time unchanged
- API response time unchanged

#### Security
- Authentication security maintained
- Cookie security with subpath deployment
- CORS configuration remains secure

#### Compatibility
- Support for all major reverse proxy solutions
- Backward compatibility with existing deployments
- Browser compatibility unchanged

## Success Metrics

### Technical Metrics
- All automated tests pass
- Zero regression issues in existing deployments
- Successful deployment at various subpaths

### User Experience Metrics
- Application functionality identical at subpath
- No increase in support tickets
- Positive feedback from deployment teams

### Business Metrics
- Increased deployment flexibility
- Reduced integration complexity
- Support for more enterprise scenarios

## Implementation Dependencies

### External Dependencies
- No new external libraries required
- Compatible with current React Router version
- Works with existing Express.js setup

### Internal Dependencies
- Requires coordination between frontend and backend changes
- Configuration system updates needed
- Documentation updates required

### Infrastructure Dependencies
- No infrastructure changes required
- Compatible with existing deployment pipelines
- Works with current Docker configuration

## Post-Implementation Tasks

### Documentation Updates
- Update all deployment guides
- Create subpath-specific examples
- Update troubleshooting documentation

### Training and Communication
- Brief development team on new patterns
- Update deployment procedures
- Communicate changes to operations teams

### Monitoring and Maintenance
- Monitor subpath deployments for issues
- Collect feedback from deployment teams
- Plan future enhancements based on usage

## Conclusion

This implementation plan provides a systematic approach to enabling subpath deployment for iHub Apps while maintaining backward compatibility and ensuring robust functionality. The phased approach minimizes risk while providing clear milestones for progress tracking.

The solution is designed to be configuration-driven, maintainable, and extensible for future deployment scenarios while requiring minimal changes to existing code patterns.