# File Upload Feature Documentation

## Overview

The file upload feature allows users to upload text files, PDF documents, Microsoft Word documents (.docx), and Outlook messages (.msg) to the iHub Apps chat interface. The uploaded content is automatically processed and included in the AI conversation.

## Supported File Types

### Text Files

- `.txt` - Plain text files
- `.md` - Markdown files
- `.csv` - Comma-separated values
- `.json` - JSON files
- `.html` - HTML files
- `.css` - CSS files
- `.js` - JavaScript files

### PDF Files

- `.pdf` - PDF documents (automatically converted to text)

### Microsoft Office Documents

- `.docx` - Microsoft Word documents (automatically converted to text)

### Email Files

- `.msg` - Microsoft Outlook email messages (subject, sender, recipients, and body extracted)

## File Size Limits

- Maximum file size: 10MB

## How It Works

1. **File Selection**: Users click the paper-clip icon to open the file uploader
2. **File Processing**:
   - Text files are read directly
   - PDF files are converted to text using `pdfjs-dist`
   - DOCX files are converted to text using `mammoth`
   - MSG files are parsed using `@kenjiuno/msgreader` to extract subject, sender, recipients, and body
3. **Preview**: The first 200 characters of the file content are shown as a preview
4. **AI Integration**: File content is prepended to the user's message and sent to the AI
5. **Content Format**: Files are formatted as `[File: filename.ext (type)] content`

## Technical Implementation

### Frontend Components

- `FileUploader.jsx` - Handles file selection and processing
- `ChatInput.jsx` - Integrates file upload with chat input
- `AppChat.jsx` - Manages file upload state

### Frontend Libraries

- `pdfjs-dist` - PDF text extraction
- `mammoth` - DOCX to HTML/text conversion
- `@kenjiuno/msgreader` - MSG file parsing

### Backend Processing

- File content is processed in `processMessageTemplates()`
- All AI adapters (OpenAI, Anthropic, Google) handle file content
- Content is automatically included in AI prompts
- Server configured with the `requestBodyLimitMB` setting in `platform.json` (default 50MB) to handle file uploads

### Configuration

Enable file upload for an app by adding to the app configuration:

```json
{
  "settings": {
    "fileUpload": {
      "enabled": true
    }
  },
  "fileUpload": {
    "maxFileSizeMB": 15,
    "supportedTextFormats": [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "text/html",
      "text/css",
      "text/javascript",
      "application/javascript",
      "text/xml"
    ],
    "supportedPdfFormats": ["application/pdf"],
    "supportedDocxFormats": [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    "supportedMsgFormats": ["application/vnd.ms-outlook"]
  }
}
```

#### Configuration Options

**settings.fileUpload.enabled** (boolean)

- Enables or disables the file upload feature for the app
- Default: `false`

**upload.allowMultiple** (boolean)

- When `true`, allows users to select and upload multiple files/images at once
- Default: `false`
- All selected files will be processed individually and sent with the message
- This setting applies to both image and file uploads

**fileUpload.maxFileSizeMB** (number)

- Maximum file size in megabytes
- Default: `10`
- Range: 1-50 (limited by the `requestBodyLimitMB` setting)

**fileUpload.supportedTextFormats** (array)

- List of supported MIME types for text files
- Default: `["text/plain", "text/markdown", "text/csv", "application/json", "text/html", "text/css", "text/javascript", "application/javascript"]`
- Common values:
  - `"text/plain"` - .txt files
  - `"text/markdown"` - .md files
  - `"text/csv"` - .csv files
  - `"application/json"` - .json files
  - `"text/html"` - .html files
  - `"text/css"` - .css files
  - `"text/javascript"` or `"application/javascript"` - .js files
  - `"text/xml"` - .xml files

**fileUpload.supportedPdfFormats** (array)

- List of supported MIME types for PDF files
- Default: `["application/pdf"]`
- Typically only includes `"application/pdf"`

**fileUpload.supportedDocxFormats** (array)

- List of supported MIME types for Microsoft Word documents
- Default: `["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]`
- Typically only includes the DOCX MIME type

**fileUpload.supportedMsgFormats** (array)

- List of supported MIME types for Microsoft Outlook email messages
- Default: `["application/vnd.ms-outlook"]`
- Typically only includes the MSG MIME type

#### Example Configurations

**Full-featured file upload (AI Chat app):**

```json
{
  "upload": {
    "enabled": true,
    "allowMultiple": false
  },
  "fileUpload": {
    "maxFileSizeMB": 15,
    "supportedTextFormats": [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "text/html",
      "text/css",
      "text/javascript",
      "application/javascript",
      "text/xml"
    ],
    "supportedPdfFormats": ["application/pdf"],
    "supportedDocxFormats": [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    "supportedMsgFormats": ["application/vnd.ms-outlook"]
  }
}
```

**Multiple file upload enabled:**

```json
{
  "upload": {
    "enabled": true,
    "allowMultiple": true
  },
  "fileUpload": {
    "maxFileSizeMB": 10,
    "supportedTextFormats": ["text/plain", "text/markdown", "text/html"],
    "supportedPdfFormats": ["application/pdf"],
    "supportedDocxFormats": [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    "supportedMsgFormats": ["application/vnd.ms-outlook"]
  }
}
```

**Text-only file upload (Summarizer app):**

```json
{
  "upload": {
    "enabled": true
  },
  "fileUpload": {
    "maxFileSizeMB": 5,
    "supportedTextFormats": ["text/plain", "text/markdown", "text/html"],
    "supportedPdfFormats": ["application/pdf"]
  }
}
```

**Minimal configuration (uses defaults):**

```json
{
  "settings": {
    "fileUpload": {
      "enabled": true
    }
  }
}
```

## Example Usage

1. Navigate to the AI Chat app
2. Click the paper-clip icon in the input area
3. Select a text file or PDF
4. Review the file preview
5. Type a message (optional) and send
6. The AI will have access to the file content for analysis

## Error Handling

- File size validation (10MB limit)
- File type validation (supported formats only)
- PDF processing error handling
- User-friendly error messages

## Security Considerations

- Files are processed client-side
- Content is only sent to the AI service
- No files are stored on the server
- Content is included in conversation logs (if logging is enabled)
