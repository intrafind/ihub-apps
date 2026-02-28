# Image Watermarking Feature

**Date**: 2026-02-20  
**Status**: Implemented  
**Related Issue**: Add watermarks to generated images

## Overview

This document describes the implementation of automatic watermarking and metadata tagging for AI-generated images. The feature adds installation-specific (and optionally user-specific) watermarks to all generated images, along with EXIF/IPTC metadata for provenance tracking.

## Requirements

1. **Watermarking**: Add visual watermarks to generated images
   - Installation-specific text
   - User-specific information (optional)
   - Configurable position, opacity, and color
2. **Metadata**: Add EXIF/IPTC metadata to images
   - Creator/Artist information
   - Timestamp
   - Copyright notice
   - Software/generator information
3. **Configuration**: Make watermarking configurable via platform.json
4. **Performance**: Minimal impact on image generation pipeline

## Technology Selection

### Image Processing Library: sharp

After evaluating several options, **sharp** was selected for the following reasons:

1. **Performance**: Built on libvips, significantly faster than pure JavaScript alternatives
2. **Metadata Support**: Excellent EXIF/IPTC metadata handling
3. **SVG Overlay**: Native support for SVG compositing, enabling high-quality text rendering
4. **Format Support**: Handles PNG, JPEG, and other common formats
5. **Active Maintenance**: Well-maintained with regular updates

**Alternatives Considered**:
- **jimp**: Pure JavaScript, slower performance, limited metadata support
- **node-canvas**: Good for custom rendering but requires separate metadata handling
- **c2pa-node**: Limited Node.js support, complex integration (future consideration)

### C2PA Support

C2PA (Coalition for Content Provenance and Authenticity) support was identified but not implemented in this phase due to:
- Limited Node.js library availability
- Complex integration requirements
- Can be added as future enhancement

Current implementation focuses on EXIF/IPTC metadata which provides basic provenance tracking.

## Implementation Architecture

### Component Structure

```
server/services/ImageWatermarkService.js
  ↓
server/services/chat/StreamingHandler.js (processImages)
  ↓
server/services/chat/ChatService.js (processStreamingChat)
  ↓
server/routes/chat/sessionRoutes.js
```

### Data Flow

1. **Image Generation**: LLM provider (Google Gemini) generates image
2. **Response Processing**: Google adapter processes response, extracts base64 image
3. **Watermarking**: StreamingHandler.processImages() applies watermark
4. **Metadata Addition**: EXIF/IPTC metadata embedded in image
5. **Client Delivery**: Watermarked image sent to client

### Configuration Schema

```json
{
  "imageWatermark": {
    "enabled": true,              // Enable/disable watermarking
    "text": "iHub Apps",          // Watermark text (installation-specific)
    "position": "bottom-right",   // Position: top-left, top-right, bottom-left, bottom-right, center
    "opacity": 0.5,               // Opacity: 0.0 to 1.0
    "textColor": "#ffffff",       // Text color (hex)
    "includeUser": true,          // Include username in watermark
    "includeTimestamp": false,    // Include date in watermark
    "installationId": ""          // Optional installation ID for metadata
  }
}
```

## Key Implementation Details

### ImageWatermarkService

The service provides a single public method:

```javascript
async addWatermark(base64ImageData, mimeType, watermarkConfig, metadata)
```

**Watermark Process**:
1. Convert base64 to buffer
2. Analyze image dimensions
3. Calculate font size (1-2% of image height)
4. Generate SVG watermark with text and shadow
5. Calculate position based on configuration
6. Composite watermark onto image
7. Add EXIF/IPTC metadata
8. Return watermarked image as base64

**Text Rendering**:
- Uses SVG for high-quality text overlay
- Includes drop shadow for better readability
- Font size scales with image dimensions
- Automatic text width calculation

**Metadata**:
- `Artist`: Username or user ID
- `Copyright`: Copyright notice with year
- `DateTimeOriginal`: ISO timestamp
- `Software`: Installation name
- `ImageDescription`: Generator and installation info

### Integration with Chat Pipeline

**Modified Components**:

1. **StreamingHandler.processImages()**:
   - Made async to support watermarking
   - Retrieves platform configuration
   - Applies watermark if enabled
   - Falls back to original image on error

2. **ChatService.processStreamingChat()**:
   - Passes user context through pipeline

3. **ToolExecutor.processChatWithTools()**:
   - Supports watermarking for tool-generated images

### Error Handling

The implementation includes graceful error handling:
- Watermarking failures log error but return original image
- No impact on chat functionality if watermarking fails
- Detailed error logging for debugging

## Configuration Examples

### Basic Watermark
```json
{
  "imageWatermark": {
    "enabled": true,
    "text": "My Company",
    "position": "bottom-right",
    "opacity": 0.5
  }
}
```

### User-Specific Watermark
```json
{
  "imageWatermark": {
    "enabled": true,
    "text": "My Company",
    "position": "bottom-right",
    "opacity": 0.5,
    "includeUser": true,
    "includeTimestamp": true
  }
}
```
Result: "My Company | john.doe | 2026-02-20"

### Center Watermark with Transparency
```json
{
  "imageWatermark": {
    "enabled": true,
    "text": "CONFIDENTIAL",
    "position": "center",
    "opacity": 0.3,
    "textColor": "#ff0000"
  }
}
```

## Testing

### Manual Testing Steps

1. **Enable watermarking** in platform.json
2. **Generate an image** using an image generation app
3. **Verify watermark** appears in correct position
4. **Check metadata** using EXIF viewer
5. **Test different configurations**:
   - Various positions
   - Different opacity levels
   - With/without user information
   - With/without timestamp

### Test Cases

- [ ] Watermark appears with default settings
- [ ] Watermark respects position configuration
- [ ] Watermark respects opacity configuration
- [ ] User information included when enabled
- [ ] Timestamp included when enabled
- [ ] Metadata embedded correctly
- [ ] Works with PNG images
- [ ] Works with JPEG images
- [ ] No impact on non-image-generation apps
- [ ] Graceful fallback on watermarking errors

## Performance Considerations

1. **sharp Performance**: 
   - Fast processing (< 100ms for typical images)
   - Minimal memory overhead
   - Efficient buffer handling

2. **Async Processing**:
   - Watermarking runs asynchronously
   - Non-blocking for other chat operations
   - Parallel processing possible for multiple images

3. **Caching**:
   - Configuration cached for performance
   - SVG watermark generated per image (dynamic sizing)

## Future Enhancements

1. **C2PA Support**:
   - Add C2PA/IPTC content credentials
   - Digital signatures for provenance
   - Tamper detection

2. **Image Watermarking**:
   - Support for logo watermarks (not just text)
   - Multiple watermark positions
   - Advanced text effects (gradient, outline)

3. **Admin UI**:
   - Visual watermark configuration editor
   - Live preview of watermark
   - Per-app watermark settings

4. **Advanced Metadata**:
   - GPS coordinates (if applicable)
   - Model/prompt information
   - Generation parameters

5. **Batch Processing**:
   - Watermark multiple images simultaneously
   - Bulk metadata updates

## Security Considerations

1. **User Privacy**:
   - User information only included if explicitly enabled
   - Username used instead of full name by default
   - Configurable user data inclusion

2. **Data Integrity**:
   - Original images not modified (watermark creates new buffer)
   - Metadata additions don't affect image quality
   - Error handling prevents data loss

3. **Access Control**:
   - Watermark configuration requires admin access
   - No client-side watermark bypass possible

## Dependencies

- **sharp**: ^0.33.x (image processing)
- No additional dependencies required

## Localization

Added translation keys:
- `appConfig.imageWatermark`: "Image Watermark"
- `appConfig.imageWatermarkHelp`: "Automatically add watermarks and metadata to generated images"

Both English and German translations provided.

## Backward Compatibility

- **Disabled by default**: No impact on existing installations
- **Optional feature**: Can be enabled per installation
- **Graceful fallback**: Works without configuration
- **No breaking changes**: Existing code paths unaffected

## Deployment Notes

1. **Install sharp**: Run `npm install` in server directory
2. **Update platform.json**: Add imageWatermark configuration
3. **Restart server**: Required for configuration to take effect
4. **Test**: Verify watermarking with test image generation

## Related Files

- `server/services/ImageWatermarkService.js`: Watermarking service implementation
- `server/services/chat/StreamingHandler.js`: Integration point
- `server/services/chat/ChatService.js`: User context passing
- `server/routes/chat/sessionRoutes.js`: Route-level user context
- `examples/config/platform.json`: Configuration example
- `shared/i18n/en.json`, `shared/i18n/de.json`: Translations

## Conclusion

The image watermarking feature provides a robust, performant solution for adding installation-specific watermarks and metadata to AI-generated images. The implementation is flexible, configurable, and designed for future enhancement with advanced provenance tracking capabilities.
