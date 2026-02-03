# Client Secret Overwrite Fix

**Date:** 2026-02-03  
**Issue:** Environment variable placeholders were being overwritten with `***REDACTED***` when saving configuration changes

## Problem Description

When administrators made changes to the authentication configuration (e.g., disabling a provider), environment variable placeholders like `${MICROSOFT_CLIENT_SECRET}` were being overwritten with the literal string `***REDACTED***` in the configuration file.

### Example Scenario

1. User sets OIDC client secret to `${MICROSOFT_CLIENT_SECRET}` in `platform.json`
2. User navigates to Admin → Authentication page
3. User disables one authentication provider (not touching the secret)
4. User saves the configuration
5. **BUG:** The `${MICROSOFT_CLIENT_SECRET}` is now `***REDACTED***` in the file

## Root Cause

The issue occurred due to the security sanitization logic in the GET endpoint:

1. **GET `/admin/configs/platform`**: Returns configuration with ALL secrets replaced by `***REDACTED***`
   - This included both actual secrets AND environment variable placeholders
   - The client received `***REDACTED***` for all secret fields

2. **Client behavior**: When the admin made changes, the client sent back the entire configuration
   - The client had no way to know the original value was an environment variable
   - It sent `***REDACTED***` back to the server

3. **POST `/admin/configs/platform`**: Saved whatever the client sent
   - The server saved `***REDACTED***` to the file
   - The original environment variable placeholder was lost

## Solution

The fix implements a two-phase approach:

### Phase 1: Preserve Environment Variables in GET Response

**Helper Function: `isEnvVarPlaceholder(value)`**
- Detects if a value is an environment variable placeholder
- Pattern: `${VARIABLE_NAME}` where VARIABLE_NAME starts with a letter/underscore

**Helper Function: `sanitizeSecret(value)`**
- Preserves environment variable placeholders
- Redacts actual secret values with `***REDACTED***`

```javascript
function sanitizeSecret(value) {
  if (!value) return undefined;
  // Preserve environment variable placeholders
  if (isEnvVarPlaceholder(value)) {
    return value;
  }
  // Redact actual secret values
  return '***REDACTED***';
}
```

### Phase 2: Restore Original Values in POST Request

**Helper Function: `restoreSecretIfRedacted(newValue, existingValue)`**
- When the client sends `***REDACTED***`, use the existing value from the file
- When the client sends a new value (including a new env var), use the new value

```javascript
function restoreSecretIfRedacted(newValue, existingValue) {
  if (newValue === '***REDACTED***') {
    return existingValue;
  }
  return newValue;
}
```

## Implementation Details

### Files Modified

**`server/routes/admin/configs.js`**
- Added three helper functions: `isEnvVarPlaceholder()`, `sanitizeSecret()`, `restoreSecretIfRedacted()`
- Updated GET endpoint to use `sanitizeSecret()` for all secret fields
- Updated POST endpoint to restore secrets when receiving `***REDACTED***`

### Secret Fields Protected

The fix handles the following secret fields:

1. **OIDC Provider Secrets**
   - `oidcAuth.providers[].clientSecret`

2. **JWT Secrets**
   - `auth.jwtSecret`
   - `localAuth.jwtSecret`

3. **Admin Secret**
   - `admin.secret`

4. **LDAP Secrets**
   - `ldapAuth.providers[].adminPassword`

## Testing

### Unit Tests

Created comprehensive unit tests in `tests/test-client-secret-preservation.js`:
- 10 tests for `isEnvVarPlaceholder()`
- 7 tests for `sanitizeSecret()`
- 6 tests for `restoreSecretIfRedacted()`
- 9 tests for complete flow simulation

**Result:** All 32 tests passing

### Integration Tests

Created integration tests to verify:
- Environment variable placeholders are preserved in GET responses
- Actual secrets are redacted in GET responses
- Original values (env vars and actual secrets) are restored when saving with `***REDACTED***`
- User changes (like enabling/disabling providers) are preserved
- New secrets can still be updated

### Manual Testing

The fix was verified to work correctly with:
- Server startup (no errors)
- Linting (no new issues)
- End-to-end flow simulation

## Behavior Matrix

| Original Value in File | GET Response to Client | Client Sends Back | Final Value in File |
|------------------------|------------------------|-------------------|---------------------|
| `${MICROSOFT_SECRET}` | `${MICROSOFT_SECRET}` | `${MICROSOFT_SECRET}` | `${MICROSOFT_SECRET}` ✓ |
| `${MICROSOFT_SECRET}` | `${MICROSOFT_SECRET}` | `${NEW_SECRET}` | `${NEW_SECRET}` ✓ |
| `actual-secret-123` | `***REDACTED***` | `***REDACTED***` | `actual-secret-123` ✓ |
| `actual-secret-123` | `***REDACTED***` | `new-secret-456` | `new-secret-456` ✓ |

## Security Considerations

The fix maintains security by:
1. **Still redacting actual secrets** from API responses
2. **Preserving environment variable placeholders** which are safe to show (they reference env vars, not actual values)
3. **Allowing secret updates** when admins provide new values
4. **Preventing unintended overwrites** when users make unrelated changes

## Migration Guide

No migration is required. This fix is backward compatible:
- Existing configurations work without changes
- Environment variable placeholders continue to work
- Actual secrets continue to be protected
- No database or file format changes

## Related Files

- Implementation: `server/routes/admin/configs.js`
- Tests: `tests/test-client-secret-preservation.js`
- Demo: `tests/demo-client-secret-preservation.js`
- Manual test: `tests/manual-test-client-secret-preservation.js`

## Future Improvements

Potential enhancements:
1. Add a visual indicator in the UI to show which fields are environment variables
2. Add validation to prevent saving `***REDACTED***` as an actual value
3. Consider supporting more environment variable formats (e.g., `$VARIABLE`)
4. Add logging to track when secrets are restored vs. updated
