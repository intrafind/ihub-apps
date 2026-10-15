# Audio Extraction from Video Files

This document describes the audio extraction feature that allows users to upload video files and automatically extract the audio track for processing by AI models.

## Overview

The audio extraction feature uses the browser's Web Audio API to decode and extract audio from video files (MP4, WebM, MOV) without requiring any server-side processing or external tools. The extracted audio is converted to a 16 kHz mono WAV file: compatible with AI models that support audio input, and exactly the format the transcription models are fed.

## How It Works

### 1. User Upload
Users can upload video files through the standard file upload interface in any app that has video upload enabled.

### 2. Browser Processing
When a video file is uploaded:
1. The file is read as an ArrayBuffer (`read`)
2. The Web Audio API `decodeAudioData()` method extracts the audio track, in a context running at 16 kHz so the track is resampled while it is decoded (`decode`)
3. An `OfflineAudioContext` downmixes the audio to mono and resamples it to 16 kHz (`resample`)
4. The audio is converted to WAV format (16-bit PCM), in slices (`encode`)
5. The WAV file is encoded as base64 for transmission to the AI model (`finalize`). The attachment also keeps the WAV itself as a `Blob`, which transcription decodes directly (the `Blob` is never serialized with the chat message)

The names in brackets are the stages the extraction reports its progress by (see below).

### Progress and Stop

A long video takes seconds to minutes, so while a file is processed a panel shows above the message box (issue #2835):

- The file name and the step ("Reading file…", "Extracting audio…", "Converting audio…", "Encoding audio…", "Finishing up…")
- A progress bar. Decoding cannot report how far it is, so the bar is animated, without a value, during that step. Reading, converting, encoding and finishing have a percentage
- A **Stop** button. Stopping rejects the extraction at its next checkpoint (the decoding itself cannot be cancelled: it runs on and its result is dropped). It is not an error: nothing is attached for the file, no message is shown, the file picker is reset so the same file can be picked again, and the files attached before stay. When several files were added at once, the ones already processed stay too

The panel shows after 300 ms of processing, so files that are done in a blink never flash it. It is shown for every kind of attachment (images, documents, audio and video); only audio and video report a percentage, the others show the animated bar. While it shows, sending is held back: a message sent meanwhile would go without the attachment, which would then join the next message. That holds for every message box of the chat page: the page has one for the phone layout and one for the desktop layout, and after a resize the one that comes into view still waits for a file added in the other. A run that is still going when the chat is left (or when the uploader is cleared with its `handleClear`) is not a Stop but a discard: it is cancelled and attaches nothing, not even the files of its batch that were done (a Stop keeps those).

The page is kept free while the extraction runs. Reading, decoding and resampling run natively, off the main thread, and the WAV is encoded in slices of about 8 ms with the event loop in between (`audioBufferToWavAsync()`). The slices hand over through a message port instead of a timer, so a tab the user switched away from keeps going at full speed (browsers run a timer once per second in the background). For a 40-minute video (the WAV is 73 MB) the longest freeze of the page measured in Chromium dropped from about 0.6 s to about 0.3 s. What is left is the browser itself: handing the decoded audio to the page (about 0.2 s) and building the base64 data URL (about 0.25 s).

### 3. Model Processing
The extracted audio is sent to the AI model as if it were a regular audio file upload.

For **transcription-enabled apps** (see [Transcription Models](models.md#transcription-models)), the extracted audio is instead transcribed by the app's transcription model, and the transcript takes the audio's place in the user's message. The extracted audio is already 16 kHz mono, which is what the transcription client streams (the vLLM realtime endpoint requires 16 kHz mono PCM16), so it is decoded from the attachment's WAV `Blob` and streamed as it is.

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

The extracted audio is always a **16 kHz mono WAV file (PCM 16-bit)**, whatever the video's own sample rate and channel count. It provides:
- Universal compatibility across AI models
- No lossy compression after the downmix
- Speech quality, which is what these uploads are for (music loses its high frequencies at 16 kHz)
- A small file: about 1.9 MB per minute, a sixth of a WAV at 48 kHz stereo (about 11.5 MB per minute)

The size matters. The attachment is also held as a base64 data URL, and browsers cannot build a string beyond a fixed length (about 536 million characters in Chromium). A 48 kHz stereo WAV passed that limit at roughly 35 minutes of video: the browser then returned an empty string instead of an error, so the attachment looked fine and sending it failed with "Could not decode this audio in your browser" (issue #2836). At 16 kHz mono the limit is about 3.5 hours; a video whose audio still exceeds it is refused when it is uploaded.

### Audio Metadata

When audio is extracted, the following metadata is kept, describing the 16 kHz mono output:
- Sample rate (Hz), always 16000
- Number of channels, always 1
- Duration (seconds)
- File size (bytes)
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
  - `extractAudioFromVideo()` - Main extraction function: stages, weighted progress, stopping
  - `readFileAsDataURL()` and the `FileReader` helpers (progress, abortable)

- **`client/src/utils/realtimeTranscriptionCore.js`**
  - `resampleTo16kMono()` - Downmix and resample the decoded audio; with `onProgress`/`signal` it suspends the offline render at 40 checkpoints

- **`client/src/utils/wav.js`**
  - `audioBufferToWav()` - WAV format conversion
  - `audioBufferToWavAsync()` - The same file, encoded in slices with progress and a signal

- **`client/src/utils/abortable.js`**
  - The abort error (`code: 'aborted'`), `raceAbort()` and `yieldToEventLoop()`

- **`client/src/features/upload/components/Uploader.jsx`**
  - One `AbortController` per processing run; hands `{ signal, onProgress }` to `onProcessFile`; exposes `progress` and `cancelProcessing`. `cancelProcessing` is a Stop (the batch's finished files are attached); `handleClear` and unmounting discard the run (nothing is attached)

- **`client/src/features/upload/components/UnifiedUploader.jsx`**
  - Video upload configuration
  - `processVideo()` - Video processing handler
  - Integration with file upload flow

- **`client/src/features/upload/components/ProcessingProgress.jsx`**
  - The progress panel with the Stop button

### Web Audio API Usage

```javascript
// Create audio context (at 16 kHz: decoding resamples to the context's rate)
const audioContext = new AudioContext({ sampleRate: 16000 });

// Decode video as audio
const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

// Downmix to mono and resample to 16 kHz (resampleTo16kMono)
const offlineContext = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);

const source = offlineContext.createBufferSource();
source.buffer = audioBuffer;
source.connect(offlineContext.destination);
source.start();

const renderedBuffer = await offlineContext.startRendering();
```

## Performance Considerations

- **Memory Usage**: Large videos require significant memory during extraction. The video's whole audio track is decoded first (see the memory note in [Realtime Voice & Transcription](voice-transcription.md#enabling-transcription-on-an-app)) before it is reduced to mono. It is decoded at 16 kHz, so for a stereo video it takes 290 MB per 40 minutes instead of the 810 MB it takes at 44.1 kHz (a browser that cannot run a context at 16 kHz decodes at its own rate). The result differs from decoding at the video's rate and resampling afterwards by about -70 dB, which is inaudible
- **Processing Time**: Proportional to video duration (typically 1-5 seconds for short clips). Decoding is the longest step: about 7.5 s for 40 minutes of audio, of about 9 s in all
- **File Size**: The extracted WAV is about 1.9 MB per minute, still larger than compressed audio formats
- **Browser Limits**: Very large files may exceed browser memory limits

### Recommended Limits
- Maximum video file size: 50MB
- Maximum video duration: 10 minutes
- For longer videos, consider using compressed audio formats directly

## Future Enhancements

Potential improvements for future versions:
- Support for MP3 output format (smaller file size)
- A percentage while the video is decoded (the browser reports none)
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

Extracts audio from a video file using Web Audio API, as a 16 kHz mono WAV.

**Parameters:**
- `file` (File): The video file to extract audio from
- `options` (Object, optional):
  - `signal` (AbortSignal): Stops the extraction at the next checkpoint (between the stages, while the file is read, in the encoder's loop, at the checkpoints of the render), and at once while decoding, whose result is then dropped. The AudioContext is closed
  - `onProgress` (Function): Called with `{ stage, percent }`. `stage` is `read`, `decode`, `resample`, `encode` or `finalize`, in that order. `percent` is the overall progress, an integer from 0 to 100 that never goes down (`read` spans 0-10, `decode` 10-50, `resample` 50-70, `encode` 70-90, `finalize` 90-100: a scale for the bar, not shares of the time), or `null` while the stage has nothing to measure: always during `decode`, and during `resample` in browsers that cannot suspend an offline render

**Returns:**
Promise resolving to object with (all describing the 16 kHz mono output):
- `base64` (string): Base64 data URL of the WAV
- `blob` (Blob): The WAV as a blob
- `format` (string): MIME type of output (`audio/wav`)
- `sampleRate` (number): Sample rate in Hz (`16000`)
- `channels` (number): Number of audio channels (`1`)
- `duration` (number): Duration in seconds
- `size` (number): File size in bytes

**Throws:**
- `aborted`: The signal fired. The error is named `AbortError`, and its message and `code` are `'aborted'` (`isAbortError()` in `abortable.js` tells it from a failure). It is never turned into `video-audio-extraction-error`
- `audio-decode-error`: Cannot decode video audio
- `video-audio-extraction-error`: General extraction failure, including audio too long to be attached as a base64 data URL

### audioBufferToWavAsync(audioBuffer, options)

`audioBufferToWav()` for long audio: the same file byte for byte, encoded in slices with the event loop in between. Takes an AudioBuffer or anything with `numberOfChannels`, `sampleRate`, `length` and `getChannelData()`.

**Options:** `signal` (stops at the next slice, rejecting with the abort error), `onProgress(percent)` (0-100, after each slice), `chunkSamples` (frames per slice, default 524288: about 8 ms of work for a mono track). Resolves to the WAV `Blob`.

### Uploader and UnifiedUploader

`onProcessFile(file, { signal, onProgress })` gets the signal and the progress callback as a second argument (callers that take only the file keep working). `Uploader` hands `progress` (`{ fileName, stage, percent, index, total }`, `index` counting from 0 within a batch) and `cancelProcessing()` to its render prop, and calls `onProcessingChange(true|false)` as processing starts and ends. `UnifiedUploader` forwards `onProcessingChange`; `ChatInput` and `ChatStartForm` use it to hold back sending. Where a page mounts several of them for one chat (`AppChat`), they report through `useFileUploadHandler()`: its `isAttachmentProcessing` is true while any uploader is busy and `setAttachmentProcessing(id, busy)` is how each reports (via `useAttachmentProcessing`); `AppChat` passes both on as `isAttachmentProcessing` and `onAttachmentProcessingChange`, and its own submit returns early while it is true. Both props are optional: without them a composer waits for its own uploader only.

## Resources

- [Web Audio API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [WAV Format Specification](http://soundfile.sapp.org/doc/WaveFormat/)
- [Browser Codec Support](https://caniuse.com/audio-api)
