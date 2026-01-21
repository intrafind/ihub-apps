---
applyTo: "server/**/*.js"
---

# Server-Side Code Guidelines for iHub Apps

When working with Node.js server code, follow these specific guidelines:

## Module System

1. **ES Modules** - Use ES module syntax (`import/export`), not CommonJS (`require/module.exports`)
2. **File Extensions** - Always include `.js` extension in import statements
3. **Named Exports** - Prefer named exports over default exports for better code navigation
4. **Dynamic Imports** - Use `await import()` for dynamic module loading when needed

## Express Patterns

1. **Route Organization** - Place routes in appropriate subdirectories under `routes/`
2. **Middleware** - Use middleware for cross-cutting concerns (auth, logging, validation)
3. **Error Handling** - Always use try/catch and pass errors to Express error handlers
4. **Async Handlers** - Wrap async route handlers to catch errors properly

## Authentication & Authorization

1. **Middleware** - Use `authRequired` or `authOptional` middleware on routes
2. **User Enhancement** - Call `enhanceUserWithPermissions()` to add resolved permissions
3. **Permission Checks** - Use `filterResourcesByPermissions()` for resource filtering
4. **Group Inheritance** - Trust the pre-resolved group inheritance from `loadGroupsConfiguration()`

## Configuration

1. **Config Cache** - Use `configCache.get()` to access configuration (automatic hot-reload)
2. **Environment Variables** - Load sensitive data from `.env` via `process.env`
3. **No Hardcoded Values** - Externalize all configuration to JSON files or environment variables
4. **Validation** - Validate configuration using Zod schemas in `validators/`

## LLM Adapters

1. **Adapter Pattern** - Follow the established adapter interface for new LLM providers
2. **Streaming Support** - Implement streaming using Server-Sent Events (SSE)
3. **Error Handling** - Handle provider-specific errors and convert to standardized format
4. **Token Limits** - Respect model token limits from configuration
5. **Tool Calling** - Support tool/function calling when the provider allows it

## Database & Persistence

1. **No Database** - This project doesn't use a traditional database
2. **File-Based Config** - Configuration is stored in JSON files under `contents/`
3. **User Data** - User data is stored in `contents/data/users.json` for local auth
4. **Chat History** - Chat history is managed client-side in localStorage

## API Design

1. **RESTful Routes** - Follow REST conventions for API endpoints
2. **Response Format** - Return consistent JSON response structures
3. **Status Codes** - Use appropriate HTTP status codes (200, 400, 401, 404, 500, etc.)
4. **Error Responses** - Return descriptive error messages with proper status codes
5. **Streaming** - Use Server-Sent Events (EventSource) for LLM streaming responses

## Security Best Practices

1. **Input Validation** - Validate all user input using Zod schemas or manual checks
2. **Authentication Bypass** - Never skip auth checks without explicit anonymous configuration
3. **API Keys** - Never log or expose API keys in responses
4. **CORS** - Use configured CORS settings from `platform.json`
5. **Rate Limiting** - Implement rate limiting for API endpoints when needed
6. **Path Traversal** - Validate file paths to prevent directory traversal attacks

## Logging

1. **Console Logging** - Use `console.log`, `console.error`, `console.warn` appropriately
2. **Structured Logging** - Include context in log messages (user ID, request ID, etc.)
3. **No Sensitive Data** - Never log passwords, API keys, or tokens
4. **Error Logging** - Log full error stack traces for debugging

## Code Structure

```javascript
// Good: ES modules, proper error handling, configuration usage
import express from 'express';
import { authRequired } from '../middleware/authRequired.js';
import { configCache } from '../configCache.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';

const router = express.Router();

router.get('/api/example', authRequired, async (req, res, next) => {
  try {
    // Get configuration
    const config = configCache.get('platform');
    
    // Enhance user with permissions
    const user = enhanceUserWithPermissions(req.user, config);
    
    // Business logic
    const result = await performOperation(user);
    
    // Send response
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error in /api/example:', error);
    next(error); // Pass to error handler
  }
});

export default router;
```

## Common Patterns

### Configuration Access
```javascript
// Good: Use configCache for hot-reloadable config
import { configCache } from '../configCache.js';
const apps = configCache.get('apps');
const models = configCache.get('models');
```

### Authentication Check
```javascript
// Good: Use middleware and enhance user
import { authRequired } from '../middleware/authRequired.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';

router.get('/protected', authRequired, async (req, res, next) => {
  const config = configCache.get('platform');
  const user = enhanceUserWithPermissions(req.user, config);
  // Use user.permissions to check access
});
```

### LLM Streaming
```javascript
// Good: Stream responses using SSE
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');

for await (const chunk of adapter.streamChat(messages)) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}
res.end();
```

## Performance Considerations

1. **Caching** - Leverage `configCache` to avoid repeated file I/O
2. **Async Operations** - Use `async/await` for I/O operations
3. **Streaming** - Stream large responses instead of buffering
4. **Clustering** - Server supports clustering for production scaling (already implemented)

## Testing

1. **Test Files** - Place tests in `server/tests/` directory
2. **Adapter Tests** - Test LLM adapters independently with mock responses
3. **Integration Tests** - Test API endpoints with supertest
4. **Manual Testing** - Test server startup after significant changes

## What NOT to Do

❌ **Don't:**
- Use CommonJS `require/module.exports`
- Hardcode API keys or secrets in code
- Skip input validation
- Ignore errors or use empty catch blocks
- Modify authentication flow without understanding it
- Create new configuration structures without updating schemas
- Block the event loop with synchronous I/O

✅ **Do:**
- Use ES modules with `.js` extensions
- Load secrets from environment variables
- Validate all user input
- Handle errors gracefully with proper logging
- Use existing auth middleware patterns
- Follow established configuration patterns
- Use async/await for I/O operations
- Test server startup after changes
