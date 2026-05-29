# Local Login Cookie Secure Flag Fix

**Date:** 2026-05-29
**Issue:** #1137 - No local login possible after fresh installation on Linux & Windows
**Status:** Fixed

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

## The Fix

Changed `getCookieSecureFlag()` to check the `USE_HTTPS` environment variable instead of `NODE_ENV`:

```javascript
// FIXED CODE
export function getCookieSecureFlag() {
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

    // Check USE_HTTPS environment variable to determine if we're using HTTPS
    // This is set to 'true' when running behind a reverse proxy with SSL or using native HTTPS
    // If not set or set to anything other than 'true', assume HTTP (even in production)
    return process.env.USE_HTTPS === 'true';  // ✓ CORRECT!
  } catch (error) {
    logger.error('Error reading cookie settings, defaulting to HTTP (secure=false)', {
      component: 'CookieSettings',
      error
    });
    // Fail safe: if we can't read config, default to insecure (works with HTTP)
    // This ensures fresh installations work out of the box on HTTP
    return false;  // ✓ FAIL SAFE for HTTP
  }
}
```

### Why This Works

1. **Fresh installations** without SSL: `USE_HTTPS` is not set → returns `false` → cookies work over HTTP ✓
2. **Production with reverse proxy**: Admin sets `USE_HTTPS=true` → returns `true` → cookies secured ✓
3. **Production with native HTTPS**: Admin sets `USE_HTTPS=true` → returns `true` → cookies secured ✓
4. **Error cases**: Returns `false` to ensure HTTP deployments work by default ✓

## Deployment Scenarios

### Scenario 1: Fresh Installation (HTTP only)

```bash
# User downloads binary and runs it
./ihub-apps-v5.3.21-linux-x64

# Environment:
NODE_ENV=production  # Default for binary
USE_HTTPS=undefined  # Not set

# Result:
secure flag = false  ✓  # Cookies work over HTTP
```

### Scenario 2: Production with Reverse Proxy (HTTPS)

```bash
# Admin sets up nginx with SSL, then runs iHub
export USE_HTTPS=true
npm run start:prod

# Environment:
NODE_ENV=production
USE_HTTPS=true

# Result:
secure flag = true  ✓  # Cookies secured for HTTPS
```

### Scenario 3: Production with Native HTTPS

```bash
# Admin provides SSL certificates
export SSL_KEY=/path/to/key.pem
export SSL_CERT=/path/to/cert.pem
export USE_HTTPS=true
npm run start:prod

# Environment:
NODE_ENV=production
USE_HTTPS=true

# Result:
secure flag = true  ✓  # Cookies secured for HTTPS
```

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

Administrators who already set this flag to work around the bug will continue to work without changes.

### Migration Not Required

No migration is needed because:
- The fix changes runtime behavior, not configuration schema
- Existing `cookieSettings.disableSecure` configurations continue to work
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
   # Expected: Login succeeds, user is authenticated ✓
   ```

2. **HTTPS Deployment Test**:
   ```bash
   export USE_HTTPS=true
   export SSL_KEY=/path/to/key.pem
   export SSL_CERT=/path/to/cert.pem
   npm run start:prod

   # Access via browser: https://yourdomain.com
   # Login with credentials
   # Expected: Login succeeds, cookies have secure flag ✓
   ```

3. **Reverse Proxy Test**:
   ```bash
   # nginx handles SSL termination
   export USE_HTTPS=true
   npm run start:prod

   # Access via: https://yourdomain.com (nginx → http://localhost:3000)
   # Expected: Login succeeds, cookies have secure flag ✓
   ```

## Documentation Updates

The following documentation already describes the `USE_HTTPS` requirement:

- `docs/ssl-https-setup.md` - Comprehensive HTTPS setup guide
- Binary release notes should mention setting `USE_HTTPS=true` for HTTPS deployments

## Related Files

### Modified Files
- `server/utils/cookieSettings.js` - Fixed `getCookieSecureFlag()` logic

### Related Documentation
- `docs/ssl-https-setup.md` - HTTPS configuration guide
- `server/defaults/config/platform.json` - Default platform configuration

### Related Code
- `server/routes/auth.js:138` - Sets authToken cookie for local login
- `server/routes/auth.js:278` - Sets authToken cookie for LDAP login
- `server/routes/auth.js:325` - Sets authToken cookie for NTLM login
- `server/routes/auth.js:415` - Sets authToken cookie for NTLM login (POST)
- `server/middleware/jwtAuth.js:28-29` - Reads authToken cookie
- `server/middleware/setup.js:275,314,339,366` - Session cookies also use `USE_HTTPS`

## Summary

**Problem:** Fresh installations couldn't login because cookies were marked `secure: true` based on `NODE_ENV=production`, but users accessed via HTTP.

**Solution:** Changed to check `USE_HTTPS` environment variable instead, defaulting to `false` (HTTP-compatible) when not set.

**Impact:** Fresh installations now work out-of-box on HTTP. HTTPS deployments continue to work with `USE_HTTPS=true`.

**Risk:** Very low - fail-safe defaults to HTTP (more permissive), HTTPS requires explicit opt-in via environment variable.
