# Video Audio Extraction Feature

## Overview

The video audio extraction feature allows users to upload video files (MP4, WebM, MOV, etc.) and automatically extract the audio track in the browser without requiring server-side processing or external tools.

## Browser Compatibility

The Web Audio API-based extraction works across all modern browsers:

| Browser | MP4 (AAC) | MP4 (MP3) | WebM | Performance |
|---------|-----------|-----------|------|-------------|
| Chrome | ✅ Native | ✅ Native | ✅ Native | Very Fast |
| Edge | ✅ Native | ✅ Native | ✅ Native | Very Fast |
| Firefox | ⚠️ OS-dependent* | ✅ Native | ✅ Native | Fast |

*Firefox uses OS codecs for AAC. If a video plays in Firefox, audio extraction will work in 99% of cases.

## How It Works

1. **User uploads video file** - Browser receives the video file
2. **AudioContext decoding** - Browser's native codecs decode the video to extract audio
3. **OfflineAudioContext rendering** - Audio is rendered to a clean buffer
4. **WAV conversion** - Audio buffer is converted to WAV format (PCM 16-bit)
5. **Base64 encoding** - WAV file is encoded as base64 for transmission to LLM

## Technical Implementation

### Web Audio API

The implementation uses the browser's built-in Web Audio API:

```javascript
// Create audio context
const audioContext = new AudioContext();

// Decode video file to extract audio
const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

// Render to clean audio buffer
const offlineContext = new OfflineAudioContext(
  audioBuffer.numberOfChannels,
  audioBuffer.length,
  audioBuffer.sampleRate
);
const renderedBuffer = await offlineContext.startRendering();

// Convert to WAV format
const wavBlob = audioBufferToWav(renderedBuffer);
```

### Key Advantages

- **No external libraries** - Uses browser-native APIs only
- **Fast processing** - Native codec performance
- **Privacy-friendly** - All processing in the browser
- **No server load** - Client-side extraction
- **Cross-platform** - Works on all modern browsers

## Configuration

### App Configuration

Enable video upload with audio extraction in your app JSON:

```json
{
  "upload": {
    "enabled": true,
    "videoUpload": {
      "enabled": true,
      "extractAudio": true,
      "maxFileSizeMB": 50,
      "supportedFormats": ["video/mp4", "video/webm", "video/quicktime"]
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable video upload |
| `extractAudio` | boolean | `true` | Extract audio from video |
| `maxFileSizeMB` | number | `50` | Maximum video file size |
| `supportedFormats` | array | See below | Supported video MIME types |

### Default Supported Formats

From `mimetypes.json`:
- `video/mp4` - MP4 video (most common)
- `video/mpeg` - MPEG video
- `video/webm` - WebM video
- `video/ogg` - OGG video
- `video/quicktime` - QuickTime MOV

## User Experience

### Upload Flow

1. User selects video file through upload button or drag-and-drop
2. System detects video MIME type
3. Audio extraction begins with visual feedback
4. Extracted audio is displayed with:
   - Original video filename with `.wav` extension
   - "WAV (extracted)" file type indicator
   - Audio duration in seconds
   - Green checkmark with "Audio extracted from video" message

### UI Indicators

The uploaded file preview shows:
- 🎵 Musical note icon (audio)
- Original filename with `.wav` extension
- "WAV (extracted)" as file type
- Duration (e.g., "Duration: 12.5s")
- ✅ "Audio extracted from video" success indicator

## Example Apps

### Video Transcription App

Located at: `contents/apps/video-transcription.json`

```json
{
  "id": "video-transcription",
  "name": {
    "en": "Video Transcription"
  },
  "description": {
    "en": "Upload video files to extract and transcribe audio automatically"
  },
  "upload": {
    "enabled": true,
    "videoUpload": {
      "enabled": true,
      "extractAudio": true,
      "maxFileSizeMB": 50
    }
  }
}
```

## Technical Details

### Audio Format

- **Format**: WAV (Waveform Audio File Format)
- **Encoding**: PCM 16-bit
- **Channels**: Stereo or Mono (preserved from source)
- **Sample Rate**: Preserved from source (typically 44.1kHz or 48kHz)
- **Volume**: 80% of original (prevents clipping)

### File Size Considerations

Extracted WAV audio is typically larger than compressed formats:
- 1 minute of stereo 44.1kHz 16-bit WAV ≈ 10MB
- Recommended max video size: 50MB
- Typical extraction: 5-10 seconds for 100MB video

### Browser Limitations

- **File size**: Browser memory constraints (typically 500MB-2GB)
- **Duration**: Longer videos take more time to process
- **Codecs**: Depends on browser codec support
- **Memory**: Processing uses significant browser memory

## Error Handling

### Common Errors

| Error Code | Message | Resolution |
|------------|---------|------------|
| `audio-extraction-error` | Failed to extract audio from video | Video may not contain audio or unsupported codec |
| `video-upload-disabled` | Video upload not supported by model | Choose a different model with audio support |
| `file-too-large` | File too large | Reduce video file size or increase `maxFileSizeMB` |

### Troubleshooting

**"Failed to extract audio from video"**
- Ensure video actually contains an audio track
- Try re-encoding video with standard codecs
- Check browser console for detailed error messages

**Slow extraction**
- Large videos take longer to process
- Consider reducing video size before upload
- Try a different browser (Chrome/Edge often faster)

**No audio in extracted file**
- Original video may not have audio track
- Audio codec might be unsupported
- Try playing video in browser first to verify audio

## Security & Privacy

- **Client-side only**: No video data sent to server during extraction
- **Memory cleanup**: Audio buffers released after processing
- **No persistence**: Videos not stored during extraction
- **Sandboxed**: Web Audio API runs in browser sandbox

## Future Enhancements

Potential improvements:
- Progress indicator during extraction
- Multiple audio track selection
- Audio format options (MP3, FLAC)
- Audio quality settings
- Batch video processing
- Video preview with playback controls

## Related Documentation

- [Mimetype Configuration](mimetypes.md)
- [Upload Configuration](configuration.md#upload-settings)
- [Web Audio API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
