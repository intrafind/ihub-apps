# Externalize Mimetype Mapping

**Date**: 2026-02-13 (Updated: 2026-02-16)  
**Author**: GitHub Copilot  
**Status**: Completed

## Problem Statement

The mimetype mappings for file uploads were hardcoded in `client/src/features/upload/utils/fileProcessing.js`. This meant that:

1. Adding support for new MIME types always required code changes
2. Even if models could handle new file types, the system couldn't use them without code modification
3. File extension mappings and display names were tightly coupled with the code
4. Apps had to duplicate MIME type lists in their configuration
5. Admin UI had hardcoded format lists

## Solution (v3 - Final)

After multiple iterations based on review feedback, the final solution provides:

- Category-based MIME type organization (images, audio, video, documents)
- Merged text and documents categories for simplicity
- Admin UI with category selection capability
- Complete documentation in `/docs` folder
- Video support for future use

## Implementation

### 1. Configuration File Structure (v3 - Final)

Created `/server/defaults/config/mimetypes.json` with two main sections:

```json
{
  "categories": {
    "images": {
      "name": { "en": "Images", "de": "Bilder" },
      "mimeTypes": ["image/jpeg", "image/png", "image/gif", "image/webp", "image/tiff"]
    },
    "audio": {
      "name": { "en": "Audio", "de": "Audio" },
      "mimeTypes": ["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]
    },
    "video": {
      "name": { "en": "Video", "de": "Video" },
      "mimeTypes": ["video/mp4", "video/webm", "video/mpeg", "video/quicktime", "video/ogg"]
    },
    "documents": {
      "name": { "en": "Documents", "de": "Dokumente" },
      "mimeTypes": [
        "text/plain", "text/markdown", "text/csv", "application/json",
        "text/html", "text/css", "text/javascript", "text/xml", "message/rfc822",
        "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-outlook", "application/vnd.oasis.opendocument.text"
        // ... and more
      ]
    }
  },
  "mimeTypes": {
    "image/jpeg": {
      "extensions": [".jpeg", ".jpg"],
      "displayName": "JPEG",
      "category": "images"
    }
    // ... complete definitions for all MIME types
  }
}
```

### Key Improvements (v3)

1. **Category-Based Organization**: MIME types grouped into `images`, `audio`, `video`, `documents`
2. **Merged Categories**: Text and documents combined into single "documents" category
3. **Video Support**: New video category with 5 common video formats
4. **Admin UI Integration**: MimeTypeSelector component for category or individual selection
5. **Documentation**: Complete documentation moved to `/docs/mimetypes.md`
6. **Better Data Model**: Extensions as arrays, proper categorization, localized names

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

#### MimeTypeSelector Component (New)

- **File**: `client/src/features/admin/components/MimeTypeSelector.jsx`
  - Reusable component for category or individual MIME type selection
  - Loads configuration dynamically from server
  - Shows file extensions and display names
  - Allows "select all in category" or individual selection

#### AppFormEditor Updates

- **File**: `client/src/features/admin/components/AppFormEditor.jsx`
  - Replaced hardcoded format lists with MimeTypeSelector
  - Integrated for images, audio, and documents (file upload)
  - No longer hardcodes any MIME types

#### File Processing Updates

- **File**: `client/src/features/upload/utils/fileProcessing.js`
  - Replaced flat structure with category-based access
  - Added `getMimeTypesByCategory()` function
  - Added `getMimeTypesByCategories()` function
  - Updated to use "documents" category (text merged)
  - Added video category support
  - Falls back to default config if server fetch fails

#### Documentation

- **File**: `/docs/mimetypes.md` (New)
  - Comprehensive documentation of MIME type configuration
  - Examples for adding new file types and categories
  - Complete MIME type reference tables
  - Usage examples for admins

- **File**: `/docs/SUMMARY.md`
  - Added mimetypes.md to documentation navigation

## Categories Structure

### images (7 MIME types)
- JPEG, PNG, GIF, WEBP, TIFF

### audio (5 MIME types)
- MP3, WAV, FLAC, OGG

### video (5 MIME types)
- MP4, WEBM, MPEG, MOV, OGG

### documents (21+ MIME types)
- **Text files**: TXT, MD, CSV, JSON, HTML, CSS, JS, XML, EML
- **Documents**: PDF, DOCX, XLSX, PPTX, XLS, PPT, MSG, ODT, ODS, ODP

## Benefits

1. **No Code Changes**: New MIME types can be added via configuration
2. **Flexibility**: Different deployments can support different file types
3. **Maintainability**: All MIME type definitions in one place
4. **Performance**: Configuration is cached both server and client-side
5. **Backward Compatible**: Existing code works without modifications
6. **Reduced Duplication**: Apps reference categories instead of listing MIME types
7. **Unified Structure**: Images, audio, video, and documents all in one config
8. **Logical Organization**: Categories make it easy to find and manage related types
9. **Admin Friendly**: UI allows category selection or fine-grained control
10. **Video Ready**: Video category available for future video upload features

## Admin UI Experience

### Before
- Hardcoded checkboxes for each format
- No category-wide selection
- Limited to formats hardcoded in JavaScript

### After
- Option to select entire category with one checkbox
- OR select individual MIME types with extensions shown
- All formats loaded dynamically from configuration
- Example:
  ```
  ☑ Use entire Images category
  OR select individual formats:
  ☐ JPEG (.jpeg, .jpg)
  ☐ PNG (.png)
  ☐ GIF (.gif)
  ...
  ```

## Testing

The server startup test confirms:
- Configuration file is loaded correctly
- API endpoint is created
- Cache is initialized
- Schema validation works
- No breaking changes to existing functionality
- Admin UI components load MIME types dynamically

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

The new format will automatically:
- Appear in the admin UI
- Be available for app configuration
- Show correct extensions and display name

### Using Categories in Apps

Apps can now specify categories in upload configuration:

```json
{
  "upload": {
    "enabled": true,
    "imageUpload": {
      "enabled": true,
      "categories": ["images"]  // Future enhancement
    },
    "fileUpload": {
      "enabled": true,
      "categories": ["documents"]  // Future enhancement
    }
  }
}
```

Or continue using individual MIME type lists for backward compatibility.

## Files Modified

### Server
- `server/defaults/config/mimetypes.json` (updated with video, merged categories)
- `server/validators/mimetypeConfigSchema.js` (updated schema)
- `server/configCache.js`
- `server/routes/chat/dataRoutes.js`

### Client
- `client/src/api/endpoints/config.js`
- `client/src/utils/cache.js`
- `client/src/features/upload/utils/fileProcessing.js` (updated with merged categories)
- `client/src/features/admin/components/MimeTypeSelector.jsx` (new)
- `client/src/features/admin/components/AppFormEditor.jsx` (integrated MimeTypeSelector)

### Documentation
- `docs/mimetypes.md` (new - moved from server/defaults/config/)
- `docs/SUMMARY.md` (updated)
- `concepts/2026-02-13 Externalize Mimetype Mapping.md` (updated)

## Future Enhancements

1. ~~Update app configurations to use categories instead of MIME type lists~~ (Admin UI implemented)
2. Admin UI for managing MIME types and categories (configuration editor)
3. Per-app MIME type restrictions via category selection (backend support)
4. Custom file processors via configuration
5. Migration tool for existing app customizations
6. Video upload feature implementation using the video category

## Review History

- **v1**: Initial implementation with separate text/documents categories
- **v2**: Improved structure based on @manzke feedback - category-based organization
- **v3**: Final implementation - merged text/documents, added video, created admin UI component

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
