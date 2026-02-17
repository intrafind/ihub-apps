# Audio Extraction from Video Files

This document describes the audio extraction feature that allows users to upload video files and automatically extract the audio track for processing by AI models.

## Overview

The audio extraction feature uses the browser's Web Audio API to decode and extract audio from video files (MP4, WebM, MOV) without requiring any server-side processing or external tools. The extracted audio is converted to WAV format for maximum compatibility with AI models that support audio input.

## How It Works

### 1. User Upload
Users can upload video files through the standard file upload interface in any app that has video upload enabled.

### 2. Browser Processing
When a video file is uploaded:
1. The file is read as an ArrayBuffer
2. The Web Audio API `decodeAudioData()` method extracts the audio track
3. An `OfflineAudioContext` renders the audio to a clean buffer
4. The audio is converted to WAV format (16-bit PCM)
5. The WAV file is encoded as base64 for transmission to the AI model

### 3. Model Processing
The extracted audio is sent to the AI model as if it were a regular audio file upload.

## Browser Compatibility

| Browser | MP4 (AAC) | MP4 (MP3) | WebM | Notes |
|---------|-----------|-----------|------|-------|
| Chrome | ✅ Full Support | ✅ Full Support | ✅ Full Support | Native codecs |
| Edge | ✅ Full Support | ✅ Full Support | ✅ Full Support | Native codecs |
| Firefox | ⚠️ OS-Dependent | ✅ Full Support | ✅ Full Support | AAC uses OS codecs |

**Firefox Note**: Firefox relies on operating system codecs for AAC decoding due to patent restrictions. If a video plays in Firefox, the audio can be extracted in 99% of cases.

## Configuration

### Enabling Video Upload with Audio Extraction

To enable video upload for an app, add the following to the app configuration:

```json
{
  "upload": {
    "videoUpload": {
      "enabled": true,
      "extractAudio": true,
      "supportedFormats": ["video/mp4", "video/webm", "video/quicktime"],
      "maxFileSizeMB": 50
    }
  }
}
```

### Configuration Options

- **`enabled`** (boolean, default: `false`): Enable/disable video upload
- **`extractAudio`** (boolean, default: `true`): Automatically extract audio from videos
- **`supportedFormats`** (array): List of supported video MIME types
- **`maxFileSizeMB`** (number, default: 10): Maximum file size in megabytes

### Disabling Audio Extraction

If you want to allow video uploads without automatic audio extraction (for models that support video directly):

```json
{
  "upload": {
    "videoUpload": {
      "enabled": true,
      "extractAudio": false
    }
  }
}
```

## Supported Video Formats

- **MP4** (`.mp4`) - Most common format, widely supported
- **WebM** (`.webm`) - Open format, good browser support
- **QuickTime** (`.mov`) - Apple format, supported on most platforms

## Extracted Audio Format

The extracted audio is always in **WAV format (PCM 16-bit)** which provides:
- Universal compatibility across AI models
- No lossy compression
- Predictable quality
- Standard format supported by all browsers

### Audio Metadata

When audio is extracted, the following metadata is preserved:
- Sample rate (Hz)
- Number of channels (mono/stereo)
- Duration (seconds)
- Original video filename

## Error Handling

The system handles various error conditions:

### Audio Decode Error
**Error**: `audio-decode-error`
**Cause**: Browser cannot decode the video's audio codec
**Solution**: Try a different video format or use a browser with better codec support

### Video Audio Extraction Error
**Error**: `video-audio-extraction-error`
**Cause**: General extraction failure (corrupt file, no audio track, etc.)
**Solution**: Ensure video has an audio track and file is not corrupted

### Video Upload Disabled
**Error**: `video-upload-disabled`
**Cause**: Selected AI model doesn't support video/audio uploads
**Solution**: Choose a different model that supports audio input

## User Experience

### Upload Flow
1. User selects or drags a video file
2. System validates file type and size
3. Audio extraction begins (progress shown)
4. Extracted audio is sent to AI model
5. User sees confirmation with audio details

### Preview
After extraction, users see:
- Audio player with extracted audio
- Original video filename
- Audio duration
- File size comparison (video vs audio)

## Testing

A standalone test page is available at `tests/manual/test-audio-extraction.html` that allows testing the audio extraction without running the full application.

### To Use Test Page:
1. Open `test-audio-extraction.html` in a browser
2. Upload a video file (MP4, WebM, or MOV)
3. Listen to the extracted audio
4. Review the metadata

## Technical Implementation

### Key Files

- **`client/src/features/upload/utils/fileProcessing.js`**
  - `extractAudioFromVideo()` - Main extraction function
  - `audioBufferToWav()` - WAV format conversion
  - Helper utilities for encoding

- **`client/src/features/upload/components/UnifiedUploader.jsx`**
  - Video upload configuration
  - `processVideo()` - Video processing handler
  - Integration with file upload flow

### Web Audio API Usage

```javascript
// Create audio context
const audioContext = new AudioContext();

// Decode video as audio
const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

// Render to clean buffer
const offlineContext = new OfflineAudioContext(
  audioBuffer.numberOfChannels,
  audioBuffer.length,
  audioBuffer.sampleRate
);

const source = offlineContext.createBufferSource();
source.buffer = audioBuffer;
source.connect(offlineContext.destination);
source.start();

const renderedBuffer = await offlineContext.startRendering();
```

## Performance Considerations

- **Memory Usage**: Large videos require significant memory during extraction
- **Processing Time**: Proportional to video duration (typically 1-5 seconds for short clips)
- **File Size**: WAV files are larger than compressed audio formats
- **Browser Limits**: Very large files may exceed browser memory limits

### Recommended Limits
- Maximum video file size: 50MB
- Maximum video duration: 10 minutes
- For longer videos, consider using compressed audio formats directly

## Future Enhancements

Potential improvements for future versions:
- Support for MP3 output format (smaller file size)
- Progress indication for long extractions
- Ability to extract specific time ranges
- Support for multiple audio tracks
- Audio preprocessing (normalization, noise reduction)

## Troubleshooting

### Audio extraction fails on Firefox
- Check if the video plays in Firefox's video player
- Try converting video to use MP3 audio codec instead of AAC
- Test on a different operating system

### Extracted audio is silent
- Ensure video has an audio track
- Check video volume is not muted
- Verify video file is not corrupted

### Browser crashes during extraction
- Reduce video file size
- Close other browser tabs
- Try a different browser with more available memory

## API Reference

### extractAudioFromVideo(file, options)

Extracts audio from a video file using Web Audio API.

**Parameters:**
- `file` (File): The video file to extract audio from
- `options` (Object): Processing options
  - `format` (string): Output format (default: 'wav')

**Returns:**
Promise resolving to object with:
- `audioBuffer` (AudioBuffer): The rendered audio buffer
- `base64` (string): Base64-encoded audio data
- `blob` (Blob): Audio file as blob
- `format` (string): MIME type of output
- `sampleRate` (number): Sample rate in Hz
- `channels` (number): Number of audio channels
- `duration` (number): Duration in seconds
- `size` (number): File size in bytes

**Throws:**
- `audio-decode-error`: Cannot decode video audio
- `video-audio-extraction-error`: General extraction failure

## Resources

- [Web Audio API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [WAV Format Specification](http://soundfile.sapp.org/doc/WaveFormat/)
- [Browser Codec Support](https://caniuse.com/audio-api)
