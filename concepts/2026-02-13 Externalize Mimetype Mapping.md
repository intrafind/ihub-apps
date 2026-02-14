# Externalize Mimetype Mapping

**Date**: 2026-02-13 (Updated: 2026-02-14)  
**Author**: GitHub Copilot  
**Status**: Implemented (Improved Structure)

## Problem Statement

The mimetype mappings for file uploads were hardcoded in `client/src/features/upload/utils/fileProcessing.js`. This meant that:

1. Adding support for new MIME types always required code changes
2. Even if models could handle new file types, the system couldn't use them without code modification
3. File extension mappings and display names were tightly coupled with the code
4. Apps had to duplicate MIME type lists in their configuration

## Solution (v2 - Improved)

After initial implementation and review, the solution was improved to use a category-based structure that:

- Eliminates duplication by grouping MIME types into categories
- Allows apps to reference categories instead of listing individual MIME types
- Provides a single source of truth for all file type information
- Supports both text, image, audio, and document formats in one unified structure

## Implementation

### 1. Configuration File Structure (v2)

Created `/server/defaults/config/mimetypes.json` with two main sections:

```json
{
  "categories": {
    "images": {
      "name": { "en": "Images", "de": "Bilder" },
      "description": { "en": "Image file formats", "de": "Bilddateiformate" },
      "mimeTypes": ["image/jpeg", "image/png", "image/gif", "image/webp"]
    },
    "audio": {
      "name": { "en": "Audio", "de": "Audio" },
      "mimeTypes": ["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]
    },
    "documents": {
      "name": { "en": "Documents", "de": "Dokumente" },
      "mimeTypes": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
    },
    "text": {
      "name": { "en": "Text Files", "de": "Textdateien" },
      "mimeTypes": ["text/plain", "text/markdown", "application/json"]
    }
  },
  "mimeTypes": {
    "image/jpeg": {
      "extensions": [".jpeg", ".jpg"],
      "displayName": "JPEG",
      "category": "images"
    },
    "application/pdf": {
      "extensions": [".pdf"],
      "displayName": "PDF",
      "category": "documents"
    }
    // ... more MIME types
  }
}
```

### Key Improvements (v2)

1. **Category-Based Organization**: MIME types grouped into `images`, `audio`, `documents`, `text`
2. **Unified Structure**: No distinction between "supported text formats" and others - all formats equal
3. **Reduced Duplication**: Apps can reference categories instead of listing MIME types
4. **Better Data Model**: Extensions as arrays, proper categorization, localized names

### 2. Server-Side Changes

#### Configuration Loading

- **File**: `server/configCache.js`
  - Added `config/mimetypes.json` to critical configs list
  - Added `getMimetypes()` method to retrieve configuration
  - Configuration is cached and hot-reloaded like other configs

#### Schema Validation (Updated)

- **File**: `server/validators/mimetypeConfigSchema.js`
  - Updated Zod schema for category-based structure
  - Validates `categories` and `mimeTypes` sections
  - Cross-validates that MIME types reference valid categories
  - Warns if categories reference undefined MIME types

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

#### File Processing Updates (Updated)

- **File**: `client/src/features/upload/utils/fileProcessing.js`
  - Replaced flat structure with category-based access
  - Added `getMimeTypesByCategory()` function
  - Added `getMimeTypesByCategories()` function
  - Maintains backward compatibility with `SUPPORTED_TEXT_FORMATS`
  - Updated `formatAcceptAttribute()` to use new extensions array
  - Updated `getFileTypeDisplay()` to use new displayName field
  - Falls back to default config if server fetch fails

## Benefits

1. **No Code Changes**: New MIME types can be added via configuration
2. **Flexibility**: Different deployments can support different file types
3. **Maintainability**: All MIME type definitions in one place
4. **Performance**: Configuration is cached both server and client-side
5. **Backward Compatible**: Existing code works without modifications
6. **Reduced Duplication**: Apps reference categories instead of listing MIME types
7. **Unified Structure**: Images, audio, documents, and text all in one config
8. **Logical Organization**: Categories make it easy to find and manage related types

## App Integration (Future Enhancement)

Apps will be able to specify which categories they support instead of listing MIME types:

```json
{
  "upload": {
    "imageUpload": {
      "enabled": true,
      "categories": ["images"]
    },
    "fileUpload": {
      "enabled": true,
      "categories": ["documents", "text"]
    }
  }
}
```

This eliminates the duplication currently present in app configurations.

## Testing

The server startup test confirms:
- Configuration file is loaded correctly
- API endpoint is created
- Cache is initialized
- Schema validation works
- No breaking changes to existing functionality

## Configuration Hot-Reload

The mimetypes configuration supports hot-reload:
- Changes to `mimetypes.json` are picked up without server restart
- Client refetches configuration when cache expires
- No application downtime needed for updates

## Usage Examples

### Adding a New File Type (e.g., EPUB)

1. Add to the appropriate category:
```json
{
  "categories": {
    "documents": {
      "mimeTypes": [
        "application/epub+zip"  // Add here
      ]
    }
  }
}
```

2. Add MIME type details:
```json
{
  "mimeTypes": {
    "application/epub+zip": {
      "extensions": [".epub"],
      "displayName": "EPUB",
      "category": "documents"
    }
  }
}
```

### Adding a New Category (e.g., Videos)

```json
{
  "categories": {
    "video": {
      "name": { "en": "Videos", "de": "Videos" },
      "description": { "en": "Video file formats" },
      "mimeTypes": ["video/mp4", "video/webm"]
    }
  },
  "mimeTypes": {
    "video/mp4": {
      "extensions": [".mp4"],
      "displayName": "MP4",
      "category": "video"
    }
  }
}
```

## Files Modified

### Server
- `server/defaults/config/mimetypes.json` (new - improved structure)
- `server/validators/mimetypeConfigSchema.js` (new - updated schema)
- `server/defaults/config/README_MIMETYPES.md` (new - updated docs)
- `server/configCache.js`
- `server/routes/chat/dataRoutes.js`

### Client
- `client/src/api/endpoints/config.js`
- `client/src/utils/cache.js`
- `client/src/features/upload/utils/fileProcessing.js` (updated with category support)

### Documentation
- `concepts/2026-02-13 Externalize Mimetype Mapping.md` (updated)

## Future Enhancements

1. Update app configurations to use categories instead of MIME type lists
2. Admin UI for managing MIME types and categories
3. Per-app MIME type restrictions via category selection
4. Custom file processors via configuration
5. Migration tool for existing app customizations
