# Multiple File Upload Feature

## Overview

This feature allows users to upload multiple files and/or images at once when the upload feature is configured for an app. Previously, only single file uploads were supported.

## Date

2025-10-27

## Problem Statement

Users could only upload one file or image at a time. When analyzing multiple documents or images, this required multiple separate upload operations, which was inefficient and cumbersome for the user experience.

## Solution

Added a configuration option `allowMultiple` to both `imageUpload` and `fileUpload` sections of the app configuration schema. When enabled, users can select multiple files from their file picker, and all files are processed individually and sent together with the message.

## Implementation Details

### Schema Changes

**File:** `server/validators/appConfigSchema.js`

Added `allowMultiple` boolean field to the `upload` configuration (default: `false`). This is a single top-level setting that applies to both image and file uploads.

### Component Changes

**File:** `client/src/features/upload/components/Uploader.jsx`
- Added `allowMultiple` prop
- Modified `handleFileChange` to process arrays of files when `allowMultiple` is true
- Added `multiple` attribute to file input element
- Validates all files before processing

**File:** `client/src/features/upload/components/UnifiedUploader.jsx`
- Reads `allowMultiple` configuration from the top-level `upload` config
- Updated preview rendering to handle arrays of files
- Displays multiple file previews with a "Remove All" button
- Shows count of selected files

**File:** `client/src/features/apps/pages/AppChat.jsx`
- Modified message content generation to handle arrays of files
- Processes multiple images and documents separately
- Generates appropriate HTML indicators for each file type
- Sends arrays to the API when multiple files are selected

**File:** `client/src/shared/hooks/useFileUploadHandler.js`
- Updated to pass `allowMultiple` from the top-level upload configuration
- Removed separate allowMultiple properties from imageUpload and fileUpload objects

### Admin Interface Changes

**File:** `client/src/features/admin/components/AppFormEditor.jsx`

Added a single checkbox in the Upload Configuration section:
- "Allow Multiple Files" - applies to both images and files

### Translations

Added to both English (`en.json`) and German (`de.json`):
- `components.uploader.uploadFiles`: "Upload Files" / "Dateien hochladen"
- `components.uploader.filesSelected`: "{{count}} file(s) selected" / "{{count}} Datei(en) ausgewählt"
- `common.remove`: "Remove file" / "Datei entfernen"
- `common.removeAll`: "Remove All" / "Alle entfernen"

### Documentation Updates

**File:** `docs/file-upload-feature.md`
- Added documentation for `fileUpload.allowMultiple` configuration option
- Added example configuration with multiple file upload enabled

**File:** `docs/image-upload-feature.md`
- Added documentation for `imageUpload.allowMultiple` configuration option
- Added extended usage section describing multiple image selection

## Code Locations

- Schema: `server/validators/appConfigSchema.js`
- Base uploader component: `client/src/features/upload/components/Uploader.jsx`
- Unified uploader component: `client/src/features/upload/components/UnifiedUploader.jsx`
- Chat integration: `client/src/features/apps/pages/AppChat.jsx`
- Admin configuration: `client/src/features/admin/components/AppFormEditor.jsx`
- Translations: `shared/i18n/en.json`, `shared/i18n/de.json`
- Documentation: `docs/file-upload-feature.md`, `docs/image-upload-feature.md`

## Backward Compatibility

The feature is fully backward compatible:
- Default value for `allowMultiple` is `false` for both image and file uploads
- Existing configurations without this field will continue to work as single file uploads
- Single file upload behavior is preserved when `allowMultiple` is `false`

## Technical Decisions

1. **Unified configuration**: A single `allowMultiple` setting at the upload level applies to both images and files, simplifying configuration and avoiding confusion.

2. **Array-based handling**: When multiple files are selected, components handle them as arrays throughout the pipeline for consistency.

3. **Individual validation**: Each file is validated independently before processing to provide clear error messages.

4. **Preview enhancements**: Multiple file previews are displayed in a scrollable list with a single "Remove All" button for better UX.

5. **Message formatting**: Multiple files are concatenated with appropriate HTML indicators in the message display, maintaining clear visual distinction between images and documents.

## Testing Considerations

Manual testing should cover:
- Single file upload (backward compatibility)
- Multiple file upload with images only
- Multiple file upload with documents only
- Mixed multiple upload (images and documents)
- File size validation with multiple files
- File type validation with multiple files
- Admin UI configuration toggles
- Message display with multiple attachments

## Future Enhancements

Potential future improvements:
- Individual file removal from the preview (currently only "Remove All")
- Drag-and-drop support for multiple files
- Progress indication for each file during processing
- Reordering of selected files before sending
- Maximum file count limit configuration
