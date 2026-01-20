# NTLM Authentication Flow - Detailed Technical Reference

## Development Environment: localhost:3000 ↔ localhost:5173

### Port Configuration

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser Address Bar: http://localhost:5173 (user sees this)         │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Vite Dev Server     │
                    │  (localhost:5173)    │
                    │                      │
                    │  - React App         │
                    │  - Hot reload        │
                    │  - Proxies /api/*    │
                    └──────────┬───────────┘
                               │
                    HTTP Request to /api/* endpoints
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Express Server       │
                    │ (localhost:3000)     │
                    │                      │
                    │ - Authentication     │
                    │ - API endpoints      │
                    │ - Middleware chain   │
                    └──────────────────────┘

CRITICAL HEADERS FOR VITE PROXY:
- req.headers.origin = "http://localhost:5173"
- req.headers.referer = "http://localhost:5173/..."
```

### NTLM Skip in Vite Proxy (Development Only)

**Code Location**: `/server/middleware/ntlmAuth.js` (lines 237-254)

```javascript
const isViteProxy =
  skipNtlmForVite &&                                    // Controlled by env var
  process.env.NODE_ENV === 'development' &&            // Only in dev mode
  (req.hostname === 'localhost' || req.hostname === '127.0.0.1') &&
  (req.headers.origin?.includes('5173') ||             // Check origin header
   req.headers.referer?.includes('5173'));             // Check referer header

if (isViteProxy) {
  return next();  // SKIP NTLM PROCESSING
}
```

**Why NTLM is Skipped:**

NTLM requires multiple round trips (challenge-response):

```
Round 1: Browser --> Server
  Request Header: GET /api/auth/status
  Response: 401 + WWW-Authenticate: NTLM (Type 1 Message)
  
Round 2: Browser --> Server  
  Request Header: Authorization: NTLM (Type 2 Message)
  Response: 401 + WWW-Authenticate: NTLM (Type 2 Response)
  
Round 3: Browser --> Server
  Request Header: Authorization: NTLM (Type 3 Message)
  Response: 200 OK (Authenticated!)
```

Vite's HTTP proxy may not preserve:
- Connection state across requests
- Proper NTLM negotiation headers
- Multipart authentication flow

**Solution**: Vite skips NTLM by default. For testing with NTLM:
```bash
SKIP_NTLM_VITE_PROXY=false npm run dev
```

---

## NTLM Configuration Details

### Minimal Configuration

```json
{
  "ntlmAuth": {
    "enabled": true
  }
}
```

**Result**: Works, but:
- No group retrieval (requires domain controller)
- No domain specified
- Default auth type: "ntlm"

### Complete Production Configuration

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "EXAMPLE.COM",
    "domainController": "ldap://dc.example.com:389",
    "type": "ntlm",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "defaultGroups": ["ntlm-users", "authenticated"],
    "sessionTimeoutMinutes": 480,
    "generateJwtToken": true,
    "domainControllerUser": "${NTLM_LDAP_USER}",
    "domainControllerPassword": "${NTLM_LDAP_PASSWORD}"
  }
}
```

### Configuration Field Reference

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `enabled` | boolean | Yes | false | Enable/disable NTLM auth |
| `domain` | string | No | - | Windows domain name (e.g., "EXAMPLE") |
| `domainController` | string | No | - | LDAP server URL for group queries (ldap://...) |
| `type` | string | No | "ntlm" | "ntlm" or "negotiate" |
| `debug` | boolean | No | false | Enable debug logging |
| `getUserInfo` | boolean | No | true | Extract user info from token |
| `getGroups` | boolean | No | true | Query LDAP for groups |
| `defaultGroups` | array | No | [] | Groups to assign all NTLM users |
| `sessionTimeoutMinutes` | number | No | 480 | JWT token expiration (8 hours) |
| `generateJwtToken` | boolean | No | true | Generate JWT for API access |
| `domainControllerUser` | string | No | - | LDAP bind DN (for group queries) |
| `domainControllerPassword` | string | No | - | LDAP bind password |
| `name` | string | No | "ntlm" | Internal provider name |
| `options` | object | No | {} | Additional options for express-ntlm |

---

## Request Flow: Step-by-Step

### Step 1: Initial Request

```
Browser makes request from http://localhost:5173/apps/chat

GET /api/auth/status HTTP/1.1
Host: localhost:3000
Origin: http://localhost:5173
Referer: http://localhost:5173/apps/chat
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
```

### Step 2: Vite Proxy Check

```javascript
// NTLM Middleware checks:
const isViteProxy = 
  req.headers.origin?.includes('5173') ||  // ✓ TRUE
  req.headers.referer?.includes('5173');   // ✓ TRUE

if (isViteProxy && SKIP_NTLM_VITE_PROXY) {
  return next();  // ✓ SKIP NTLM
}
```

**Result**: NTLM skipped, request continues to next middleware

### Step 3: JWT Middleware

```javascript
// Check for token in cookie
const token = req.cookies?.authToken;
// or header
const token = req.headers.authorization?.substring(7);

if (token) {
  const decoded = jwt.verify(token, jwtSecret);
  req.user = reconstructUserFromToken(decoded);
  return next();
}

// No token, continue as anonymous
return next();
```

### Step 4: Route Handler

```javascript
app.get('/api/auth/status', (req, res) => {
  // req.user is undefined if no token
  // Return available auth methods
  res.json({
    authenticated: false,
    authMethods: {
      ntlm: { enabled: true, domain: "EXAMPLE.COM" }
    }
  });
});
```

---

## Production Environment: Browser Direct to Server

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ User's Windows Browser (on domain EXAMPLE.COM)                │
│                                                              │
│ Windows Credentials: user@EXAMPLE.COM (cached in browser)  │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   │ HTTPS Request
                   │ (with NTLM negotiation capability)
                   ▼
         ┌──────────────────────┐
         │ Reverse Proxy        │
         │ (nginx, Apache, etc) │
         │                      │
         │ Port: 443 (HTTPS)    │
         └────────┬─────────────┘
                  │
                  │ HTTP or HTTPS
                  │ (proxy to backend)
                  ▼
         ┌──────────────────────┐
         │ Express Server       │
         │ (localhost:3000)     │
         │                      │
         │ NTLM Middleware      │
         │ (NOT SKIPPED)        │
         └──────────────────────┘
```

### NTLM Negotiation (3-step)

#### Request 1: Initial Request

```http
GET https://yourdomain.com/apps/chat HTTP/1.1
Host: yourdomain.com
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
```

**Server NTLM Middleware Response:**

```javascript
// express-ntlm sends 401 challenge
res.status(401);
res.setHeader('WWW-Authenticate', 'NTLM');
res.end();
```

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: NTLM
```

#### Request 2: Browser Sends NTLM Type 1 (Challenge Request)

```javascript
// Browser automatically includes:
Authorization: NTLM <base64-encoded-type-1-message>
```

**Server processes Type 1 message, responds with Type 2:**

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: NTLM <base64-encoded-type-2-message>
```

#### Request 3: Browser Sends NTLM Type 3 (Signature)

```javascript
// Browser includes Windows credentials (encrypted):
Authorization: NTLM <base64-encoded-type-3-message>
```

**Server validates Type 3 against domain controller:**

```javascript
// In ntlmAuthMiddleware
const ntlmMiddleware = getNtlmMiddleware(ntlmAuth);
ntlmMiddleware(req, res, (err) => {
  if (req.ntlm && req.ntlm.Authenticated) {
    // User authenticated!
    const user = processNtlmUser(req, ntlmAuth);
    req.user = user;
  }
});
```

**Server responds with authenticated content:**

```http
HTTP/1.1 200 OK
Set-Cookie: authToken=<jwt>; HttpOnly; Secure; SameSite=Lax
```

---

## Group Extraction Process

### Group Retrieval Flow

```
1. NTLM Middleware Initialized
   └─ createNtlmMiddleware(ntlmConfig)
   
2. Pass LDAP Credentials to express-ntlm
   const options = {
     domaincontroller: "ldap://dc.example.com:389",
     domaincontrolleruser: "CN=Service,OU=Users,DC=example,DC=com",
     domaincontrollerpassword: "password",
     getGroups: true
   }
   
3. After User Authentication
   └─ req.ntlm.Authenticated = true
   
4. Extract Groups from NTLM Object
   if (req.ntlm.groups) {
     groups = req.ntlm.groups;  // Array of group names
   }
   
5. Map Groups Using groups.json Configuration
   const mappedGroups = mapExternalGroups(groups);
   // Example mapping:
   // "Domain Users" --> "domain-users"
   // "IT-Admin" --> "admin"
   
6. Add Default Groups
   mappedGroups.push(...defaultGroups);
   
7. Create User Object
   user.groups = mappedGroups;
   
8. Enhance with Inheritance
   user = enhanceUserGroups(user, authConfig, ntlmAuth);
   // Resolves group hierarchy
   // Example: admin -> users -> authenticated -> anonymous
   
9. Generate JWT (if enabled)
   const token = generateJwt(user, {
     authMode: 'ntlm',
     additionalClaims: { domain: user.domain }
   });
```

### LDAP Query Details (Behind Scenes)

```javascript
// What express-ntlm does with LDAP credentials:

// 1. Bind as service account
const ldapBind = new LDAP({
  url: "ldap://dc.example.com:389",
  adminDn: "CN=Service,OU=Users,DC=example,DC=com",
  adminPassword: "password"
});

// 2. Search for user's groups
const userDN = `CN=${username},OU=Users,DC=example,DC=com`;
const groupSearchFilter = `(member=${userDN})`;
const groupsResult = ldapBind.search({
  base: "dc=example,dc=com",
  filter: groupSearchFilter
});

// 3. Extract group names
const groups = groupsResult.map(entry => entry.cn);
// Result: ["Domain Users", "Engineers", "IT-Admin"]

// 4. Return in req.ntlm.Groups or req.ntlm.groups
req.ntlm.Groups = groups;
```

---

## Group Mapping Configuration

### groups.json Structure

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Administrators",
      "description": "Full system access",
      "inherits": ["users"],
      "mappings": ["Admins", "IT-Admin", "Operators"],
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      }
    },
    "users": {
      "id": "users",
      "name": "Users",
      "description": "Standard user access",
      "inherits": ["authenticated"],
      "mappings": ["Domain Users", "Employees"],
      "permissions": {
        "apps": ["translator", "summarizer", "chat"],
        "prompts": ["general", "writing"],
        "models": ["gpt-3.5-turbo", "gpt-4"],
        "adminAccess": false
      }
    }
  }
}
```

### Mapping Algorithm

```javascript
export function mapExternalGroups(externalGroups = []) {
  const groupsConfig = configCache.getGroupsConfiguration() || {};
  const groups = groupsConfig.groups || {};
  
  const mappedGroups = [];
  
  // Check each internal group's mappings
  for (const [groupId, groupConfig] of Object.entries(groups)) {
    const mappings = groupConfig.mappings || [];
    
    // If any external group matches this group's mappings
    if (externalGroups.some(ext => mappings.includes(ext))) {
      mappedGroups.push(groupId);
    }
  }
  
  return mappedGroups;
}
```

**Example Mapping:**

```
External Groups from NTLM:    ["Domain Users", "Engineers", "IT-Admin"]
                                    │               │              │
                                    │               │              └──► matches "admin" mappings
                                    │               └──► no mapping found
                                    └──► matches "users" mappings

Result: mappedGroups = ["users", "admin"]
```

---

## JWT Token Generation

### Token Payload

```javascript
{
  // Standard claims
  iss: "ihub-apps",           // Issuer
  sub: "DOMAIN\\username",    // Subject (user ID)
  aud: "ihub-apps",           // Audience
  iat: 1700000000,            // Issued at
  exp: 1700001800,            // Expires at (30 minutes typical)
  jti: "unique-id",           // JWT ID
  
  // Custom claims
  authMode: "ntlm",           // Authentication method
  authProvider: "ntlm",       // Provider name
  username: "username",       // Username
  name: "User Name",          // Display name
  email: "user@example.com",  // Email address
  groups: ["users", "authenticated"], // User's groups
  permissions: {              // Resolved permissions
    apps: ["translator", "summarizer", "chat"],
    prompts: ["general", "writing"],
    models: ["gpt-3.5-turbo", "gpt-4"],
    tools: ["search"],
    sources: []
  },
  isAdmin: false,             // Admin flag
  
  // Additional NTLM-specific claims
  domain: "EXAMPLE.COM",      // Windows domain
  externalGroups: ["Domain Users", "IT-Admin"]  // Original LDAP groups
}
```

### Cookie vs Header

**HttpOnly Cookie (Preferred):**
```javascript
res.cookie('authToken', token, {
  httpOnly: true,              // Can't be accessed by JavaScript
  secure: production,          // HTTPS only in production
  sameSite: 'lax',            // CSRF protection
  maxAge: 30 * 60 * 1000      // 30 minutes in milliseconds
});
```

**Authorization Header (Legacy):**
```javascript
// Client sends with every request:
Authorization: Bearer <jwt>
```

---

## Troubleshooting Checklist

### Problem: NTLM authentication not working

```
Check List:
1. ✓ Is NTLM enabled in platform.json?
   {"ntlmAuth": {"enabled": true}}

2. ✓ In development, is SKIP_NTLM_VITE_PROXY set correctly?
   export SKIP_NTLM_VITE_PROXY=false  // to test NTLM

3. ✓ Is the server running on localhost:3000?
   npm run dev  // or npm run start:prod

4. ✓ Are you accessing from the right origin?
   Dev: http://localhost:5173 (through Vite proxy)
   Prod: https://yourdomain.com

5. ✓ Is the browser on a Windows domain?
   Verify: whoami /all (shows domain info)

6. ✓ Check server logs:
   [NTLM Debug] Request: { url, hostname, origin }
```

### Problem: Groups not retrieved

```
Check List:
1. ✓ Is domainController configured?
   {"domainController": "ldap://dc.example.com:389"}

2. ✓ Are LDAP credentials set?
   NTLM_LDAP_USER=CN=Service,OU=Users,DC=example,DC=com
   NTLM_LDAP_PASSWORD=password

3. ✓ Is getGroups enabled?
   {"getGroups": true}

4. ✓ Can the server reach the domain controller?
   telnet dc.example.com 389

5. ✓ Check server logs for LDAP errors:
   [NTLM Auth] LDAP bind failed: ...
   [NTLM Auth] Group retrieval failed: ...

6. ✓ Verify group mappings in groups.json
   Check if external group names match "mappings" field
```

### Problem: Token not being sent

```
Check List:
1. ✓ Is generateJwtToken enabled?
   {"generateJwtToken": true}

2. ✓ Is JWT_SECRET configured?
   JWT_SECRET=your-secret-key

3. ✓ Is the cookie being set?
   Check browser DevTools > Application > Cookies
   Look for "authToken" cookie

4. ✓ Is axios configured with credentials?
   const apiClient = axios.create({
     withCredentials: true
   });

5. ✓ Check server logs:
   [NTLM Auth] JWT token generation failed: ...
```

---

## Quick Reference

### Files to Review

```
Server-Side NTLM:
  /server/middleware/ntlmAuth.js         (NTLM middleware)
  /server/middleware/setup.js             (Middleware chain)
  /server/routes/auth.js                  (Login endpoints)
  /server/utils/authorization.js          (Group mapping)

Client-Side:
  /client/src/api/client.js               (API client config)
  /client/src/utils/runtimeBasePath.js    (Base path detection)

Configuration:
  contents/config/platform.json           (NTLM settings)
  contents/config/groups.json             (Group hierarchy)

Documentation:
  /docs/ldap-ntlm-authentication.md       (User docs)
```

### Key Configuration Environment Variables

```bash
# NTLM Group Retrieval
NTLM_LDAP_USER="CN=Service,OU=Users,DC=example,DC=com"
NTLM_LDAP_PASSWORD="password123"

# JWT Token Generation
JWT_SECRET="secret-key-min-32-chars"

# Development NTLM Testing
SKIP_NTLM_VITE_PROXY=false

# Base Path (subpath deployment)
BASE_PATH=/ai-hub
```

---

## Summary Table

| Component | Port | Protocol | Purpose |
|-----------|------|----------|---------|
| Vite Dev Server | 5173 | HTTP | React frontend, proxies /api/* |
| Express Server | 3000 | HTTP | Backend API, authentication |
| Domain Controller | 389 | LDAP | User verification, group lookup |
| Reverse Proxy | 443 | HTTPS | Production frontend, TLS termination |

