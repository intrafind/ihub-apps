# Audio File Upload Support

iHub Apps supports audio file uploads for transcription, analysis, and processing using Google Gemini and OpenAI models. This feature enables applications to work with audio content including speech-to-text, speaker identification, sentiment analysis, and audio summarization.

## Overview

Audio file support allows users to upload audio files (MP3, WAV, FLAC, OGG) directly into compatible applications. The audio data is sent to LLM providers that support multimodal input, enabling tasks such as:

- **Transcription**: Convert speech to text
- **Speaker Identification**: Identify and label different speakers
- **Sentiment Analysis**: Analyze tone and emotion in audio
- **Summarization**: Extract key points from conversations or presentations
- **Translation**: Transcribe and translate audio content
- **Audio Analysis**: Analyze music, sound effects, or environmental audio

## Supported Models

Audio file support is available for any model with `supportsAudio: true` in its configuration. This flag can be set via the Admin UI under model settings.

### Google Gemini

All current Gemini models support audio input:

- **Gemini 3.1 Pro** - `gemini-3.1-pro`
- **Gemini 3.1 Flash Image** - `gemini-3.1-flash-image`
- **Gemini 3.1 Flash Lite** - `gemini-3.1-flash-lite`
- **Gemini 3 Pro** - `gemini-3-pro`
- **Gemini 3 Flash** - `gemini-3-flash`
- **Gemini 2.5 Pro** - `gemini-2.5-pro`
- **Gemini 2.5 Flash** - `gemini-2.5-flash`
- **Gemini Flash Latest** - `gemini-flash-latest`
- **Gemini Flash Lite Latest** - `gemini-flash-lite-latest`

### OpenAI

OpenAI models with audio input support (GPT-4o and newer):

- **GPT-5** - `gpt-5`
- **GPT-4o** - `gpt-4o` (requires `supportsAudio: true` in model config)

### Enabling Audio for Custom Models

Set `supportsAudio: true` in the model configuration via the Admin panel or directly in the model JSON file.

## Supported Audio Formats

The following audio formats are supported:

| Format | MIME Type | Extension | Description |
|--------|-----------|-----------|-------------|
| MP3 | `audio/mpeg` or `audio/mp3` | `.mp3` | Compressed audio, widely compatible |
| WAV | `audio/wav` | `.wav` | Uncompressed audio, highest quality for speech |
| FLAC | `audio/flac` | `.flac` | Lossless compressed audio |
| OGG | `audio/ogg` | `.ogg` | Open-source compressed audio format |
| MP4 | `audio/mp4` | `.mp4`, `.m4a` | MPEG-4 audio (used by QuickTime and Apple devices) |

### File Size Limits

- **Default maximum size**: 20MB
- **Recommended size**: Under 10MB for faster processing
- **Note**: The 20MB limit is based on Google Gemini API's inline data limit

### Audio Quality Recommendations

For best transcription results:
- **Sample rate**: 16 kHz or higher
- **Channels**: Mono for speech, stereo for music
- **Format preference**: WAV for accuracy, MP3 for convenience
- **Bitrate**: 128 kbps or higher for MP3

## Configuration

### App Configuration

To enable audio upload in an application, add the `audioUpload` configuration to the app's `upload` section:

```json
{
  "id": "audio-transcription",
  "name": {
    "en": "Audio Transcription",
    "de": "Audio-Transkription"
  },
  "upload": {
    "enabled": true,
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 20,
      "supportedFormats": [
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/flac",
        "audio/ogg"
      ]
    }
  },
  "preferredModel": "gemini-flash-latest"
}
```

### Configuration Options

#### `audioUpload` Object

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable audio file uploads |
| `maxFileSizeMB` | number | `20` | Maximum file size in megabytes (1-100) |
| `supportedFormats` | string[] | See below | Array of supported MIME types |

**Default supported formats**:
```json
["audio/mpeg", "audio/mp3", "audio/wav", "audio/flac", "audio/ogg", "audio/mp4"]
```

### Schema Validation

The audio upload configuration is validated using the following schema (defined in `server/validators/appConfigSchema.js`):

```javascript
audioUpload: z.object({
  enabled: z.boolean().optional().default(false),
  maxFileSizeMB: z.number().int().min(1).max(100).optional().default(20),
  supportedFormats: z
    .array(z.string().regex(/^audio\//))
    .optional()
    .default(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/mp4'])
}).optional()
```

## Model Configuration

Models can declare audio support using the `supportsAudio` field:

```json
{
  "id": "gemini-flash-latest",
  "modelId": "gemini-flash-latest",
  "name": {
    "en": "Gemini Flash Latest",
    "de": "Gemini Flash Latest"
  },
  "provider": "google",
  "supportsAudio": true,
  "supportsVision": true,
  "supportsTools": true,
  "enabled": true
}
```

## Implementation Details

### Client-Side Processing

When a user uploads an audio file:

1. **File Validation**: The `UnifiedUploader` component validates the file type and size
2. **Base64 Encoding**: Audio files are converted to base64-encoded data URLs
3. **No Processing**: Unlike images, audio files are not processed or modified
4. **Message Attachment**: Audio data is attached to the message as `audioData`

```javascript
// Example audio data structure
{
  type: 'audio',
  base64: 'data:audio/mpeg;base64,//uQx...',
  fileName: 'recording.mp3',
  fileSize: 2048000,
  fileType: 'audio/mpeg'
}
```

### Server-Side Processing

Both the Google Gemini and OpenAI adapters handle audio files, each using their provider-specific format.

**Google Gemini** uses `inlineData`:

```javascript
{
  inlineData: {
    mimeType: 'audio/mpeg',
    data: 'base64_encoded_audio_data'
  }
}
```

**OpenAI** uses `input_audio`:

```javascript
{
  type: 'input_audio',
  input_audio: {
    data: 'base64_encoded_audio_data',
    format: 'mp3'
  }
}
```

Both adapters:
1. Detect audio data using `hasAudioData(message)` helper from `BaseAdapter`
2. Strip data URL prefixes with `cleanBase64Data()`
3. Construct provider-specific API requests
4. Support multiple audio files in a single message

### API Request Format

**Google Gemini:**

```javascript
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "Transcribe this audio" },
        {
          "inlineData": {
            "mimeType": "audio/wav",
            "data": "<base64-encoded-audio>"
          }
        }
      ]
    }
  ]
}
```

**OpenAI:**

```javascript
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Transcribe this audio" },
        {
          "type": "input_audio",
          "input_audio": {
            "data": "<base64-encoded-audio>",
            "format": "wav"
          }
        }
      ]
    }
  ]
}
```

## Usage Examples

### Basic Transcription App

```json
{
  "id": "transcription",
  "name": { "en": "Transcription", "de": "Transkription" },
  "system": {
    "en": "You are a transcription assistant. Transcribe audio files accurately.",
    "de": "Du bist ein Transkriptionsassistent. Transkribiere Audiodateien genau."
  },
  "upload": {
    "enabled": true,
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 15,
      "supportedFormats": ["audio/wav", "audio/mp3"]
    }
  },
  "preferredModel": "gemini-flash-latest"
}
```

### Advanced Audio Analysis

```json
{
  "id": "audio-analysis",
  "name": { "en": "Audio Analysis", "de": "Audio-Analyse" },
  "system": {
    "en": "You are an audio analysis expert. Analyze audio files for transcription, speaker identification, sentiment, and key topics.",
    "de": "Du bist ein Audio-Analyseexperte. Analysiere Audiodateien für Transkription, Sprecheridentifikation, Stimmung und Hauptthemen."
  },
  "upload": {
    "enabled": true,
    "allowMultiple": true,
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 20,
      "supportedFormats": ["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]
    }
  },
  "tokenLimit": 16384,
  "preferredModel": "gemini-flash-latest"
}
```

### Combined Media App (Images + Audio)

```json
{
  "id": "multimedia-analysis",
  "name": { "en": "Multimedia Analysis", "de": "Multimedia-Analyse" },
  "upload": {
    "enabled": true,
    "allowMultiple": true,
    "imageUpload": {
      "enabled": true,
      "maxFileSizeMB": 10
    },
    "audioUpload": {
      "enabled": true,
      "maxFileSizeMB": 20
    }
  },
  "preferredModel": "gemini-flash-latest"
}
```

## User Interface

### Upload Button

When audio upload is enabled, the upload button in the chat interface allows users to select audio files. The file picker automatically filters to show only supported audio formats.

### Audio File Indicator

Uploaded audio files are displayed with a music note icon (🎵) and the filename:

```
🎵 recording.mp3
```

### Multiple Files

When `allowMultiple` is enabled, users can upload multiple audio files in a single message. Each file is processed separately and sent to the model.

## Best Practices

### Application Design

1. **Clear Instructions**: Provide clear system prompts explaining what the model should do with audio
2. **Model Selection**: Use `preferredModel` to default to an audio-capable model
3. **File Size**: Set appropriate `maxFileSizeMB` based on expected use case
4. **Starter Prompts**: Include example prompts to guide users

### Audio Quality

1. **Format Choice**: Recommend WAV for highest accuracy, MP3 for convenience
2. **Sample Rate**: Encourage 16 kHz or higher for speech
3. **Background Noise**: Advise users to use clear audio with minimal background noise
4. **Length**: Keep audio files under 5 minutes for best results

### Error Handling

The system provides error messages for:
- **File too large**: Exceeds `maxFileSizeMB` limit
- **Unsupported format**: File type not in `supportedFormats`
- **Model compatibility**: Audio upload disabled for non-audio models
- **Read errors**: File cannot be read or processed

## Technical Architecture

### Component Flow

```
User selects audio file
  ↓
UnifiedUploader validates format & size
  ↓
processAudio() converts to base64
  ↓
AppChat attaches audioData to message
  ↓
Message sent to server with audioData
  ↓
Provider adapter formats for API (Google/OpenAI)
  ↓
Audio sent in provider-specific format
  ↓
Model processes and responds
```

### File Structure

Key files implementing audio support:

- **Schema**: `server/validators/appConfigSchema.js`
- **Uploader**: `client/src/features/upload/components/UnifiedUploader.jsx`
- **File Utils**: `client/src/features/upload/utils/fileProcessing.js`
- **Upload Hook**: `client/src/shared/hooks/useFileUploadHandler.js`
- **Chat UI**: `client/src/features/apps/pages/AppChat.jsx`
- **Base Adapter**: `server/adapters/BaseAdapter.js`
- **Google Adapter**: `server/adapters/google.js`
- **OpenAI Adapter**: `server/adapters/openai.js`

## Troubleshooting

### Audio upload not available

- Verify `audioUpload.enabled` is `true` in app configuration
- Ensure the selected model has `supportsAudio: true` (check in Admin > Models)
- The audio file picker only appears when both conditions are met

### File upload fails

- Check file size against `maxFileSizeMB` limit
- Verify file format is in `supportedFormats` array
- Check browser console for detailed error messages

### Poor transcription quality

- Use WAV format instead of MP3
- Ensure audio sample rate is 16 kHz or higher
- Reduce background noise in recording
- Try shorter audio clips (under 5 minutes)

### Model doesn't process audio

- Verify model has `supportsAudio: true` in its configuration
- For Google models: check that `GOOGLE_API_KEY` is configured
- For OpenAI models: check that `OPENAI_API_KEY` is configured and model supports audio input
- Ensure model is enabled in configuration
- Check server logs for API errors

## Future Enhancements

Potential improvements for audio support:

1. **Real-time streaming**: Live audio input for real-time transcription
2. **Audio preview**: Play audio files before sending
3. **Automatic detection**: Smart model selection based on file type
4. **Audio processing**: Pre-processing options (noise reduction, normalization)
5. **Extended formats**: Support for additional audio formats
6. **Provider expansion**: Audio support for Anthropic Claude and Mistral providers

## References

- [Google Gemini Audio Documentation](https://ai.google.dev/gemini-api/docs/audio)
- [Gemini File API](https://ai.google.dev/gemini-api/docs/files)
- [Supported Audio Formats](https://firebase.google.com/docs/ai-logic/input-file-requirements)
