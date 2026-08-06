# ETag-based Cache Validation for Models

**Date:** 2026-01-19  
**Status:** Implemented  
**Related Issue:** Model selector not showing newly added models without server restart

## Problem Statement

When a user created a new model via the admin interface, the model would not appear in the model selector of apps without restarting the server. This was caused by client-side caching with a 5-minute TTL that prevented the client from fetching the updated model list.

### User Flow That Failed:
1. User opens an app and chats (models are cached on client)
2. User creates a new model via admin interface
3. User returns to the app
4. **BUG**: New model doesn't show in selector (client serves from cache)
5. **Workaround**: Wait 5 minutes or restart server

## Root Cause

The issue stemmed from a disconnect between server-side and client-side caching:

- **Server-side**: When a model is created via admin API (`POST /api/admin/models`), the server correctly calls `configCache.refreshModelsCache()` which updates the server's in-memory cache and regenerates the ETag
- **Client-side**: The client has its own in-memory cache with a 5-minute TTL. When fetching models, it would check the cache first and return cached data if not expired
- **Missing Link**: The client had no way to know that the server's data had changed until the cache TTL expired

## Solution

Implemented ETag-based cache validation (HTTP 304 Not Modified) to enable efficient cache invalidation:

### Server Changes (`server/routes/modelRoutes.js`)

1. **Already implemented**: Server returns ETag header with model list
2. **New**: Server checks `If-None-Match` header and returns 304 if ETag matches
3. **New**: Updated API documentation to reflect conditional request support

```javascript
// Handle conditional requests with ETag
if (userSpecificEtag) {
  res.setHeader('ETag', userSpecificEtag);
  const clientETag = req.headers['if-none-match'];
  if (clientETag && clientETag === userSpecificEtag) {
    return res.status(304).end();
  }
}
```

### Client Changes (`client/src/api/endpoints/models.js`)

1. **New**: Client sends `If-None-Match` header with cached ETag
2. **New**: Client enables ETag handling in request handler
3. Pattern follows existing implementation in `prompts.js`

```javascript
return handleApiResponse(
  () => {
    const headers = {};

    // Add ETag header if we have cached data
    if (cacheKey) {
      const cachedData = cache.get(cacheKey);
      if (cachedData && cachedData.etag) {
        headers['If-None-Match'] = cachedData.etag;
      }
    }

    return apiClient.get('/models', { headers });
  },
  cacheKey,
  DEFAULT_CACHE_TTL.MEDIUM,
  true,
  true // Enable ETag handling
);
```

## How It Works

### Normal Flow (No Changes)
1. Client requests models: `GET /api/models`
2. Server returns models with ETag: `ETag: "abc123"`
3. Client caches models with ETag (TTL: 5 minutes)

### Efficient Re-fetch (Cache Valid)
1. Client requests models: `GET /api/models` with `If-None-Match: "abc123"`
2. Server checks ETag, data unchanged
3. Server returns: `304 Not Modified` (no data transfer)
4. Client continues using cached data

### Cache Invalidation (Model Added)
1. Admin creates new model via `POST /api/admin/models`
2. Server calls `configCache.refreshModelsCache()`
3. Server generates new ETag: `"xyz789"`
4. Client requests models: `GET /api/models` with `If-None-Match: "abc123"`
5. Server sees ETag mismatch: `"abc123" !== "xyz789"`
6. Server returns: `200 OK` with new model list and new ETag
7. Client updates cache with new data
8. **New model appears in selector immediately**

## Benefits

1. **Immediate Updates**: New models appear in apps without waiting for cache expiry or server restart
2. **Bandwidth Efficiency**: 304 responses have no body, saving bandwidth when data hasn't changed
3. **Performance**: Client-side cache still provides fast response times
4. **Standard HTTP**: Uses standard HTTP caching mechanisms (ETags, If-None-Match, 304)
5. **Consistent Pattern**: Follows the same pattern as prompts and other cached resources

## Technical Details

### ETag Generation

ETags are generated in `configCache.js` using MD5 hash:
```javascript
generateETag(data) {
  const hash = createHash('md5');
  hash.update(JSON.stringify(data));
  return `"${hash.digest('hex')}"`;
}
```

For user-filtered data, a composite ETag is created:
```javascript
// User-specific ETag includes content hash
const contentHash = createHash('md5')
  .update(JSON.stringify(modelIds))
  .digest('hex')
  .substring(0, 8);
userSpecificETag = `${modelsEtag}-${contentHash}`;
```

### Cache Refresh Triggers

The server cache automatically refreshes in these scenarios:

1. **Admin API Operations**: Immediate refresh via `configCache.refreshModelsCache()`
   - Model creation: `POST /api/admin/models`
   - Model update: `PUT /api/admin/models/:id`
   - Model deletion: `DELETE /api/admin/models/:id`
   - Model toggle: `POST /api/admin/models/:id/toggle`

2. **Automatic TTL Refresh**: Background refresh every 1 minute (dev) or 5 minutes (production)

### Client Cache Behavior

- **Cache Key**: `CACHE_KEYS.MODELS_LIST`
- **TTL**: `DEFAULT_CACHE_TTL.MEDIUM` (5 minutes)
- **Storage**: In-memory only (not persisted to localStorage/sessionStorage)
- **ETag Storage**: Stored with cached data in cache entry

## Code Locations

### Server-side:
- `/server/routes/modelRoutes.js` - HTTP endpoint with ETag support
- `/server/routes/admin/models.js` - Admin API that triggers cache refresh
- `/server/configCache.js` - Cache management and ETag generation

### Client-side:
- `/client/src/api/endpoints/models.js` - API client with ETag support
- `/client/src/api/utils/requestHandler.js` - Generic ETag handling logic
- `/client/src/utils/cache.js` - Client-side cache implementation

### Testing:
- Manual testing scripts in `/tmp/quick-test-etag.sh`

## Future Enhancements

1. **Server-Sent Events**: Consider pushing cache invalidation events to clients for even faster updates
2. **Stale-While-Revalidate**: Implement background cache refresh while serving stale data
3. **Bulk Operations**: Optimize ETag handling for bulk model operations
4. **Metrics**: Add monitoring for cache hit/miss rates and 304 response rates

## Related Features

This implementation pattern should be applied to other cached resources:
- ✅ Prompts (already implemented)
- ✅ Models (newly implemented)
- ⏳ Apps (consider implementing)
- ⏳ Tools (consider implementing)
- ⏳ Styles (consider implementing)

## Testing

Verified functionality with:
1. Server returns ETag header on `/api/models`
2. Server handles `If-None-Match` header correctly
3. Server returns 304 when ETag matches
4. Server returns 200 with new data when ETag differs
5. Client sends `If-None-Match` header with cached ETag
6. Client handles 304 responses correctly
7. Client updates cache on 200 responses with new ETag

## Migration Notes

No migration required. This is a backward-compatible enhancement:
- Clients without ETag support still work (always get 200)
- Old clients continue to use TTL-based caching
- New clients benefit from ETag validation
- Server gracefully handles both scenarios
