# Microphone Feature Documentation

## Overview

The microphone feature allows users to dictate messages instead of typing. It supports two operation modes, an optional transcript overlay, and multiple speech recognition backends (browser-native, Azure Cognitive Services, and any transcription model — Voxtral on vLLM or Mistral, Gemini Transcribe Live, Gemini Transcribe — streamed through iHub).

> **Dictation vs. transcription.** This page covers **dictation** — live microphone speech dropped into the **input field** for the user to edit and send. A separate feature, **transcription**, turns a recording or an uploaded audio/video clip into the **user's message** — a recording grows the message while the user speaks and sends it on stop — using a `modelType: "transcription"` model; the chat model then answers it. Both can be enabled on the same app and share the same authenticated `/api/voice/realtime` WebSocket. See [Transcription Models](models.md#transcription-models) and [Audio File Support](audio-file-support.md#two-audio-paths-multimodal-vs-voxtral-transcription).

## Modes

- `automatic` — Speech recognition stops automatically when the user pauses speaking. The transcribed text is placed in the input field and the listener shuts down. This is the default mode.
- `manual` — Recognition continues in continuous mode until the user explicitly stops it by clicking the microphone button again. Use this for long dictation sessions.

The mode is read from `app.inputMode.microphone.mode`. If that field is absent the system falls back to `app.microphone.mode`, and then defaults to `automatic`.

## Speech Recognition Services

Configure which backend to use with `settings.speechRecognition.service`:

| Value | Behavior |
| ----- | -------- |
| `default` (or omitted) | Uses the **platform default** set under **Admin → Voice Input → Voice input** (`platform.speech.defaultService`, see below). Out of the box that is the browser. |
| `browser` | Always uses the browser's built-in `SpeechRecognition` / `webkitSpeechRecognition` API, whatever the platform default. No additional credentials are required. |
| `azure` | Uses Azure Cognitive Services Speech SDK. Set `settings.speechRecognition.host` to your Azure Speech endpoint. |
| `model` | Streams microphone audio through the iHub server to the transcription model in `settings.speechRecognition.modelId` and streams the text back. Any enabled `modelType: "transcription"` model works; its endpoint and key stay on the model, server-side. |
| `custom` | Uses the browser. Reserved for future custom providers. |

### Platform default

Rather than configuring every app, set the dictation service once in `platform.json` (or **Admin → Voice Input → Voice input**):

```json
{
  "speech": {
    "defaultService": "model",
    "dictation": { "modelId": "voxtral-mini-realtime" }
  }
}
```

`defaultService` is `browser` (the default), `azure` or `model`; with `model`, `dictation.modelId` names the transcription model. Every app whose service is `default` or unset follows it, including later changes. Apps that select a service explicitly keep their choice. In the app editor the choice reads **Platform default (…)** and names the current default.

If the default names a backend that is not available — Azure while `speech.azure.enabled` is `false`, or a model that is disabled or deleted — apps that follow the default use the browser instead of failing. The admin page shows a warning in that case.

### Transcription models (server-proxied)

Any transcription model can take dictation: self-hosted Voxtral on vLLM, Voxtral on the Mistral platform, Gemini Transcribe Live or Gemini Transcribe. The data flow is:

```
browser mic ──(PCM16 16kHz over WebSocket, naming the model)──▶ iHub /api/voice/realtime
   iHub ──(the model's own protocol)──▶ its endpoint ──transcription──▶ iHub ──▶ browser
```

Set the model up once in **Admin → Models** (endpoint, key, enabled; see [Transcription Models](models.md#transcription-models)), then pick it as the platform default or in an app:

```json
{
  "settings": {
    "speechRecognition": {
      "service": "model",
      "modelId": "gemini-3.5-transcribe-live"
    }
  }
}
```

- A streaming model (Voxtral, Gemini Transcribe Live) shows the text while the user speaks. Gemini Transcribe is a batch model: the text appears in one piece when the user stops.
- Users need access to the model through their groups, as for any model.
- The same model can serve dictation, the record button and file transcription.

Both `manual` (continuous) and `automatic` (silence-detected auto-stop via client-side
voice-activity detection) microphone modes are supported. Because the browser captures
raw audio via `getUserMedia` + `AudioContext`/`AudioWorklet`, this mode requires a secure
context (HTTPS, or `localhost`) and does not depend on the browser's Web Speech API — so
it also works in Firefox.

> **Upgrading from an earlier version:** the `vllm-realtime` service and its endpoint under
> `speech.realtime` (`url`, `model`, `apiKey`, `enabled`) are gone. Migration V146 moves the
> endpoint onto a transcription model and switches the platform default and apps to it. See
> [Choosing what voice input uses](voice-transcription.md#choosing-what-voice-input-uses).

### Configuring backends in the Admin UI

Admins choose what voice uses under **Admin → Voice Input** (`/admin/voice-input`)
instead of editing `platform.json` by hand:

- **Voice input**: the browser, Azure Speech or any enabled transcription model, for every
  app that follows the platform default (see [Platform default](#platform-default)).
- **Transcription**: the model for recordings and uploads in apps that enable transcription
  without picking one (see
  [Realtime Voice & Transcription](voice-transcription.md#platform-default-transcription-model)).
- **Read aloud**: the text-to-speech model (see [Text-to-Speech](text-to-speech.md)).
- **Azure Speech** — enable/disable, default host/endpoint, region, and the subscription
  **key**. The key is stored **encrypted at rest** on the server and exchanged for a
  short-lived authorization token per session via `/api/voice/azure/token`, so it never
  reaches the browser. When an app selects the Azure service without its own
  `settings.speechRecognition.host`, it falls back to the platform host configured here.

  **On-prem Azure Speech containers (air-gapped)** need no key: leave the subscription key
  empty and set the host to the container (e.g. `ws://speech.internal:5000`), either here
  or per app. The browser then connects straight to that host: it requests no token, and
  neither the browser nor the iHub server contacts Microsoft. This also works when Azure
  Speech is not enabled here, as long as the app sets its own host. Without a key _and_
  without a host (Azure cloud), voice input fails with "Azure subscription key is not
  configured". Setting a key makes the iHub server call
  `https://<region>.api.cognitive.microsoft.com` for a token, so don't set one when
  air-gapped.

  > **Migrating from `VITE_AZURE_SUBSCRIPTION_ID`:** earlier builds baked the Azure key
  > into the client bundle via this env var. It is no longer used — set the key under
  > **Admin → Voice Input** (`speech.azure.subscriptionKey`) instead.

Transcription models keep their endpoints and keys on the model, set in **Admin → Models**.
The WebSocket proxy's resource guards live under `speech.realtime`: `maxConnections` (global
cap, default 50), `maxConnectionsPerUser` (default 3), `maxFrameBytes` (max inbound audio
frame, default 256 KB) and more; see
[Runtime limits and tuning](voice-transcription.md#runtime-limits-and-tuning).

An app can still pick its own backend in the app editor's **Speech Recognition Service** dropdown,
which lists the transcription models next to the browser and Azure.

**Testing.** Azure Speech has a **Test connection** button that exchanges the key and region
for a token from the iHub server. A transcription model's endpoint is checked with its **Test**
action in **Admin → Models**; a redirect on a `ws://` URL is reported as "use `wss://`".
**Test voice input** checks everything from the admin's own browser, against the saved
configuration:

- a **microphone check** (input level meter);
- a **live dictation** test for any service (browser, Azure, any transcription model), showing
  interim and final text;
- a **recording** test that records a short clip and transcribes it with a transcription model.

See [Testing from the admin UI](voice-transcription.md#testing-from-the-admin-ui).

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

`"service": "default"` follows the platform default. Use `"browser"` to pin the browser's Web Speech API.

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
| Microphone busy (admin test panel) | "The microphone could not be started. It may be in use by another application." |
| Not a secure context (admin test panel) | "Microphone access requires a secure connection (HTTPS or localhost)." |
| No speech detected | "No speech detected. Please try again." |
| Network error | "Network error. Please check your connection." |
| Generic error | "Voice input error. Please try again." |
