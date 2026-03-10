# Microphone Feature Documentation

## Overview

The microphone feature allows users to dictate messages instead of typing. It supports two operation modes, an optional transcript overlay, and two speech recognition backends (browser-native and Azure Cognitive Services).

## Modes

- `automatic` — Speech recognition stops automatically when the user pauses speaking. The transcribed text is placed in the input field and the listener shuts down. This is the default mode.
- `manual` — Recognition continues in continuous mode until the user explicitly stops it by clicking the microphone button again. Use this for long dictation sessions.

The mode is read from `app.inputMode.microphone.mode`. If that field is absent the system falls back to `app.microphone.mode`, and then defaults to `automatic`.

## Speech Recognition Services

Configure which backend to use with `settings.speechRecognition.service`:

| Value | Behavior |
| ----- | -------- |
| `default` (or omitted) | Uses the browser's built-in `SpeechRecognition` / `webkitSpeechRecognition` API. No additional credentials are required. |
| `azure` | Uses Azure Cognitive Services Speech SDK. Set `settings.speechRecognition.host` to your Azure Speech endpoint. |
| `custom` | Falls through to the browser default. Reserved for future custom providers. |

## Supported Languages

The microphone adapts to the application's current UI language. Two-letter language codes are automatically mapped to the full BCP 47 locale required by the Speech Recognition API:

| Language code | Locale used |
| ------------- | ----------- |
| `en` | `en-US` |
| `de` | `de-DE` |
| `fr` | `fr-FR` |
| `es` | `es-ES` |
| `it` | `it-IT` |
| `ja` | `ja-JP` |
| `ko` | `ko-KR` |
| `zh` | `zh-CN` |
| `ru` | `ru-RU` |
| `pt` | `pt-BR` |
| `nl` | `nl-NL` |
| `pl` | `pl-PL` |
| `tr` | `tr-TR` |
| `ar` | `ar-SA` |

If the current language is not in this list the locale falls back to `en-US`. Full BCP 47 tags (e.g., `en-GB`) are passed through unchanged.

## Voice Commands

Users can speak special commands at the end of their dictation to trigger actions without touching the keyboard. The system strips the command phrase from the transcribed text before it is placed in the input field.

| Command phrase (EN) | Command phrase (DE) | Action |
| ------------------- | ------------------- | ------ |
| "clear chat", "clear the chat", "delete chat", "delete all messages", "start new chat", "reset chat" | "chat löschen", "alles löschen", "nachrichten löschen", "neuer chat", "chat zurücksetzen" | Clears the current conversation |
| "send message", "send", "sent", "sent message", "submit message", "submit" | "nachricht senden", "senden", "abschicken", "nachricht abschicken" | Submits the current message |

Example: saying "Summarize this document for me. Send." will place "Summarize this document for me." in the input field and immediately send it.

## Transcript Overlay

Set `showTranscript` to `true` in the microphone configuration to display the live interim transcript during recording. This gives users real-time feedback as words are recognized.

## Browser Compatibility

The default browser-based service relies on the Web Speech API. As of 2025:

- **Fully supported**: Chrome, Edge, and other Chromium-based browsers
- **Not supported**: Firefox (no native Speech Recognition API)
- **Partial**: Safari — available on macOS 14+ and iOS 17+, but may require permission prompts

If the browser does not support the Speech Recognition API, the microphone button is hidden and an error message is shown. If the user denies microphone permission, an error message appears in the input placeholder for three seconds.

## App Configuration Example

Add the following sections to an app's JSON configuration to enable and customize the microphone feature:

```json
{
  "id": "my-app",
  "inputMode": {
    "type": "multiline",
    "microphone": {
      "enabled": true,
      "mode": "automatic",
      "showTranscript": true
    }
  },
  "settings": {
    "speechRecognition": {
      "service": "default"
    }
  }
}
```

### Using Azure Speech Services

```json
{
  "id": "my-app",
  "inputMode": {
    "type": "multiline",
    "microphone": {
      "enabled": true,
      "mode": "manual",
      "showTranscript": true
    }
  },
  "settings": {
    "speechRecognition": {
      "service": "azure",
      "host": "https://<region>.stt.speech.microsoft.com"
    }
  }
}
```

Replace `<region>` with your Azure region (e.g., `westeurope`).

## Error Handling

The microphone feature surfaces errors directly in the chat input placeholder for three seconds before restoring the original placeholder:

| Error | Message |
| ----- | ------- |
| Browser not supported | "Speech recognition not supported in this browser" |
| Permission denied | "Please allow microphone access and try again." |
| No microphone found | "No microphone found. Please check your device settings." |
| No speech detected | "No speech detected. Please try again." |
| Network error | "Network error. Please check your connection." |
| Generic error | "Voice input error. Please try again." |
