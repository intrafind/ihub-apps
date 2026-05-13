# Upload Feature Documentation

## Overview

iHub Apps supports a unified upload system that enables users to attach files, images, audio recordings, and cloud storage documents to their AI conversations. All upload types are configured together under the `upload` key in the app configuration.

## Upload Types

Four upload sub-types are available, each independently enabled:

| Type | Description | Default size limit |
|------|-------------|--------------------|
| `fileUpload` | Text documents, PDFs, Office files, email files | 5 MB |
| `imageUpload` | JPEG, PNG, GIF, WebP, TIFF images | 10 MB |
| `audioUpload` | MP3, WAV, FLAC, OGG, MP4 audio | 20 MB |
| `cloudStorageUpload` | Google Drive, OneDrive, Nextcloud | — |

## Configuration

All upload types share a single `upload` object in the app configuration:

```json
{
  "upload": {
    "enabled": true,
    "allowMultiple": false,
    "fileUpload": { "enabled": true },
    "imageUpload": { "enabled": true },
    "audioUpload": { "enabled": true },
    "cloudStorageUpload": { "enabled": true }
  }
}
```

### Top-Level Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch — must be `true` for any upload to work |
| `allowMultiple` | boolean | `false` | Allow selecting multiple files at once (applies to all types) |

### `fileUpload` Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable document/file attachment |
| `maxFileSizeMB` | number (1–100) | `5` | Maximum file size in megabytes |
| `supportedFormats` | string[] | See below | MIME types accepted for upload |

Default `supportedFormats` for `fileUpload`:

```
text/plain, text/markdown, text/csv, application/json, text/html, text/css,
text/javascript, application/javascript, text/xml, message/rfc822,
application/pdf,
application/vnd.openxmlformats-officedocument.wordprocessingml.document,
application/vnd.ms-outlook, application/x-msg,
application/vnd.oasis.opendocument.text,
application/vnd.oasis.opendocument.spreadsheet,
application/vnd.oasis.opendocument.presentation
```

### `imageUpload` Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable image attachment |
| `resizeImages` | boolean | `true` | Resize to max 1024 px and convert to JPEG before sending |
| `maxFileSizeMB` | number (1–100) | `10` | Maximum file size in megabytes |
| `supportedFormats` | string[] | `['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']` | Must match `image/*` |

TIFF images (`image/tiff`, `image/tif`) are supported when added to `supportedFormats` — they are converted to PNG before being sent to the model. Multi-page TIFFs produce one image per page.

### `audioUpload` Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable audio attachment |
| `maxFileSizeMB` | number (1–100) | `20` | Maximum file size in megabytes |
| `supportedFormats` | string[] | `['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/flac', 'audio/ogg', 'audio/mp4']` | Must match `audio/*` |

The system can also extract the audio track from video files using the Web Audio API.

> **Note:** Audio upload requires a model that supports audio input. OpenAI (GPT-4o Audio models) and Google Gemini support audio; Anthropic Claude does not.

### `cloudStorageUpload` Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Show the cloud storage file picker |

Supported providers (configured at the platform level):

- Google Drive
- Microsoft OneDrive / Office 365
- Nextcloud

## Supported File Types

### Documents and Text Files

| Extension | MIME Type | Processing library |
|-----------|-----------|-------------------|
| `.txt`, `.md`, `.csv`, `.json`, `.html`, `.css`, `.js`, `.xml` | `text/*` / `application/json` | Read directly as text |
| `.pdf` | `application/pdf` | Text extracted via `pdfjs-dist`; falls back to rendering each page as an image |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Converted to text via `mammoth` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | Cell content extracted via `xlsx` |
| `.xls` | `application/vnd.ms-excel` | Cell content extracted via `xlsx` |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | Slide text extracted via `xlsx` |
| `.ppt` | `application/vnd.ms-powerpoint` | Slide text extracted via `xlsx` |
| `.odt` | `application/vnd.oasis.opendocument.text` | XML text extracted via `jszip` |
| `.ods` | `application/vnd.oasis.opendocument.spreadsheet` | XML text extracted via `jszip` |
| `.odp` | `application/vnd.oasis.opendocument.presentation` | XML text extracted via `jszip` |
| `.msg` | `application/vnd.ms-outlook`, `application/x-msg` | Subject, sender, recipients, body extracted via `@kenjiuno/msgreader` |
| `.eml` | `message/rfc822` | Read as-is (RFC 822 format) |

> `.xlsx`, `.xls`, `.pptx`, and `.ppt` are fully supported by the processing engine but are not included in the default `supportedFormats` list. Add their MIME types explicitly to enable them.

### Images

| Extension | MIME Type | Notes |
|-----------|-----------|-------|
| `.jpg`, `.jpeg` | `image/jpeg` | |
| `.png` | `image/png` | |
| `.gif` | `image/gif` | |
| `.webp` | `image/webp` | |
| `.tiff`, `.tif` | `image/tiff` | Converted to PNG; multi-page supported |

### Audio

| Extension | MIME Type |
|-----------|-----------|
| `.mp3` | `audio/mpeg`, `audio/mp3` |
| `.wav` | `audio/wav` |
| `.flac` | `audio/flac` |
| `.ogg` | `audio/ogg` |
| `.mp4` (audio) | `audio/mp4` |

## LLM Provider Support

| Provider | Images | Audio | Files (text) |
|----------|:------:|:-----:|:------------:|
| OpenAI (GPT-4o, GPT-4 Vision, etc.) | ✅ | ✅ (GPT-4o Audio) | ✅ |
| Anthropic (Claude) | ✅ | ❌ | ✅ |
| Google Gemini | ✅ | ✅ | ✅ |
| Mistral | ✅ | ❌ | ✅ |
| Local (vLLM, LM Studio, Jan.ai) | ✅ | ❌ | ✅ |

File content (text documents, PDFs, etc.) is always converted to plain text and prepended to the message, so it works with any text-capable model regardless of multimodal support.

## How It Works

### Processing Pipeline

All file processing happens **client-side** before content is sent to the server.

1. **Selection** — User clicks the paperclip (files), camera (images), or microphone icon (audio).
2. **Validation** — MIME type and file size are checked against the app's upload configuration. File extension is used as a fallback when the browser reports an incorrect MIME type.
3. **Processing** (type-specific):
   - **Text files** — Read directly as UTF-8 text.
   - **PDF** — Text extracted via PDF.js. If the extracted text is empty or minimal (e.g. a scanned document), each page is rendered as an image instead.
   - **DOCX** — Converted to plain text via mammoth.
   - **XLSX / XLS** — Cell content extracted as text via the xlsx library.
   - **PPTX / PPT** — Slide text extracted via the xlsx library.
   - **ODT / ODS / ODP** — XML parsed and text content extracted via jszip.
   - **MSG** — Subject, sender, recipients, and body extracted via msgreader.
   - **EML** — Read as-is.
   - **Images** — Optionally resized to max 1024 px and converted to JPEG; TIFF images converted to PNG first.
   - **Audio** — Base64-encoded and sent natively to the model.
   - **Video** — Audio track extracted via the Web Audio API, then processed as audio.
4. **Preview** — Attached files are displayed with a preview before sending.
5. **Sending** — File content is packed into the message:
   - Text file content → prepended to `message.content` as `[File: filename.ext (type)]\n<content>`
   - Image data → `imageData` property (base64)
   - Audio data → `audioData` property (base64)
6. **Provider formatting** — The server reformats data per provider:
   - **OpenAI** — `image_url` content parts (images) or `input_audio` parts (audio)
   - **Anthropic** — `image` source blocks with base64 data
   - **Google** — `inlineData` parts with MIME type and base64

### Size Limits

| Type | Default | Configurable range | Server ceiling |
|------|---------|--------------------|----------------|
| Files | 5 MB | 1–100 MB | 50 MB |
| Images | 10 MB | 1–100 MB | 50 MB |
| Audio | 20 MB | 1–100 MB | 50 MB |

The server-wide request body limit is set by `requestBodyLimitMB` in `platform.json` (default: 50 MB). Per-type limits must stay within this ceiling.

## Example Configurations

### Full-featured (all upload types)

```json
{
  "upload": {
    "enabled": true,
    "allowMultiple": true,
    "imageUpload": {
      "enabled": true,
      "resizeImages": true,
      "maxFileSizeMB": 10,
      "supportedFormats": [
        "image/jpeg", "image/jpg", "image/png",
        "image/gif", "image/webp", "image/tiff"
      ]
    },
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 20
    },
    "fileUpload": {
      "enabled": true,
      "maxFileSizeMB": 5
    },
    "cloudStorageUpload": {
      "enabled": true
    }
  }
}
```

### Document summarizer (PDF and Office files only)

```json
{
  "upload": {
    "enabled": true,
    "fileUpload": {
      "enabled": true,
      "maxFileSizeMB": 10,
      "supportedFormats": [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ]
    }
  }
}
```

### Audio transcription

```json
{
  "upload": {
    "enabled": true,
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 20,
      "supportedFormats": [
        "audio/mpeg", "audio/mp3", "audio/wav",
        "audio/flac", "audio/ogg", "audio/mp4"
      ]
    }
  }
}
```

### Image analysis (no resizing)

```json
{
  "upload": {
    "enabled": true,
    "allowMultiple": true,
    "imageUpload": {
      "enabled": true,
      "resizeImages": false,
      "maxFileSizeMB": 10
    }
  }
}
```

### Minimal (file upload with all defaults)

```json
{
  "upload": {
    "enabled": true,
    "fileUpload": { "enabled": true }
  }
}
```

## Frontend Components

| Component | Purpose |
|-----------|---------|
| `UnifiedUploader.jsx` | Main upload coordinator; auto-detects file type and routes to the correct handler |
| `ImageUploader.jsx` | Image resizing, TIFF-to-PNG conversion, base64 encoding |
| `Uploader.jsx` | Generic file handling with drag-and-drop and MIME validation |
| `AttachedFilesList.jsx` | Preview display for attached files; allows individual removal |
| `CloudStoragePicker.jsx` | Cloud storage provider selection dialog |
| `GoogleDriveFileBrowser.jsx` | Google Drive file browser |
| `Office365FileBrowser.jsx` | OneDrive / SharePoint file browser |
| `NextcloudFileBrowser.jsx` | Nextcloud file browser |

## Security Considerations

- All file processing happens client-side; only extracted text or base64-encoded data is transmitted to the server.
- No files are stored on the server; content exists only for the duration of the conversation session.
- File content is included in conversation logs if server-side logging is enabled.
- MIME type and file size are validated before processing begins.
- File extension is used as a secondary validation when the browser reports an incorrect MIME type.
