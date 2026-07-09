# Local Login Cookie Secure Flag Fix

**Date:** 2026-05-29
**Issue:** #1137 - No local login possible after fresh installation on Linux & Windows
**Status:** Fixed - Enhanced with dynamic protocol detection

## Problem Description

After fresh installation (via one-liner or binary download), users could not login using the default admin credentials:

1. User tries to login with `admin` / `password123`
2. Server logs show: `[Auth] Local authentication succeeded`
3. Server sets an HTTP-only authentication cookie
4. User remains in anonymous state - login appears to have failed silently

## Root Cause Analysis

### The Bug

Located in `server/utils/cookieSettings.js:24`:

```javascript
// BUGGY CODE
export function getCookieSecureFlag() {
  try {
    // ...
    // Default behavior: use secure flag in production
    return process.env.NODE_ENV === 'production';  // ❌ WRONG!
  } catch (error) {
    // Fail safe: if we can't read config, default to secure in production
    return process.env.NODE_ENV === 'production';  // ❌ WRONG!
  }
}
```

### Why This Failed

1. **Fresh installations** run with `NODE_ENV=production` (default for binary releases)
2. The code returned `true` for the secure flag when `NODE_ENV === 'production'`
3. Cookies with `secure: true` are **only sent over HTTPS connections**
4. Users accessing via `http://localhost` or `http://192.168.x.x` (without SSL) **never receive the cookie**
5. Browser silently drops the cookie → authentication fails

### Authentication Flow

```
┌─────────────────────────────────────────────────────────────┐
│  POST /api/auth/local/login                                 │
│  - Server validates credentials ✓                           │
│  - Server generates JWT token ✓                             │
│  - Server sets cookie: authToken (secure: true) ✓           │
│  - Response: { success: true, user: {...} } ✓               │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Browser receives response                                  │
│  - Sees Set-Cookie header with secure flag                  │
│  - Current connection is HTTP (not HTTPS)                   │
│  - Silently DROPS the cookie ❌                             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  GET /api/auth/status (or any subsequent request)           │
│  - No authToken cookie sent                                 │
│  - JWT middleware finds no token                            │
│  - User remains anonymous ❌                                │
└─────────────────────────────────────────────────────────────┘
```

## The Fix (Version 2 - Dynamic Protocol Detection)

Enhanced `getCookieSecureFlag()` to dynamically detect the actual request protocol instead of relying solely on environment variables:

```javascript
// ENHANCED CODE
export function getCookieSecureFlag(req) {
  try {
    const platform = configCache.getPlatform() || {};
    const cookieSettings = platform.cookieSettings || {};

    // If disableSecure is explicitly set to true, disable the secure flag
    if (cookieSettings.disableSecure === true) {
      logger.warn(
        'Cookie secure flag is disabled - this should only be used in non-SSL environments',
        { component: 'CookieSettings' }
      );
      return false;
    }

    // If USE_HTTPS environment variable is set, use HTTPS
    if (process.env.USE_HTTPS === 'true') {
      return true;
    }

    // Detect protocol from actual request if available
    if (req) {
      // Check X-Forwarded-Proto header first (for reverse proxy scenarios)
      const forwardedProto = req.get('x-forwarded-proto');
      if (forwardedProto) {
        return forwardedProto === 'https';
      }

      // Check req.protocol (set by Express based on connection)
      if (req.protocol) {
        return req.protocol === 'https';
      }

      // Check req.secure (Express sets this based on protocol)
      if (req.secure !== undefined) {
        return req.secure;
      }
    }

    // Default to false (HTTP) if we can't detect the protocol
    return false;
  } catch (error) {
    logger.error('Error reading cookie settings, defaulting to HTTP (secure=false)', {
      component: 'CookieSettings',
      error
    });
    // Fail safe: if we can't read config, default to insecure (works with HTTP)
    return false;
  }
}
```

### Decision Logic Priority

1. **Explicit Disable**: `cookieSettings.disableSecure === true` → `false` (override everything)
2. **Environment Variable**: `USE_HTTPS === 'true'` → `true` (explicit HTTPS mode)
3. **X-Forwarded-Proto Header**: `req.get('x-forwarded-proto')` → Check if `'https'` (reverse proxy)
4. **Request Protocol**: `req.protocol` → Check if `'https'` (direct connection)
5. **Request Secure Flag**: `req.secure` → Boolean value (Express detection)
6. **Default**: `false` (HTTP-compatible fail-safe)

### Why This Works Better

1. **Automatic Detection**: No need to set `USE_HTTPS` - works automatically based on actual protocol
2. **Reverse Proxy Support**: Detects HTTPS from `X-Forwarded-Proto` header when behind nginx/Apache
3. **Native HTTPS**: Detects direct HTTPS connections via `req.protocol` or `req.secure`
4. **Backward Compatible**: Respects existing `USE_HTTPS` environment variable
5. **Fail-Safe**: Defaults to HTTP when detection fails, ensuring fresh installations work

## Deployment Scenarios

### Scenario 1: Fresh Installation (HTTP only)

```bash
# User downloads binary and runs it
./ihub-apps-v5.3.22-linux-x64

# Environment:
NODE_ENV=production  # Default for binary
USE_HTTPS=undefined  # Not set

# Request:
protocol: http
secure: false

# Result:
secure flag = false  ✓  # Cookies work over HTTP
```

### Scenario 2: Production with Reverse Proxy (HTTPS)

```bash
# nginx handles SSL termination and sets X-Forwarded-Proto
npm run start:prod

# Environment:
NODE_ENV=production
USE_HTTPS=undefined  # Not needed anymore

# Request (from nginx):
X-Forwarded-Proto: https
protocol: http  # Internal connection
secure: false

# Result:
secure flag = true  ✓  # Automatically detected from header
```

### Scenario 3: Production with Native HTTPS

```bash
# Admin provides SSL certificates
export SSL_KEY=/path/to/key.pem
export SSL_CERT=/path/to/cert.pem
npm run start:prod

# Environment:
NODE_ENV=production
USE_HTTPS=undefined  # Not needed anymore

# Request:
protocol: https
secure: true

# Result:
secure flag = true  ✓  # Automatically detected from connection
```

### Scenario 4: Explicit HTTPS Mode

```bash
# Admin explicitly sets USE_HTTPS
export USE_HTTPS=true
npm run start:prod

# Result:
secure flag = true  ✓  # Forced by environment variable
```

## Code Changes

### Modified Files

1. **`server/utils/cookieSettings.js`**:
   - Updated `getCookieSecureFlag()` to accept `req` parameter
   - Added dynamic protocol detection logic
   - Updated `getAuthCookieOptions()` to accept and pass `req` parameter
   - Updated `getClearAuthCookieOptions()` to accept and pass `req` parameter

2. **`server/routes/auth.js`**:
   - Updated 4 `getAuthCookieOptions()` calls to pass `req` parameter (lines 138, 278, 325, 415)
   - Updated 1 `getClearAuthCookieOptions()` call to pass `req` parameter (line 457)

3. **`server/middleware/teamsAuth.js`**:
   - Updated 1 `getAuthCookieOptions()` call to pass `req` parameter (line 257)

4. **`server/middleware/jwtAuth.js`**:
   - Updated 3 `getClearAuthCookieOptions()` calls to pass `req` parameter (lines 206, 335, 405)

5. **`server/middleware/ntlmAuth.js`**:
   - Updated 1 `getAuthCookieOptions()` call to pass `req` parameter (line 668)

6. **`server/middleware/oidcAuth.js`**:
   - Updated 2 `getAuthCookieOptions()` calls to pass `req` parameter (lines 783, 817)

## Backward Compatibility

### Existing Configuration Override

The fix preserves the existing `cookieSettings.disableSecure` option in `platform.json`:

```json
{
  "cookieSettings": {
    "disableSecure": true
  }
}
```

Administrators who already set this flag continue to work without changes.

### Environment Variable Support

The `USE_HTTPS` environment variable is still supported and takes priority over protocol detection:

```bash
export USE_HTTPS=true  # Forces secure cookies regardless of protocol
```

### Migration Not Required

No migration is needed because:
- The fix changes runtime behavior, not configuration schema
- Existing `cookieSettings.disableSecure` configurations continue to work
- Existing `USE_HTTPS` environment variable configurations continue to work
- New installations automatically get the correct behavior

## Testing

### Manual Testing Steps

1. **Fresh Installation Test** (HTTP):
   ```bash
   # Download binary
   wget https://github.com/intrafind/ihub-apps/releases/download/v5.3.22/ihub-apps-v5.3.22-linux-x64
   chmod +x ihub-apps-v5.3.22-linux-x64
   ./ihub-apps-v5.3.22-linux-x64

   # Access via browser: http://localhost:3000
   # Login with: admin / password123
   # Expected: Login succeeds, cookie has secure=false ✓
   ```

2. **Native HTTPS Test**:
   ```bash
   export SSL_KEY=/path/to/key.pem
   export SSL_CERT=/path/to/cert.pem
   npm run start:prod

   # Access via browser: https://localhost:3000
   # Login with credentials
   # Expected: Login succeeds, cookie has secure=true ✓
   ```

3. **Reverse Proxy Test** (nginx with SSL termination):
   ```nginx
   # nginx config
   server {
     listen 443 ssl;
     server_name yourdomain.com;

     location / {
       proxy_pass http://localhost:3000;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

   ```bash
   npm run start:prod

   # Access via: https://yourdomain.com
   # Expected: Login succeeds, cookie has secure=true ✓
   ```

4. **Environment Variable Override Test**:
   ```bash
   export USE_HTTPS=true
   npm run start:prod

   # Access via: http://localhost:3000
   # Expected: Cookie has secure=true (forced by env var) ✓
   ```

## Documentation Updates

The following documentation already describes the deployment scenarios:

- `docs/ssl-https-setup.md` - Comprehensive HTTPS setup guide
- Binary release notes should mention automatic protocol detection

## Related Files

### Modified Files
- `server/utils/cookieSettings.js` - Enhanced `getCookieSecureFlag()` with dynamic protocol detection
- `server/routes/auth.js` - Updated to pass `req` parameter to cookie functions
- `server/middleware/teamsAuth.js` - Updated to pass `req` parameter
- `server/middleware/jwtAuth.js` - Updated to pass `req` parameter
- `server/middleware/ntlmAuth.js` - Updated to pass `req` parameter
- `server/middleware/oidcAuth.js` - Updated to pass `req` parameter

### Related Documentation
- `docs/ssl-https-setup.md` - HTTPS configuration guide
- `server/defaults/config/platform.json` - Default platform configuration

## Summary

**Original Problem:** Fresh installations couldn't login because cookies were marked `secure: true` based on `NODE_ENV=production`, but users accessed via HTTP.

**First Fix (v1):** Changed to check `USE_HTTPS` environment variable instead, defaulting to `false` when not set.

**Enhanced Fix (v2):** Added dynamic protocol detection from the actual HTTP request:
- Automatically detects HTTPS from request headers (X-Forwarded-Proto) and connection properties
- No environment variable configuration needed for most deployments
- Respects existing `USE_HTTPS` environment variable for explicit control
- Preserves `cookieSettings.disableSecure` config option for expert use

**Impact:**
- Fresh installations work out-of-box on HTTP ✓
- HTTPS deployments work automatically without configuration ✓
- Reverse proxy deployments work automatically ✓
- Existing deployments with `USE_HTTPS` continue to work ✓

**Risk:** Very low - fail-safe defaults to HTTP (more permissive), multiple detection methods provide redundancy
