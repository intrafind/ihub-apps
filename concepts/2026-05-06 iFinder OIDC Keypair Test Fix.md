# iFinder OIDC Keypair Test Fix

**Date:** 2026-05-06
**Issue:** #1137
**Component:** Admin - iFinder Integration Testing

## Problem

The iFinder integration test endpoint (`POST /api/admin/integrations/ifinder/_test`) was failing when the "Use iHub OIDC Keypair for JWT signing" option was enabled. The test always checked for the `privateKey` field in the iFinder configuration, even when OIDC keypair mode was enabled.

**Error Message:**
```
iFinder private key is not configured
{
  "missingConfig": "privateKey"
}
```

## Root Cause

The test validation logic in `server/routes/admin/integrationTest.js` did not account for the two different JWT signing modes:

1. **Dedicated iFinder Private Key Mode** (`useOidcKeyPair: false`): Uses `iFinderConfig.privateKey`
2. **OIDC Keypair Mode** (`useOidcKeyPair: true`): Uses the iHub OIDC RSA keypair from `tokenStorageService`

The original code always checked for `iFinderConfig.privateKey`, regardless of the mode:

```javascript
if (!iFinderConfig.privateKey) {
  return res.json({
    success: false,
    message: 'iFinder private key is not configured',
    details: {
      missingConfig: 'privateKey'
    }
  });
}
```

## Solution

Updated the validation logic to check for the appropriate key source based on the `useOidcKeyPair` setting:

```javascript
// Validate JWT signing configuration based on mode
if (iFinderConfig.useOidcKeyPair) {
  // When using OIDC keypair mode, verify OIDC RSA keypair is available
  const rsaKeyPair = tokenStorageService.getRSAKeyPair();
  if (!rsaKeyPair || !rsaKeyPair.privateKey) {
    return res.json({
      success: false,
      message: 'iHub OIDC RSA key pair is not initialized. Cannot sign iFinder JWT with OIDC keypair.',
      details: {
        missingConfig: 'oidcKeyPair',
        useOidcKeyPair: true
      }
    });
  }
} else {
  // When using dedicated iFinder private key, verify it's configured
  if (!iFinderConfig.privateKey) {
    return res.json({
      success: false,
      message: 'iFinder private key is not configured',
      details: {
        missingConfig: 'privateKey',
        useOidcKeyPair: false
      }
    });
  }
}
```

## Implementation Details

**File Modified:** `server/routes/admin/integrationTest.js`

**Changes:**
1. Added import for `tokenStorageService`
2. Replaced single `privateKey` check with conditional validation based on `useOidcKeyPair`
3. When OIDC mode is enabled, checks `tokenStorageService.getRSAKeyPair()` for availability
4. Added `useOidcKeyPair` flag to error response details for debugging

## Related Code

The JWT signing logic is implemented in `server/utils/iFinderJwt.js`:

- `getIFinderPrivateKey()` (lines 71-114): Handles both modes
  - When `useOidcKeyPair: true`: Uses `tokenStorageService.getRSAKeyPair().privateKey`
  - When `useOidcKeyPair: false`: Uses `iFinderConfig.privateKey` or `IFINDER_PRIVATE_KEY` env var

## Testing

Verified that:
1. Code passes linting (`npm run lint:fix`)
2. Code passes formatting (`npm run format:fix`)
3. Server starts successfully without errors
4. Test endpoint validation logic matches JWT signing logic

## Impact

This fix ensures that the iFinder integration test works correctly in both modes:
- ✅ Dedicated private key mode (backward compatible)
- ✅ OIDC keypair mode (previously broken)

## References

- Issue: #1137
- Related Files:
  - `server/routes/admin/integrationTest.js` (test endpoint)
  - `server/utils/iFinderJwt.js` (JWT signing logic)
  - `server/services/TokenStorageService.js` (OIDC keypair storage)
  - `client/src/features/admin/components/IFinderConfig.jsx` (UI configuration)
