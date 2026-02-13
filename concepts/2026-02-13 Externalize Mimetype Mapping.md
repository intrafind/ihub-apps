# Externalize Mimetype Mapping

**Date**: 2026-02-13  
**Author**: GitHub Copilot  
**Status**: Implemented

## Problem Statement

The mimetype mappings for file uploads were hardcoded in `client/src/features/upload/utils/fileProcessing.js`. This meant that:

1. Adding support for new MIME types always required code changes
2. Even if models could handle new file types, the system couldn't use them without code modification
3. File extension mappings and display names were tightly coupled with the code

## Solution

Externalize the mimetype configuration into a JSON configuration file that can be modified without code changes. This allows:

- Dynamic addition of new MIME types
- Customization of file extension mappings
- Configuration of display names for different file types
- No code changes needed to support new file formats

## Implementation

### 1. Configuration File Structure

Created `/server/defaults/config/mimetypes.json` with three main sections:

```json
{
  "supportedTextFormats": [
    "text/plain",
    "application/pdf",
    // ... more MIME types
  ],
  "mimeToExtension": {
    "image/jpeg": ".jpeg,.jpg",
    "application/pdf": ".pdf",
    // ... more mappings
  },
  "typeDisplayNames": {
    "text/plain": "TXT",
    "application/pdf": "PDF",
    // ... more display names
  }
}
```

### 2. Server-Side Changes

#### Configuration Loading

- **File**: `server/configCache.js`
  - Added `config/mimetypes.json` to critical configs list
  - Added `getMimetypes()` method to retrieve configuration
  - Configuration is cached and hot-reloaded like other configs

#### Schema Validation

- **File**: `server/validators/mimetypeConfigSchema.js`
  - Created Zod schema for validation
  - Validates structure of mimetypes configuration
  - Provides default configuration getter

#### API Endpoint

- **File**: `server/routes/chat/dataRoutes.js`
  - Added `/api/configs/mimetypes` endpoint
  - Returns mimetypes configuration with ETag support
  - Includes Swagger documentation

### 3. Client-Side Changes

#### API Integration

- **File**: `client/src/api/endpoints/config.js`
  - Added `fetchMimetypesConfig()` function
  - Uses standard API client with caching
  - Cache key: `MIMETYPES_CONFIG`

#### Cache Key

- **File**: `client/src/utils/cache.js`
  - Added `MIMETYPES_CONFIG` to `CACHE_KEYS` enum
  - Long TTL (30 minutes) for performance

#### File Processing Updates

- **File**: `client/src/features/upload/utils/fileProcessing.js`
  - Replaced hardcoded constants with dynamic configuration loading
  - Maintains backward compatibility with synchronous API
  - Loads configuration on module initialization
  - Falls back to default config if server fetch fails
  - Functions remain synchronous for existing code compatibility

Key changes:
- `loadMimetypesConfig()`: Async loader with caching
- `getConfig()`: Internal synchronous accessor
- `formatAcceptAttribute()`: Uses dynamic config
- `getFileTypeDisplay()`: Uses dynamic config
- `formatMimeTypesToDisplay()`: Uses dynamic config

## Benefits

1. **No Code Changes**: New MIME types can be added via configuration
2. **Flexibility**: Different deployments can support different file types
3. **Maintainability**: All MIME type definitions in one place
4. **Performance**: Configuration is cached both server and client-side
5. **Backward Compatible**: Existing code works without modifications

## Testing

The server startup test confirms:
- Configuration file is loaded correctly
- API endpoint is created
- Cache is initialized
- No breaking changes to existing functionality

## Configuration Hot-Reload

The mimetypes configuration supports hot-reload:
- Changes to `mimetypes.json` are picked up without server restart
- Client refetches configuration when cache expires
- No application downtime needed for updates

## Usage Example

To add support for a new file type (e.g., `.epub`):

1. Edit `server/defaults/config/mimetypes.json` or `contents/config/mimetypes.json`
2. Add to `supportedTextFormats`: `"application/epub+zip"`
3. Add to `mimeToExtension`: `"application/epub+zip": ".epub"`
4. Add to `typeDisplayNames`: `"application/epub+zip": "EPUB"`
5. Save the file
6. Configuration auto-reloads (or wait for cache expiry on client)

No code deployment needed!

## Files Modified

### Server
- `server/defaults/config/mimetypes.json` (new)
- `server/validators/mimetypeConfigSchema.js` (new)
- `server/configCache.js`
- `server/routes/chat/dataRoutes.js`

### Client
- `client/src/api/endpoints/config.js`
- `client/src/utils/cache.js`
- `client/src/features/upload/utils/fileProcessing.js`

## Future Enhancements

Potential improvements:
1. Admin UI for managing MIME types
2. Per-app MIME type restrictions
3. Custom file processors via configuration
4. Validation of MIME type format
5. Migration tool for existing customizations
