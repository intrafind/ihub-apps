# Pluggable Persistence Layer Concept

**Date:** 2025-07-24  
**Issue:** #235 - Implement support for external persistent layer  
**Status:** Concept/Research Phase  
**Author:** Analysis based on codebase research

## Overview

Currently, the AI Hub Apps platform stores all data in the filesystem, which prevents horizontal scaling. This concept outlines the analysis of the current persistence architecture and provides a roadmap for implementing a pluggable persistence layer that can support databases, OpenSearch, and Spring Cloud Server.

## Current Persistence Analysis

The codebase has three main categories of data persistence:

### 1. Configuration Data (`configCache.js` + `/contents/config/`)

**Current Implementation:**
- Platform, apps, models, groups, UI settings stored in JSON files
- In-memory cache with 5-minute TTL in production, 1-minute in development
- Environment variable resolution and group inheritance at load time
- Read-heavy, infrequent writes (only admin changes)
- ETag generation for HTTP caching using MD5 hash

**Key Files:**
- `server/configCache.js` - Main caching system
- `contents/config/*.json` - Configuration files
- `server/utils/authorization.js` - Group inheritance resolution

### 2. Runtime Analytics Data (High-frequency writes with batching)

**Current Implementation:**
- **Usage tracking** (`usageTracker.js` → `contents/data/usage.json`): Token usage, message counts per user/app/model with 10-second write batching
- **Feedback storage** (`feedbackStorage.js` → `contents/data/feedback.jsonl`): User feedback in append-only JSONL format with 10-second flush intervals
- **Short links** (`shortLinkManager.js` → `contents/data/shortlinks.json`): URL shortener with usage tracking and 10-second persistence intervals

**Key Files:**
- `server/usageTracker.js` - Usage analytics
- `server/feedbackStorage.js` - User feedback
- `server/shortLinkManager.js` - URL shortening

### 3. Ephemeral State (In-memory only, process-bound)

**Current Implementation:**
- **SSE connections** (`sse.js`): Real-time chat connections in `Map` data structure (`clients`, `activeRequests`)
- **JWT authentication**: Stateless tokens, no server-side session storage
- **Action tracking**: In-memory event handling for real-time features

**Key Files:**
- `server/sse.js` - Server-sent events
- `server/actionTracker.js` - Action tracking

## Pluggable Persistence Architecture Design

### Provider Interfaces

The following three core provider interfaces are needed:

#### 1. ConfigurationProvider (for configCache.js)

```javascript
class ConfigurationProvider {
  /**
   * Get configuration with ETag support
   * @param {string} key - Configuration key
   * @returns {Promise<{data: any, etag: string}>}
   */
  async get(key) {}

  /**
   * Set configuration with TTL
   * @param {string} key - Configuration key
   * @param {any} value - Configuration value
   * @param {Object} options - Options including TTL
   * @returns {Promise<void>}
   */
  async set(key, value, options = {}) {}

  /**
   * Subscribe to configuration changes
   * @param {string} key - Configuration key
   * @param {Function} callback - Change callback
   * @returns {Promise<void>}
   */
  async subscribe(key, callback) {}

  /**
   * Batch read multiple configurations
   * @param {string[]} keys - Configuration keys
   * @returns {Promise<Map<string, any>>}
   */
  async getMultiple(keys) {}

  /**
   * Generate ETag for data
   * @param {any} data - Data to generate ETag for
   * @returns {string}
   */
  generateETag(data) {}
}
```

#### 2. StateStorageProvider (for analytics data)

```javascript
class StateStorageProvider {
  /**
   * Key-value get operation
   * @param {string} collection - Collection name
   * @param {string} key - Item key
   * @returns {Promise<any>}
   */
  async get(collection, key) {}

  /**
   * Key-value set with TTL support
   * @param {string} collection - Collection name
   * @param {string} key - Item key
   * @param {any} value - Item value
   * @param {number|null} ttl - Time to live in seconds
   * @returns {Promise<void>}
   */
  async set(collection, key, value, ttl = null) {}

  /**
   * Atomic counter increment
   * @param {string} collection - Collection name
   * @param {string} key - Counter key
   * @param {number} amount - Increment amount
   * @returns {Promise<number>}
   */
  async increment(collection, key, amount = 1) {}

  /**
   * Append-only log operation
   * @param {string} collection - Collection name
   * @param {any} data - Data to append
   * @returns {Promise<void>}
   */
  async append(collection, data) {}

  /**
   * Batch write operations
   * @param {string} collection - Collection name
   * @param {Array<{key: string, value: any}>} entries - Batch entries
   * @returns {Promise<void>}
   */
  async setBatch(collection, entries) {}
}
```

#### 3. SessionProvider (for real-time connections)

```javascript
class SessionProvider {
  /**
   * Store connection data
   * @param {string} sessionId - Session identifier
   * @param {any} connectionData - Connection information
   * @returns {Promise<void>}
   */
  async setConnection(sessionId, connectionData) {}

  /**
   * Cross-instance event broadcasting
   * @param {string} event - Event name
   * @param {any} data - Event data
   * @returns {Promise<void>}
   */
  async broadcast(event, data) {}

  /**
   * Subscribe to cross-instance events
   * @param {Function} callback - Event callback
   * @returns {Promise<void>}
   */
  async subscribe(callback) {}
}
```

## Implementation Recommendations

### Phase 1: Interface Abstraction (Minimal Risk)

1. **Wrap existing filesystem code** in provider interfaces
2. **Create FileSystemConfigurationProvider** that wraps current `configCache.js` logic
3. **Create FileSystemStateStorageProvider** that wraps `usageTracker.js`, `feedbackStorage.js`, `shortLinkManager.js`
4. **Create InMemorySessionProvider** that wraps current `sse.js` logic
5. **Add provider selection via `platform.json` configuration**

### Phase 2: Alternative Implementations (Medium Risk)

#### For High-Frequency Data (Usage, Feedback, Short Links):
- **RedisStateStorageProvider**: Use Redis Hash, Sets, and Lists
  - Usage tracking: Redis Hashes with `HINCRBY` for atomic increments
  - Feedback: Redis Lists with `LPUSH` for append-only logging  
  - Short links: Redis Hashes with TTL support

#### For Configuration Data:
- **RedisConfigurationProvider**: Use Redis with pub/sub for change notifications
- **S3ConfigurationProvider**: Store JSON in S3 with CloudFront for global caching
- **DatabaseConfigurationProvider**: PostgreSQL/MongoDB with read replicas

#### For Session State:
- **RedisSessionProvider**: Use Redis pub/sub for cross-instance SSE broadcasting

### Phase 3: Full Pluggability (Higher Risk)

- **Mixed providers**: Config in S3, state in Redis, sessions in Redis pub/sub
- **Health checking**: Automatic fallback between providers
- **Data migration**: Tools to move data between provider types

## Migration Strategy

### Step 1: Configuration Changes

Add provider configuration to `contents/config/platform.json`:

```json
{
  "persistence": {
    "configuration": {
      "provider": "filesystem",
      "config": { "cacheTTL": 300000 }
    },
    "state": {
      "provider": "filesystem", 
      "config": { "batchInterval": 10000 }
    },
    "sessions": {
      "provider": "memory",
      "config": {}
    }
  }
}
```

### Step 2: Refactor Current Code

1. **Update configCache.js**: Replace direct filesystem calls with `ConfigurationProvider` interface
2. **Update usageTracker.js**: Replace direct file operations with `StateStorageProvider.increment()` and `StateStorageProvider.setBatch()`
3. **Update feedbackStorage.js**: Replace file appends with `StateStorageProvider.append()`
4. **Update shortLinkManager.js**: Replace JSON file operations with `StateStorageProvider` key-value operations
5. **Update sse.js**: Replace Map operations with `SessionProvider` interface

### Step 3: Implement Alternative Providers

**Example Redis Implementation Priority:**
1. `RedisStateStorageProvider` (highest impact for scaling)
2. `RedisSessionProvider` (enables sticky session elimination) 
3. `RedisConfigurationProvider` (lowest priority, filesystem works fine for config)

### Step 4: Deployment Strategy

#### For Horizontal Scaling:
- **Configuration**: Can stay filesystem with shared storage (NFS/EFS) or move to S3
- **State Data**: Move to Redis for cross-instance sharing and atomic operations
- **Sessions**: Use Redis pub/sub to eliminate sticky sessions

#### Performance Considerations:
- **Current filesystem**: ~0ms access time (in-memory cache)
- **Redis**: ~1-3ms access time but enables horizontal scaling
- **Maintain batching**: Critical for performance with network-based providers
- **Health checks**: Fallback to filesystem if Redis unavailable

## Technical Considerations

### Data Patterns Analysis

1. **Configuration Data** (Low frequency, read-heavy):
   - Current: File-based JSON with in-memory caching
   - Scaling: Works with shared filesystem or distributed cache

2. **Analytics Data** (High frequency, write-heavy):
   - Current: Batched writes to JSON files
   - Scaling: Requires atomic operations and cross-instance sharing

3. **Session Data** (Real-time, ephemeral):
   - Current: In-memory Maps per process
   - Scaling: Requires cross-instance communication

### Provider Selection Guidelines

- **Single Instance**: FileSystem providers for all categories
- **Multi-Instance (Shared Storage)**: FileSystem for config, Redis for state/sessions
- **Multi-Instance (No Shared Storage)**: S3/Database for config, Redis for state/sessions
- **Cloud Native**: Managed services (RDS, ElastiCache, etc.)

## Implementation Files to Modify

### Core Infrastructure
- `server/configCache.js` - Abstract to use ConfigurationProvider
- `server/usageTracker.js` - Abstract to use StateStorageProvider  
- `server/feedbackStorage.js` - Abstract to use StateStorageProvider
- `server/shortLinkManager.js` - Abstract to use StateStorageProvider
- `server/sse.js` - Abstract to use SessionProvider

### New Provider Implementations
- `server/providers/` - New directory for provider implementations
- `server/providers/filesystem/` - Filesystem-based providers
- `server/providers/redis/` - Redis-based providers
- `server/providers/database/` - Database-based providers

### Configuration
- `contents/config/platform.json` - Add persistence configuration section

## Benefits

1. **Horizontal Scaling**: Eliminate single-point-of-failure filesystem dependency
2. **Performance**: Atomic operations and cross-instance data sharing
3. **Flexibility**: Mix and match providers based on requirements
4. **Migration Path**: Gradual transition from filesystem to distributed storage
5. **Operational**: Better monitoring, backup, and disaster recovery options

## Risks and Mitigation

1. **Complexity**: Start with filesystem abstraction, gradual implementation
2. **Performance**: Maintain batching patterns, implement caching layers
3. **Reliability**: Health checks and fallback mechanisms
4. **Data Loss**: Proper backup strategies and atomic operations
5. **Migration**: Comprehensive testing and rollback procedures

This concept provides a clear roadmap from single-instance filesystem storage to horizontally scalable distributed storage while maintaining the current application's performance characteristics and operational simplicity.