# Log Redaction for API Keys

**Date:** 2026-01-21  
**Status:** Implemented  
**Related Issue:** Redact keys in logs

## Problem Statement

The application was logging sensitive information such as API keys in various places:

1. **Google Adapter**: API keys were included in URLs (e.g., `?key=AIzaSy...`) and logged in error messages
2. **All Adapters**: Request bodies containing potentially sensitive data were logged in full
3. **StreamingHandler**: URLs with API keys were logged in error messages
4. **Headers**: Authorization headers with Bearer tokens could be exposed in logs

This posed a security risk as logs could be shared for debugging purposes and would leak access credentials.

## Solution

Created a centralized log redaction utility (`server/utils/logRedactor.js`) that provides functions to redact sensitive information from logs:

### Core Functions

1. **`redactUrl(url)`**
   - Redacts API keys from URLs
   - Handles patterns like `?key=xxx`, `?api_key=xxx`, `?token=xxx`, etc.
   - Preserves URL structure while hiding sensitive values
   - Example: `?key=AIzaSyABC123` → `?key=[REDACTED]`

2. **`redactHeaders(headers)`**
   - Redacts sensitive headers (Authorization, x-api-key, etc.)
   - Keeps first 10 characters for debugging context
   - Example: `Bearer sk-proj-abc...` → `Bearer sk-...[REDACTED]`

3. **`redactRequestBody(body)`**
   - Recursively redacts sensitive fields from request bodies
   - Handles nested objects
   - Does not modify the original object
   - Redacts fields: `api_key`, `apiKey`, `token`, `password`, etc.

4. **`redactLogMessage(message)`**
   - General-purpose message redaction
   - Handles URLs, Bearer tokens, and API key patterns
   - Can be used with any log message string

## Implementation

### Files Modified

1. **`server/utils/logRedactor.js`** (new)
   - Core redaction utility functions
   - Handles URLs, headers, request bodies, and log messages

2. **`server/tests/logRedactor.test.js`** (new)
   - Comprehensive tests for all redaction functions
   - Tests edge cases and various API key patterns

3. **`server/services/chat/StreamingHandler.js`**
   - Import `redactUrl` function
   - Redact URLs in error logging (line 147)

4. **`server/adapters/google.js`**
   - Import `redactUrl` function
   - Disabled verbose request body logging

5. **`server/adapters/openai.js`**
   - Disabled verbose request body logging

6. **`server/adapters/anthropic.js`**
   - Disabled verbose request body logging

7. **`server/adapters/mistral.js`**
   - Disabled verbose request body logging

8. **`server/adapters/vllm.js`**
   - Disabled verbose request body logging

### Key Design Decisions

1. **Centralized Utility**: Created a single utility module instead of duplicating redaction logic across files
2. **Non-destructive**: Redaction functions do not modify original objects/strings
3. **Preserve Context**: Keep some characters visible (e.g., first 10 chars) to help with debugging
4. **Pattern-based**: Use regex patterns to detect and redact various API key formats
5. **Disabled Verbose Logging**: Request body logging was too verbose and not needed in production

## Testing

All tests pass successfully:

```bash
cd server && node tests/logRedactor.test.js
```

Tests cover:
- Google API keys in URLs
- Multiple API key patterns (key, api_key, apikey, token, etc.)
- Authorization headers
- Nested sensitive fields in objects
- Edge cases (empty values, non-string types)

## Usage Examples

### Redacting URLs

```javascript
import { redactUrl } from './utils/logRedactor.js';

const url = 'https://api.google.com?key=AIzaSyABC123';
console.error('Error with URL:', redactUrl(url));
// Output: Error with URL: https://api.google.com?key=[REDACTED]
```

### Redacting Headers

```javascript
import { redactHeaders } from './utils/logRedactor.js';

const headers = {
  'Authorization': 'Bearer sk-proj-abc123',
  'Content-Type': 'application/json'
};
console.log('Headers:', redactHeaders(headers));
// Output: Headers: { Authorization: 'Bearer sk-...[REDACTED]', Content-Type: 'application/json' }
```

### Redacting Log Messages

```javascript
import { redactLogMessage } from './utils/logRedactor.js';

const message = 'Request to https://api.google.com?key=secret123 failed';
console.error(redactLogMessage(message));
// Output: Request to https://api.google.com?key=[REDACTED] failed
```

## Security Considerations

1. **API Keys in URLs**: Google Gemini API keys are passed in URL query parameters, making them particularly vulnerable to logging
2. **Authorization Headers**: Bearer tokens and API keys in headers must be protected
3. **Request Bodies**: May contain API keys or other sensitive data
4. **Log Sharing**: Logs are often shared for debugging, so redaction is critical

## Future Enhancements

1. **Configurable Redaction**: Allow configuration of which fields/patterns to redact
2. **Safe Logging Wrappers**: Create `safeLog()` and `safeError()` wrapper functions
3. **Performance**: Optimize regex patterns if performance becomes an issue
4. **Additional Patterns**: Add more API key patterns as new providers are added

## Related Code

- Redaction utility: `server/utils/logRedactor.js`
- Tests: `server/tests/logRedactor.test.js`
- Usage in StreamingHandler: `server/services/chat/StreamingHandler.js:11,147`
- Google adapter: `server/adapters/google.js:6,241`
