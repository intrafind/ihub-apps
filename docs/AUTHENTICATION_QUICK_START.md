---
description: "Choose a sign-in mode and set up anonymous, local, OIDC, LDAP or proxy authentication."
audience: admin
type: how-to
adminPage: /admin/auth
---

# Authentication Quick Start

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
    "domainController": "ldaps://dc.example.com:636",
    "ldapGroupLookupProvider": "corporate-ldap",
    "generateJwtToken": true
  }
}
```

NTLM sign-in returns no groups. `ldapGroupLookupProvider` names an entry in `ldapAuth.providers`
(with admin bind credentials and group search) that supplies them; without it, NTLM users get only
`defaultGroups`. See [LDAP/NTLM Authentication](ldap-ntlm-authentication.md#ldap-group-lookup-for-ntlm-users).

**Environment Variables**:
```bash
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
        "url": "ldaps://ldap.example.com:636",
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

### Automatic Detection

The base path is detected automatically at runtime. No environment variables are needed.

- **Server side:** The `X-Forwarded-Prefix` header (set by your reverse proxy) is used to detect the subpath. Both stripping and non-stripping proxy configurations are supported.
- **Client side:** The client detects the base path from `window.location.pathname`. No build-time configuration needed.

To customize the header name (default: `x-forwarded-prefix`):

```bash
export BASE_PATH_HEADER=x-custom-prefix
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

## Switching Sign-in Methods Safely

iHub refuses any change that would lock you, or every administrator, out:

- **Authentication** (`/admin/auth`): you cannot save a configuration that turns off the sign-in
  method you are signed in with (for example unticking **Local Authentication** while signed in
  locally, or removing the OIDC provider you used), or that leaves no administrator who can sign
  in. The page shows why and nothing is saved.
- **Users** (`/admin/users`): you cannot deactivate or delete your own account. Removing
  administrator rights from a user, or deactivating one, is refused when no other active
  administrator who can sign in would remain. Removing your own administrator group is allowed
  while another administrator remains.
- **Groups** (`/admin/groups`): a group that other groups inherit from cannot be deleted; the
  dialog lists them, so you can remove the inheritance first. An edit or a delete that would leave
  no administrator (for example removing the inheritance every admin gets admin rights through, or
  deleting a custom admin group that all administrators are in) is refused.

If `groups.json` was edited on disk and no longer resolves (a group inherits from itself through
others, or from a group that does not exist), iHub keeps using the last groups that did resolve
and logs the problem. You can repair it in the admin UI: edit one of the
groups named in the message and remove the inheritance that closes the loop, or create the
missing group. Other group edits are refused until then, with a message naming the stored
problem.

There is no override. To move from one sign-in method to another:

1. Enable the new method (for example OIDC) and save.
2. Sign out, and sign in with the new method once, so iHub creates your user record for it.
3. Sign in again with the old method and, on **Users**, give that new user record an
   administrator group (for example `admins`). A group mapping from the identity provider alone
   is not enough: iHub cannot tell whether anyone holds the mapped group, so it does not count
   such administrators (neither does the admin rescue below), and step 5 would be refused.
4. Sign in with the new method as that administrator.
5. Turn off the old method and save.

If step 5 is refused with "no active administrator could sign in", step 3 is what is missing.

An "administrator who can sign in" is an active user in `users.json`, in a group with
administrator access (also through inherited groups), whose sign-in method is enabled; or an LDAP
provider or NTLM whose default groups include such a group. Administrators who get their rights
only from an identity-provider group mapping are not counted, because iHub cannot know whether
anyone holds that group.

## Recover Admin Access

If nobody can sign in as an administrator (for example `platform.json` was edited on disk, or
the only administrator's identity provider is gone):

1. Stop iHub (or keep it running if you use the environment variable below and can restart).
2. Turn local sign-in back on, either way:
   - edit `contents/config/platform.json` and set `"localAuth": { "enabled": true }`, or
   - set the environment variable `IHUB_PLATFORM__LOCAL_AUTH__ENABLED=true`.
3. Make sure a local administrator exists in `contents/config/users.json`: an `"active": true`
   user with `"authMethods": ["local"]`, a password hash and `"internalGroups": ["admins"]`.
4. Start iHub again and sign in with that account at `/login`.
5. Before you remove the environment variable, either tick **Local Authentication** on the
   Authentication page and save, or make sure another administrator can sign in with a method
   that stays enabled. While the variable is set, the page shows local sign-in as off (the stored
   value) but it stays on, and iHub accepts saves that keep it off in the file. Removing the
   variable then turns local sign-in off without any check, and if the local administrator was
   the only one, the admin rescue below applies.

**What the checks do not cover:**

- **Backup import** (`/admin/backup`) replaces the whole configuration, including users, groups
  and sign-in methods, with the archive's. It is a deliberate restore: the archive may come from
  another installation where you have no account, or from a time before your account existed, so
  "you keep access" cannot be evaluated against it, and refusing would block disaster recovery.
  Check the archive's sign-in methods and administrators before importing it.
- **Configuration migrations** that run on startup are part of iHub itself, not admin actions.
- **Two administrators at the same moment, on several servers:** within one installation,
  authentication saves and user and group edits wait for each other, also across its worker
  processes, so two of them cannot each pass against the other's old state. Separate servers
  (pods) that do not share one `contents/` directory are not coordinated: two such changes made
  within milliseconds of each other on different servers can still together leave no
  administrator.

**How the admin rescue behaves:** whenever nobody can sign in as an administrator (by the rule
above), the next person who signs in through local, OIDC, proxy, NTLM or Teams sign-in is made an
administrator automatically (LDAP sign-ins are not). This keeps a fresh installation reachable,
but on a running installation it means a stranger can become administrator. The guards above
exist so that the admin UI never puts an installation into that state; a hand edit on disk can,
so after recovering, check **Users** for unexpected administrators.

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
# JWT (optional - auto-generated if not provided)
# JWT_SECRET="secret-key-minimum-32-characters"

# Proxy Auth
PROXY_AUTH_ENABLED=true
PROXY_AUTH_USER_HEADER=x-forwarded-user
PROXY_AUTH_GROUPS_HEADER=x-forwarded-groups
```

### Base Path

```bash
# Auto-detected from X-Forwarded-Prefix header — no env vars needed.
# Optionally customize the header name:
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

