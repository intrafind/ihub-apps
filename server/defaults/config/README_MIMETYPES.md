# Mimetype Configuration

This directory contains the `mimetypes.json` configuration file that defines which file types are supported for upload and how they are displayed in the UI.

## Configuration Structure

The `mimetypes.json` file has two main sections:

### 1. categories

Categories organize MIME types into logical groups that apps can reference. Each category has:
- `name`: Localized category name
- `description`: Localized category description (optional)
- `mimeTypes`: Array of MIME types in this category

```json
{
  "categories": {
    "images": {
      "name": {
        "en": "Images",
        "de": "Bilder"
      },
      "description": {
        "en": "Image file formats",
        "de": "Bilddateiformate"
      },
      "mimeTypes": [
        "image/jpeg",
        "image/png",
        "image/gif"
      ]
    }
  }
}
```

**Available Categories:**
- `images` - Image file formats (JPEG, PNG, GIF, WEBP, TIFF)
- `audio` - Audio file formats (MP3, WAV, FLAC, OGG)
- `documents` - Document formats (PDF, DOCX, ODT, MSG)
- `text` - Plain text and code files (TXT, MD, CSV, JSON, HTML, CSS, JS, XML, EML)

### 2. mimeTypes

Detailed information for each MIME type:
- `extensions`: Array of file extensions (e.g., `[".jpeg", ".jpg"]`)
- `displayName`: UI display name (e.g., `"JPEG"`)
- `category`: Category this MIME type belongs to

```json
{
  "mimeTypes": {
    "image/jpeg": {
      "extensions": [".jpeg", ".jpg"],
      "displayName": "JPEG",
      "category": "images"
    }
  }
}
```

## Using Categories in Apps

Apps should reference categories instead of listing individual MIME types. This reduces duplication and makes it easier to manage supported formats centrally.

### App Configuration Example

Instead of:
```json
{
  "upload": {
    "imageUpload": {
      "enabled": true,
      "supportedFormats": ["image/jpeg", "image/png", "image/gif", "image/webp"]
    }
  }
}
```

Use categories (future):
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

## Adding a New File Type

To add support for a new file type:

1. Add the MIME type to the appropriate category
2. Add detailed MIME type information

### Example: Adding EPUB Support

```json
{
  "categories": {
    "documents": {
      "mimeTypes": [
        "application/epub+zip"  // Add to existing array
      ]
    }
  },
  "mimeTypes": {
    "application/epub+zip": {
      "extensions": [".epub"],
      "displayName": "EPUB",
      "category": "documents"
    }
  }
}
```

## Adding a New Category

To create a new category:

```json
{
  "categories": {
    "video": {
      "name": {
        "en": "Videos",
        "de": "Videos"
      },
      "description": {
        "en": "Video file formats",
        "de": "Videodateiformate"
      },
      "mimeTypes": [
        "video/mp4",
        "video/webm"
      ]
    }
  },
  "mimeTypes": {
    "video/mp4": {
      "extensions": [".mp4"],
      "displayName": "MP4",
      "category": "video"
    },
    "video/webm": {
      "extensions": [".webm"],
      "displayName": "WEBM",
      "category": "video"
    }
  }
}
```

## Benefits of Category-Based Structure

1. **Reduced Duplication**: Apps reference categories instead of listing MIME types
2. **Centralized Management**: Add new formats once, available to all apps
3. **Easier Maintenance**: Update supported formats without touching app configs
4. **Logical Organization**: Files grouped by type (images, audio, documents, text)
5. **Flexible**: Apps can select multiple categories or override with specific MIME types

## Notes

- Changes to this file take effect immediately (no server restart required in most cases)
- The client caches this configuration for 30 minutes
- All MIME types must have corresponding entries in the `mimeTypes` section
- All MIME types must reference a valid category

## Common MIME Types

| File Type | MIME Type | Category | Extension |
|-----------|-----------|----------|-----------|
| JPEG | `image/jpeg` | images | `.jpeg, .jpg` |
| PNG | `image/png` | images | `.png` |
| MP3 | `audio/mpeg` | audio | `.mp3` |
| WAV | `audio/wav` | audio | `.wav` |
| PDF | `application/pdf` | documents | `.pdf` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | documents | `.docx` |
| Plain Text | `text/plain` | text | `.txt` |
| Markdown | `text/markdown` | text | `.md` |
| JSON | `application/json` | text | `.json` |
| HTML | `text/html` | text | `.html` |

For a complete list of MIME types, see: https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Common_types
