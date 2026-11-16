---
description: "Let users attach audio files, recordings and the audio track of videos, and send them to a multimodal chat model or a transcription model: models, app and model settings, formats, limits, what users see, errors and troubleshooting."
audience: admin
type: how-to
adminPage: /admin/apps
---

# Audio File Support

Users can attach audio to a chat message: an audio file, a recording made in the browser, or a
video whose audio track the browser extracts. The audio goes either to a chat model that accepts
audio input (Google Gemini, OpenAI) or to a transcription model, which turns it into text.

This page covers both paths, how to enable them for an app, the formats and limits, video audio
extraction, what users see, and how to fix common problems.

## Overview

With a multimodal chat model, the model receives the audio itself and can work with it:

- **Transcription**: convert speech to text
- **Speaker identification**: identify and label different speakers
- **Sentiment analysis**: analyze tone and emotion
- **Summarization**: extract key points from a conversation or presentation
- **Translation**: transcribe and translate
- **Audio analysis**: describe music, sound effects or environmental audio

Supported audio files are MP3, WAV, FLAC, OGG and M4A/MP4. Videos (MP4, WebM, MOV) are reduced to
their audio track in the browser before anything is sent; see
[Video uploads: audio extraction](#video-uploads-audio-extraction).

Related features with their own pages: [Microphone dictation](microphone-feature.md) (speech into
the input field), [Realtime Voice & Transcription](voice-transcription.md) (deploying the
transcription endpoint) and [Text-to-Speech](text-to-speech.md).

## Two audio paths: multimodal vs. Voxtral transcription

The model selected in the chat decides which path applies:

|                          | Multimodal audio                                                                   | Transcription model ([Transcription Models](models.md#transcription-models))      |
| ------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Selected model**       | A chat model with `supportsAudio: true` (plus `upload.audioUpload` on the app)      | A `modelType: "transcription"` model, picked in the model selector                |
| **Where the audio goes** | Sent as `audioData` to the multimodal chat LLM (Gemini / OpenAI), often external    | Streamed through iHub to the transcription endpoint; the URL and key stay on the server |
| **Result**               | The chat model's answer (transcription, analysis, Q&A, …)                          | The transcript is the answer and is stored in the chat                            |
| **Sources**              | Audio upload, video upload (extracted audio), browser recording                    | Audio upload, video upload (extracted audio), browser recording                   |
| **Decoding**             | The provider decodes the audio                                                     | The browser decodes it to 16 kHz mono PCM16 (see caveat below)                    |

With a transcription model selected, the text box is disabled: the user uploads audio or video, or
records, and the transcript comes back as the answer. A chat model picked afterwards can work with
it (summarize, write notes, …).

For deployment details of the transcription endpoint (configuration, reverse proxy, limits), see
[Realtime Voice & Transcription](voice-transcription.md).

### When users can attach audio

1. `upload.enabled` must not be `false`, and the specific block (`audioUpload` / `videoUpload`)
   must be enabled.
2. The audio picker and the **Record** button are shown only when the selected model has
   `supportsAudio: true` or is a transcription model. The **Record** button is not offered in
   compare mode.

> [!WARNING]
> An _absent_ `audioUpload` block passes the `enabled !== false` check, while a block that is
> present defaults to `enabled: false`. Set `enabled` explicitly in app configs.

### Browser decode caveat (transcription only)

The transcription path decodes audio **in the browser** (`AudioContext.decodeAudioData`), so codec
support depends on the browser: Safari, for example, cannot decode OGG. A file the browser cannot
decode is not sent; the chat shows "Could not decode this audio in your browser. The format or
codec may be unsupported (e.g. OGG in Safari)." The multimodal path is unaffected: it sends the
raw audio to the provider, which decodes it.

## Supported models

Audio input works with any model that has `supportsAudio: true`, on a provider whose adapter sends
audio: Google Gemini (`inlineData`) and OpenAI or OpenAI-compatible endpoints (`input_audio`).
Set the flag in **Admin → Models → (model) → Supports Audio**, or in the model JSON.

Examples of models that accept audio input:

| Provider      | Models                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Gemini | `gemini-3.1-pro`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite`, `gemini-3-pro`, `gemini-3-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-flash-latest`, `gemini-flash-lite-latest` |
| OpenAI        | GPT-4o and newer audio-capable models, such as `gpt-4o` and `gpt-5`                                                                                                    |

```json
{
  "id": "gemini-flash-latest",
  "modelId": "gemini-flash-latest",
  "name": { "en": "Gemini Flash Latest", "de": "Gemini Flash Latest" },
  "provider": "google",
  "supportsAudio": true,
  "supportsVision": true,
  "enabled": true
}
```

Transcription models (`modelType: "transcription"`, such as Voxtral) are configured separately; see
[Transcription Models](models.md#transcription-models).

## Enable audio upload for an app

### In the admin UI

Open **Admin → Apps → (app) → Upload Configuration**. Below the image and file upload settings:

- **Enable Audio Upload**: turns audio uploads on
- **Max Audio File Size (MB)**: 1-2000, default 20
- **Supported Audio Formats**: one checkbox per MIME type (MP3 as `audio/mpeg` and `audio/mp3`,
  WAV, FLAC, OGG, M4A/MP4)

**Enable Upload** must be on as well. For videos, see
[Enable video upload](#enable-video-upload).

### In the app config

```json
{
  "id": "audio-transcription",
  "name": { "en": "Audio Transcription", "de": "Audio-Transkription" },
  "system": {
    "en": "You are a transcription assistant. Transcribe audio files accurately.",
    "de": "Du bist ein Transkriptionsassistent. Transkribiere Audiodateien genau."
  },
  "upload": {
    "enabled": true,
    "allowMultiple": true,
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 20,
      "supportedFormats": ["audio/mpeg", "audio/mp3", "audio/wav", "audio/flac", "audio/ogg", "audio/mp4"]
    }
  },
  "preferredModel": "gemini-flash-latest"
}
```

Audio combines with the other upload types: add `imageUpload`, `fileUpload` or `videoUpload` next to
`audioUpload` in the same `upload` block.

### `audioUpload` options

| Field              | Type     | Default                                                                                | Description                                          |
| ------------------ | -------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `enabled`          | boolean  | `false`                                                                                | Enable audio file uploads                            |
| `maxFileSizeMB`    | integer  | `20`                                                                                   | Maximum file size in megabytes (1-2000)              |
| `supportedFormats` | string[] | `["audio/mpeg", "audio/wav", "audio/mp3", "audio/flac", "audio/ogg", "audio/mp4"]`     | Accepted MIME types; each must start with `audio/`   |

The schema is in `server/validators/appConfigSchema.js`. With `upload.allowMultiple`, users can
attach several audio files to one message; each is sent to the model.

### App design tips

- Write a system prompt that says what the model should do with the audio.
- Set `preferredModel` to an audio-capable model.
- Set `maxFileSizeMB` for the expected use, and add starter prompts that show users what to ask.

## Supported audio formats

| Format    | MIME type                   | Extension      | Notes                                                           |
| --------- | --------------------------- | -------------- | --------------------------------------------------------------- |
| MP3       | `audio/mpeg` or `audio/mp3` | `.mp3`         | Compressed, widely compatible                                   |
| WAV       | `audio/wav`                 | `.wav`         | Uncompressed, best quality for speech                           |
| FLAC      | `audio/flac`                | `.flac`        | Lossless compressed                                             |
| OGG       | `audio/ogg`                 | `.ogg`         | Open compressed format (not decodable in Safari for transcription) |
| M4A / MP4 | `audio/mp4`                 | `.m4a`, `.mp4` | MPEG-4 audio (QuickTime "Export As → Audio Only", Apple devices) |

### Alternative MIME types

Browsers do not report every format under the MIME type listed above: Chrome and Safari on macOS
report an `.m4a` file as `audio/x-m4a`, and some setups report no type at all. The upload picks the
canonical type from the table, so a file is accepted when the app lists the canonical type
(`audio/mp4`); the alternative type does not have to be added to `supportedFormats`:

| Reported by the browser                       | Treated as                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `audio/x-m4a`, `audio/m4a`                    | `audio/mp4`                                                                                                    |
| `audio/x-wav`, `audio/wave`, `audio/vnd.wave` | `audio/wav`                                                                                                    |
| `audio/x-flac`                                | `audio/flac`                                                                                                   |
| no type or `application/octet-stream`         | the type of the file extension (`.m4a` → `audio/mp4`), when the extension identifies one audio or video type |

An `.mp4` file keeps the type the browser reports, because the extension is used for audio and video
alike. The canonical type is what the attachment carries (`fileType` and the prefix of the data
URL), so the model providers receive a type they know.

### File size limits

- **Default maximum**: 20 MB (`audioUpload.maxFileSizeMB`, 1-2000). The default follows the Google
  Gemini API's limit for inline data. Under 10 MB is processed faster.
- **Own limit**: an audio file is held to the audio limit, whatever the limits of the other upload
  types are (a 50 GB video limit does not raise it). The error for a refused file names the limit
  of its own type.
- **Larger files**: the audio is attached as a base64 data URL, which a browser cannot build beyond
  about 400 MB of audio. What is sent to a multimodal model must also fit the request body
  (`requestBodyLimitMB` in `platform.json`, 50 MB by default), so raise the limit only where the
  audio is [transcribed](#two-audio-paths-multimodal-vs-voxtral-transcription) in the browser
  instead.

### Audio quality recommendations

For the best transcription results:

- **Sample rate**: 16 kHz or higher
- **Channels**: mono for speech, stereo for music
- **Format**: WAV for accuracy, MP3 for convenience (128 kbps or higher)
- **Recording**: little background noise; for multimodal models, clips under 5 minutes work best

## Video uploads: audio extraction

Users can upload a video, and the browser extracts its audio track as a **16 kHz mono WAV**. That
file goes to the model like an uploaded audio file, or, with a transcription model selected, is
transcribed (the video's name is the question, the transcript the answer). No server-side
processing or external tool is involved.

The video itself never leaves the browser, so its size is limited only by what the browser can
read. An **MP4 or MOV can be up to 50 GB** (half an hour of video is 10 GB and more): only its
index and its audio are read, see [Large videos](#large-videos-mp4-and-mov-up-to-50-gb). Other
containers (WebM, MKV, AVI, …) are decoded from the whole file and stop at about 2 GB.

### Enable video upload

In **Admin → Apps → (app) → Upload Configuration**, turn on **Enable Video Upload** and
**Extract audio track (for transcription / audio models)**. In the app config:

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

| Field              | Type     | Default                                          | Description                                                                                                                                                                                                       |
| ------------------ | -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | boolean  | `false`                                          | Enable video uploads                                                                                                                                                                                              |
| `extractAudio`     | boolean  | `true`                                           | Extract the audio track. With `false` the video itself is sent to the model, for models that take video                                                                                                           |
| `maxFileSizeMB`    | integer  | `50`                                             | Maximum video size, 1-51200 (50 GB). Applies to videos only; documents, images and audio keep their own limits. With extraction an MP4 or MOV may be any size up to this; other containers, and videos sent as they are, stop at about 2 GB |
| `supportedFormats` | string[] | `["video/mp4", "video/webm", "video/quicktime"]` | Accepted MIME types; each must start with `video/`                                                                                                                                                                |

### Supported video formats

| Format    | Extension | Size                       |
| --------- | --------- | -------------------------- |
| MP4       | `.mp4`    | Any size up to the limit   |
| QuickTime | `.mov`    | Any size up to the limit   |
| WebM      | `.webm`   | Up to about 2 GB           |

### How extraction works

1. **Read**: for an MP4 or MOV, the index and the audio bytes of the file; for any other container,
   the whole file.
2. **Decode**: the browser decodes the audio track, resampling it to 16 kHz as it decodes.
   Uncompressed PCM in a MOV needs no decoder.
3. **Resample**: the audio is downmixed to mono at 16 kHz. If an MP4 or MOV edit list trims the
   audio, only the part the file plays is rendered.
4. **Encode**: the audio is written as a 16-bit PCM WAV.
5. **Finish**: the WAV is attached (as a base64 data URL and as a file the transcription reads
   directly).

These are the steps the progress panel shows (see [Progress and Stop](#progress-and-stop)). Reading,
decoding and resampling run off the main thread and the WAV is encoded in small slices, so the page
stays usable; this keeps working at full speed when the user switches to another tab.

### Large videos (MP4 and MOV, up to 50 GB)

A browser cannot read more than about 2 GB of a file into memory at once (in Chromium a 1.9 GB file
works, a 3 GB file fails). A video of half an hour is 10 GB and more, while its audio is small: half
an hour of AAC is about 30 MB. So an MP4 or MOV of **any size** is not read whole:

1. **The index.** The box headers at the top level are read, skipping the picture data however large
   it is, to find the `moov` index (at the start of an MP4 written for streaming, after the picture
   in a QuickTime file and in what most cameras write).
2. **The samples.** The sample table says where the audio bytes are. They are read in parts of at
   most 8 MB; the picture between them is skipped.
3. **The result.** AAC (`mp4a.40.*`, including HE-AAC and HE-AACv2) is decoded by the browser.
   Uncompressed PCM (QuickTime `sowt`, `twos`, `in24`, `in32`, `fl32`, `fl64`, `raw `, `lpcm`, in
   either byte order) is converted directly. The MP4 parser
   ([mp4box.js](https://github.com/gpac/mp4box.js), BSD-3-Clause) loads when the first MP4 with AAC
   is processed, not with the page.

Memory use follows the audio, not the file: reading 30 minutes of AAC from a 10 GB video reads about
30 MB.

**The index is checked against the file.** Every sample range must lie inside the file, and
together they cannot add up to more than the file. A damaged or crafted index is refused at once,
before any audio is read, instead of freezing the tab.

**Edit lists.** An MP4 or MOV can carry an edit list that says which part of the track is played
(QuickTime writes one when a recording is trimmed; ffmpeg and most AAC encoders write one that skips
the encoder delay). Empty edits at the start are ignored, and one edit at normal speed is applied as
a trim, so only what the file plays is transcribed. An edit list that plays the audio in several
pieces, at another speed or not at all cannot be read in parts.

**Fragmented MP4 files** (`moof` boxes) are always refused by the partial reader: reading only the
samples in the index would cut the audio off.

What cannot be read in parts falls back to decoding the whole file, which works up to about 1.9 GB:

| The file                                                                                                                                                                                    | Up to about 1.9 GB                       | Above                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| MP4/MOV with AAC-LC, HE-AAC or PCM audio                                                                                                                                                    | read in parts                            | read in parts                                                           |
| MP4/MOV with another codec (Opus, AC-3, ALAC, …), unsigned 16/24/32-bit `lpcm`, a fragmented MP4, an edit list in pieces or at another speed, a damaged index, audio the browser cannot decode | the whole file is decoded by the browser | [`video-large-audio-unsupported`](#error-messages)                       |
| Other containers (WebM, MKV, AVI, …)                                                                                                                                                        | the whole file is decoded by the browser | [`video-unsupported-large-container`](#error-messages)                   |
| `extractAudio: false` (the video itself is sent)                                                                                                                                            | read whole as a data URL                 | [`video-too-large-to-attach`](#error-messages)                           |

### Extracted audio format

The extracted audio is always a **16 kHz mono WAV (PCM 16-bit)**, whatever the video's own sample
rate and channel count:

- It works with every audio-capable model and is exactly what the transcription models are fed.
- It has no lossy compression after the downmix.
- It keeps speech quality, which is what these uploads are for (music loses its high frequencies).
- It is small: about **1.9 MB per minute**, a sixth of a 48 kHz stereo WAV (about 11.5 MB per
  minute). An hour is about 115 MB.

The size matters because the attachment is also held as a base64 data URL, and browsers cannot build
a string beyond a fixed length (about 536 million characters in Chromium). At 16 kHz mono that limit
is about 3.5 hours of audio; a video whose audio still exceeds it is refused when it is uploaded.

The attachment keeps the sample rate (16000), channels (1), duration, size and the original video
file name.

### Progress and Stop

A long video takes seconds to minutes. While a file is processed, a panel above the message box
shows:

- The file name and the step: "Reading file…", "Extracting audio…", "Converting audio…", "Encoding
  audio…", "Finishing up…"
- A progress bar. Decoding cannot report how far it is, so the bar is animated without a value
  during that step; the other steps show a percentage.
- A **Stop** button. Stopping is not an error: nothing is attached for that file, no message is
  shown, the file picker is reset so the same file can be picked again, and files attached before
  stay. When several files were added at once, the ones already processed stay too.

The panel appears after 300 ms, so quick files never flash it, and it is shown for every kind of
attachment (images, documents, audio and video; see
[File Upload](file-upload-feature.md#processing-pipeline)). While it shows, sending is held back, so
a message cannot go out without its attachment. Leaving the chat while a file is processed discards
the run: nothing from it is attached.

### Saving the extracted audio

The extracted audio is attached as `<video name>.wav`, a file the user does not have on disk. Its
row in the attachment list has a **Save audio** button (download icon) that saves the WAV under that
name: `lecture.mp4` becomes `lecture.wav`. It is the exact 16 kHz mono WAV that is transcribed or
sent to the model.

- Only audio extracted from a video gets the button; uploaded audio files are already on disk.
- The button works while an answer is running.
- With a transcription model selected, only the transcript stays in the chat after sending, so save
  the audio before sending.

### Browser compatibility

| Browser | MP4 (AAC)       | MP4 (MP3) | WebM |
| ------- | --------------- | --------- | ---- |
| Chrome  | Yes             | Yes       | Yes  |
| Edge    | Yes             | Yes       | Yes  |
| Firefox | OS-dependent    | Yes       | Yes  |

Firefox uses the operating system's codecs for AAC; if a video plays in Firefox, its audio can
almost always be extracted. The AAC of a large MP4 or MOV needs the same AAC decoder as a small one;
uncompressed PCM needs none. Chromium builds without proprietary codecs (Playwright's Chromium, some
Linux distributions) cannot decode AAC at all.

### Performance and recommended limits

- **Memory**: an MP4 or MOV costs memory for its audio, not its video. The whole audio track is
  decoded before it is reduced to mono; decoding at 16 kHz, a stereo track takes about 290 MB per
  40 minutes (810 MB at 44.1 kHz). Uncompressed PCM is held at its own sample rate until it is
  resampled (345 MB for 30 minutes at 48 kHz). See also the memory note in
  [Realtime Voice & Transcription](voice-transcription.md#using-transcription-in-a-chat).
- **Time**: proportional to the duration; decoding is the longest step (about 7.5 s of about 9 s
  for 40 minutes of audio). A 3.4 GB MOV with 4 minutes of PCM audio was attached in about 3 s.
- **Video size**: up to 50 GB as MP4 or MOV (`maxFileSizeMB` up to 51200), about 2 GB for other
  containers.
- **Duration**: as long as the model takes. A transcription takes an hour by default. Audio sent to
  a multimodal model must fit the request body (`requestBodyLimitMB`, 50 MB by default), which is
  about 20 minutes of 16 kHz mono WAV.

## What users see

### Attaching audio

The upload button (or drag and drop) opens a file picker that lists the formats the app accepts.
Each attached file appears in the attachment list above the message box with its name, type and size
and a remove button; **Remove All** clears the list. A **Record** button records audio in the
browser for the selected model.

### Audio in the chat history

Audio a user sends is shown as a card above the message, with the file name, type and size and the
line "Audio sent to the model". The message itself holds only the typed text.

- There is no audio player: the server does not keep the audio of a chat message, so a player would
  stop working after a reload. The card is not a button; there is nothing stored to open.
- After a reload the card shows the name, type and size; "Audio sent to the model" is shown for
  messages sent in the current session.
- Several audio files show as several cards. From the fifth file of a message (the fourth on a phone
  or in the Outlook task pane) the rest fold into **+N more files**.

## Error messages

| Code                                | Message the user sees                                                                                                                                                         | Cause and fix                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-too-large`                    | File too large. Maximum size is {N}MB.                                                                                                                                        | The file exceeds `maxFileSizeMB` of its own type. Use a smaller file or raise the limit.                                                                                      |
| `unsupported-format`                | Unsupported file format. Please use: {formats}                                                                                                                                | The type is not in `supportedFormats`. Add it, or convert the file.                                                                                                           |
| `audio-upload-disabled`             | Audio upload is not supported by the selected model. Please choose a different model.                                                                                         | The model has no `supportsAudio: true` and is not a transcription model.                                                                                                      |
| `video-upload-disabled`             | Video upload is not supported by the selected model. Please choose a different model.                                                                                         | As above, for a video.                                                                                                                                                        |
| —                                   | The selected model cannot process audio. Select a model that can, or a transcription model, or remove the audio attachment.                                                   | Audio was attached, then the user switched to a model without audio support before sending.                                                                                  |
| —                                   | Could not decode this audio in your browser. The format or codec may be unsupported (e.g. OGG in Safari).                                                                     | Transcription path: the browser cannot decode the file. Use another format or browser.                                                                                        |
| `audio-decode-error`                | Could not decode audio from video. The video format or codec may not be supported by your browser.                                                                            | The browser cannot decode the video's audio codec. Try another format or browser.                                                                                             |
| `video-unsupported-large-container` | Videos larger than 2 GB are supported as MP4 or MOV. Convert this video to MP4 or MOV, or use a smaller file.                                                                 | Not an MP4 or MOV, and larger than about 1.9 GB. A remux is enough when the codecs fit: `ffmpeg -i in.mkv -c copy out.mp4`.                                                  |
| `video-large-audio-unsupported`     | The audio of this large video could not be read. Videos larger than 2 GB need AAC or uncompressed (PCM) audio in an MP4 or MOV file, and a browser that can play that audio. | An MP4 or MOV over about 1.9 GB whose audio cannot be read in parts (see [Large videos](#large-videos-mp4-and-mov-up-to-50-gb)). Use AAC or PCM in a regular MP4/MOV.        |
| `video-too-large-to-attach`         | This video is too large to be attached as it is. Turn on audio extraction for the app, or use a video smaller than 2 GB.                                                      | `extractAudio` is `false` and the video is over about 2 GB. Turn on `extractAudio`.                                                                                           |
| `video-audio-extraction-error`      | Error extracting audio from video. Please ensure the video contains an audio track.                                                                                           | Corrupt file, no audio track, or audio too long to attach (over about 3.5 hours).                                                                                            |
| `read-error`                        | Error reading file                                                                                                                                                            | The browser could not read the file.                                                                                                                                          |

## Troubleshooting

### Audio upload is not available

- Check that **Enable Upload** and **Enable Audio Upload** are on (`upload.enabled` and
  `audioUpload.enabled: true`).
- Check that the selected model has `supportsAudio: true` (**Admin → Models**) or is a transcription
  model. The picker appears only when both the app and the model allow audio.
- In compare mode the **Record** button is hidden and audio is not transcribed.

### The file is refused

- Compare the file size with `maxFileSizeMB` of its own type (audio or video).
- Check that its format is in `supportedFormats`; for `.m4a` files, `audio/mp4` is enough.
- See [Error messages](#error-messages); the browser console has details.

### The model does not process the audio

- Check that the model has `supportsAudio: true` and is enabled.
- Check the provider's API key (`GOOGLE_API_KEY` for Gemini, `OPENAI_API_KEY` for OpenAI) and that
  the OpenAI model accepts audio input.
- Check that the audio fits `requestBodyLimitMB`; check the server logs for API errors.

### Poor transcription quality

- Use WAV instead of MP3, at 16 kHz or more.
- Reduce background noise; try shorter clips (under 5 minutes) with multimodal models.

### Audio extraction fails in Firefox

- Check that the video plays in Firefox's own player.
- Convert the video to MP3 audio instead of AAC, or try another operating system or browser.

### The extracted audio is silent

- Check that the video has an audio track, is not muted and is not corrupted.

### The browser crashes during extraction

- Use a smaller video, close other tabs, or use a browser with more memory available. Prefer MP4 or
  MOV for large videos: only their audio is read.

## References

- [Google Gemini audio documentation](https://ai.google.dev/gemini-api/docs/audio)
- [Gemini File API](https://ai.google.dev/gemini-api/docs/files)
- [Supported audio formats (Firebase AI Logic)](https://firebase.google.com/docs/ai-logic/input-file-requirements)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
