# Microphone Feature Documentation

## Overview

The microphone feature allows users to dictate messages instead of typing. It supports two operation modes, an optional transcript overlay, and multiple speech recognition backends (browser-native, Azure Cognitive Services, and an iHub-proxied vLLM realtime endpoint such as Voxtral).

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
| `vllm-realtime` | Streams microphone audio to the iHub server over a WebSocket; iHub proxies it to a vLLM realtime endpoint (e.g. Voxtral on `/v1/realtime`) and streams transcription back. The endpoint is configured **server-side** in `platform.json` (see below) — no per-app `host` is needed and the vLLM URL/key never reach the browser. |
| `custom` | Falls through to the browser default. Reserved for future custom providers. |

### vLLM Realtime (server-proxied)

This mode is for self-hosted realtime speech models served by vLLM's realtime API
(for example `mistralai/Voxtral-Mini-4B-Realtime-2602`). The data flow is:

```
browser mic ──(PCM16 16kHz over WebSocket)──▶ iHub /api/voice/realtime
   iHub ──(vLLM realtime JSON protocol)──▶ vLLM /v1/realtime ──transcription──▶ iHub ──▶ browser
```

**Platform configuration** (`contents/config/platform.json`):

```json
{
  "speech": {
    "realtime": {
      "enabled": true,
      "url": "ws://localhost:8080/v1/realtime",
      "model": "mistralai/Voxtral-Mini-4B-Realtime-2602",
      "apiKey": ""
    }
  }
}
```

- `enabled` — master switch for the server-side proxy. When `false` (default), the endpoint returns 503.
- `url` — the vLLM realtime WebSocket URL (`ws://` or `wss://`).
- `model` — the model id sent in the `session.update` handshake.
- `apiKey` — optional. Local vLLM usually needs none. Supports plaintext, a `${ENV_VAR}` placeholder, or an encrypted `ENC[...]` value (decrypted on load).

**App configuration** — an app simply opts in:

```json
{
  "settings": {
    "speechRecognition": {
      "service": "vllm-realtime"
    }
  }
}
```

Both `manual` (continuous) and `automatic` (silence-detected auto-stop via client-side
voice-activity detection) microphone modes are supported. Because the browser captures
raw audio via `getUserMedia` + `AudioContext`/`AudioWorklet`, this mode requires a secure
context (HTTPS, or `localhost`) and does not depend on the browser's Web Speech API — so
it also works in Firefox.

### Configuring backends in the Admin UI

Admins can configure the platform-level speech backends under **Admin → Voice Input**
(`/admin/voice-input`) instead of editing `platform.json` by hand:

- **vLLM Realtime** — enable/disable, WebSocket URL, model, and an optional API key
  (stored encrypted at rest; a localhost vLLM usually needs none).
- **Azure Speech** — enable/disable, default host/endpoint, and region. The Azure
  subscription **key** is provided via the `VITE_AZURE_SUBSCRIPTION_ID` environment
  variable (baked into the client at build time) and is intentionally **not** stored in
  platform config. When an app selects the Azure service without its own
  `settings.speechRecognition.host`, it falls back to the platform host configured here.

Per-app selection of which backend to use still happens in the app editor's
**Speech Recognition Service** dropdown.

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
