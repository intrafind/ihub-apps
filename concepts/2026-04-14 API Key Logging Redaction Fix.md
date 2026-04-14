# API Key Logging Redaction Fix

**Date**: 2026-04-14
**Issue**: Logging of API keys and secrets in structured logs
**Status**: Fixed

## Problem

With the introduction of structured logging using Winston and JSON format, API keys and other secrets were being logged in plain text when objects containing sensitive fields were logged.

**Example of the issue**:
```json
{"component":"Utils","level":"info","timestamp":"2026-04-14T08:57:06.265Z","message":"Using model:","modelConfig":{...,"apiKey":"ENC[AE..."}}
```

While encrypted values starting with `ENC[` were partially masked, the fact that they were visible at all was a security concern. Additionally, non-encrypted API keys would be fully exposed.

## Root Cause

The logger's `processLogArgs` function was passing objects directly to Winston without any sanitization or redaction of sensitive fields. When logging objects containing model configurations, platform configurations, or other data structures with API keys, secrets, passwords, or tokens, these sensitive values were being included in the log output.

Specific problematic code location:
- `server/utils.js:526` - Logging entire `modelConfig` object which contains `apiKey` field

## Solution

Implemented automatic redaction of sensitive information at the logger level:

### 1. Enhanced Logger (`server/utils/logger.js`)

Added `redactSensitiveData()` function to the `processLogArgs()` flow that:

- Identifies sensitive field names (case-insensitive exact match):
  - `apikey`, `api_key`, `apiKey`
  - `token`, `accesstoken`, `access_token`, `accessToken`
  - `password`
  - `secret`, `clientsecret`, `client_secret`, `clientSecret`
  - `privatekey`, `private_key`, `privateKey`
  - `authorization`, `bearer`
  - `jwt`, `jwttoken`, `jwt_token`
  - `sessionid`, `session_id`, `sessionId`
  - `refreshtoken`, `refresh_token`, `refreshToken`

- Only redacts string/number/boolean values (not nested objects) to preserve structure
- Recursively processes nested objects and arrays
- Handles encrypted values specially:
  - Values starting with `ENC[` are replaced with `[ENCRYPTED]`
  - Other sensitive values are replaced with first 4 chars + `...[REDACTED]`
  - Short values (<10 chars) are replaced with `[REDACTED]`

### 2. Enhanced LogRedactor (`server/utils/logRedactor.js`)

Added `redactObject()` function with similar logic for manual redaction when needed.

### 3. No Code Changes Required

The beauty of this solution is that **no existing code needs to be modified**. All logger calls automatically benefit from the redaction:

```javascript
// This code remains unchanged
logger.info('Using model:', { component: 'Utils', modelConfig });

// But the output is now safe:
// {"component":"Utils",...,"modelConfig":{...,"apiKey":"sk-p...[REDACTED]",...}}
```

## Testing

Created comprehensive tests:

1. **`server/tests/logRedactor.test.js`**
   - Tests URL redaction
   - Tests header redaction
   - Tests request body redaction
   - Tests log message redaction
   - Tests object redaction (new)

2. **`server/tests/logger-redaction.test.js`**
   - Tests automatic redaction in logger
   - Tests encrypted value handling
   - Tests nested object preservation

3. **`server/tests/issue-apikey-logging-fix.test.js`**
   - Reproduces the exact issue scenario
   - Verifies the fix works for `modelConfig` logging
   - Ensures non-sensitive fields are preserved

All tests pass successfully.

## Impact

### Security Benefits
- API keys no longer exposed in logs
- Secrets, passwords, and tokens automatically redacted
- Encrypted values clearly marked as `[ENCRYPTED]`
- Applies to all log levels (info, debug, warn, error)

### Performance
- Minimal overhead - redaction only runs when objects are logged
- No impact on string-only log messages
- Efficient field matching using Set lookups

### Backward Compatibility
- No breaking changes
- No code modifications needed in existing files
- Works with all existing log statements

## Files Modified

- `server/utils/logger.js` - Added automatic redaction to `processLogArgs()`
- `server/utils/logRedactor.js` - Added `redactObject()` export
- `server/tests/logRedactor.test.js` - Added object redaction tests
- `server/tests/logger-redaction.test.js` - New automatic redaction tests
- `server/tests/issue-apikey-logging-fix.test.js` - New issue reproduction test

## Verification

To verify the fix is working:

1. Run the tests:
   ```bash
   node server/tests/issue-apikey-logging-fix.test.js
   ```

2. Check logs for redacted values:
   ```bash
   npm run dev
   # Look for [REDACTED] or [ENCRYPTED] in logs instead of actual API keys
   ```

## Future Considerations

- Monitor logs to identify any additional sensitive fields that should be redacted
- Consider adding a configuration option for custom sensitive field names
- Evaluate if debug logs need different redaction rules than info logs

## Conclusion

This fix provides comprehensive protection against API key and secret leakage in logs without requiring any code changes to existing log statements. All objects logged through the Winston logger are automatically sanitized, ensuring sensitive information is never exposed in log files or console output.
