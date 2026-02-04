# Logging Configuration Guide

## Overview

iHub Apps uses **Winston** as its logging framework, providing configurable log levels and structured logging throughout the application. This document explains how to configure and use the logging system.

## Log Levels

The logging system supports the following log levels (from most to least verbose):

| Level | Description | Use Case |
|-------|-------------|----------|
| `error` | Only errors | Production - critical issues only |
| `warn` | Warnings and errors | Production - track potential issues |
| `info` | General information (default) | Production - standard operation logging |
| `http` | HTTP requests/responses | Development - API debugging |
| `verbose` | Detailed information | Development - troubleshooting |
| `debug` | Debug information | Development - detailed debugging |
| `silly` | Everything | Development - very verbose debugging |

**Recommendation**: Use `info` for production and `debug` for development.

## Configuration

### Platform Configuration

Logging is configured in `contents/config/platform.json`:

```json
{
  "logging": {
    "level": "info",
    "file": {
      "enabled": false,
      "path": "logs/app.log",
      "maxSize": 10485760,
      "maxFiles": 5
    }
  }
}
```

### Configuration Options

- **`level`**: Current log level (error, warn, info, http, verbose, debug, silly)
- **`file.enabled`**: Whether to enable file logging (default: false)
- **`file.path`**: Path to log file (default: `logs/app.log`)
- **`file.maxSize`**: Maximum log file size in bytes (default: 10MB)
- **`file.maxFiles`**: Maximum number of log files to keep (default: 5)

## Admin Interface

### Accessing Log Configuration

1. Navigate to **Admin** → **System**
2. Scroll to the **Logging Configuration** section
3. View current log level and available levels
4. Click a log level button to change the level immediately

### Features

- **Visual log level selector** with descriptions
- **Real-time updates** - changes apply immediately to all server processes
- **Persistent configuration** - changes are saved to `platform.json`
- **No server restart required** - hot-reload support

## API Endpoints

### Get Current Log Level

```bash
GET /api/admin/logging/level
```

**Response:**
```json
{
  "current": "info",
  "available": ["error", "warn", "info", "http", "verbose", "debug", "silly"]
}
```

### Update Log Level

```bash
PUT /api/admin/logging/level
Content-Type: application/json

{
  "level": "debug",
  "persist": true
}
```

**Response:**
```json
{
  "success": true,
  "level": "debug",
  "persisted": true,
  "message": "Log level updated to debug and saved to configuration"
}
```

### Get Full Logging Configuration

```bash
GET /api/admin/logging/config
```

**Response:**
```json
{
  "level": "info",
  "file": {
    "enabled": false,
    "path": "logs/app.log",
    "maxSize": 10485760,
    "maxFiles": 5
  }
}
```

### Update Full Logging Configuration

```bash
PUT /api/admin/logging/config
Content-Type: application/json

{
  "level": "info",
  "file": {
    "enabled": true,
    "path": "logs/app.log",
    "maxSize": 20971520,
    "maxFiles": 10
  }
}
```

## Usage in Code

### Server-Side Logging

The logger supports both traditional string-based logging and new structured logging with component names.

#### Structured Logging (Recommended)

Use structured logging for better filtering and analysis:

```javascript
import logger from './utils/logger.js';

// Info level with component and structured data
logger.info({
  component: 'ChatService',
  message: 'Chat request received',
  type: 'CHAT_REQUEST',
  id: 'msg-123',
  appId: 'platform',
  modelId: 'gpt-4',
  sessionId: 'session-456',
  user: 'john.doe'
});

// Error level with component
logger.error({
  component: 'Server',
  message: 'Failed to initialize configuration',
  error: error.message,
  stack: error.stack
});

// Warning level with component
logger.warn({
  component: 'AuthService',
  message: 'API key missing for provider',
  provider: 'openai'
});

// Debug level with component and context
logger.debug({
  component: 'RequestBuilder',
  message: 'Processing request',
  method: req.method,
  url: req.url,
  userId: req.user?.id
});
```

#### Traditional Logging (Backward Compatible)

The logger still supports traditional string-based logging:

```javascript
// String messages (automatically converted to structured format)
logger.info('Server started successfully');
logger.warn('API key missing for provider:', providerName);
logger.error('Failed to connect to database:', error);

// String with metadata object
logger.info('User logged in', { 
  component: 'AuthService',
  userId: user.id 
});
```

### Component Naming Convention

Use descriptive component names that identify the source of the log:

- **Server**: Main server operations
- **ChatService**: Chat-related operations
- **AuthService**: Authentication and authorization
- **ConfigCache**: Configuration caching
- **Adapter**: LLM adapter operations (e.g., OpenAIAdapter, AnthropicAdapter)
- **ToolExecutor**: Tool execution
- **RequestBuilder**: Request building
- **[RouteName]**: Route-specific logs (e.g., DataRoutes, AdminRoutes)

### Log Format

#### JSON Format (Default)

When `logging.format` is set to `"json"` (default), logs are output as structured JSON:

```json
{
  "component": "ChatService",
  "level": "info",
  "timestamp": "2026-02-03T11:19:35.830Z",
  "message": "Chat request received",
  "type": "CHAT_REQUEST",
  "id": "msg-1770117575710-703",
  "appId": "platform",
  "modelId": "gpt-4",
  "sessionId": "chat-98bc4fb4-3545",
  "user": "john.doe",
  "query": "How do I...?"
}
```

**Field Order Guarantee:**

The JSON formatter guarantees a consistent field order in all log entries:

1. **`component`** (if present) - Source component/module name
2. **`level`** - Log level (error, warn, info, etc.)
3. **`timestamp`** - ISO 8601 timestamp
4. **`message`** - Log message
5. **All other fields** - Additional attributes in the order they were added

This consistent ordering makes logs easier to read and parse, even when different log entries have different sets of fields.

**Example with varying fields:**

```json
// Log with component
{"component":"Server","level":"info","timestamp":"...","message":"Started"}

// Log without component
{"level":"info","timestamp":"...","message":"Request processed"}

// Log with many extra fields
{"component":"ChatService","level":"info","timestamp":"...","message":"Chat request","appId":"...","modelId":"...","userId":"..."}
```

Benefits:
- Easy to filter by component: `cat logs/app.log | jq 'select(.component == "ChatService")'`
- Query specific fields: `cat logs/app.log | jq 'select(.type == "CHAT_REQUEST")'`
- Compatible with log aggregation tools (Splunk, ELK, Datadog)
- **Consistent field order** makes visual inspection and parsing easier

#### Text Format

When `logging.format` is set to `"text"`, logs include a component tag:

```
2026-02-03 11:19:35 [info][ChatService]: Chat request received {"type":"CHAT_REQUEST","id":"msg-123",...}
2026-02-03 11:19:36 [warn][AuthService]: API key missing for provider {"provider":"openai"}
2026-02-03 11:19:37 [error][Server]: Failed to load model {"error":"ENOENT","path":"/models/invalid.json"}
```

## File Logging

To enable file logging:

1. **Via Admin UI**:
   - Navigate to Admin → System → Logging Configuration
   - Update the logging configuration
   - Enable file logging and set path/size options

2. **Via Configuration File**:
   ```json
   {
     "logging": {
       "level": "info",
       "file": {
         "enabled": true,
         "path": "logs/app.log",
         "maxSize": 10485760,
         "maxFiles": 5
       }
     }
   }
   ```

3. **Via API**:
   ```bash
   curl -X PUT http://localhost:3000/api/admin/logging/config \
     -H "Content-Type: application/json" \
     -H "X-Admin-Secret: your-admin-secret" \
     -d '{
       "level": "info",
       "file": {
         "enabled": true,
         "path": "logs/app.log",
         "maxSize": 10485760,
         "maxFiles": 5
       }
     }'
   ```

### Log Rotation

File logging includes automatic log rotation:
- When a log file reaches `maxSize`, it's rotated
- Old files are kept up to `maxFiles` count
- Files are named: `app.log`, `app.log.1`, `app.log.2`, etc.
- Oldest files are automatically deleted

## Filtering and Querying Logs

### Using jq to Filter JSON Logs

With structured JSON logging, you can easily filter and analyze logs:

```bash
# Filter by component
cat logs/app.log | jq 'select(.component == "ChatService")'

# Filter by log type
cat logs/app.log | jq 'select(.type == "CHAT_REQUEST")'

# Filter by level
cat logs/app.log | jq 'select(.level == "error")'

# Get all errors from a specific component
cat logs/app.log | jq 'select(.component == "Server" and .level == "error")'

# Extract specific fields
cat logs/app.log | jq '{timestamp, component, message, user}'

# Count requests by app
cat logs/app.log | jq 'select(.type == "CHAT_REQUEST") | .appId' | sort | uniq -c

# Find slow requests (if duration is logged)
cat logs/app.log | jq 'select(.duration > 5000)'

# Get all logs for a specific session
cat logs/app.log | jq 'select(.sessionId == "chat-98bc4fb4-3545")'
```

### Using grep for Quick Searches

```bash
# Find all logs from a component
grep '"component":"ChatService"' logs/app.log

# Find specific error messages
grep '"level":"error"' logs/app.log | grep '"component":"Server"'

# Search for a specific user
grep '"user":"john.doe"' logs/app.log

# Find logs within a time range
grep '2026-02-03T11:' logs/app.log
```

### Log Analysis Examples

#### Most Active Components

```bash
cat logs/app.log | jq -r '.component' | sort | uniq -c | sort -rn
```

#### Error Summary

```bash
cat logs/app.log | jq 'select(.level == "error") | {component, message, timestamp}'
```

#### Chat Activity by Model

```bash
cat logs/app.log | jq 'select(.type == "CHAT_REQUEST") | {modelId, user}' | jq -r '.modelId' | sort | uniq -c
```

## Environment-Specific Configuration

### Development

```json
{
  "logging": {
    "level": "debug",
    "file": {
      "enabled": false
    }
  }
}
```

### Production

```json
{
  "logging": {
    "level": "info",
    "file": {
      "enabled": true,
      "path": "/var/log/ihub-apps/app.log",
      "maxSize": 52428800,
      "maxFiles": 10
    }
  }
}
```

### Debugging Issues

```json
{
  "logging": {
    "level": "debug",
    "file": {
      "enabled": true,
      "path": "logs/debug.log",
      "maxSize": 10485760,
      "maxFiles": 3
    }
  }
}
```

## Troubleshooting

### Logs Not Appearing

1. Check the current log level:
   ```bash
   curl http://localhost:3000/api/admin/logging/level
   ```

2. Increase log level to `debug` or `silly`

3. Verify logger is imported correctly in your module:
   ```javascript
   import logger from './utils/logger.js';  // Adjust path as needed
   ```

### Log File Not Created

1. Verify file logging is enabled in configuration
2. Check directory permissions for log file path
3. Ensure the log directory exists (create if needed)
4. Check server logs for file system errors

### Too Many Logs

1. Reduce log level (e.g., from `debug` to `info`)
2. Adjust file rotation settings (reduce `maxFiles`)
3. Consider implementing log filtering in production

## Best Practices

1. **Use structured logging with components**:
   ```javascript
   // Good: Structured with component
   logger.info({
     component: 'ChatService',
     message: 'Processing request',
     requestId: req.id,
     userId: req.user.id
   });
   
   // Avoid: Concatenated string
   logger.info(`Processing request ${req.id} for user ${req.user.id}`);
   ```

2. **Use appropriate log levels**:
   - `error` for failures that require attention
   - `warn` for recoverable issues or deprecation warnings
   - `info` for normal operation milestones
   - `debug` for development details and troubleshooting
   - `http` for HTTP request/response logging
   - `verbose` for detailed trace information

3. **Always include component name**:
   ```javascript
   // Good: Component helps filter and identify log source
   logger.error({
     component: 'OpenAIAdapter',
     message: 'API request failed',
     error: error.message,
     modelId: 'gpt-4'
   });
   
   // Avoid: No component context
   logger.error('API request failed', { error: error.message });
   ```

4. **Structure data for queryability**:
   ```javascript
   // Good: Structured fields can be filtered/aggregated
   logger.info({
     component: 'ChatService',
     message: 'Chat request received',
     type: 'CHAT_REQUEST',
     appId: 'platform',
     modelId: 'gpt-4',
     user: req.user.username,
     sessionId: chatId
   });
   
   // Avoid: Data in message string
   logger.info(`Chat request for app platform with model gpt-4`);
   ```

5. **Avoid sensitive data**:
   - Never log passwords, API keys, or tokens
   - Redact sensitive user information
   - Use sanitization for PII
   - Use user IDs or usernames instead of email addresses when possible

6. **Production settings**:
   - Use `info` or `warn` level
   - Enable file logging with JSON format
   - Set up log rotation
   - Monitor log file sizes
   - Use log aggregation tools (Splunk, ELK, Datadog)

7. **Development settings**:
   - Use `debug` or `verbose` level
   - Console logging only (no file)
   - Review logs regularly
   - Use text format for readability

## Migration Notes

### From console.log to logger

The entire server codebase has been migrated from `console.*` to `logger.*`:

- `console.log()` → `logger.info()`
- `console.error()` → `logger.error()`
- `console.warn()` → `logger.warn()`
- `console.debug()` → `logger.debug()`
- `console.trace()` → `logger.debug()`
- `console.info()` → `logger.info()`

### From String Logs to Structured Logs

Migrating to structured logging is straightforward:

**Before (Concatenated Strings):**
```javascript
logger.info(`[CHAT_REQUEST] ${timestamp} | ID: ${id} | App: ${appId} | Model: ${modelId}`);
```

**After (Structured):**
```javascript
logger.info({
  component: 'ChatService',
  message: 'Chat request received',
  type: 'CHAT_REQUEST',
  id: id,
  appId: appId,
  modelId: modelId,
  timestamp: timestamp
});
```

**Before (Multiple Arguments):**
```javascript
logger.error('Failed to load model:', error);
```

**After (Structured):**
```javascript
logger.error({
  component: 'ModelLoader',
  message: 'Failed to load model',
  error: error.message,
  stack: error.stack,
  modelId: modelId
});
```

### Gradual Migration

The logger supports both old and new formats, so you can migrate gradually:

1. **Keep existing logs working** - No breaking changes
2. **Add components to new logs** - Start using structured logging for new code
3. **Migrate high-value logs** - Convert important logs (errors, chat requests) first
4. **Migrate remaining logs** - Update other logs as you touch the code

### Exceptions

- **`server/telemetry.js`**: Intentionally uses `console.*` for OpenTelemetry integration
- **Test files**: May still use `console.*` for test output

## Further Reading

- [Winston Documentation](https://github.com/winstonjs/winston)
- [Winston Transports](https://github.com/winstonjs/winston/blob/master/docs/transports.md)
- [Winston Formats](https://github.com/winstonjs/winston/blob/master/docs/formats.md)
- [jq Manual](https://stedolan.github.io/jq/manual/) - For JSON log filtering
