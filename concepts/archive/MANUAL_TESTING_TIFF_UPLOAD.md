# Manual Testing Script for TIF/TIFF Image Upload Fix

## Prerequisites
- iHub Apps server running
- Access to a TIF or TIFF image file

## Test Case 1: File Analysis App (Default Configuration)

### Steps:
1. Start the iHub Apps server:
   ```bash
   npm run dev
   ```

2. Open browser and navigate to the File Analysis app

3. Click the file upload area

4. Select a .tif or .tiff file from your system

### Expected Results:
- ✅ File is accepted without error
- ✅ No "invalid-image" error appears
- ✅ Document-style preview shows:
  - File name
  - "TIFF" file type
  - Message: "TIFF image file (preview not available in browser)"
- ✅ File can be submitted successfully

### Previous Behavior (Before Fix):
- ❌ Error: "Error processing file: Error: invalid-image"
- ❌ File upload failed

## Test Case 2: Custom App Configuration

### Steps:
1. Create or edit an app configuration to include TIFF support:
   ```json
   {
     "upload": {
       "imageUpload": {
         "enabled": true,
         "supportedFormats": [
           "image/jpeg",
           "image/png",
           "image/tiff",
           "image/tif"
         ]
       }
     }
   }
   ```

2. Restart server if needed (platform.json changes only)

3. Upload a TIFF file to the app

### Expected Results:
- ✅ File accepted without error
- ✅ Base64 data captured
- ✅ File metadata preserved

## Test Case 3: Verify Other Formats Still Work

### Steps:
1. Upload a JPEG file
2. Upload a PNG file  
3. Upload a GIF file
4. Upload a WebP file

### Expected Results:
- ✅ All formats work as before
- ✅ Image preview appears for supported formats
- ✅ Resizing occurs if configured
- ✅ No regression in existing functionality

## Verification Checklist

### Before Testing:
- [ ] Server dependencies installed (`npm install` in /server)
- [ ] Client dependencies installed (`npm install` in /client)
- [ ] Server running on port 3000
- [ ] Client running on port 5173 (dev mode)

### During Testing:
- [ ] No console errors when selecting TIFF file
- [ ] File upload UI shows appropriate feedback
- [ ] File data is captured (check Network tab)
- [ ] Other image formats still work correctly

### After Testing:
- [ ] TIFF files can be processed by backend (if applicable)
- [ ] No memory leaks from blob URLs
- [ ] Multiple TIFF uploads work sequentially

## Sample TIFF Files

If you don't have TIFF files for testing, you can:

1. Convert an existing image to TIFF using ImageMagick:
   ```bash
   convert input.jpg output.tif
   ```

2. Download sample TIFF files from:
   - https://filesamples.com/formats/tiff
   - https://www.libreoffice.org/assets/images/ (many use TIFF)

3. Create a TIFF using GIMP:
   - Open any image
   - File → Export As
   - Choose .tif extension
   - Export

## Debugging

If issues occur:

1. Check browser console for errors
2. Check Network tab for failed requests
3. Verify MIME type detection:
   ```javascript
   console.log(file.type); // Should be 'image/tiff' or 'image/tif'
   ```
4. Check server logs for backend processing errors

## Success Criteria

The fix is working correctly if:
- ✅ TIFF files upload without "invalid-image" error
- ✅ Base64 data is captured correctly
- ✅ File metadata (name, size, type) is preserved
- ✅ Other image formats continue to work normally
- ✅ No console errors or warnings
- ✅ Backend receives TIFF data correctly

## Notes

- TIFF preview is not available in browsers (by design)
- TIFF files are sent to backend without client-side resizing
- Width/height metadata is null for TIFF files (cannot be extracted without processing)
- Backend systems should handle TIFF processing if needed
