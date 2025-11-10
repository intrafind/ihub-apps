# DOCX and MSG File Upload Support

## Date

2025-11-10

## Problem Statement

Users requested the ability to upload Microsoft Office document types, especially .docx (Word documents) and .msg (Outlook email messages), to the chat interface. Previously, the file upload feature only supported text files (txt, md, csv, json, html, css, js, xml) and PDF documents. This limitation prevented users from easily sharing and analyzing common Microsoft Office files with the AI.

## Solution

Extended the file upload feature to support .docx and .msg files by adding dedicated processing libraries and updating the configuration schema to allow these new file types.

## Implementation Details

### New Dependencies

**File:** `client/package.json`

Added two npm packages:
- `mammoth@1.11.0` - Converts .docx files to HTML/text
- `@kenjiuno/msgreader@1.27.0-alpha.3` - Parses .msg files and extracts metadata

Both packages were checked for vulnerabilities using the GitHub Advisory Database and are secure.

### Frontend Component Changes

**File:** `client/src/features/upload/components/FileUploader.jsx`

1. **Lazy Loading Functions**: Added lazy loading for new libraries (similar to PDF.js pattern):
   ```javascript
   const loadMammoth = async () => await import('mammoth');
   const loadMsgReader = async () => await import('@kenjiuno/msgreader');
   ```

2. **Supported Formats**: Added new format arrays:
   - `SUPPORTED_DOCX_FORMATS`: `['application/vnd.openxmlformats-officedocument.wordprocessingml.document']`
   - `SUPPORTED_MSG_FORMATS`: `['application/vnd.ms-outlook']`

3. **File Type Display**: Updated `getFileTypeDisplay()` to return 'DOCX' and 'MSG' for respective MIME types

4. **DOCX Processing**:
   - Converts .docx to HTML using mammoth
   - Extracts plain text from HTML for better readability
   - Returns text content for AI processing

5. **MSG Processing**:
   - Parses .msg file using msgreader
   - Extracts key fields: subject, sender name, sender email, recipients, body
   - Formats extracted data as structured text
   - Returns formatted content for AI processing

6. **Format List**: Updated format list generation to include DOCX and MSG in user-facing messages

### Schema Changes

**File:** `server/validators/appConfigSchema.js`

Added two new optional configuration fields to the `fileUpload` schema:

- `supportedDocxFormats`: Array of MIME types for Word documents
  - Default: `['application/vnd.openxmlformats-officedocument.wordprocessingml.document']`
  
- `supportedMsgFormats`: Array of MIME types for Outlook messages
  - Default: `['application/vnd.ms-outlook']`

### Documentation Updates

**File:** `docs/file-upload-feature.md`

1. Updated overview to mention .docx and .msg support
2. Added new sections:
   - "Microsoft Office Documents" section listing .docx support
   - "Email Files" section listing .msg support
3. Updated "How It Works" section to document new processing libraries
4. Added new configuration options documentation
5. Updated all example configurations to include the new format arrays

## Code Locations

- Client dependencies: `client/package.json`
- File processing: `client/src/features/upload/components/FileUploader.jsx`
- Configuration schema: `server/validators/appConfigSchema.js`
- Documentation: `docs/file-upload-feature.md`

## Technical Decisions

1. **Library Selection**:
   - **mammoth**: Chosen for .docx processing because it's actively maintained, widely used, and provides good text extraction without requiring server-side processing
   - **@kenjiuno/msgreader**: Selected for .msg parsing as it's one of the few pure JavaScript libraries that can parse Outlook .msg files in the browser

2. **Lazy Loading**: Maintained the existing pattern of lazy-loading document processing libraries to keep the initial bundle size small

3. **Text Extraction**: For .docx files, HTML is first generated then converted to plain text for consistency with other file types and better AI processing

4. **MSG Field Extraction**: Extracted the most relevant fields (subject, sender, recipients, body) to provide context while keeping the content manageable

5. **Configuration Flexibility**: Added separate configuration arrays for each new file type to allow fine-grained control (e.g., admins could disable .msg but enable .docx)

6. **Backward Compatibility**: New file types are off by default in the schema, ensuring existing configurations continue to work without changes

## Security Considerations

- Both libraries were checked for known vulnerabilities (none found)
- File processing happens entirely client-side
- No files are stored on the server
- File content is only sent to the AI service
- Existing file size limits (default 10MB) apply to new file types
- MIME type validation prevents unauthorized file types

## Testing Considerations

Manual testing should cover:
- Uploading .docx files with various content (text, formatting, tables)
- Uploading .msg files with different email structures
- Verifying text extraction quality from .docx files
- Verifying metadata extraction from .msg files
- File size validation with large documents
- File type validation (rejecting other Office formats not explicitly supported)
- Error handling for corrupted files
- Multiple file upload with .docx and .msg files
- Configuration toggle functionality in admin interface

## Backward Compatibility

- Fully backward compatible
- New file types are disabled by default (empty arrays in schema defaults)
- Existing apps without these configuration fields will continue to work as before
- Apps explicitly configuring file upload will need to add the new fields if they want .docx/.msg support

## Future Enhancements

Potential improvements:
- Support for .doc (older Word format) using a different library
- Support for other Office formats (.xlsx, .pptx)
- Support for .eml (standard email format)
- Enhanced metadata display in file preview (showing sender/subject for .msg files)
- Syntax highlighting or formatting preservation for .docx files
- Image extraction from Office documents
- Table extraction and formatting from .docx files
- Attachment extraction from .msg files

## Related Issues

This implementation addresses the feature request to support M365 document types, with specific focus on .docx and .msg files as the most frequently used formats.
