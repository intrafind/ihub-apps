# Mimetype Configuration

This directory contains the `mimetypes.json` configuration file that defines which file types are supported for upload and how they are displayed in the UI.

## Configuration Structure

The `mimetypes.json` file has three main sections:

### 1. supportedTextFormats

An array of MIME types that are supported for text/document uploads.

```json
{
  "supportedTextFormats": [
    "text/plain",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ]
}
```

### 2. mimeToExtension

A mapping from MIME type to file extension(s). Multiple extensions can be comma-separated.

```json
{
  "mimeToExtension": {
    "text/plain": ".txt",
    "image/jpeg": ".jpeg,.jpg",
    "application/pdf": ".pdf"
  }
}
```

### 3. typeDisplayNames

A mapping from MIME type to display name shown in the UI.

```json
{
  "typeDisplayNames": {
    "text/plain": "TXT",
    "application/pdf": "PDF",
    "image/jpeg": "JPEG"
  }
}
```

## Adding a New File Type

To add support for a new file type:

1. Add the MIME type to `supportedTextFormats` array (for document types)
2. Add the MIME type and extension(s) to `mimeToExtension`
3. Add a display name to `typeDisplayNames`

### Example: Adding EPUB Support

```json
{
  "supportedTextFormats": [
    "application/epub+zip"
  ],
  "mimeToExtension": {
    "application/epub+zip": ".epub"
  },
  "typeDisplayNames": {
    "application/epub+zip": "EPUB"
  }
}
```

## Notes

- Changes to this file take effect immediately (no server restart required in most cases)
- The client caches this configuration for 30 minutes
- Image and audio formats don't need to be in `supportedTextFormats` (they are handled separately)
- Make sure to include both the MIME type and extension mapping for proper file upload handling

## Common MIME Types

| File Type | MIME Type | Extension |
|-----------|-----------|-----------|
| Plain Text | `text/plain` | `.txt` |
| PDF | `application/pdf` | `.pdf` |
| Word (DOCX) | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` |
| Excel (XLSX) | `application/vnd.openxmlformats-officedocument.spreadsheetml.document` | `.xlsx` |
| PowerPoint (PPTX) | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `.pptx` |
| Markdown | `text/markdown` | `.md` |
| JSON | `application/json` | `.json` |
| HTML | `text/html` | `.html` |
| CSV | `text/csv` | `.csv` |

For a complete list of MIME types, see: https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Common_types
