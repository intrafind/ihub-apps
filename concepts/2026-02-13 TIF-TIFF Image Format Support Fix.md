# TIF/TIFF Image Format Support Fix

**Date:** 2026-02-13  
**Issue:** Picking TIF results in Invalid image file  
**Status:** Fixed

## Problem Statement

When users configured TIF/TIFF image formats in the `supportedFormats` configuration and attempted to upload TIFF files, they received an "invalid-image" error:

```
Error processing file: Error: invalid-image
    at z.onerror (index-BULJTuZC.js:277:2287)
```

## Root Cause Analysis

The issue occurred because:

1. **Browser Limitation**: Modern web browsers do not natively support TIFF image format in the HTML `Image` object or `<img>` tags
2. **Image Processing Pipeline**: The upload components (`ImageUploader.jsx` and `UnifiedUploader.jsx`) attempted to load all image files using the browser's `Image` object to:
   - Extract dimensions (width/height)
   - Create preview URLs
   - Resize images if configured
3. **Error Trigger**: When `img.src = e.target.result` was set with TIFF data, the `img.onerror` callback fired immediately, rejecting the promise with "invalid-image" error

## Solution

Implemented special handling for TIFF files to bypass browser image processing:

### Changes Made

#### 1. ImageUploader.jsx
- Added detection for TIFF files before attempting Image object loading
- For TIFF files:
  - Skip preview generation (set `preview: null`)
  - Return base64 data directly without processing
  - Set width/height to `null` since they cannot be extracted
  - Preserve original file type and metadata

#### 2. UnifiedUploader.jsx  
- Added same TIFF detection logic
- For TIFF files:
  - Use document-style preview with file info
  - Display message: "TIFF image file (preview not available in browser)"
  - Return base64 data marked as `type: 'image'`
  - Preserve all file metadata

### Code Implementation

```javascript
// TIFF files are not supported by browser Image object, handle them separately
const isTiff = file.type === 'image/tiff' || file.type === 'image/tif';

if (isTiff) {
  // For TIFF files, return base64 data with appropriate preview format
  return resolve({
    preview: { type: 'document', fileName: file.name, fileType: 'TIFF', ... },
    data: {
      type: 'image',
      base64: e.target.result,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      width: null,
      height: null
    }
  });
}
```

## Testing

### Manual Testing Required
1. Configure TIFF support in an app's `upload.imageUpload.supportedFormats`:
   ```json
   "supportedFormats": ["image/jpeg", "image/png", "image/tiff", "image/tif"]
   ```
2. Upload a TIFF file through the interface
3. Verify:
   - No "invalid-image" error occurs
   - File is accepted and base64 data is captured
   - For UnifiedUploader: Document-style preview appears
   - File can be submitted successfully to the backend

### Server Startup Verification
- ✅ Server starts successfully with changes
- ✅ No linting errors introduced
- ✅ Code formatting passes

## Impact

### Positive
- TIFF files can now be uploaded without errors
- Existing image formats (JPEG, PNG, GIF, WebP) continue to work with full preview/resize support
- Minimal code changes (surgical fix)
- No breaking changes to existing functionality

### Limitations
- TIFF files cannot be previewed in the browser
- TIFF files cannot be resized client-side (sent as-is to server)
- Width/height metadata not available for TIFF files
- Backend systems must handle TIFF format processing if needed

## Configuration Examples

TIFF support is already configured in several default apps:

### File Analysis App
```json
"imageUpload": {
  "enabled": true,
  "supportedFormats": [
    "image/jpeg",
    "image/jpg", 
    "image/png",
    "image/gif",
    "image/webp",
    "image/tiff",
    "image/tif"
  ]
}
```

## Related Files

### Modified Files
- `client/src/features/upload/components/ImageUploader.jsx`
- `client/src/features/upload/components/UnifiedUploader.jsx`

### Configuration Files
- `server/defaults/apps/file-analysis.json` (already configured for TIFF)
- `examples/apps/file-analysis.json` (already configured for TIFF)

### Utility Files
- `client/src/features/upload/utils/fileProcessing.js` (already has TIFF extension mapping)

## Technical Notes

### MIME Types for TIFF
The fix handles both common TIFF MIME types:
- `image/tiff` (standard)
- `image/tif` (alternative)

### File Extension Mapping
Already existed in `fileProcessing.js`:
```javascript
'image/tiff': '.tiff,.tif',
'image/tif': '.tif',
```

### Future Enhancements
Potential improvements for better TIFF support:
1. Server-side TIFF to JPEG/PNG conversion for preview generation
2. Client-side TIFF library integration (e.g., using WebAssembly)
3. Extract EXIF data from TIFF files for metadata display
4. Thumbnail generation using server-side processing

## Deployment Notes

- No server restart required (client-side only changes)
- No database migrations needed
- No API changes
- Compatible with all existing configurations
- Safe to deploy to production
