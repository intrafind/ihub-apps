# Rate Limiting Implementation

This document describes the rate limiting implementation added to protect the iHub Apps API endpoints.

## Overview

Rate limiting has been implemented using the `express-rate-limit` package to protect against abuse and ensure fair usage of API resources. The implementation includes two distinct rate limiters with different restrictions for normal and administrative endpoints.

## Rate Limiters

### Normal API Rate Limiter
- **Limit**: 100 requests per 15 minutes per IP address
- **Applied to**: All regular API endpoints including:
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
  - `/auth`
  - `/inference`

### Admin API Rate Limiter
- **Limit**: 50 requests per 15 minutes per IP address
- **Applied to**: Administrative endpoints:
  - `/api/admin/*` (all admin routes)

## Configuration

The rate limiters are configured in `server/middleware/rateLimiting.js` and applied in `server/middleware/setup.js`.

### Features
- **Standard Headers**: Returns rate limit information in `RateLimit-*` headers
- **Skip Failed Requests**: Normal API limiter skips failed requests to prevent DoS amplification
- **Error Messages**: Provides clear error messages when rate limits are exceeded
- **Sliding Window**: Uses a 15-minute sliding window for fair distribution

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
  "error": "Too many requests from this IP, please try again later.",
  "retryAfter": "15 minutes"
}
```

## Testing

Rate limiting can be tested by making multiple requests to any protected endpoint:

```bash
# Test normal API rate limiting
curl -I http://localhost:3000/api/apps

# Test admin API rate limiting  
curl -I http://localhost:3000/api/admin/apps
```

The response headers will show the current rate limit status.

## Security Impact

This implementation addresses GitHub security finding #217 by adding comprehensive rate limiting to all API endpoints, preventing abuse and ensuring the server remains available for legitimate users.