# Log Redactor Utility

A security utility for redacting sensitive information (API keys, tokens, secrets) from log output.

## Overview

The `logRedactor.js` module provides functions to automatically redact sensitive information from logs, preventing accidental exposure of API keys and other credentials when logs are shared or stored.

## Why This Matters

- **Google Gemini API**: Includes API keys in URL query parameters (`?key=xxx`)
- **Error Logging**: URLs with API keys can be logged during error conditions
- **Log Sharing**: Logs are often shared for debugging, making redaction critical
- **Compliance**: Helps meet security and compliance requirements

## Available Functions

### `redactUrl(url)`

Redacts API keys from URLs.

**Patterns Redacted:**
- `?key=xxx` or `&key=xxx`
- `?api_key=xxx` or `&api_key=xxx`
- `?apikey=xxx` or `&apikey=xxx`
- `?token=xxx` or `&token=xxx`
- `?access_token=xxx` or `&access_token=xxx`

**Example:**
```javascript
import { redactUrl } from './utils/logRedactor.js';

const url = 'https://api.google.com?key=AIzaSyABC123';
console.error('Error with URL:', redactUrl(url));
// Output: Error with URL: https://api.google.com?key=[REDACTED]
```

### `redactHeaders(headers)`

Redacts sensitive headers while preserving first 10 characters for debugging.

**Headers Redacted:**
- `authorization`
- `x-api-key`
- `api-key`
- `apikey`
- `x-auth-token`
- `auth-token`

**Example:**
```javascript
import { redactHeaders } from './utils/logRedactor.js';

const headers = {
  'Authorization': 'Bearer sk-proj-abc123xyz789',
  'Content-Type': 'application/json'
};
console.log('Headers:', redactHeaders(headers));
// Output: Headers: { Authorization: 'Bearer sk-...[REDACTED]', Content-Type: 'application/json' }
```

### `redactRequestBody(body)`

Recursively redacts sensitive fields from request bodies.

**Fields Redacted:**
- `api_key`
- `apiKey`
- `apikey`
- `token`
- `accessToken`
- `password`

**Example:**
```javascript
import { redactRequestBody } from './utils/logRedactor.js';

const body = {
  model: 'gpt-4',
  api_key: 'sk-123456',
  messages: [{ role: 'user', content: 'Hello' }]
};
console.log('Body:', redactRequestBody(body));
// Output: Body: { model: 'gpt-4', api_key: '[REDACTED]', messages: [...] }
```

### `redactLogMessage(message)`

General-purpose string redaction for log messages.

**Patterns Redacted:**
- URLs with API keys
- Bearer tokens
- API key patterns (sk-xxx, api-xxx, key-xxx)
- Long alphanumeric strings that look like keys

**Example:**
```javascript
import { redactLogMessage } from './utils/logRedactor.js';

const message = 'Request to https://api.google.com?key=AIzaSyABC123 failed';
console.error(redactLogMessage(message));
// Output: Request to https://api.google.com?key=[REDACTED] failed
```

## Usage in Code

### Error Logging

```javascript
import { redactUrl } from './utils/logRedactor.js';

try {
  const response = await fetch(request.url);
} catch (error) {
  // GOOD: Redact URL before logging
  console.error('Fetch failed:', redactUrl(request.url), error.message);
  
  // BAD: Don't log raw URLs
  // console.error('Fetch failed:', request.url, error.message);
}
```

### Request Logging

```javascript
import { redactHeaders, redactRequestBody } from './utils/logRedactor.js';

const request = {
  url: 'https://api.openai.com/v1/chat/completions',
  headers: { Authorization: 'Bearer sk-proj-abc123' },
  body: { model: 'gpt-4', messages: [...] }
};

// GOOD: Redact sensitive data
console.log('Request:', {
  url: request.url,  // Safe - no API key in URL for OpenAI
  headers: redactHeaders(request.headers),
  body: redactRequestBody(request.body)
});
```

### General Logging

```javascript
import { redactLogMessage } from './utils/logRedactor.js';

const message = `API call failed with status 401 for URL: ${url}`;
console.error(redactLogMessage(message));
```

## Best Practices

### DO ✅

- Use `redactUrl()` before logging any URL
- Use `redactHeaders()` before logging request/response headers
- Use `redactRequestBody()` before logging request bodies
- Use `redactLogMessage()` for any user-facing error messages
- Test redaction with sample data before deploying

### DON'T ❌

- Don't assume URLs are safe (Google embeds keys in URLs)
- Don't log raw request/response objects
- Don't disable redaction "temporarily" for debugging
- Don't create custom redaction logic (use this utility)
- Don't log API keys even if you think logs are "private"

## Testing

Run the test suite:

```bash
cd server && node tests/logRedactor.test.js
```

## Implementation Notes

1. **Non-destructive**: All functions return new objects/strings without modifying originals
2. **Performance**: Uses efficient regex patterns for fast redaction
3. **Debugging**: Preserves context (first 10 chars) to help identify which key is being used
4. **Extensible**: Easy to add new patterns or customize redaction rules

## Security Considerations

- **Defense in Depth**: Use redaction as an additional layer, not the only security measure
- **Environment Variables**: Store API keys in environment variables, never in code
- **HTTPS Only**: Always use HTTPS for API requests
- **Key Rotation**: Regularly rotate API keys
- **Access Control**: Limit access to logs and log files

## Related Documentation

- Concept Document: `/concepts/2026-01-21 Log Redaction for API Keys.md`
- Tests: `/server/tests/logRedactor.test.js`
- Implementation: `/server/utils/logRedactor.js`

## Changelog

### 2026-01-21 - Initial Release
- Created log redaction utility
- Added comprehensive test suite
- Applied to all LLM adapters and StreamingHandler
- Disabled verbose request body logging in production
