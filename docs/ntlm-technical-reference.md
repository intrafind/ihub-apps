---
description: "The NTLM authentication flow in detail, step by step."
audience: developer
type: reference
---

# NTLM Technical Reference

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

### NTLM Through the Vite Proxy (Development)

**Code Location**: `/client/vite.config.js` (connection-affine proxy agent)

NTLM authenticates a TCP connection, not a request. The handshake needs several round trips on the
same connection:

```
Round 1: Browser --> Server
  Request: GET /api/auth/ntlm/login
  Response: 401 + WWW-Authenticate: NTLM

Round 2: Browser --> Server
  Request Header: Authorization: NTLM <Type 1 message>
  Response: 401 + WWW-Authenticate: NTLM <Type 2 message>

Round 3: Browser --> Server
  Request Header: Authorization: NTLM <Type 3 message>
  Response: 302 to returnUrl?ntlm=success + Set-Cookie: authToken (signed in)
```

The Vite dev proxy keeps each browser connection on one upstream connection to the Express server,
so the handshake works through `npm run dev` without any flag. The handshake runs only on
`/api/auth/ntlm/login`; all other requests through the proxy are signed in by the `authToken`
session cookie.

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

**Result**: Not for production:
- No `domainController`: express-ntlm accepts every NTLM sign-in without checking the password
- No groups (they come only from `ldapGroupLookupProvider`)
- No domain specified

### Complete Production Configuration

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "EXAMPLE.COM",
    "domainController": "ldaps://dc.example.com:636",
    "debug": false,
    "ldapGroupLookupProvider": "corporate-ldap",
    "defaultGroups": ["ntlm-users", "authenticated"],
    "sessionTimeoutMinutes": 480
  }
}
```

### Configuration Field Reference

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `enabled` | boolean | Yes | false | Enable/disable NTLM auth |
| `domain` | string | No | - | Windows domain name (e.g., "EXAMPLE") |
| `domainController` | string | No | - | LDAP URL of the domain controller that checks the sign-in (`ldaps://...` recommended) |
| `debug` | boolean | No | false | Enable debug logging |
| `ldapGroupLookupProvider` | string | No | - | Entry in `ldapAuth.providers` that supplies the user's groups |
| `defaultGroups` | array | No | [] | Groups to assign all NTLM users |
| `sessionTimeoutMinutes` | number | No | 480 | Lifetime of the session cookie issued at sign-in (8 hours) |
| `name` | string | No | "ntlm" | Internal provider name |
| `options` | object | No | {} | Additional options for express-ntlm |

---

## Request Flow: Step-by-Step

The NTLM middleware runs the handshake only on `/api/auth/ntlm/login` (GET for the browser, POST
for API clients). Every other request is signed in by the `authToken` session cookie, the same way
as after a local, LDAP or OIDC sign-in. Each handshake is a logon at the domain controller, so a
wrong password counts as one failed logon, not one per API call.

### Step 1: Auth Status

```
Browser loads http://localhost:5173/apps/chat; the auth gate asks:

GET /api/auth/status HTTP/1.1
Host: localhost:3000
```

The NTLM middleware does nothing here (not the login path). Without a session cookie the request is
anonymous, and the response tells the client where to sign in:

```javascript
res.json({
  authenticated: false,
  autoRedirect: { provider: 'ntlm', url: '<basePath>/api/auth/ntlm/login' },
  authMethods: {
    ntlm: { enabled: true, domain: "EXAMPLE.COM" }
  }
});
```

`autoRedirect` is set for a signed-out browser when NTLM is the only enabled sign-in method
(anonymous off), or when the browser has the `ntlmRequested` cookie (it signed in with Windows
before; logout clears it). The client follows it without a click, the same mechanism as OIDC
`autoRedirect`, and also when the session cookie expires. With several methods enabled and no
`ntlmRequested` cookie, the user clicks "Windows sign-in" on the login screen.

### Step 2: NTLM Login

```javascript
// ntlmAuthMiddleware: only the login path runs the handshake
if (!ntlmAuth.enabled || !isNtlmLoginPath(req.path)) {
  return next();
}
// express-ntlm: 401 challenges until req.ntlm.Authenticated
```

The `GET /api/auth/ntlm/login?returnUrl=…` route then calls `processNtlmLogin()`, which looks up
groups, persists the user and issues the session token. The route sets the `authToken` and
`ntlmRequested=1` cookies and redirects to `returnUrl?ntlm=success`.

On any failure (domain controller rejected the logon, did not answer within 5 seconds, NTLM
disabled, cooldown after a rejection) GET redirects to `/?auth=error&message=…`, which the auth gate
shows on its login screen. POST answers JSON on success, and problem+json on failure with 403
(rejected), 429 (cooldown) or 503 (domain controller timeout).

After a rejection, the account's next NTLM answers are held back for 60 seconds (429) so they do
not count as further failed logons. This also works when the browser sends no domain (a machine
outside the domain); express-ntlm then uses `ntlmAuth.domain`.

### Step 3: Later Requests (JWT Middleware)

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

`/api/health` never signs in.

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
         │ (login path only)    │
         └──────────────────────┘
```

### NTLM Negotiation (3-step)

#### Request 1: Initial Request

```http
GET https://yourdomain.com/api/auth/ntlm/login?returnUrl=%2Fapps%2Fchat HTTP/1.1
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
// In ntlmAuthMiddleware (login path only)
const ntlmMiddleware = getNtlmMiddleware(ntlmAuth);
ntlmMiddleware(req, res, (err) => {
  // express-ntlm relays the messages to the domain controller and
  // sets req.ntlm.Authenticated; the login route then calls processNtlmLogin()
});
```

**Server sets the session cookie and redirects:**

```http
HTTP/1.1 302 Found
Location: /apps/chat?ntlm=success
Set-Cookie: authToken=<jwt>; HttpOnly; Secure; SameSite=Lax
Set-Cookie: ntlmRequested=1
```

All further requests carry the `authToken` cookie and run no NTLM handshake.

---

## Group Extraction Process

### Group Retrieval Flow

express-ntlm checks the sign-in and nothing else: it relays the NTLM messages to
`domainController` as an LDAP bind and sets `req.ntlm` to
`{ UserName, DomainName, Workstation, Authenticated }`. It returns no groups, display name or email.

```
1. NTLM Middleware Initialized
   └─ createNtlmMiddleware(ntlmConfig)
      options = { domain, domaincontroller, tlsOptions, debug, response handlers }

2. After User Authentication
   └─ req.ntlm.Authenticated = true

3. processNtlmUser(req, ntlmConfig)
   └─ groups = [] (express-ntlm returns none)
   └─ mapExternalGroups(groups), then add defaultGroups

4. LDAP Group Lookup (only when ntlmAuth.ldapGroupLookupProvider is set)
   └─ getLdapProviderByName(ntlmConfig.ldapGroupLookupProvider)
   └─ lookupLdapGroupsForUser(user.username, ldapProvider)
      binds with that provider's admin credentials and searches its groups
   └─ groups merged and mapped through groups.json

5. Enhance with Inheritance
   user = enhanceUserGroups(user, authConfig, ntlmAuth);
   // Example: admin -> users -> authenticated -> anonymous

6. Issue the session token (always)
   const token = generateJwt(user, {
     authMode: 'ntlm',
     additionalClaims: { domain: user.domain }
   });
```

The LDAP lookup runs at sign-in (session start), not on every request. Configure the provider in
`ldapAuth.providers` with admin bind credentials and group search settings; `ldapAuth.enabled` can
stay `false`.

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

2. ✓ What does the login screen say?
   A failed sign-in redirects to /?auth=error&message=...
   (rejected by the domain controller, no answer within 5 s,
   or 60 s cooldown after a rejection)

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
1. ✓ Is ldapGroupLookupProvider set? NTLM sign-in itself returns no groups.
   {"ldapGroupLookupProvider": "corporate-ldap"}

2. ✓ Does that provider exist in ldapAuth.providers, with admin bind
   credentials and group search configured?

3. ✓ Can the server reach that LDAP server?
   telnet ldap.example.com 636

4. ✓ Check server logs for LDAP errors:
   NTLM Auth: ldapGroupLookupProvider references non-existent LDAP provider
   NTLM Auth: LDAP group lookup failed ...

5. ✓ Verify group mappings in groups.json
   Check if external group names match "mappings" field
```

### Problem: Token not being sent

```
Check List:
1. ✓ Did the sign-in go through /api/auth/ntlm/login?
   Only that endpoint runs the handshake and sets the cookie

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
   NTLM login failed (with an error code)
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
# JWT Token Generation
JWT_SECRET="secret-key-min-32-chars"

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

