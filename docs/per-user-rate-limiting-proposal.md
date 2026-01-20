# Per-User Rate Limiting Implementation Proposal

## Executive Summary

This document proposes implementing per-user rate limiting as an enhancement to the existing IP-based rate limiting system. Per-user rate limiting provides more accurate tracking of API usage, better handles shared IP scenarios (proxies, corporate networks), and allows differentiated rate limits based on user roles and permissions.

## Problem Statement

### Current Limitations (IP-Based Rate Limiting)

1. **Shared IPs**: Multiple users behind corporate proxies/NAT share the same IP address
2. **No User Differentiation**: Admins and regular users have the same limits per IP
3. **False Positives**: Legitimate users get blocked when sharing IPs with heavy users
4. **Limited Granularity**: Cannot set different limits based on user roles/groups
5. **Anonymous Access**: Cannot effectively rate limit anonymous users vs authenticated users

### Use Cases Requiring Per-User Rate Limiting

- **Corporate Environments**: Many users behind single proxy IP
- **Role-Based Limits**: Admins need higher limits than regular users
- **Premium Tiers**: Different user groups with different allowances
- **User Abuse**: Track and limit specific problematic users
- **Compliance**: Track per-user API usage for auditing/billing

## Proposed Solution

### Architecture Overview

Implement a **hybrid rate limiting system** that combines:
1. **IP-based rate limiting** (primary, for brute force protection)
2. **User-based rate limiting** (secondary, for authenticated users)
3. **Fallback to IP** when user is not authenticated

### Key Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Rate Limiting Flow                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Request → Authentication → Rate Limit Check → Response     │
│                    │              │                          │
│                    │              ├─→ IP-based (unauthenticated)
│                    │              └─→ User-based (authenticated)
│                    │                                          │
│                    └─→ Store user in req.user                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Design

### 1. Enhanced Rate Limiting Configuration

Add per-user configuration options to `platform.json`:

```json
{
  "rateLimit": {
    "strategy": "hybrid",  // "ip-only" | "user-only" | "hybrid"
    "default": {
      "windowMs": 900000,
      "limit": 150,
      "standardHeaders": true,
      "legacyHeaders": false,
      "skipSuccessfulRequests": false,
      "skipFailedRequests": true
    },
    "perUser": {
      "enabled": true,
      "store": "memory",  // "memory" | "redis" | "database"
      "keyPrefix": "rl:user:",
      "skipAnonymous": false,  // If true, anonymous users use IP-based only
      "groupLimits": {
        "admin": {
          "limit": 500,
          "windowMs": 900000
        },
        "users": {
          "limit": 200,
          "windowMs": 900000
        },
        "authenticated": {
          "limit": 150,
          "windowMs": 900000
        },
        "anonymous": {
          "limit": 50,
          "windowMs": 900000
        }
      }
    },
    "adminApi": {
      "windowMs": 60000,
      "limit": 100,
      "perUser": {
        "enabled": true,
        "limit": 200  // Higher limit for authenticated admin users
      }
    },
    "publicApi": {
      "limit": 150
    },
    "authApi": {
      "windowMs": 900000,
      "limit": 30,
      "skipFailedRequests": false
    },
    "inferenceApi": {
      "windowMs": 60000,
      "limit": 100,
      "perUser": {
        "enabled": true,
        "groupLimits": {
          "admin": 300,
          "users": 150,
          "authenticated": 100
        }
      }
    }
  }
}
```

### 2. New Middleware: `rateLimitingPerUser.js`

Create `server/middleware/rateLimitingPerUser.js`:

```javascript
import rateLimit from 'express-rate-limit';

/**
 * Generate rate limit key based on strategy
 * @param {Object} req - Express request object
 * @param {Object} config - Rate limit configuration
 * @returns {string} - Rate limit key
 */
function generateRateLimitKey(req, config = {}) {
  const strategy = config.strategy || 'hybrid';
  const perUserConfig = config.perUser || {};

  // If per-user is disabled or user is not authenticated, use IP
  if (!perUserConfig.enabled || !req.user) {
    return req.ip;
  }

  // Skip anonymous users if configured
  if (perUserConfig.skipAnonymous && req.user.isAnonymous) {
    return req.ip;
  }

  // Use user ID for authenticated users
  const keyPrefix = perUserConfig.keyPrefix || 'rl:user:';

  switch (strategy) {
    case 'user-only':
      return `${keyPrefix}${req.user.id}`;

    case 'hybrid':
      // Use user ID if authenticated, otherwise use IP
      return req.user ? `${keyPrefix}${req.user.id}` : req.ip;

    case 'ip-only':
    default:
      return req.ip;
  }
}

/**
 * Get rate limit for user based on their highest privilege group
 * @param {Object} user - User object with groups
 * @param {Object} groupLimits - Group-specific limits
 * @param {number} defaultLimit - Default limit if no group match
 * @returns {number} - Rate limit for the user
 */
function getUserRateLimit(user, groupLimits = {}, defaultLimit = 100) {
  if (!user || !user.groups || user.groups.length === 0) {
    return groupLimits.anonymous || defaultLimit;
  }

  // Priority order: admin > users > authenticated > anonymous
  const priorityGroups = ['admin', 'users', 'authenticated', 'anonymous'];

  for (const groupName of priorityGroups) {
    if (user.groups.includes(groupName) && groupLimits[groupName]) {
      return groupLimits[groupName];
    }
  }

  return defaultLimit;
}

/**
 * Create a per-user rate limiter with group-based limits
 * @param {Object} config - Rate limiter configuration
 * @param {Object} defaults - Default configuration
 * @param {string} type - Type of rate limiter
 * @returns {Function} Express rate limiter middleware
 */
export function createPerUserRateLimiter(config = {}, defaults = {}, type = 'API') {
  const finalConfig = { ...defaults, ...config };
  const perUserConfig = finalConfig.perUser || {};

  return rateLimit({
    windowMs: finalConfig.windowMs || 15 * 60 * 1000,

    // Dynamic limit based on user's group
    limit: (req) => {
      if (!perUserConfig.enabled || !req.user) {
        return finalConfig.limit || 100;
      }

      const groupLimits = perUserConfig.groupLimits || {};
      return getUserRateLimit(req.user, groupLimits, finalConfig.limit);
    },

    // Dynamic key generation (IP or User ID)
    keyGenerator: (req) => {
      return generateRateLimitKey(req, finalConfig);
    },

    // Custom handler with user context
    handler: (req, res) => {
      const key = generateRateLimitKey(req, finalConfig);
      const isUserBased = key.startsWith(perUserConfig.keyPrefix || 'rl:user:');

      res.status(429).json({
        error: `Too many ${type.toLowerCase()} requests, please try again later.`,
        retryAfter: `${Math.ceil((finalConfig.windowMs || 15 * 60 * 1000) / 60000)} minutes`,
        limitType: isUserBased ? 'per-user' : 'per-ip',
        userId: isUserBased && req.user ? req.user.id : undefined
      });
    },

    message: finalConfig.message || {
      error: `Too many ${type.toLowerCase()} requests, please try again later.`,
      retryAfter: `${Math.ceil((finalConfig.windowMs || 15 * 60 * 1000) / 60000)} minutes`
    },

    standardHeaders: finalConfig.standardHeaders !== undefined ? finalConfig.standardHeaders : true,
    legacyHeaders: finalConfig.legacyHeaders !== undefined ? finalConfig.legacyHeaders : false,
    skipSuccessfulRequests: finalConfig.skipSuccessfulRequests !== undefined ? finalConfig.skipSuccessfulRequests : false,
    skipFailedRequests: finalConfig.skipFailedRequests !== undefined ? finalConfig.skipFailedRequests : false,

    // Store configuration (default: memory, can be Redis for distributed systems)
    store: perUserConfig.store === 'redis' ? createRedisStore() : undefined
  });
}

/**
 * Create Redis store for distributed rate limiting (optional)
 * Requires 'rate-limit-redis' package
 */
function createRedisStore() {
  // This is a placeholder - requires rate-limit-redis package
  // import { RedisStore } from 'rate-limit-redis';
  // import { createClient } from 'redis';
  //
  // const client = createClient({
  //   url: process.env.REDIS_URL || 'redis://localhost:6379'
  // });
  //
  // return new RedisStore({
  //   client: client,
  //   prefix: 'rl:',
  // });

  console.warn('Redis store requested but not configured. Falling back to memory store.');
  return undefined;
}

/**
 * Create all rate limiters with per-user support
 * @param {Object} platformConfig - Platform configuration object
 * @returns {Object} Object containing all rate limiters
 */
export function createPerUserRateLimiters(platformConfig = {}) {
  const rateLimitConfig = platformConfig.rateLimit || {};

  // Default configuration
  const defaultConfig = {
    windowMs: 15 * 60 * 1000,
    limit: 150,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: true,
    perUser: {
      enabled: false,
      store: 'memory',
      keyPrefix: 'rl:user:',
      skipAnonymous: false
    },
    ...rateLimitConfig.default
  };

  // Admin API configuration
  const adminApiConfig = {
    ...defaultConfig,
    windowMs: 60000,  // 1 minute
    limit: 100,
    skipFailedRequests: true,
    perUser: {
      ...defaultConfig.perUser,
      enabled: true,
      groupLimits: {
        admin: 200,
        users: 100
      }
    },
    ...rateLimitConfig.adminApi
  };

  // Public API configuration
  const publicApiConfig = {
    ...defaultConfig,
    limit: 150,
    ...rateLimitConfig.publicApi
  };

  // Auth API configuration
  const authApiConfig = {
    ...defaultConfig,
    limit: 30,
    windowMs: 15 * 60 * 1000,
    skipFailedRequests: false,
    ...rateLimitConfig.authApi
  };

  // Inference API configuration
  const inferenceApiConfig = {
    ...defaultConfig,
    windowMs: 60000,  // 1 minute
    limit: 100,
    perUser: {
      ...defaultConfig.perUser,
      enabled: true,
      groupLimits: {
        admin: 300,
        users: 150,
        authenticated: 100,
        anonymous: 50
      }
    },
    ...rateLimitConfig.inferenceApi
  };

  return {
    adminApiLimiter: createPerUserRateLimiter(adminApiConfig, {}, 'admin API'),
    publicApiLimiter: createPerUserRateLimiter(publicApiConfig, {}, 'public API'),
    authApiLimiter: createPerUserRateLimiter(authApiConfig, {}, 'authentication'),
    inferenceApiLimiter: createPerUserRateLimiter(inferenceApiConfig, {}, 'inference API')
  };
}
```

### 3. Integration with Existing Setup

Update `server/middleware/setup.js`:

```javascript
// Import both rate limiting strategies
import { createRateLimiters } from './rateLimiting.js';
import { createPerUserRateLimiters } from './rateLimitingPerUser.js';

export function setupMiddleware(app, platformConfig = {}) {
  // ... existing middleware setup ...

  // Create rate limiters based on configuration
  const rateLimitConfig = platformConfig.rateLimit || {};
  const usePerUserLimiting = rateLimitConfig.perUser?.enabled || rateLimitConfig.strategy === 'user-only';

  const rateLimiters = usePerUserLimiting
    ? createPerUserRateLimiters(platformConfig)
    : createRateLimiters(platformConfig);

  // Apply rate limiters
  app.use('/api/apps', rateLimiters.publicApiLimiter);
  app.use('/api/tools', rateLimiters.publicApiLimiter);
  // ... rest of the rate limiter applications ...
}
```

### 4. Database Schema (Optional - for persistence)

If using database storage instead of memory/Redis:

```sql
CREATE TABLE rate_limit_records (
  id SERIAL PRIMARY KEY,
  key_type VARCHAR(10) NOT NULL,  -- 'ip' or 'user'
  key_value VARCHAR(255) NOT NULL,
  endpoint_type VARCHAR(50) NOT NULL,  -- 'admin', 'public', 'auth', 'inference'
  request_count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  user_id VARCHAR(255),
  user_groups TEXT[],
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(key_type, key_value, endpoint_type, window_start)
);

CREATE INDEX idx_rate_limit_key ON rate_limit_records(key_type, key_value, endpoint_type);
CREATE INDEX idx_rate_limit_window ON rate_limit_records(window_end);
CREATE INDEX idx_rate_limit_user ON rate_limit_records(user_id);
```

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create `rateLimitingPerUser.js` middleware
- [ ] Add configuration schema validation
- [ ] Implement key generation logic
- [ ] Add group-based limit resolution
- [ ] Unit tests for key generation and limit resolution

### Phase 2: Integration (Week 2)
- [ ] Integrate with existing authentication middleware
- [ ] Update `setup.js` to support both strategies
- [ ] Add configuration migration support
- [ ] Integration tests for hybrid mode

### Phase 3: Enhanced Features (Week 3)
- [ ] Add Redis support for distributed systems
- [ ] Implement database persistence option
- [ ] Add admin API for viewing rate limit status per user
- [ ] Add user-facing rate limit status endpoint

### Phase 4: Monitoring & Documentation (Week 4)
- [ ] Add logging for rate limit events
- [ ] Create admin dashboard for rate limit monitoring
- [ ] Update documentation
- [ ] Performance testing and optimization

## Benefits

### Immediate Benefits
1. **Better Admin Experience**: Admins get higher limits based on their role
2. **Fair Resource Distribution**: Individual users tracked separately
3. **Reduced False Positives**: Shared IPs don't penalize all users
4. **Better Security**: Track and limit specific problematic users

### Long-Term Benefits
1. **Compliance Ready**: Per-user tracking for auditing
2. **Scalable**: Ready for premium tiers and user-based billing
3. **Flexible**: Easy to adjust limits per user group
4. **Observable**: Better monitoring and analytics

## Migration Path

### For Existing Deployments

1. **Backward Compatible**: Default to IP-based if not configured
2. **Gradual Rollout**: Enable per-user limiting per endpoint type
3. **Testing**: Run hybrid mode to compare IP vs user-based
4. **Migration Script**: No database changes required for memory store

### Configuration Migration

```javascript
// Old configuration (still supported)
{
  "rateLimit": {
    "adminApi": {
      "limit": 50
    }
  }
}

// New configuration (enhanced)
{
  "rateLimit": {
    "strategy": "hybrid",
    "perUser": {
      "enabled": true
    },
    "adminApi": {
      "limit": 100,  // Default for IP-based
      "perUser": {
        "enabled": true,
        "groupLimits": {
          "admin": 200
        }
      }
    }
  }
}
```

## Testing Strategy

### Unit Tests
- Key generation for different scenarios (authenticated, anonymous, no user)
- Group-based limit resolution with priority
- Configuration merging and defaults

### Integration Tests
- Rate limiting with authenticated users
- Rate limiting with anonymous users
- Shared IP scenarios
- Group-based limit enforcement

### Performance Tests
- Memory usage with many users
- Lookup performance for user-based keys
- Comparison: IP-based vs user-based performance

### Load Tests
- Concurrent requests from same user
- Concurrent requests from multiple users on same IP
- Rate limit accuracy under high load

## Security Considerations

1. **User Enumeration**: Rate limit responses shouldn't leak user existence
2. **Key Collisions**: Use proper prefixes to separate IP and user keys
3. **Memory Exhaustion**: Implement max keys limit for memory store
4. **Redis Security**: Secure Redis connection in distributed setup
5. **Audit Logging**: Log rate limit violations for security analysis

## Performance Considerations

### Memory Store
- **Pros**: Fast, no external dependencies, simple
- **Cons**: Not shared across workers/servers, lost on restart
- **Use Case**: Single-server deployments, development

### Redis Store
- **Pros**: Shared across instances, persistent, fast
- **Cons**: Requires Redis, network latency, operational complexity
- **Use Case**: Production, multi-server deployments, high availability

### Database Store
- **Pros**: Persistent, queryable, audit trail
- **Cons**: Slower, higher load on database
- **Use Case**: Compliance requirements, detailed analytics needed

## Monitoring & Observability

### Metrics to Track
1. Rate limit hits per endpoint type
2. Rate limit hits per user group
3. Most rate-limited users
4. Average requests per user/IP
5. False positive rate (legitimate users blocked)

### Admin Dashboard Features
- Real-time rate limit status per user
- Historical rate limit violations
- Ability to temporarily increase user limits
- Ability to whitelist/blacklist users
- Rate limit effectiveness analytics

### Logging
```javascript
{
  "event": "rate_limit_exceeded",
  "timestamp": "2025-11-12T10:30:00Z",
  "limitType": "per-user",
  "userId": "user123",
  "userGroups": ["users", "authenticated"],
  "endpoint": "/api/admin/apps",
  "limit": 100,
  "windowMs": 60000,
  "ip": "192.168.1.100"
}
```

## Cost-Benefit Analysis

### Development Cost
- Initial implementation: ~2-3 weeks
- Testing and QA: ~1 week
- Documentation: ~2-3 days
- **Total**: ~1 month

### Operational Cost
- Memory overhead: Minimal (user ID keys instead of IPs)
- Redis (if used): Standard Redis hosting costs
- Performance impact: Negligible (<1ms per request)

### Benefits
- Improved user experience (fewer false positives)
- Better security (per-user tracking)
- Compliance ready
- Premium tier foundation
- Better resource management

## Alternatives Considered

### 1. IP-Only with Whitelist
- **Pros**: Simple, no code changes
- **Cons**: Doesn't solve shared IP problem, manual maintenance

### 2. External Rate Limiting Service (e.g., Cloudflare)
- **Pros**: Offloads complexity
- **Cons**: Cost, vendor lock-in, less control

### 3. API Gateway with Rate Limiting
- **Pros**: Centralized, feature-rich
- **Cons**: Architecture change, operational complexity, cost

## Conclusion

Implementing per-user rate limiting provides significant benefits for multi-user environments, especially in corporate settings with shared IPs. The proposed hybrid approach maintains backward compatibility while enabling fine-grained control based on user roles and groups.

The implementation is straightforward, leveraging the existing `express-rate-limit` package with custom key generation and group-based limits. The phased approach allows for gradual rollout and testing.

## Next Steps

1. **Review and Approve** this proposal
2. **Prioritize** implementation phases
3. **Assign Resources** for development
4. **Set Timeline** based on business priorities
5. **Plan Testing** strategy and QA resources

## References

- [express-rate-limit Documentation](https://github.com/express-rate-limit/express-rate-limit)
- [rate-limit-redis Documentation](https://github.com/express-rate-limit/rate-limit-redis)
- [OWASP Rate Limiting Guidelines](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)
- Current implementation: `server/middleware/rateLimiting.js`
