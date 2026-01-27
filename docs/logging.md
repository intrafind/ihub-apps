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

```javascript
import logger from './utils/logger.js';

// Info level (general information)
logger.info('Server started successfully');
logger.info('User logged in:', { userId: user.id });

// Warning level (potential issues)
logger.warn('API key missing for provider:', providerName);
logger.warn('Configuration validation failed');

// Error level (critical issues)
logger.error('Failed to connect to database:', error);
logger.error('Request failed:', { error: error.message, stack: error.stack });

// Debug level (development)
logger.debug('Processing request:', { method: req.method, url: req.url });
logger.debug('Cache hit:', { key: cacheKey });

// HTTP level (API requests)
logger.http('GET /api/health - 200 OK');
```

### Log Format

Console output includes:
- **Timestamp**: `YYYY-MM-DD HH:mm:ss`
- **Level**: Colored (error=red, warn=yellow, info=green, etc.)
- **Message**: Primary log message
- **Metadata**: Additional data as JSON

Example:
```
2026-01-27 23:12:47 [info]: Server is running on http://0.0.0.0:3000
2026-01-27 23:12:47 [warn]: ⚠️ WARNING: Missing API keys for providers: openai, anthropic
2026-01-27 23:12:48 [error]: Failed to load model: {"error":"ENOENT","path":"/models/invalid.json"}
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

1. **Use appropriate log levels**:
   - `error` for failures
   - `warn` for recoverable issues
   - `info` for normal operation
   - `debug` for development details

2. **Include context in logs**:
   ```javascript
   logger.error('Failed to process request', { 
     userId: req.user.id, 
     endpoint: req.path,
     error: error.message 
   });
   ```

3. **Avoid sensitive data**:
   - Never log passwords, API keys, or tokens
   - Redact sensitive user information
   - Use sanitization for PII

4. **Production settings**:
   - Use `info` or `warn` level
   - Enable file logging
   - Set up log rotation
   - Monitor log file sizes

5. **Development settings**:
   - Use `debug` or `verbose` level
   - Console logging only (no file)
   - Review logs regularly

## Migration Notes

### From console.log to logger

The entire server codebase has been migrated from `console.*` to `logger.*`:

- `console.log()` → `logger.info()`
- `console.error()` → `logger.error()`
- `console.warn()` → `logger.warn()`
- `console.debug()` → `logger.debug()`
- `console.trace()` → `logger.debug()`
- `console.info()` → `logger.info()`

### Exceptions

- **`server/telemetry.js`**: Intentionally uses `console.*` for OpenTelemetry integration
- **Test files**: May still use `console.*` for test output

## Further Reading

- [Winston Documentation](https://github.com/winstonjs/winston)
- [Winston Transports](https://github.com/winstonjs/winston/blob/master/docs/transports.md)
- [Winston Formats](https://github.com/winstonjs/winston/blob/master/docs/formats.md)
