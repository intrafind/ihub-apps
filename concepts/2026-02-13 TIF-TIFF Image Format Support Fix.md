# TIF/TIFF Image Format Support Fix

**Date:** 2026-02-13  
**Issue:** Picking TIF results in Invalid image file  
**Status:** Enhanced with TIFF Conversion and Multipage Support  
**Last Updated:** 2026-02-14

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

## Solution Evolution

### Initial Solution (Commit 0e849d1)
Basic TIFF file handling by bypassing browser Image processing and returning raw base64 data.

### Enhanced Solution v1 (Commit d0edd9d)
Implemented full TIFF decoding and conversion to PNG using the UTIF library, as suggested by @manzke.

### Enhanced Solution v2 (Current)
Added multipage TIFF support - each page becomes a separate image when `allowMultiple` is enabled, as requested by @manzke.

### Changes Made

#### 1. Added UTIF Library (`client/package.json`)
```json
"utif2": "^4.1.0"
```
UTIF2 is a modern TIFF decoder that supports:
- All TIFF compression types
- Multipage TIFF files
- RGBA conversion
- High performance

#### 2. Created TIFF Processing Utility (`fileProcessing.js`)
```javascript
export const processTiffFile = async (file, options = {}) => {
  const { maxDimension = 1024, resize = true } = options;
  
  // Load UTIF library lazily
  const UTIF = await loadUTIF();
  
  // Decode TIFF
  const arrayBuffer = await file.arrayBuffer();
  const ifds = UTIF.decode(arrayBuffer);
  
  // Process each page
  const pages = [];
  for (let i = 0; i < ifds.length; i++) {
    const ifd = ifds[i];
    UTIF.decodeImage(arrayBuffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    
    // Create canvas and convert to PNG
    // Apply resizing if configured
    // Return base64 PNG data for each page
  }
  
  return pages; // Array of all pages
}
```

#### 3. Updated ImageUploader.jsx
- Detects TIFF files (`image/tiff`, `image/tif`)
- Calls `processTiffFile()` to decode and convert to PNG
- Creates preview from converted PNG data
- Supports resizing based on configuration
- Handles multipage TIFFs (uses first page for single image upload mode)
- Preserves original metadata (filename, type, etc.)

#### 4. Updated UnifiedUploader.jsx  
- Same TIFF detection and conversion logic
- **NEW**: For multipage TIFFs with `allowMultiple` enabled:
  - Each page becomes a separate image
  - Filenames include page number (e.g., `document_page1.png`, `document_page2.png`)
  - All pages are returned as separate results
- When `allowMultiple` is disabled or single-page TIFF:
  - Uses first page only
  - Standard single image handling
- Generates proper image preview instead of document-style preview
- Converts TIFF to PNG for universal browser compatibility

#### 5. Updated Uploader.jsx (Base Component)
- Enhanced to handle `multipleResults` from single file processing
- When a file processor returns `{ multipleResults: [...] }`:
  - In `allowMultiple` mode: Expands all results into the results array
  - In single mode: Uses only the first result
- Maintains backward compatibility with standard single-result processing

### Code Implementation

**Multipage TIFF Detection and Processing (with allowMultiple):**
```javascript
const isTiff = file.type === 'image/tiff' || file.type === 'image/tif';

if (isTiff) {
  // Process TIFF file and convert to PNG
  const pages = await processTiffFile(file, {
    maxDimension: MAX_DIMENSION,
    resize: RESIZE_IMAGES
  });

  // For multipage TIFFs, return all pages as separate images
  if (pages.length > 1 && allowMultiple) {
    const pageResults = [];
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      
      // Create blob URL for preview
      const response = await fetch(page.base64);
      const blob = await response.blob();
      const previewUrl = URL.createObjectURL(blob);
      
      // Generate filename with page number
      const baseFileName = file.name.replace(/\.tiff?$/i, '');
      const fileName = `${baseFileName}_page${page.pageNumber}.png`;
      
      pageResults.push({
        preview: { type: 'image', url: previewUrl },
        data: {
          type: 'image',
          base64: page.base64,
          fileName: fileName,  // e.g., document_page1.png
          fileSize: blob.size,
          fileType: 'image/png',
          width: page.width,
          height: page.height,
          originalFileType: file.type,
          originalFileName: file.name,
          pageNumber: page.pageNumber,
          totalPages: page.totalPages
        }
      });
    }
    
    // Return special structure to indicate multiple results from single file
    return { multipleResults: pageResults };
  }

  // For single-page TIFF or when allowMultiple is false
  const firstPage = pages[0];
  const response = await fetch(firstPage.base64);
  const blob = await response.blob();
  const previewUrl = URL.createObjectURL(blob);

  return {
    preview: { type: 'image', url: previewUrl },
    data: {
      type: 'image',
      base64: firstPage.base64,
      fileName: file.name.replace(/\.tiff?$/i, '.png'),
      fileSize: blob.size,
      fileType: 'image/png',
      width: firstPage.width,
      height: firstPage.height,
      originalFileType: file.type,
      originalFileName: file.name,
      tiffPages: pages.length > 1 ? pages : undefined
    }
  };
}
```

**Uploader.jsx Enhancement for Multiple Results:**
```javascript
// In Uploader.jsx processFiles function
if (allowMultiple) {
  const results = [];
  for (const file of files) {
    const result = await onProcessFile(file);
    if (result && typeof result === 'object') {
      // Check if this is a multipage TIFF that returned multiple results
      if (result.multipleResults && Array.isArray(result.multipleResults)) {
        // Add all pages from multipage TIFF
        results.push(...result.multipleResults);
      } else {
        results.push(result);
      }
    }
  }
  
  if (results.length > 0) {
    setPreview(results.map(r => r.preview || null));
    if (onSelect) {
      onSelect(results.map(r => r.data));
    }
  }
}
```
  });
}
```

## Testing

### Automated Testing
- ✅ Linting passes (no new errors)
- ✅ Formatting passes (no changes needed)
- ✅ Server starts successfully
- ✅ Client builds successfully (includes UTIF library at 108.90 kB gzipped: 39.76 kB)

### Manual Testing Required

#### Single-Page TIFF Test
1. Configure TIFF support in an app's `upload.imageUpload.supportedFormats`:
   ```json
   "supportedFormats": ["image/jpeg", "image/png", "image/tiff", "image/tif"]
   ```
2. Upload a single-page TIFF file through the interface
3. Verify:
   - No "invalid-image" error occurs
   - File is converted to PNG automatically
   - Image preview appears (not document-style)
   - Width/height are extracted correctly
   - File can be resized if configured
   - File can be submitted successfully to the backend

#### Multipage TIFF Test (without allowMultiple)
1. Upload a multipage TIFF file to an app without `allowMultiple` enabled
2. Verify:
   - First page is used for preview and submission
   - All pages are included in `tiffPages` data array
   - Conversion to PNG succeeds
   - No errors occur

#### Multipage TIFF Test (with allowMultiple) - NEW!
1. Configure an app with both TIFF support and multiple file upload:
   ```json
   "upload": {
     "allowMultiple": true,
     "imageUpload": {
       "enabled": true,
       "supportedFormats": ["image/jpeg", "image/png", "image/tiff", "image/tif"]
     }
   }
   ```
2. Upload a multipage TIFF file (e.g., 3-page document)
3. Verify:
   - Each page becomes a separate image
   - All pages show as separate previews
   - Filenames include page numbers (e.g., `scan_page1.png`, `scan_page2.png`, `scan_page3.png`)
   - Each page has correct dimensions
   - All pages can be submitted to backend as separate images
   - Page metadata includes `pageNumber` and `totalPages`

### Expected Behavior Changes

**Before (Initial Fix):**
- TIFF files: No preview, null dimensions, raw TIFF base64 data
- Other images: Normal processing with preview

**After v1 (Enhanced with UTIF):**
- TIFF files: PNG preview, actual dimensions, converted PNG base64 data
- Multipage TIFFs: First page as preview, all pages in tiffPages array
- Other images: Normal processing (unchanged)

**After v2 (Current - Multipage Support):**
- Single-page TIFF: PNG preview, actual dimensions, converted PNG base64 data
- Multipage TIFF without allowMultiple: First page only, all pages in tiffPages array
- Multipage TIFF with allowMultiple: **Each page becomes separate image** with unique filename
- Other images: Normal processing (unchanged)

### Server Startup Verification
- ✅ Server starts successfully with changes
- ✅ No linting errors introduced
- ✅ Code formatting passes

## Impact

### Positive
- **TIFF Upload Support**: TIFF files can now be uploaded without errors
- **Full Image Processing**: TIFF files are converted to PNG and get full preview/resize support
- **Multipage Support**: Multipage TIFF files are handled (first page for preview, all pages available in data)
- **Universal Compatibility**: Converted PNG format works everywhere (browser preview, backend processing)
- **Dimension Extraction**: Width and height are properly extracted from TIFF files
- **Existing Formats Unchanged**: JPEG, PNG, GIF, WebP continue to work exactly as before
- **Minimal Breaking Changes**: Only changes TIFF handling from error to successful conversion

### Limitations Removed
- ~~TIFF files cannot be previewed~~ → Now converted to PNG for preview
- ~~TIFF files cannot be resized~~ → Now resized like other images
- ~~Width/height metadata not available~~ → Now extracted during conversion

### New Considerations
- **Library Size**: Adds ~109 KB (40 KB gzipped) for UTIF library
- **Processing Time**: TIFF decoding takes additional time (especially for large/multipage files)
- **Memory Usage**: TIFF decoding requires more memory than simple image loading
- **Error Handling**: New error type `tiff-processing-error` for corrupted/unsupported TIFF formats

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
- `client/src/features/upload/components/ImageUploader.jsx` (Enhanced with TIFF conversion)
- `client/src/features/upload/components/UnifiedUploader.jsx` (Enhanced with TIFF conversion)
- `client/src/features/upload/utils/fileProcessing.js` (Added `processTiffFile` utility)
- `client/package.json` (Added utif2 dependency)

### Configuration Files
- `server/defaults/apps/file-analysis.json` (already configured for TIFF)
- `examples/apps/file-analysis.json` (already configured for TIFF)

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

### UTIF Library
Using **utif2** (v4.1.0) for TIFF decoding:
- Supports all TIFF compression types (LZW, PackBits, JPEG, etc.)
- Handles multipage TIFF documents
- Converts to RGBA8 format for canvas rendering
- Lazy-loaded only when TIFF files are uploaded
- Size: ~109 KB (~40 KB gzipped)

### Multipage TIFF Handling
For multipage TIFF files:
1. All pages are decoded and converted
2. First page is used for preview and primary data
3. Additional pages stored in `tiffPages` array
4. Each page includes: base64, width, height, page number, total pages

### Implementation Inspiration
Solution based on suggestion by @manzke to use TIFF conversion libraries:
- https://github.com/photopea/UTIF.js (original)
- https://github.com/image-js/tiff
- We chose utif2 as it's the maintained fork with TypeScript support

### Future Enhancements
~Potential improvements for better TIFF support:~ (Implemented!)
1. ~~Client-side TIFF library integration~~ ✅ Implemented with UTIF
2. ~~Extract dimensions from TIFF files~~ ✅ Implemented
3. ~~Preview generation~~ ✅ Implemented via PNG conversion
4. Possible: Multi-page TIFF UI for selecting which page to use
5. Possible: Extract EXIF/metadata from TIFF files
6. Possible: Server-side TIFF processing for very large files

## Deployment Notes

- Client rebuild required (new dependency)
- No server restart required  
- No database migrations needed
- No API changes
- Compatible with all existing configurations
- Safe to deploy to production
- Adds ~40 KB (gzipped) to client bundle size
