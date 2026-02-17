# Mimetype Configuration

The `mimetypes.json` configuration file defines which file types are supported for upload and how they are displayed in the UI. This configuration is located at `server/defaults/config/mimetypes.json` and can be overridden in `contents/config/mimetypes.json`.

## Configuration Structure

The `mimetypes.json` file has two main sections:

### 1. categories

Categories organize MIME types into logical groups that apps can reference. Each category has:
- `name`: Localized category name (en, de)
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
- `video` - Video file formats (MP4, WEBM, MOV, MPEG, OGG)
- `documents` - Document and text file formats (PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, HTML, CSS, JS, XML, EML, ODT, ODS, ODP, MSG, XLS, PPT)

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

Apps can reference categories instead of listing individual MIME types in the admin interface. This reduces duplication and makes it easier to manage supported formats centrally.

### App Configuration in Admin UI

In the app edit page, you can:
1. **Select entire categories** - Choose "Images", "Audio", "Video", or "Documents" to support all formats in that category
2. **Select individual MIME types** - Fine-tune which specific formats are supported

### App Configuration File Example

```json
{
  "id": "file-analysis",
  "upload": {
    "enabled": true,
    "imageUpload": {
      "enabled": true,
      "maxFileSizeMB": 10,
      "categories": ["images"]
    },
    "fileUpload": {
      "enabled": true,
      "maxFileSizeMB": 5,
      "categories": ["documents"]
    }
  }
}
```

Or specify individual MIME types:

```json
{
  "upload": {
    "fileUpload": {
      "enabled": true,
      "supportedFormats": ["application/pdf", "text/plain", "text/markdown"]
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

After adding the configuration, the new format will be:
- Available in the app admin UI for selection
- Automatically handled by the upload components
- Displayed with the configured display name

## Adding a New Category

To create a new category (advanced use case):

```json
{
  "categories": {
    "archives": {
      "name": {
        "en": "Archives",
        "de": "Archive"
      },
      "description": {
        "en": "Compressed archive formats",
        "de": "Komprimierte Archivformate"
      },
      "mimeTypes": [
        "application/zip",
        "application/x-tar",
        "application/gzip"
      ]
    }
  },
  "mimeTypes": {
    "application/zip": {
      "extensions": [".zip"],
      "displayName": "ZIP",
      "category": "archives"
    },
    "application/x-tar": {
      "extensions": [".tar"],
      "displayName": "TAR",
      "category": "archives"
    },
    "application/gzip": {
      "extensions": [".gz"],
      "displayName": "GZIP",
      "category": "archives"
    }
  }
}
```

## Benefits of Category-Based Structure

1. **Reduced Duplication**: Apps reference categories instead of listing MIME types
2. **Centralized Management**: Add new formats once, available to all apps
3. **Easier Maintenance**: Update supported formats without touching app configs
4. **Logical Organization**: Files grouped by type (images, audio, video, documents)
5. **Flexible**: Apps can select multiple categories or override with specific MIME types
6. **No Code Changes**: New file types added via configuration only

## Configuration Management

### Location
- **Default config**: `server/defaults/config/mimetypes.json`
- **Override config**: `contents/config/mimetypes.json`

### Hot Reload
- Changes to `mimetypes.json` take effect immediately (no server restart required in most cases)
- The client caches this configuration for 30 minutes
- Administrators can force a refresh by clearing the browser cache

### Validation
- All MIME types must have corresponding entries in the `mimeTypes` section
- All MIME types must reference a valid category
- Extensions must be non-empty arrays
- Display names are required for all MIME types

## Complete MIME Type Reference

### Images
| File Type | MIME Type | Extensions | Display Name |
|-----------|-----------|------------|--------------|
| JPEG | `image/jpeg` | `.jpeg, .jpg` | JPEG |
| PNG | `image/png` | `.png` | PNG |
| GIF | `image/gif` | `.gif` | GIF |
| WEBP | `image/webp` | `.webp` | WEBP |
| TIFF | `image/tiff` | `.tiff, .tif` | TIFF |

### Audio
| File Type | MIME Type | Extensions | Display Name |
|-----------|-----------|------------|--------------|
| MP3 | `audio/mpeg` | `.mp3` | MP3 |
| WAV | `audio/wav` | `.wav` | WAV |
| FLAC | `audio/flac` | `.flac` | FLAC |
| OGG | `audio/ogg` | `.ogg` | OGG |

### Video
| File Type | MIME Type | Extensions | Display Name |
|-----------|-----------|------------|--------------|
| MP4 | `video/mp4` | `.mp4` | MP4 |
| WEBM | `video/webm` | `.webm` | WEBM |
| MPEG | `video/mpeg` | `.mpeg, .mpg` | MPEG |
| MOV | `video/quicktime` | `.mov` | MOV |
| OGG | `video/ogg` | `.ogv` | OGG |

### Documents
| File Type | MIME Type | Extensions | Display Name |
|-----------|-----------|------------|--------------|
| PDF | `application/pdf` | `.pdf` | PDF |
| Word (DOCX) | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` | DOCX |
| Excel (XLSX) | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `.xlsx` | XLSX |
| PowerPoint (PPTX) | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `.pptx` | PPTX |
| Word (DOC) | `application/vnd.ms-excel` | `.xls` | XLS |
| Excel (XLS) | `application/vnd.ms-powerpoint` | `.ppt` | PPT |
| Plain Text | `text/plain` | `.txt` | TXT |
| Markdown | `text/markdown` | `.md` | MD |
| CSV | `text/csv` | `.csv` | CSV |
| JSON | `application/json` | `.json` | JSON |
| HTML | `text/html` | `.html` | HTML |
| CSS | `text/css` | `.css` | CSS |
| JavaScript | `text/javascript` | `.js` | JS |
| XML | `text/xml` | `.xml` | XML |
| Email | `message/rfc822` | `.eml` | EML |
| Outlook MSG | `application/vnd.ms-outlook` | `.msg` | MSG |
| OpenDocument Text | `application/vnd.oasis.opendocument.text` | `.odt` | ODT |
| OpenDocument Spreadsheet | `application/vnd.oasis.opendocument.spreadsheet` | `.ods` | ODS |
| OpenDocument Presentation | `application/vnd.oasis.opendocument.presentation` | `.odp` | ODP |

## See Also

- [File Upload Feature](file-upload-feature.md)
- [Audio File Support](audio-file-support.md)
- [Image Upload Feature](image-upload-feature.md)
- [Content Management](content-management.md)

## External Resources

- [MDN: MIME Types](https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types)
- [IANA Media Types](https://www.iana.org/assignments/media-types/media-types.xhtml)
