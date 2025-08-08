# Rate Limiting Implementation

This document describes the comprehensive rate limiting implementation added to protect the iHub Apps API endpoints.

## Overview

Rate limiting has been implemented using the `express-rate-limit` package to protect against abuse and ensure fair usage of API resources. The implementation includes configurable rate limiters with different restrictions for various endpoint types.

## Rate Limiting Types

The system supports five different types of rate limiters, each configurable through the platform configuration:

### 1. Public API Rate Limiter
- **Default Limit**: 100 requests per 15 minutes per IP address
- **Applied to**: Regular API endpoints including:
  - `/api/apps`
  - `/api/tools` (including `/api/tools/:toolId`)
  - `/api/models`
  - `/api/prompts`
  - `/api/styles`
  - `/api/translations`
  - `/api/configs`
  - `/api/sessions`
  - `/api/pages`
  - `/api/magic-prompts`
  - `/api/short-links`

### 2. Admin API Rate Limiter
- **Default Limit**: 50 requests per 15 minutes per IP address (more restrictive)
- **Applied to**: Administrative endpoints:
  - `/api/admin/*` (all admin routes)

### 3. Auth API Rate Limiter
- **Default Limit**: 30 requests per 15 minutes per IP address (most restrictive)
- **Applied to**: Authentication endpoints:
  - `/auth/*` (all authentication routes)

### 4. Inference API Rate Limiter
- **Default Limit**: 60 requests per 15 minutes per IP address (moderate)
- **Applied to**: AI inference endpoints:
  - `/inference/*` (all inference routes)

### 5. Default Rate Limiter
- **Default Limit**: 100 requests per 15 minutes per IP address
- **Purpose**: Base configuration that other limiters inherit from

## Configuration

Rate limiting is now fully configurable through the `platform.json` configuration file. Add the following section to customize rate limiting:

```json
{
  "rateLimit": {
    "default": {
      "windowMs": 900000,
      "limit": 100,
      "standardHeaders": true,
      "legacyHeaders": false,
      "skipSuccessfulRequests": false,
      "skipFailedRequests": true
    },
    "adminApi": {
      "limit": 50,
      "skipFailedRequests": false
    },
    "publicApi": {},
    "authApi": {
      "limit": 30,
      "skipFailedRequests": false
    },
    "inferenceApi": {
      "limit": 60
    }
  }
}
```

### Configuration Options

Each rate limiter supports the following configuration options:

- `windowMs`: Time window in milliseconds (default: 900000 = 15 minutes)
- `limit`: Maximum number of requests per window (varies by type)
- `standardHeaders`: Return rate limit info in `RateLimit-*` headers (default: true)
- `legacyHeaders`: Enable legacy `X-RateLimit-*` headers (default: false)
- `skipSuccessfulRequests`: Don't count successful requests (default: false)
- `skipFailedRequests`: Don't count failed requests (default: varies by type)
- `message`: Custom error message when limit exceeded

### Inheritance

All rate limiters inherit from the `default` configuration. You only need to specify the options you want to override for each type. Empty configurations (`{}`) will use the default settings.

## Implementation Details

The rate limiters are implemented in `server/middleware/rateLimiting.js` using a factory pattern that creates configured limiters based on platform settings. They are applied in `server/middleware/setup.js` during application initialization.

### Features
- **Configurable Limits**: All parameters can be customized per endpoint type
- **Standard Headers**: Returns rate limit information in `RateLimit-*` headers
- **Smart Skipping**: Different behaviors for failed requests based on endpoint type
- **Clear Error Messages**: Provides helpful error messages when limits are exceeded
- **Sliding Window**: Uses a sliding window approach for fair distribution

## Response Headers

When rate limiting is active, the following headers are returned:

- `RateLimit-Policy`: Shows the policy (e.g., "100;w=900" for 100 requests per 900 seconds)
- `RateLimit-Limit`: Maximum number of requests allowed
- `RateLimit-Remaining`: Number of requests remaining in the current window
- `RateLimit-Reset`: Time in seconds until the rate limit resets

## Error Response

When rate limits are exceeded, a 429 status code is returned with a JSON error message:

```json
{
  "error": "Too many [type] requests from this IP, please try again later.",
  "retryAfter": "15 minutes"
}
```

## Testing

Rate limiting can be tested by making multiple requests to any protected endpoint:

```bash
# Test public API rate limiting
curl -I http://localhost:3000/api/apps

# Test admin API rate limiting  
curl -I http://localhost:3000/api/admin/apps

# Test auth API rate limiting
curl -I http://localhost:3000/auth/login

# Test inference API rate limiting
curl -I http://localhost:3000/inference/chat
```

The response headers will show the current rate limit status.

## Security Impact

This implementation addresses GitHub security finding #217 by adding comprehensive, configurable rate limiting to all API endpoints, preventing abuse and ensuring the server remains available for legitimate users while allowing fine-tuned control over different endpoint types.