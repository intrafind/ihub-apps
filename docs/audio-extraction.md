# Audio Extraction from Video Files

This document describes the audio extraction feature that allows users to upload video files and automatically extract the audio track for processing by AI models.

## Overview

The audio extraction feature uses the browser's Web Audio API to decode and extract audio from video files (MP4, WebM, MOV) without requiring any server-side processing or external tools. The extracted audio is converted to a 16 kHz mono WAV file: compatible with AI models that support audio input, and exactly the format the transcription models are fed.

The video is never uploaded, so its size is only limited by what the browser can read. An **MP4 or MOV can be up to 50 GB** (half an hour of video is 10 GB and more): only its index and its audio are read, see [Large videos](#large-videos-mp4-and-mov-up-to-50-gb). Other containers (WebM, MKV, AVI, ...) are decoded from the whole file and stop at about 2 GB.

## How It Works

### 1. User Upload
Users can upload video files through the standard file upload interface in any app that has video upload enabled.

### 2. Browser Processing
When a video file is uploaded:
1. The audio is read (`read`). For an MP4 or MOV that is the index and the audio bytes of the file, read with `File.slice()` (see [Large videos](#large-videos-mp4-and-mov-up-to-50-gb)); for any other container, the whole file as an ArrayBuffer
2. The Web Audio API `decodeAudioData()` method extracts the audio track, in a context running at 16 kHz so the track is resampled while it is decoded (`decode`). Uncompressed PCM in a MOV needs no decoder: it is converted to floats as it is read, and this step is done at once
3. An `OfflineAudioContext` downmixes the audio to mono and resamples it to 16 kHz (`resample`). Of an MP4 or MOV whose edit list trims the audio only the part it plays is rendered (see [Large videos](#large-videos-mp4-and-mov-up-to-50-gb))
4. The audio is converted to WAV format (16-bit PCM), in slices (`encode`)
5. The WAV file is encoded as base64 for transmission to the AI model (`finalize`). The attachment also keeps the WAV itself as a `Blob`, which transcription decodes directly (the `Blob` is never serialized with the chat message)

The names in brackets are the stages the extraction reports its progress by (see below).

### Large videos (MP4 and MOV, up to 50 GB)

A browser cannot read more than about 2 GB of a file into one ArrayBuffer (measured in Chromium: a 1.9 GB file works, a 3 GB file fails with `NotReadableError`; `File.slice()` works at any size). A video of half an hour is 10 GB and more, and its audio is a small part of it: half an hour of AAC is about 30 MB. So an MP4 or MOV of **any size** is not read whole:

1. **The index.** The top-level box headers are read (16 bytes each), hopping over the `mdat` that holds the picture however large it is, to find the `moov` index. It is at the start of an MP4 written for streaming (`faststart`), and after the `mdat` in a QuickTime file and in what most cameras write. The `moov` is read and cut down to the first audio track
2. **The samples.** The sample table says where the audio bytes are. They are read in reads of at most 8 MB; the bytes of the picture between them are skipped (small gaps are read through)
3. **The result.** AAC (`mp4a.40.*`): every raw frame gets a 7-byte ADTS header built from the AudioSpecificConfig of the track, and the browser decodes that stream (`audio/aac`). The sample table and the AudioSpecificConfig come from [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3-Clause), which is loaded when the first MP4 with AAC is processed, not with the page. Uncompressed PCM (QuickTime `sowt`, `twos`, `in24`, `in32`, `fl32`, `fl64`, `raw `, `lpcm`, in either byte order: little endian variants are marked by an `enda` box) is converted straight to mono floats; the sample table of uncompressed audio has one entry per sample frame, which mp4box.js would turn into an object each (86 million for half an hour at 48 kHz), so it is read from its raw `stsc`/`stco`/`stsz` boxes

The memory used is proportional to the audio, not to the file: reading 30 minutes of AAC from a 10 GB video takes about 30 MB of reads. The progress of the `read` stage counts the bytes of the index and of the audio.

**The index is checked against the file.** The sample table comes from the file, so it is not believed blindly: every sample range has to lie inside the file, and together the ranges cannot add up to more than the file (samples do not overlap), and the chunks of the table have to follow each other. A damaged or crafted index could otherwise ask for terabytes of audio, which would freeze the tab while the reads were planned, or read the same bytes over and over. Such a file is refused (`mp4-invalid`) at once, before any audio is read.

**Edit lists.** An MP4 or MOV can carry an edit list (`edts`/`elst`) that says which part of the track is played. QuickTime writes one when a recording is trimmed, and ffmpeg and most AAC encoders write one that skips the encoder's delay (the first 1024 samples). The reader does not cut the samples, it hands the result of the edit list to the resample as a trim, so only the part the file plays is rendered and transcribed:

- Empty edits at the start only delay the track, they are ignored
- Then one edit at normal speed is a trim: where it starts, and how long it lasts (to the end of the audio where it reaches it)
- Anything else (the audio played in several pieces, at another speed, a gap after it has started, nothing played at all) cannot be described by one trim and would give other audio than the file plays. The file is refused (`mp4-unsupported-edit`) and takes the path of any other file the reader cannot take: the whole file is decoded by the browser, which applies the edit list itself (up to 1.9 GB), above that the extraction fails with `video-large-audio-unsupported`

**Fragmented files** (`mvex` in the index, the rest of the samples in `moof` boxes after it) are always refused, also those whose index lists some samples: reading only those would cut the audio off, and the transcript with it.

What does not work this way, and what happens then:

| The file | Up to about 1.9 GB | Above |
|----------|--------------------|-------|
| MP4/MOV with AAC-LC, HE-AAC or PCM audio | read in parts | read in parts |
| MP4/MOV with another audio codec (Opus, AC-3, ALAC, ...), unsigned 16, 24 or 32-bit `lpcm`, a fragmented MP4 (`moof`, whether or not its index lists samples), an edit list that plays the audio in pieces or at another speed, a damaged index or one that points outside of the file, an audio track the browser cannot decode | the whole file is decoded by the browser, as for any other video | `video-large-audio-unsupported` |
| Other containers (WebM, MKV, AVI, ...) | the whole file is decoded by the browser | `video-unsupported-large-container` |
| `extractAudio: false` (the video itself is sent to the model) | read whole as a data URL | `video-too-large-to-attach` |

HE-AAC and HE-AACv2 are written as the AAC-LC core with the core's sample rate in the ADTS header; decoders find the SBR extension in the frames themselves (implicit signalling).

### Progress and Stop

A long video takes seconds to minutes, so while a file is processed a panel shows above the message box (issue #2835):

- The file name and the step ("Reading file…", "Extracting audio…", "Converting audio…", "Encoding audio…", "Finishing up…")
- A progress bar. Decoding cannot report how far it is, so the bar is animated, without a value, during that step. Reading, converting, encoding and finishing have a percentage
- A **Stop** button. Stopping rejects the extraction at its next checkpoint (the decoding itself cannot be cancelled: it runs on and its result is dropped). It is not an error: nothing is attached for the file, no message is shown, the file picker is reset so the same file can be picked again, and the files attached before stay. When several files were added at once, the ones already processed stay too

The panel shows after 300 ms of processing, so files that are done in a blink never flash it. It is shown for every kind of attachment (images, documents, audio and video). Documents report how far the file is read and, for PDF, PowerPoint, Word and TIFF, which page, slide or step they are on (see [File Upload](file-upload-feature.md#processing-pipeline)). While it shows, sending is held back: a message sent meanwhile would go without the attachment, which would then join the next message. That holds for every message box of the chat page: the page has one for the phone layout and one for the desktop layout, and after a resize the one that comes into view still waits for a file added in the other. A run that is still going when the chat is left (or when the uploader is cleared with its `handleClear`) is not a Stop but a discard: it is cancelled and attaches nothing, not even the files of its batch that were done (a Stop keeps those).

The page is kept free while the extraction runs. Reading, decoding and resampling run natively, off the main thread, and the WAV is encoded in slices of about 8 ms with the event loop in between (`audioBufferToWavAsync()`). The slices hand over through a message port instead of a timer, so a tab the user switched away from keeps going at full speed (browsers run a timer once per second in the background). For a 40-minute video (the WAV is 73 MB) the longest freeze of the page measured in Chromium dropped from about 0.6 s to about 0.3 s. What is left is the browser itself: handing the decoded audio to the page (about 0.2 s) and building the base64 data URL (about 0.25 s).

### 3. Model Processing
The extracted audio is sent to the AI model as if it were a regular audio file upload.

With a **transcription model selected** in the chat (see [Transcription Models](models.md#transcription-models)), the extracted audio is instead transcribed by that model: the video's name is the question and the transcript is the answer. The extracted audio is already 16 kHz mono, which is what the transcription client streams (the vLLM realtime endpoint requires 16 kHz mono PCM16), so it is decoded from the attachment's WAV `Blob` and streamed as it is.

## Browser Compatibility

| Browser | MP4 (AAC) | MP4 (MP3) | WebM | Notes |
|---------|-----------|-----------|------|-------|
| Chrome | ✅ Full Support | ✅ Full Support | ✅ Full Support | Native codecs |
| Edge | ✅ Full Support | ✅ Full Support | ✅ Full Support | Native codecs |
| Firefox | ⚠️ OS-Dependent | ✅ Full Support | ✅ Full Support | AAC uses OS codecs |

**Firefox Note**: Firefox relies on operating system codecs for AAC decoding due to patent restrictions. If a video plays in Firefox, the audio can be extracted in 99% of cases.

**Large videos**: the AAC of an MP4 or MOV above 2 GB is decoded from an ADTS stream, so the browser needs an AAC decoder for it (the same as for a small video). Uncompressed PCM audio needs no decoder in any browser. Chromium builds without proprietary codecs (Playwright's Chromium, some Linux distributions) cannot decode AAC at all.

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
- **`maxFileSizeMB`** (number, 1-51200, default: 50): Maximum file size in megabytes. Up to 51200 (50 GB). This is the limit of videos; documents, images and audio files are held to their own limits (`fileUpload`, `imageUpload`, `audioUpload`). With audio extraction an MP4 or MOV may be any size up to this limit; other containers, and videos sent as they are, stop at about 2 GB (see [Large videos](#large-videos-mp4-and-mov-up-to-50-gb))

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

- **MP4** (`.mp4`) - Most common format, widely supported. Any size up to the limit
- **WebM** (`.webm`) - Open format, good browser support. Up to about 2 GB
- **QuickTime** (`.mov`) - Apple format, supported on most platforms. Any size up to the limit

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

### Video Larger Than 2 GB In Another Container
**Error**: `video-unsupported-large-container`
**Cause**: The video is not an MP4 or MOV and is larger than about 1.9 GB, which a browser cannot read into memory for decoding
**Solution**: Convert the video to MP4 or MOV (a remux, `ffmpeg -i in.mkv -c copy out.mp4`, is enough when the codecs fit), or use a smaller file

### Audio Of A Large Video Cannot Be Read
**Error**: `video-large-audio-unsupported`
**Cause**: An MP4 or MOV larger than about 1.9 GB whose audio cannot be read in parts: a codec other than AAC or PCM, a fragmented MP4, an edit list that plays the audio in pieces or at another speed, a damaged index, or a browser that cannot decode the AAC. A smaller file would have been decoded from the whole file instead
**Solution**: Use AAC or uncompressed audio in a regular (not fragmented) MP4 or MOV whose timeline is not cut up into pieces, or a browser with an AAC decoder

### Video Too Large To Attach As It Is
**Error**: `video-too-large-to-attach`
**Cause**: Audio extraction is off for the app, so the whole video would be sent to the model as a data URL, which a browser cannot build beyond about 2 GB (a request could not carry it either)
**Solution**: Turn on `extractAudio`, or use a smaller video

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

### Saving the Extracted Audio

The extracted audio is attached as `<video name>.wav`, a file the user does not have on disk. While it is attached, its row in the attachment list has a **Save audio** button (download icon) that saves the WAV locally under that name: `lecture.mp4` becomes `lecture.wav`. The 16 kHz mono WAV is saved exactly as it would be transcribed or sent to the model.

- Only audio extracted from a video gets the button. Audio files the user uploads themselves are already on their disk
- The button saves the attachment's WAV `Blob`. An attachment that lost it, for example a copy of the attachment that was serialized and restored, is rebuilt from its base64 data URL
- The button is available while the chat input is busy, so the audio can still be saved while an answer is running
- With a transcription model selected, the audio is transcribed when the message is sent and only the transcript stays in the chat, so save it before sending

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
  - `extractAudioFromVideo()` - Main extraction function: stages, weighted progress, stopping, and the choice between reading an MP4/MOV in parts and decoding the whole file
  - `WHOLE_FILE_READ_LIMIT_BYTES` - What may be read into one ArrayBuffer (1.9 GB)
  - `readFileAsDataURL()` and the `FileReader` helpers (progress, abortable)

- **`client/src/features/upload/utils/mp4AudioExtraction.js`**
  - `readMp4Audio()` - The audio of an MP4/MOV/M4A of any size, read with `File.slice()`: AAC as ADTS or PCM as floats
  - `readMp4Audio()` returns the `trim` of the edit list (`{ offset, duration }` in seconds, or null) next to the audio; `extractAudioFromVideo()` hands it to `resampleTo16kMono()`
  - `isMp4Container()`, `planReads()`, `parseAudioSpecificConfig()`, `writeAdtsHeader()`, `convertPcmToMono()`, `parseEditList()`, `editListTrim()`, `createRangeGuard()` - Its parts

- **`client/src/utils/realtimeTranscriptionCore.js`**
  - `resampleTo16kMono()` - Downmix and resample the decoded audio; with `onProgress`/`signal` it suspends the offline render at 40 checkpoints. With `offset`/`duration` (seconds) it renders only that part of the audio, the trim an MP4/MOV edit list gives

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
  - The size limit of each file type (`file-too-large` names the limit of the file's own type)
  - Integration with file upload flow

- **`client/src/features/upload/components/ProcessingProgress.jsx`**
  - The progress panel with the Stop button

- **`client/src/features/upload/components/AttachedFilesList.jsx`** and **`client/src/features/upload/utils/extractedAudio.js`**
  - The **Save audio** button of an extracted-audio attachment and the helpers behind it (`canSaveExtractedAudio()`, `getExtractedAudioBlob()`, `saveExtractedAudio()`)

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

- **Memory Usage**: What is read of an MP4/MOV is the index and the audio, so the memory is proportional to the audio (30 minutes of AAC: about 30 MB read), not to the video. Beyond that, the decoded audio takes memory. The video's whole audio track is decoded first (see the memory note in [Realtime Voice & Transcription](voice-transcription.md#enabling-transcription-on-an-app)) before it is reduced to mono. It is decoded at 16 kHz, so for a stereo video it takes 290 MB per 40 minutes instead of the 810 MB it takes at 44.1 kHz (a browser that cannot run a context at 16 kHz decodes at its own rate). The result differs from decoding at the video's rate and resampling afterwards by about -70 dB, which is inaudible
- **Processing Time**: Proportional to video duration (typically 1-5 seconds for short clips). Decoding is the longest step: about 7.5 s for 40 minutes of audio, of about 9 s in all
- **File Size**: The extracted WAV is about 1.9 MB per minute, still larger than compressed audio formats
- **Large videos**: The picture is never read. Measured in Chromium with 4 minutes of 1280×720 video and 48 kHz stereo PCM in a MOV: a 3.4 GB file was attached in about 3 s and a 5.6 GB one (64-bit box sizes) in about 6 s, reading 1.4 % of the file in 2,400 and 4,000 reads of about 19 KB (the audio chunks between the video frames), without a freeze of the page longer than 0.3 s. Uncompressed PCM audio takes memory at its own sample rate as mono floats (345 MB for 30 minutes at 48 kHz) until it is resampled
- **Browser Limits**: Other containers than MP4/MOV are read whole and stop at about 2 GB

### Recommended Limits
- Maximum video file size: up to 50 GB as MP4 or MOV (`maxFileSizeMB` up to 51200), about 2 GB for other containers
- Maximum video duration: as long as the audio the model takes: a transcription takes an hour by default. Audio sent to a multimodal model must fit in the request body (`requestBodyLimitMB`, 50 MB by default, about 20 minutes of 16 kHz mono WAV)

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
  - `onProgress` (Function): Called with `{ stage, percent }`. `stage` is `read`, `decode`, `resample`, `encode` or `finalize`, in that order (for uncompressed PCM in a MOV `decode` is reported once, at its end: there is nothing to decode). `read` counts the bytes of the index and of the audio for an MP4/MOV, of the whole file for another container. `percent` is the overall progress, an integer from 0 to 100 that never goes down (`read` spans 0-10, `decode` 10-50, `resample` 50-70, `encode` 70-90, `finalize` 90-100: a scale for the bar, not shares of the time), or `null` while the stage has nothing to measure: always during `decode`, and during `resample` in browsers that cannot suspend an offline render

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
- `video-unsupported-large-container`: Not an MP4 or MOV, and larger than `WHOLE_FILE_READ_LIMIT_BYTES`
- `video-large-audio-unsupported`: An MP4 or MOV larger than `WHOLE_FILE_READ_LIMIT_BYTES` whose audio could not be read in parts
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
