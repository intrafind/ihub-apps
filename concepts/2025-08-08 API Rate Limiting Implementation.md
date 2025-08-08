# 2025-08-08 API Rate Limiting Implementation

## Overview

Implementation of comprehensive rate limiting for all API endpoints to address GitHub security finding #217 and protect the iHub Apps server against abuse and DoS attacks.

## Problem Statement

GitHub's security scanning identified missing rate limiting on the `/api/tools/:toolId` route (lines 45-71 in `toolRoutes.js`). The absence of rate limiting across all API endpoints posed security risks including:

- Potential DoS attacks through excessive requests
- Resource exhaustion from uncontrolled API usage
- Lack of fair usage enforcement across users

## Solution Design

### Two-Tier Rate Limiting Approach

**Normal API Rate Limiter**
- Limit: 100 requests per 15 minutes per IP
- Applied to: Regular API endpoints (`/api/apps`, `/api/tools`, `/api/models`, etc.)
- Purpose: Allow generous usage for normal operations while preventing abuse

**Admin API Rate Limiter**  
- Limit: 50 requests per 15 minutes per IP
- Applied to: Administrative endpoints (`/api/admin/*`)
- Purpose: More restrictive limits for sensitive administrative operations

### Technical Implementation

**Package**: `express-rate-limit` v7.x
- Industry-standard, well-maintained rate limiting middleware
- Provides sliding window rate limiting
- Supports standard rate limit headers
- Memory-based storage (suitable for current architecture)

**Integration Points**:
- `server/middleware/rateLimiting.js`: Rate limiter configurations
- `server/middleware/setup.js`: Middleware application to routes
- Applied early in middleware chain for maximum protection

## Implementation Details

### Files Modified/Created

1. **`server/middleware/rateLimiting.js`** (NEW)
   - Defines two rate limiter instances
   - Configures error messages and headers
   - Optimizes for different use cases (normal vs admin)

2. **`server/middleware/setup.js`** (MODIFIED)
   - Added import for rate limiting middleware
   - Applied rate limiters to appropriate route patterns
   - Integrated into existing middleware chain

3. **`server/package.json`** (MODIFIED)
   - Added `express-rate-limit` dependency

### Rate Limiter Configuration

```javascript
// Normal API: More permissive
windowMs: 15 * 60 * 1000,  // 15 minutes
limit: 100,                 // 100 requests per window
skipFailedRequests: true    // Don't count failed requests

// Admin API: More restrictive  
windowMs: 15 * 60 * 1000,  // 15 minutes
limit: 50,                  // 50 requests per window
skipFailedRequests: false   // Count all requests
```

## Response Headers

Standard rate limit headers are provided:
- `RateLimit-Policy`: Policy description
- `RateLimit-Limit`: Maximum requests allowed
- `RateLimit-Remaining`: Requests remaining in window
- `RateLimit-Reset`: Seconds until reset

## Security Benefits

1. **DoS Protection**: Prevents overwhelming the server with excessive requests
2. **Resource Conservation**: Ensures fair resource allocation across users
3. **Abuse Prevention**: Limits automated attacks and scraping attempts
4. **Compliance**: Addresses GitHub security finding #217

## Testing Results

- ✅ Server startup: No performance impact
- ✅ Header verification: Correct rate limit headers present
- ✅ Route coverage: All intended endpoints protected
- ✅ Development workflow: No interference with normal development

## Future Considerations

1. **Persistent Storage**: Consider Redis-based storage for multi-instance deployments
2. **Dynamic Configuration**: Make rate limits configurable via platform settings
3. **User-Based Limiting**: Implement per-user rate limiting in addition to per-IP
4. **Monitoring**: Add rate limiting metrics to telemetry system

## Related Files

- `server/middleware/rateLimiting.js`: Rate limiter definitions
- `server/middleware/setup.js`: Middleware integration
- `server/routes/toolRoutes.js`: Originally flagged route (now protected)
- `docs/rate-limiting.md`: User documentation

## Decision Log

- **express-rate-limit**: Chosen for reliability and industry adoption
- **Two-tier approach**: Balances usability with security requirements
- **15-minute window**: Provides reasonable protection without hindering normal usage
- **Memory storage**: Sufficient for current single-instance architecture
- **Early middleware**: Applied before authentication for maximum protection