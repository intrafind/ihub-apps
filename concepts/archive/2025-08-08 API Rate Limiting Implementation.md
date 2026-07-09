# 2025-08-08 API Rate Limiting Implementation

## Overview

Implementation of comprehensive, configurable rate limiting for all API endpoints to address GitHub security finding #217 and protect the iHub Apps server against abuse and DoS attacks.

## Problem Statement

GitHub's security scanning identified missing rate limiting on the `/api/tools/:toolId` route (lines 45-71 in `toolRoutes.js`). The absence of rate limiting across all API endpoints posed security risks including:

- Potential DoS attacks through excessive requests
- Resource exhaustion from uncontrolled API usage
- Lack of fair usage enforcement across users

## Solution Design

### Multi-Tier Configurable Rate Limiting Approach

**1. Public API Rate Limiter**
- Default Limit: 100 requests per 15 minutes per IP
- Applied to: Regular API endpoints (`/api/apps`, `/api/tools`, `/api/models`, etc.)
- Purpose: Allow generous usage for normal operations while preventing abuse

**2. Admin API Rate Limiter**  
- Default Limit: 50 requests per 15 minutes per IP
- Applied to: Administrative endpoints (`/api/admin/*`)
- Purpose: More restrictive limits for sensitive administrative operations

**3. Auth API Rate Limiter**
- Default Limit: 30 requests per 15 minutes per IP
- Applied to: Authentication endpoints (`/auth/*`)
- Purpose: Most restrictive limits for authentication to prevent brute force attacks

**4. Inference API Rate Limiter**
- Default Limit: 60 requests per 15 minutes per IP  
- Applied to: AI inference endpoints (`/inference/*`)
- Purpose: Moderate limits for resource-intensive AI operations

**5. Default Configuration**
- Base configuration that all other limiters inherit from
- Provides global defaults that can be overridden per endpoint type

### Technical Implementation

**Package**: `express-rate-limit` v7.x
- Industry-standard, well-maintained rate limiting middleware
- Provides sliding window rate limiting
- Supports standard rate limit headers
- Memory-based storage (suitable for current architecture)

**Configuration System**:
- Fully configurable through `platform.json`
- Inheritance model where specific limiters override default settings
- Factory pattern for creating configured rate limiters

**Integration Points**:
- `server/middleware/rateLimiting.js`: Configurable rate limiter factory
- `server/middleware/setup.js`: Middleware application using platform config
- `server/validators/platformConfigSchema.js`: Configuration validation
- Applied early in middleware chain for maximum protection

## Implementation Details

### Files Modified/Created

1. **`server/middleware/rateLimiting.js`** (MODIFIED)
   - Added configurable rate limiter factory
   - Supports inheritance from default configuration
   - Maintains backward compatibility

2. **`server/middleware/setup.js`** (MODIFIED)
   - Updated to use configurable rate limiters
   - Separated auth and inference endpoints from public API
   - Applies appropriate limiter to each endpoint type

3. **`server/validators/platformConfigSchema.js`** (MODIFIED)
   - Added comprehensive rate limiting configuration schema
   - Validation for all rate limiting parameters

4. **Platform Configuration Files** (MODIFIED)
   - `server/defaults/config/platform.json`: Default rate limiting configuration
   - `configs/config/platform.json`: User-customizable rate limiting settings

5. **`docs/rate-limiting.md`** (MODIFIED)
   - Updated documentation for configurable approach
   - Added configuration examples and inheritance explanation

### Rate Limiter Configuration Schema

```json
{
  "rateLimit": {
    "default": {
      "windowMs": 900000,        // 15 minutes in milliseconds
      "limit": 100,              // Default request limit
      "standardHeaders": true,    // Return RateLimit-* headers
      "legacyHeaders": false,     // Don't return X-RateLimit-* headers
      "skipSuccessfulRequests": false,
      "skipFailedRequests": true  // Don't count failed requests
    },
    "adminApi": {
      "limit": 50,               // Override: more restrictive
      "skipFailedRequests": false // Override: count all requests
    },
    "publicApi": {},             // Inherits all from default
    "authApi": {
      "limit": 30,               // Override: most restrictive
      "skipFailedRequests": false
    },
    "inferenceApi": {
      "limit": 60                // Override: moderate limit
    }
  }
}
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
4. **Endpoint-Specific Security**: Different protection levels for different endpoint types
5. **Configuration Flexibility**: Allows customization without code changes
6. **Compliance**: Addresses GitHub security finding #217

## Testing Results

- ✅ Server startup: No performance impact with configurable approach
- ✅ Header verification: Correct rate limit headers for each endpoint type
- ✅ Route coverage: All intended endpoints protected with appropriate limits
- ✅ Configuration validation: Schema validation prevents invalid configurations
- ✅ Development workflow: No interference with normal development

## Configuration Benefits

1. **No Code Changes**: Rate limits can be adjusted via configuration
2. **Environment-Specific**: Different limits for development, staging, production
3. **Customer Customization**: Allows customers to adjust limits per their needs
4. **Inheritance Model**: Reduces configuration duplication through defaults
5. **Validation**: Schema ensures valid configurations prevent runtime errors

## Future Considerations

1. **Persistent Storage**: Consider Redis-based storage for multi-instance deployments
2. **User-Based Limiting**: Implement per-user rate limiting in addition to per-IP
3. **Monitoring**: Add rate limiting metrics to telemetry system
4. **Advanced Policies**: Implement burst limiting and dynamic rate adjustments

## Related Files

- `server/middleware/rateLimiting.js`: Configurable rate limiter factory
- `server/middleware/setup.js`: Middleware integration with platform config
- `server/validators/platformConfigSchema.js`: Configuration schema
- `server/defaults/config/platform.json`: Default configuration
- `configs/config/platform.json`: User configuration
- `docs/rate-limiting.md`: User documentation

## Decision Log

- **express-rate-limit**: Chosen for reliability and industry adoption
- **Multi-tier approach**: Balances different security needs per endpoint type
- **Configuration-driven**: Enables customization without code deployment
- **Inheritance model**: Reduces duplication while allowing specific overrides
- **15-minute window**: Provides reasonable protection without hindering normal usage
- **Memory storage**: Sufficient for current single-instance architecture
- **Early middleware**: Applied before authentication for maximum protection
- **Schema validation**: Ensures configuration integrity and prevents runtime errors