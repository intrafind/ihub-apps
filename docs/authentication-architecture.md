# iHub Apps Authentication Architecture Analysis

## Overview

iHub Apps implements a sophisticated, multi-layered authentication system that supports:
- **Anonymous access** (no authentication)
- **Local authentication** (username/password)
- **LDAP authentication** (directory services)
- **NTLM/Windows authentication** (integrated Windows authentication)
- **OIDC/OAuth2** (OpenID Connect providers)
- **Proxy authentication** (reverse proxy headers)
- **JWT-based tokens** (stateless API authentication)

The system is designed for enterprise environments with flexible deployment options, including subpath deployment and base URL handling.

---

## Key Architecture Components

### 1. Server-Side Entry Point

**File**: `/server/server.js`

The server initializes in this order:
1. Load platform configuration from `contents/config/platform.json`
2. Initialize configuration cache
3. Register middleware via `setupMiddleware(app, platformConfig)`
4. Register authentication routes (`/api/auth/*`)
5. Register API routes with base path support

### 2. Middleware Setup & Chain

**File**: `/server/middleware/setup.js`

The authentication middleware chain is configured in `setupMiddleware()`:

```javascript
app.use(
  createAuthChain([
    proxyAuth,              // Step 1: Check proxy headers
    teamsAuthMiddleware,    // Step 2: Teams authentication
    jwtAuthMiddleware,      // Step 3: JWT token validation
    localAuthMiddleware,    // Step 4: Local auth placeholder
    ldapAuthMiddleware,     // Step 5: LDAP auth placeholder
    ntlmAuthMiddleware      // Step 6: NTLM/Windows auth
  ])
);
```

**Critical Detail**: The middleware chain is wrapped in `createAuthChain()` which:
- Skips auth for static assets and SPA routes
- Runs middleware in sequence until one sets `req.user`
- Allows middleware to silently pass (not setting `req.user`) for optional authentication

After the auth chain completes, a final middleware enhances the user with permissions:
```javascript
app.use((req, res, next) => {
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
  }
  next();
});
```

---

## Authentication Flows by Method

### Authentication Method 1: NTLM (Windows Integrated Authentication)

**Files**: 
- `/server/middleware/ntlmAuth.js`
- `/server/routes/auth.js` (POST /api/auth/ntlm/login)
- `/docs/ldap-ntlm-authentication.md`

#### NTLM Configuration

Add to `contents/config/platform.json`:

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "EXAMPLE",
    "domainController": "ldap://dc.example.com:389",
    "type": "ntlm",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "defaultGroups": ["ntlm-users"],
    "sessionTimeoutMinutes": 480,
    "generateJwtToken": true,
    "domainControllerUser": "${NTLM_LDAP_USER}",
    "domainControllerPassword": "${NTLM_LDAP_PASSWORD}"
  }
}
```

#### NTLM Authentication Flow

1. **Request arrives at server**
   - Client browser makes HTTP request to `localhost:3000` (in dev)
   - Request includes Windows credentials in NTLM negotiation

2. **NTLM Middleware Processing** (`ntlmAuthMiddleware`)
   
   a. **Vite Proxy Skip Logic** (Development Only)
   ```javascript
   // SKIP NTLM for Vite proxy in development to avoid authentication loops
   const isViteProxy = 
     process.env.NODE_ENV === 'development' &&
     (req.headers.origin?.includes('5173') || req.headers.referer?.includes('5173'));
   
   if (isViteProxy && skipNtlmForVite) {
     return next(); // Skip NTLM for Vite requests
   }
   ```
   **Why?** NTLM requires multiple round trips with specific headers. Vite's dev proxy doesn't handle this well.

   b. **Express-NTLM Middleware Invocation**
   ```javascript
   const ntlmMiddleware = getNtlmMiddleware(ntlmAuth);
   ntlmMiddleware(req, res, (err) => {
     // express-ntlm populates req.ntlm if authenticated
     // may send 401 challenge with WWW-Authenticate header
   });
   ```

   c. **User Object Creation**
   ```javascript
   const user = processNtlmUser(req, ntlmAuth); // Extracts data from req.ntlm
   user = enhanceUserGroups(user, authConfig, ntlmAuth); // Adds group inheritance
   req.user = user;
   ```

   d. **Optional JWT Generation**
   ```javascript
   if (ntlmAuth.generateJwtToken) {
     const { token, expiresIn } = generateJwt(user, {
       authMode: 'ntlm',
       expiresInMinutes: sessionTimeout
     });
     res.cookie('authToken', token, {
       httpOnly: true,
       secure: process.env.NODE_ENV === 'production',
       sameSite: 'lax'
     });
   }
   ```

3. **NTLM Challenge-Response (if not authenticated)**
   - express-ntlm sends HTTP 401 with `WWW-Authenticate: NTLM` header
   - Browser responds with NTLM negotiation token
   - Server validates against domain controller LDAP

4. **Group Extraction**
   - `getNtlmMiddleware()` receives NTLM config with domain controller
   - `domainControllerUser` and `domainControllerPassword` used for LDAP bind
   - `getGroups: true` triggers LDAP query for user's group membership
   - Groups extracted from `req.ntlm.Groups` or `req.ntlm.groups`

5. **Group Mapping**
   ```javascript
   const mappedGroups = mapExternalGroups(groups); // Uses groups.json mappings
   user.groups = mappedGroups;
   ```

#### NTLM in Development vs Production

**Development Mode** (`localhost:3000`):
```
Client (5173) --HTTP--> Vite Proxy --skips NTLM--> Server (3000)
    └─ If SKIP_NTLM_VITE_PROXY=false, NTLM goes through
```

**Production Mode**:
```
Client Browser --HTTPS--> Server (with NTLM challenge-response)
    └─ Browser handles NTLM negotiation automatically
    └─ Works only in Windows environments
    └─ Requires domain controller accessibility
```

#### NTLM Group Retrieval

For groups to be retrieved:
1. **Domain Controller must be configured** (`domainController` in ntlmAuth)
2. **LDAP credentials required** (`domainControllerUser`, `domainControllerPassword`)
3. **Configuration passed to express-ntlm**:
   ```javascript
   const options = {
     domain: ntlmAuth.domain,
     domaincontroller: ntlmAuth.domainController,
     domaincontrolleruser: ldapUser,       // For LDAP bind
     domaincontrollerpassword: ldapPassword,
     getGroups: true
   };
   ```

---

### Authentication Method 2: Proxy Authentication

**Files**: `/server/middleware/proxyAuth.js`

#### Configuration

```json
{
  "proxyAuth": {
    "enabled": true,
    "userHeader": "x-forwarded-user",
    "groupsHeader": "x-forwarded-groups",
    "jwtProviders": [
      {
        "name": "external-provider",
        "header": "authorization",
        "jwkUrl": "https://auth.example.com/.well-known/jwks.json",
        "issuer": "https://auth.example.com",
        "audience": "api"
      }
    ]
  }
}
```

#### Flow

1. Reverse proxy (nginx, Apache, etc.) sets headers:
   - `X-Forwarded-User: username`
   - `X-Forwarded-Groups: group1,group2,group3`
   - `Authorization: Bearer <token>` (optional, for JWT validation)

2. Server extracts user from headers
3. JWT tokens validated if jwtProviders configured
4. User enhanced with permissions based on groups

---

### Authentication Method 3: Local Authentication

**Files**: `/server/middleware/localAuth.js`

#### Configuration

```json
{
  "localAuth": {
    "enabled": true,
    "usersFile": "contents/config/users.json",
    "showDemoAccounts": true,
    "sessionTimeoutMinutes": 480
  }
}
```

#### Flow

1. **POST /api/auth/login**
   ```javascript
   {
     "username": "user123",
     "password": "password123"
   }
   ```

2. **Server authenticates** against users.json
3. **JWT token generated**
4. **HttpOnly cookie set**: `authToken`
5. **Token returned** in response for backward compatibility

#### JWT Token Structure

```javascript
{
  sub: "username",          // User ID
  id: "username",
  username: "username",
  name: "User Name",
  email: "user@example.com",
  groups: ["authenticated", "users"],
  authMode: "local",
  iat: <timestamp>,
  exp: <timestamp>,
  iss: "ihub-apps",
  maxAge: "7d"
}
```

---

### Authentication Method 4: LDAP Authentication

**Files**: `/server/middleware/ldapAuth.js`

#### Configuration

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "displayName": "Corporate LDAP",
        "url": "ldap://ldap.example.com:389",
        "adminDn": "${LDAP_ADMIN_DN}",
        "adminPassword": "${LDAP_ADMIN_PASSWORD}",
        "userSearchBase": "ou=people,dc=example,dc=org",
        "usernameAttribute": "uid",
        "userDn": "uid={{username}},ou=people,dc=example,dc=org",
        "groupSearchBase": "ou=groups,dc=example,dc=org",
        "groupClass": "groupOfNames",
        "defaultGroups": ["ldap-users"],
        "sessionTimeoutMinutes": 480
      }
    ]
  }
}
```

#### Flow

1. **POST /api/auth/ldap/login**
   ```javascript
   {
     "username": "john.doe",
     "password": "password123",
     "provider": "corporate-ldap"
   }
   ```

2. **LDAP authentication** using `ldap-authentication` library
3. **Group extraction** from LDAP directory
4. **JWT token generated** with groups
5. **HttpOnly cookie set**

---

## Client-Side Authentication

### API Client Configuration

**Files**: 
- `/client/src/api/client.js`
- `/client/src/utils/runtimeBasePath.js`

#### Dynamic Base Path Detection

The client detects the base path at runtime:

```javascript
// client/src/utils/runtimeBasePath.js
export const detectBasePath = () => {
  const pathname = window.location.pathname;
  let basePath = pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  
  const knownRoutes = ['/apps', '/admin', '/auth', '/login', '/chat', '/pages', '/s/'];
  for (const route of knownRoutes) {
    const routeIndex = basePath.indexOf(route);
    if (routeIndex > 0) {
      basePath = basePath.substring(0, routeIndex);
      break;
    }
  }
  
  return basePath;
};
```

**Why?** Allows the same build to run at any subpath without build-time configuration.

#### API Client Setup

```javascript
// client/src/api/client.js
const API_URL = import.meta.env.VITE_API_URL || buildApiUrl('');

const apiClient = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  withCredentials: true,  // CRITICAL for NTLM & cookies
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request interceptor
apiClient.interceptors.request.use(config => {
  const authToken = localStorage.getItem('authToken');
  if (authToken) {
    config.headers['Authorization'] = `Bearer ${authToken}`;
  }
  return config;
});
```

#### Token Handling

**Preferred**: HttpOnly cookies (set by server)
- Browser sends automatically with every request
- Not accessible to JavaScript (more secure)
- Used for streaming requests (SSE)

**Fallback**: LocalStorage (backward compatibility)
- Stored manually by legacy code
- Accessible to JavaScript
- Sent as `Authorization: Bearer <token>` header

---

## JWT Authentication Middleware

**File**: `/server/middleware/jwtAuth.js`

### How JWT Validation Works

1. **Token Source Detection** (in order of preference):
   - HttpOnly cookie (`req.cookies.authToken`)
   - Authorization header (`Authorization: Bearer <token>`)

2. **Token Validation**:
   ```javascript
   const decoded = jwt.verify(token, jwtSecret, {
     issuer: 'ihub-apps',
     maxAge: '7d'
   });
   ```

3. **User Object Reconstruction** (depends on `authMode`):
   ```javascript
   // For local auth tokens
   if (decoded.authMode === 'local') {
     user = {
       id: decoded.sub || decoded.username,
       username: decoded.username,
       name: decoded.name,
       email: decoded.email,
       groups: decoded.groups,
       authMode: 'local'
     };
   }
   
   // For LDAP tokens
   else if (decoded.authMode === 'ldap') {
     user = {
       id: decoded.username,
       name: decoded.name || decoded.displayName,
       email: decoded.email || decoded.mail,
       groups: decoded.groups,
       authMode: 'ldap'
     };
   }
   ```

4. **req.user Set** for downstream middleware

---

## Authorization & Permission System

**File**: `/server/utils/authorization.js`

### Group Inheritance System

Groups are hierarchical with inheritance:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "inherits": ["users"],
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      }
    },
    "users": {
      "id": "users",
      "inherits": ["authenticated"],
      "permissions": {
        "apps": ["translator", "summarizer"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gpt-4"],
        "adminAccess": false
      }
    },
    "authenticated": {
      "id": "authenticated",
      "inherits": ["anonymous"],
      "permissions": {}
    },
    "anonymous": {
      "id": "anonymous",
      "permissions": {
        "apps": ["public-chat"]
      }
    }
  }
}
```

### Inheritance Resolution

At server startup:
```javascript
const resolvedGroups = resolveGroupInheritance(groupsConfig);
```

1. **Circular Dependency Detection**: Throws error if cycles detected
2. **Permission Merging**: Child groups merge parent permissions
3. **Caching**: Resolved groups cached for runtime performance

### User Permission Enhancement

After authentication:
```javascript
const authConfig = platformConfig.auth || {};
req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
```

This adds to `req.user`:
- `permissions`: { apps, prompts, models, tools, sources }
- `isAdmin`: true/false
- Resolved group permissions

---

## Base Path & URL Handling

### Server-Side Base Path

**File**: `/server/utils/basePath.js`

```javascript
export const getBasePath = () => {
  let basePath = process.env.BASE_PATH || '';
  
  // Optional: Auto-detect from reverse proxy headers
  if (process.env.AUTO_DETECT_BASE_PATH === 'true' && global.currentRequest) {
    const detectedPath = global.currentRequest.headers['x-forwarded-prefix'];
    if (detectedPath && isValidBasePath(detectedPath)) {
      basePath = detectedPath;
    }
  }
  
  return basePath.endsWith('/') && basePath !== '/' ? basePath.slice(0, -1) : basePath;
};
```

Routes are built with base path:
```javascript
registerAuthRoutes(app, basePath);
// Results in: /subpath/api/auth/login (if basePath = '/subpath')
```

### Client-Side Base Path

**File**: `/client/src/utils/runtimeBasePath.js`

```javascript
// Detected at runtime from window.location.pathname
const API_URL = import.meta.env.VITE_API_URL || buildApiUrl(''); 
// Results in correct path automatically
```

---

## Development Environment (localhost:3000 & localhost:5173)

### Port Mapping

```
localhost:5173 (Vite Dev Server)
    ├─ Serves React components
    ├─ Proxies /api/* to localhost:3000
    └─ Proxies /auth/* to localhost:3000

localhost:3000 (Express Server)
    ├─ Serves API endpoints
    ├─ Serves static content (production fallback)
    └─ Runs authentication middleware
```

### Vite Proxy Configuration

Vite automatically proxies API requests to the server. NTLM is skipped through Vite proxy to avoid multi-step negotiation issues.

### CORS Configuration

**Development**: Automatically includes `localhost:3000` and `localhost:5173`
**Production**: Controlled via `ALLOWED_ORIGINS` environment variable

```json
{
  "cors": {
    "origin": ["http://localhost:3000", "http://localhost:5173", "${ALLOWED_ORIGINS}"],
    "credentials": true
  }
}
```

---

## Authentication Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        REQUEST ARRIVES                          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  setupMiddleware() Chain                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Is this a static asset request?                        │  │
│  │ /assets/*, /vite/*, /@vite/*, /*.js, /*.css, etc.     │  │
│  └────────────┬───────────────────────────────────────────┘  │
│               │ NO                                              │
│               ▼                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Run Auth Middleware Chain                  │  │
│  │                                                          │  │
│  │ 1. proxyAuth()        ─────► Check X-Forwarded-User   │  │
│  │      │ Sets req.user? ─► CONTINUE                       │  │
│  │      │ No user? ─────────┐                              │  │
│  │      ▼                     │                              │  │
│  │ 2. teamsAuthMiddleware()   │ Continue if no user      │  │
│  │      │ Sets req.user? ─► CONTINUE                       │  │
│  │      │ No? ───────────────┐                              │  │
│  │      ▼                     │                              │  │
│  │ 3. jwtAuthMiddleware()     │ Continue if no user      │  │
│  │      │ Cookie: authToken?  │                            │  │
│  │      │ Header: Bearer?     │                            │  │
│  │      │ Valid JWT? ────► req.user = decoded            │  │
│  │      │ No? ───────────────┐                              │  │
│  │      ▼                     │                              │  │
│  │ 4. localAuthMiddleware()   │ Continue if no user      │  │
│  │      │ (placeholder)       │                            │  │
│  │      ▼                     │                              │  │
│  │ 5. ldapAuthMiddleware()    │ Continue if no user      │  │
│  │      │ (placeholder)       │                            │  │
│  │      ▼                     │                              │  │
│  │ 6. ntlmAuthMiddleware()    │ Continue if no user      │  │
│  │      │                     │                            │  │
│  │      │ Is Vite proxy?      │                            │  │
│  │      │ (dev mode, 5173)    │                            │  │
│  │      │ ──► SKIP NTLM       │                            │  │
│  │      │ No ────────────┐    │                            │  │
│  │      ▼                │    │                            │  │
│  │      Apply express-ntlm middleware                     │  │
│  │      │                │    │                            │  │
│  │      │ NTLM Challenge?    │                            │  │
│  │      │ ──► 401 + WWW-Authenticate header              │  │
│  │      │ Authenticated?     │                            │  │
│  │      │ ──► processNtlmUser()                           │  │
│  │      │      │ Extract from req.ntlm                    │  │
│  │      │      │ Map external groups                      │  │
│  │      │      │ req.user = enhanced user                 │  │
│  │      │      ▼                                           │  │
│  │      │ Continue to next                                │  │
│  │      └────────┬───────────────────────────────────────┘  │
│  └──────────────┼──────────────────────────────────────────┘  │
│                 │                                              │
│                 ▼                                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │    Enhance User with Permissions (if req.user exists)   │  │
│  │    req.user = enhanceUserWithPermissions(...)           │  │
│  │    ├─ Add resolved group permissions                    │  │
│  │    ├─ Add isAdmin flag                                  │  │
│  │    └─ Cache for performance                             │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ROUTE HANDLER                                │
│         (uses req.user and req.user.permissions)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## CORS & Credentials

### CORS Headers for NTLM

```
Access-Control-Allow-Origin: http://localhost:3000
Access-Control-Allow-Credentials: true
Access-Control-Allow-Headers: Content-Type, Authorization, X-Forwarded-User, X-Forwarded-Groups
```

**Critical**: `credentials: true` in axios is required for NTLM to work:
```javascript
const apiClient = axios.create({
  withCredentials: true  // Must send cookies & auth headers
});
```

---

## Environment Variables

### Server Configuration

```bash
# Authentication
NTLM_LDAP_USER=CN=Service Account,OU=Users,DC=muc,DC=intrafind,DC=de
NTLM_LDAP_PASSWORD=password123
LDAP_ADMIN_PASSWORD=password123

# JWT
JWT_SECRET=your-secret-key

# Base Path
BASE_PATH=/subpath                    # Optional, for subpath deployment
AUTO_DETECT_BASE_PATH=false           # Optional, detect from reverse proxy
BASE_PATH_HEADER=x-forwarded-prefix   # Optional, header name for detection

# CORS
ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com

# Proxy Auth
PROXY_AUTH_ENABLED=false
PROXY_AUTH_USER_HEADER=x-forwarded-user
PROXY_AUTH_GROUPS_HEADER=x-forwarded-groups

# Development
NODE_ENV=development
SKIP_NTLM_VITE_PROXY=true             # Skip NTLM through Vite proxy in dev
```

### Client Configuration

```bash
# Development
VITE_API_URL=/api                     # Optional, defaults to runtime detection
```

---

## API Endpoints

### Authentication

- **POST /api/auth/login** - Local authentication
- **POST /api/auth/ldap/login** - LDAP authentication
- **POST /api/auth/ntlm/login** - NTLM authentication (requires Windows auth)
- **GET /api/auth/status** - Get auth status and available methods
- **GET /api/auth/user** - Get current user info
- **POST /api/auth/logout** - Clear authentication cookie
- **GET /api/auth/ntlm/status** - Get NTLM status
- **GET /api/auth/oidc/providers** - List OIDC providers
- **GET /api/auth/ldap/providers** - List LDAP providers

### Group-Protected Routes

Routes can be protected with authorization middleware:
```javascript
import { createAuthorizationMiddleware } from '../utils/authorization.js';

app.post('/api/admin/users', 
  createAuthorizationMiddleware({ requireAdmin: true }),
  handler
);
```

---

## Troubleshooting NTLM

### Issue: NTLM not working in development

**Solution**: NTLM is skipped through Vite proxy by default. To test:
```bash
SKIP_NTLM_VITE_PROXY=false npm run dev
```

### Issue: Groups not retrieved

**Cause**: Domain controller not configured or LDAP credentials missing

**Solution**:
1. Configure `domainController` in platform.json
2. Set `NTLM_LDAP_USER` and `NTLM_LDAP_PASSWORD` environment variables
3. Verify domain controller is accessible from the server

### Issue: NTLM on non-Windows server

**Limitation**: NTLM requires Windows Server (or Samba) for proper functionality
**Alternative**: Use LDAP authentication instead

---

## Summary

The iHub Apps authentication system is designed for enterprise flexibility:

1. **Multiple auth methods** coexist without conflicts
2. **Middleware chain** allows graceful fallback
3. **JWT tokens** provide stateless operation
4. **Group inheritance** creates flexible permission hierarchies
5. **Runtime base path detection** supports subpath deployment
6. **CORS support** enables secure cross-origin integration
7. **Development-friendly** with NTLM bypass for Vite proxy

The system properly handles the localhost:3000 (server) ↔ localhost:5173 (client) relationship through CORS, Vite proxying, and explicit credentials configuration.

