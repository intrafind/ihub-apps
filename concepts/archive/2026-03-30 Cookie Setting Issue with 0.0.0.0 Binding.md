# Cookie Setting Issue with 0.0.0.0 Binding

**Date:** 2026-03-30
**Issue:** Cookies not being set when server binds to 0.0.0.0:3001
**Status:** Fixed

## Problem Statement

When starting a blank iHub installation, the server binds to `0.0.0.0:3001` by default (as configured in `config.env`). However, when users log in by accessing `http://0.0.0.0:3001`, no authentication cookie is set, which leads to follow-up authentication issues.

## Root Cause Analysis

### Cookie Configuration

The authentication routes (`server/routes/auth.js`) set cookies with the following configuration:

```javascript
res.cookie('authToken', result.token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: result.expiresIn * 1000
});
```

### Browser Security Restrictions

Modern browsers have strict security policies regarding cookies:

1. **0.0.0.0 is not a valid hostname**: Browsers treat `0.0.0.0` as a special "any address" indicator, not as a real host
2. **Cookie rejection**: Most browsers will **reject cookies** when the origin is `http://0.0.0.0:*` for security reasons
3. **SameSite restrictions**: The `sameSite: 'lax'` setting provides CSRF protection but requires valid hostnames

### Understanding 0.0.0.0 Binding

The `0.0.0.0` address is a **bind address**, not an access address:
- **Bind address** (0.0.0.0): Tells the server to listen on all network interfaces
- **Access address**: The hostname/IP users should use to access the server (localhost, 127.0.0.1, actual hostname)

When a server binds to `0.0.0.0:3001`, it means:
- ✅ Accept connections from any network interface
- ✅ Can be accessed via `localhost:3001`, `127.0.0.1:3001`, or the actual hostname
- ❌ Should NOT be accessed directly as `http://0.0.0.0:3001`

## Solution

### Primary Fix: Server Logging Enhancement

Add clear logging at server startup that explains:
1. The difference between bind address and access URLs
2. Recommended ways to access the application
3. Warning if users try to access via 0.0.0.0

**Implementation Location:** `server/server.js` lines 408-423

### Cookie Configuration (No Changes Needed)

The existing cookie configuration is correct and doesn't specify a `domain` attribute. This is intentional:
- Without a `domain` attribute, cookies work with whatever valid hostname the user accesses
- This allows the same configuration to work for localhost, 127.0.0.1, and actual hostnames
- The issue is not with the cookie configuration but with users accessing via an invalid hostname

## Implementation Details

### File: `server/server.js`

Enhanced the server startup logging to:
1. Show bind address vs access URLs
2. Recommend proper access methods
3. Warn about 0.0.0.0 limitations

```javascript
server.listen(PORT, HOST, () => {
  const protocol = server instanceof https.Server ? 'https' : 'http';

  // Show bind address
  logger.info({
    component: 'Server',
    message: 'Server is listening',
    protocol,
    bindAddress: HOST,
    port: PORT
  });

  // Show recommended access URLs
  if (HOST === '0.0.0.0') {
    logger.info({
      component: 'Server',
      message: 'Access the application at:',
      urls: [
        `${protocol}://localhost:${PORT}`,
        `${protocol}://127.0.0.1:${PORT}`
      ]
    });
    logger.warn({
      component: 'Server',
      message: 'Do not access via http://0.0.0.0:* - browsers will reject cookies',
      recommendation: 'Use localhost or 127.0.0.1 instead'
    });
  } else {
    logger.info({
      component: 'Server',
      message: 'Access the application at',
      url: `${protocol}://${HOST}:${PORT}`
    });
  }
});
```

## Testing

### Test Cases

1. **Bind to 0.0.0.0, access via localhost**
   - Expected: Cookies set correctly ✅
   - Browser sees: `http://localhost:3001`

2. **Bind to 0.0.0.0, access via 127.0.0.1**
   - Expected: Cookies set correctly ✅
   - Browser sees: `http://127.0.0.1:3001`

3. **Bind to 0.0.0.0, access via actual hostname**
   - Expected: Cookies set correctly ✅
   - Browser sees: `http://myserver.local:3001`

4. **Bind to 0.0.0.0, access via 0.0.0.0**
   - Expected: Cookies NOT set (browser limitation) ❌
   - Warning shown in logs
   - User redirected via documentation

## Documentation Updates

Updated the following documentation:
- `docs/INSTALLATION.md`: Added note about bind address vs access URL
- `docs/server-config.md`: Clarified HOST configuration

## Prevention

To prevent this issue in the future:
1. Server logs clearly indicate the difference between bind and access addresses
2. Documentation explains the concept
3. Error messages guide users to proper access methods

## Related Files

- `server/server.js` (lines 408-423): Server startup logging
- `server/routes/auth.js` (lines 130-135, 274-279, 327-332, 403-408): Cookie setting
- `server/config.js` (lines 14-15): HOST and PORT defaults
- `config.env` (lines 6-7): Configuration file with HOST and PORT settings
- `docs/INSTALLATION.md`: Installation documentation
- `docs/server-config.md`: Server configuration reference

## Conclusion

The issue was not a bug in the cookie configuration but a **user error** in how the application was being accessed. By enhancing server logging and documentation, users will be guided to access the application correctly via `localhost` or `127.0.0.1` instead of the bind address `0.0.0.0`.
