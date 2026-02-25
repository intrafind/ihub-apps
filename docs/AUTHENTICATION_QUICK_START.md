# Authentication Quick Start Guide

This guide provides a quick reference for the iHub Apps authentication system.

**For detailed technical information, see:**
- `/docs/authentication-architecture.md` - Complete architecture overview
- `/docs/ntlm-technical-reference.md` - NTLM-specific technical details
- `/docs/ldap-ntlm-authentication.md` - User-focused configuration guide

---

## Development Environment (localhost)

### Start Development Server

```bash
npm run dev
```

This starts:
- **Vite Dev Server**: http://localhost:5173 (React frontend)
- **Express Server**: http://localhost:3000 (Backend API)

### Access the Application

```
http://localhost:5173
```

The Vite proxy automatically routes `/api/*` requests to the Express server.

---

## Authentication Middleware Chain

The authentication system processes requests in this order:

```
1. proxyAuth              → Check X-Forwarded-User headers
2. teamsAuthMiddleware    → Microsoft Teams authentication
3. jwtAuthMiddleware      → Validate JWT tokens from cookies/headers
4. localAuthMiddleware    → Placeholder for local auth
5. ldapAuthMiddleware     → Placeholder for LDAP auth
6. ntlmAuthMiddleware     → Windows/NTLM authentication
```

**Key Point**: The chain stops when the first middleware sets `req.user`. If no middleware sets a user, the request continues as anonymous.

---

## Configuration Examples

### Enable NTLM Authentication

**File**: `contents/config/platform.json`

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "EXAMPLE",
    "domainController": "ldap://dc.example.com:389",
    "getGroups": true,
    "generateJwtToken": true
  }
}
```

**Environment Variables**:
```bash
NTLM_LDAP_USER="CN=Service,OU=Users,DC=example,DC=com"
NTLM_LDAP_PASSWORD="password123"
# JWT_SECRET is optional - auto-generated if not provided
# JWT_SECRET="your-secret-key"
```

### Enable Local Authentication

**File**: `contents/config/platform.json`

```json
{
  "localAuth": {
    "enabled": true,
    "showDemoAccounts": true
  }
}
```

**Users File**: `contents/config/users.json`

```json
{
  "users": [
    {
      "id": "user1",
      "username": "user1",
      "password": "hashed-password",
      "name": "User One",
      "email": "user1@example.com"
    }
  ]
}
```

### Enable LDAP Authentication

**File**: `contents/config/platform.json`

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "company-ldap",
        "displayName": "Company LDAP",
        "url": "ldap://ldap.example.com:389",
        "userSearchBase": "ou=users,dc=example,dc=com",
        "usernameAttribute": "uid",
        "groupSearchBase": "ou=groups,dc=example,dc=com"
      }
    ]
  }
}
```

### Enable Proxy Authentication

**File**: `contents/config/platform.json`

```json
{
  "proxyAuth": {
    "enabled": true,
    "userHeader": "x-forwarded-user",
    "groupsHeader": "x-forwarded-groups"
  }
}
```

---

## Group Configuration

**File**: `contents/config/groups.json`

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Administrators",
      "inherits": ["users"],
      "mappings": ["Admins", "IT-Admin"],
      "permissions": {
        "apps": ["*"],
        "adminAccess": true
      }
    },
    "users": {
      "id": "users",
      "name": "Users",
      "inherits": ["authenticated"],
      "mappings": ["Domain Users"],
      "permissions": {
        "apps": ["translator", "chat"],
        "adminAccess": false
      }
    }
  }
}
```

---

## API Endpoints

### Authentication

```http
GET /api/auth/status
```
Returns available authentication methods and current user status.

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "user123",
  "password": "password123"
}
```
Universal authentication login (supports both local and LDAP authentication).

```http
POST /api/auth/ntlm/login
```
NTLM authentication login (requires Windows authentication).

```http
GET /api/auth/user
Authorization: Bearer <jwt>
```
Get current authenticated user information.

```http
POST /api/auth/logout
```
Clear authentication cookie.

---

## JWT Tokens

### Token Storage

**Preferred**: HttpOnly Cookies
- Set automatically by server after authentication
- Sent automatically with every request
- Not accessible to JavaScript (more secure)

**Fallback**: LocalStorage
- For backward compatibility
- Sent as `Authorization: Bearer <token>` header
- Accessible to JavaScript

### Token Verification

```javascript
// Client-side (axios)
const apiClient = axios.create({
  baseURL: API_URL,
  withCredentials: true  // CRITICAL: Send cookies
});
```

### Token Structure

```javascript
{
  sub: "username",
  id: "username",
  username: "username",
  name: "User Name",
  email: "user@example.com",
  groups: ["authenticated", "users"],
  authMode: "local",
  authProvider: "local",
  iat: <timestamp>,
  exp: <timestamp>,
  iss: "ihub-apps"
}
```

---

## NTLM in Development

### Default Behavior

NTLM is **skipped** through the Vite proxy in development mode to avoid multi-step authentication issues.

### Test NTLM Locally

```bash
SKIP_NTLM_VITE_PROXY=false npm run dev
```

### NTLM Debug Logging

Add to `platform.json`:
```json
{
  "ntlmAuth": {
    "debug": true
  }
}
```

---

## Base Path Deployment

### Server-Side Configuration

```bash
# Set base path for subpath deployments
export BASE_PATH=/ai-hub

# Or use environment variable substitution
export BASE_PATH=/my-apps
```

### Client-Side Detection

The client automatically detects the base path at runtime from `window.location.pathname`. No build-time configuration needed.

### Reverse Proxy Detection

For reverse proxies, enable header-based detection:

```bash
export AUTO_DETECT_BASE_PATH=true
export BASE_PATH_HEADER=x-forwarded-prefix
```

---

## CORS Configuration

**File**: `contents/config/platform.json`

```json
{
  "cors": {
    "origin": [
      "http://localhost:3000",
      "http://localhost:5173",
      "${ALLOWED_ORIGINS}"
    ],
    "credentials": true,
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"]
  }
}
```

**Environment Variables**:
```bash
# Single domain
export ALLOWED_ORIGINS="https://yourdomain.com"

# Multiple domains (comma-separated)
export ALLOWED_ORIGINS="https://yourdomain.com,https://api.yourdomain.com"
```

---

## Debugging

### Check Authentication Status

```javascript
// Browser console
fetch('/api/auth/status')
  .then(r => r.json())
  .then(data => console.log(JSON.stringify(data, null, 2)));
```

### View Request Headers

Press F12 in browser, go to Network tab, look for request headers including:
- `Origin`
- `Authorization`
- `Cookie`

### Check Server Logs

```bash
npm run dev
# Look for [NTLM Debug], [LDAP Auth], [JWT Auth] prefixes
```

### Verify Cookies

Press F12, go to Application → Cookies, look for `authToken` cookie.

---

## Troubleshooting

### "NTLM authentication required" Error

**Cause**: NTLM not configured or browser not on Windows domain

**Solution**:
1. Verify `ntlmAuth.enabled: true` in platform.json
2. Check if browser is on Windows domain (`whoami /all`)
3. In development, set `SKIP_NTLM_VITE_PROXY=false` to test

### "Access Denied" After Login

**Cause**: User groups not mapped to internal groups

**Solution**:
1. Check `groups.json` mappings
2. Verify external group names match `mappings` array
3. Add user's groups to `mappings`

### CORS Errors

**Cause**: Origin not in `ALLOWED_ORIGINS`

**Solution**:
1. Set `ALLOWED_ORIGINS` environment variable
2. Or add to `cors.origin` in platform.json
3. Restart server

### Token Expired Error

**Solution**:
1. Log out: POST /api/auth/logout
2. Log in again to get new token
3. Or configure longer `sessionTimeoutMinutes` in auth config

---

## Key Files Reference

```
Server Authentication:
  /server/middleware/ntlmAuth.js          NTLM middleware
  /server/middleware/proxyAuth.js         Proxy auth middleware
  /server/middleware/jwtAuth.js           JWT validation
  /server/middleware/setup.js             Middleware chain setup
  /server/routes/auth.js                  Auth endpoints
  /server/utils/authorization.js          Group/permission system

Client:
  /client/src/api/client.js               API client config
  /client/src/utils/runtimeBasePath.js    Base path detection
  /client/src/shared/contexts/AuthContext.jsx  Auth state

Configuration:
  contents/config/platform.json           Platform settings
  contents/config/groups.json             Group definitions
  contents/config/users.json              Local user database

Documentation:
  /docs/authentication-architecture.md    Complete overview
  /docs/ntlm-technical-reference.md       NTLM technical guide
  /docs/ldap-ntlm-authentication.md       Configuration guide
```

---

## Environment Variables Summary

### Authentication

```bash
# NTLM/LDAP Group Retrieval
NTLM_LDAP_USER="CN=Service,OU=Users,DC=example,DC=com"
NTLM_LDAP_PASSWORD="password123"

# JWT (optional - auto-generated if not provided)
# JWT_SECRET="secret-key-minimum-32-characters"

# Proxy Auth
PROXY_AUTH_ENABLED=true
PROXY_AUTH_USER_HEADER=x-forwarded-user
PROXY_AUTH_GROUPS_HEADER=x-forwarded-groups
```

### Base Path

```bash
BASE_PATH=/subpath
AUTO_DETECT_BASE_PATH=true
BASE_PATH_HEADER=x-forwarded-prefix
```

### CORS

```bash
ALLOWED_ORIGINS="https://domain1.com,https://domain2.com"
```

### Development

```bash
SKIP_NTLM_VITE_PROXY=false    # Test NTLM in dev
NODE_ENV=development
```

---

## Testing Authentication Locally

### Test without NTLM (Development Default)

```bash
npm run dev
# Navigate to http://localhost:5173
# NTLM is skipped through Vite proxy
```

### Test with NTLM (Requires Windows Domain)

```bash
SKIP_NTLM_VITE_PROXY=false npm run dev
# Requires:
# - Windows domain-joined computer
# - Configured domain controller in platform.json
```

### Test Local Authentication

```bash
# Edit contents/config/users.json
# Add test user

# In platform.json:
# Enable localAuth: { enabled: true }

npm run dev
# Login with demo credentials shown in UI
```

### Test LDAP Authentication

```bash
# In platform.json:
# Configure ldapAuth with LDAP server details

npm run dev
# Login with LDAP credentials
```

---

## Production Checklist

- [ ] JWT_SECRET configured for multi-node deployments (auto-generated for single node)
- [ ] CORS origins properly configured
- [ ] HTTPS enabled
- [ ] NTLM domain controller accessible (if using NTLM)
- [ ] LDAP/NTLM credentials set via environment variables
- [ ] Group mappings configured in groups.json
- [ ] Cookie secure flag enabled
- [ ] Authentication logs monitored
- [ ] Rate limiting enabled
- [ ] Base path configuration tested (if using subpath deployment)

