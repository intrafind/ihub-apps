# Microphone Feature Documentation

## Overview

The microphone feature allows users to dictate messages instead of typing. It supports two operation modes, an optional transcript overlay, and multiple speech recognition backends (browser-native, Azure Cognitive Services, and any transcription model — Voxtral on vLLM or Mistral, Gemini Transcribe Live, Gemini Transcribe, Whisper on T-Systems LLM Hub or OpenAI — streamed through iHub).

> **Dictation vs. transcription.** This page covers **dictation** — live microphone speech dropped into the **input field** for the user to edit and send. A separate feature, **transcription**, turns a recording or an uploaded audio/video clip into the **user's message** — a recording grows the message while the user speaks and sends it on stop — using a `modelType: "transcription"` model; the chat model then answers it. Both can be enabled on the same app and share the same authenticated `/api/voice/realtime` WebSocket. See [Transcription Models](models.md#transcription-models) and [Audio File Support](audio-file-support.md#two-audio-paths-multimodal-vs-voxtral-transcription).

> **Voice mode.** A third feature builds on the same voice input: **[voice mode](#voice-mode-spoken-conversation)** is a spoken conversation with the app. The user talks, the app answers out loud and can be interrupted. It is a preview feature and listens with the speech service configured on this page.

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

Any transcription model can take dictation: self-hosted Voxtral on vLLM, Voxtral on the Mistral platform, Gemini Transcribe Live, Gemini Transcribe, or Whisper on T-Systems LLM Hub, OpenAI or another OpenAI-compatible server. The data flow is:

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

- A streaming model (Voxtral, Gemini Transcribe Live) shows the text while the user speaks. Gemini Transcribe and Whisper are batch models: the text appears in one piece when the user stops.
- Users need access to the model through their groups, as for any model.
- The same model can serve dictation, the record button and file transcription.

Both `manual` (continuous) and `automatic` (silence-detected auto-stop via client-side
voice-activity detection) microphone modes are supported. Because the browser captures
raw audio via `getUserMedia` + `AudioContext`/`AudioWorklet`, this mode requires a secure
context (HTTPS, or `localhost`) and does not depend on the browser's Web Speech API — so
it also works in Firefox.

> **Upgrading from an earlier version:** the `vllm-realtime` service and its endpoint under
> `speech.realtime` (`url`, `model`, `apiKey`, `enabled`) are gone. Migration V151 moves the
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
- **Voice mode**: the platform switch and settings of the spoken conversation (see [Voice mode](#voice-mode-spoken-conversation)).
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

## Voice Mode (Spoken Conversation)

> **Preview.** Voice mode is off until an admin enables the **Voice Mode** feature under **Admin → Features** (`voiceMode`) and switches it on under **Admin → Voice Input**.

Voice mode turns a chat into a spoken conversation. The user talks, the app answers out loud, and the user can interrupt at any time. It is the **same chat**: same app, model, tools and sources, and the same history. The only difference is an instruction added to the app's system prompt that keeps answers short and easy to listen to. Voice mode is part of voice input: it listens with the app's speech recognition service (see [Speech Recognition Services](#speech-recognition-services)) and speaks with a [text-to-speech model](text-to-speech.md).

### Using it

- **Start.** Click the **waveform button** next to **Send**. The first click asks the browser for the microphone, because audio needs a click to start. The button only shows when voice mode is available for the app (see [When voice mode is available](#when-voice-mode-is-available)).
- **The voice view.** It covers the messages and leaves the chat header visible. An orb moves with your voice and the app's, a label says what is going on (*Listening…*, *Thinking…*, *Speaking…*, *Microphone is muted*), and captions show what you said and what the app is saying. **Mute** switches the microphone off for a moment, **End** closes the view.
- **Hands-free** (default). Just speak. After a short pause, 0.8 seconds by default, your turn ends and the app answers. Your own words show as a caption while you speak, and a turn with nothing but a cough or "um" is dropped without sending anything.
- **Push-to-talk.** Hold the on-screen button or the **Space** bar while you speak. Letting go sends your turn. Space is not push-to-talk while you are typing into a field or while a button has the focus (it presses that button then). Keyboard and screen reader users: pressing **Space** or **Enter** on the on-screen button holds it, and a single activation by a screen reader starts the turn and a second one sends it. The turn also ends when the window loses focus, so the microphone is never left open in the background.
- **Interrupting.** When you speak while the app is answering, it stops about a third of a second after you begin (the detector waits for 350 ms of speech so that a cough or a click does not interrupt), stops the answer that is still being written, and listens to you. A tap on the orb also stops the answer. Turn **Let me interrupt by speaking** off if the app keeps cutting itself off.
- **Headphones.** The microphone cancels echo, but laptop speakers can still be picked up as a voice. With headphones interrupting works best. Without, switch interrupting off in the settings and use push-to-talk or the tap.
- **Captions** are on by default. They show the app's answer as text while it is spoken, and mark how far the voice has got: what has been said keeps the accent colour, what is still to come is grey, and the caption scrolls to keep the spot being read in view. The text is usually written faster than it is spoken, so the grey part can run ahead. The mark follows the audio word by word; with a long sentence that is still arriving it is an estimate, and it catches up when the audio is complete. Nothing is marked when the answer is not played (muted, or speech failed). Captions are the alternative to audio for people who cannot hear it and for noisy places, and the whole conversation is also in the chat behind the view. Switch them off in the settings.
- **Settings (⚙).** Listening style, interrupting and captions. They are stored in the browser of each user and win over the defaults of the admin.
- **Tools and long answers.** While the app searches or reads, the label says so (*Searching the web…*, *Looking in the documents…*). Tables, images and charts cannot be spoken: they appear in the chat, and the app tells you so. If the app has a question for you (a clarification), it asks it out loud and your next sentence is the answer. For a question with options, say the option; where several can be picked, name all of them ("red and blue"). If what you said names no option, or too few or too many of them, the app asks again instead of guessing.
- **End.** **✕**, **End** or **Esc** closes the microphone and the audio and returns to the normal chat. You can carry on by typing, and start voice mode again later in the same chat.
- Spoken turns are saved as ordinary messages, marked as spoken, so the history shows what was said.

### Speech services

Voice mode listens with the service its app uses for voice input: `settings.speechRecognition.service`, or the platform default under **Admin → Voice Input**. No separate speech-to-text setting exists.

| Service | How voice mode works with it |
| ------- | ---------------------------- |
| **Transcription model** (`model`) | The browser sends only the audio of speech, plus a short run-up, through iHub to the model, and ends each turn with a `commit`. A streaming model shows the words while you speak; a batch model (Whisper, Gemini Transcribe) shows them after each turn. Details: [Realtime Voice & Transcription](voice-transcription.md). |
| **Azure Speech** (`azure`) | The browser streams the audio to Azure Speech with a short-lived token from iHub. The subscription key never reaches the browser. |
| **Browser** (`browser`) | The browser's own Web Speech API. Chrome, Edge and Safari have it, Firefox does not. The recognizer pauses while the app speaks and restarts when you interrupt. |

In hands-free mode a voice-activity detector runs in the browser and finds where your turn ends. It is served from iHub itself, so voice mode works without internet access to other hosts.

### Privacy

- **Audio is never stored.** iHub keeps neither what the microphone hears nor what the app speaks, as with dictation and transcription.
- The microphone audio goes **only to the speech service of the app**: the browser vendor's recognizer, Azure Speech, or iHub and from there the transcription model you configured. The text of the answer goes to the text-to-speech model.
- The microphone is open only while the voice view is open.
- What you said is kept as text in the chat, like a typed message. [Incognito chats](user-guide.md) stay unsaved.

### Setting it up

1. **Switch the feature on.** **Admin → Features → Voice Mode** (a preview feature, off by default). Without it nobody sees the button and the server refuses voice sessions.
2. **Prepare the speech services.** Voice input for the apps that should have voice mode (see [Speech Recognition Services](#speech-recognition-services)), and a text-to-speech model (see [Read Aloud](text-to-speech.md#setting-it-up) for adding one; read aloud itself does not have to be switched on when voice mode names its own model).
3. **Open Admin → Voice Input → Voice mode.** Tick **Enable voice mode**, optionally choose a text-to-speech model, and set the listening style, the length of the pause, interrupting, the reasoning effort and the longest session. Use **Try it** to hold a conversation from the admin page with the settings in the form (before you save them) and the speech service chosen under **Voice input**. The app repeats what it heard. One exception: with a transcription model as the speech service, **Enable voice mode** must have been saved once, because that conversation socket checks the saved switch like it does for every user. **Try it** says so until then.
4. **Decide per app.** With **Turn voice mode on for apps that do not decide themselves** (`appDefault`) off, voice mode is opt-in: open an app in the app editor, and under **Input Mode & Microphone** set **Voice mode** to **On**. With it on, every app that allows voice input has voice mode unless the app sets it to **Off**.
5. **Permissions.** No new permission is needed. Users need the app, the speech model (when the app uses one) and the text-to-speech model through their groups.

### When voice mode is available

The button shows when all of these hold:

1. the `voiceMode` feature is on and `speech.voiceMode.enabled` is `true`;
2. the app allows voice input (`inputMode.microphone.enabled` is not `false`) and voice mode is on for the app (`inputMode.voiceMode.enabled`, else `appDefault`);
3. a text-to-speech model is set for the app, for voice mode, or as the read-aloud default, and the user may use it;
4. the app's speech service works: a transcription model is set, Azure Speech is enabled, or the browser has the Web Speech API;
5. the browser has microphone access (`getUserMedia`) and `AudioWorklet`, which needs HTTPS or `localhost`.

### Deployment notes

- **Voice detection files.** Hands-free listening runs a voice-activity detector (Silero VAD on ONNX Runtime Web) in the browser. Its files (`silero_vad_v5.onnx` about 2.3 MB, the ONNX Runtime WebAssembly binary about 14 MB, and two small scripts) are built into the client and served by iHub under `<base path>/vad/`. Nothing is loaded from a CDN, so air-gapped installs work. They are fetched once when voice mode first starts and then come from the browser cache. iHub does not compress responses itself: let your reverse proxy compress `application/wasm` (gzip or brotli makes the WebAssembly file considerably smaller) and cache `/vad/*` for a long time (the file names do not change within a release).
- **Content Security Policy.** iHub sets none. If your proxy sets one, voice mode needs `script-src 'self' blob: 'wasm-unsafe-eval'` (the audio worklets are created from blob URLs and ONNX Runtime compiles WebAssembly), `worker-src 'self' blob:` and `connect-src 'self'` (plus the Azure Speech hosts when Azure is the speech service). Without them the voice view reports that voice detection could not be loaded.
- **Microphone permission.** A proxy that sends `Permissions-Policy` must allow `microphone=(self)`. Voice mode is not offered in an embedded chat. Send `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (unless you embed iHub on purpose) so that no other site can frame iHub and start recording with a click.
- **HTTPS.** The browser grants the microphone and `AudioWorklet` only on HTTPS or `localhost`.
- **Sub-paths.** Behind a base path (`/ihub/`) the files are served from `/ihub/vad/`; the client works the path out like it does for the API.
- **Rate limits.** Every answer is read in several requests (three to six). They count against `rateLimit.inferenceApi`, which is keyed by IP address: many users behind one NAT share it, so raise its `limit` when voice mode is used widely. A request the user stops by interrupting is not counted by that limiter, so a user can additionally have at most six syntheses running at once (`429` with `too-many-requests`).

### Configuration reference

**Platform** (`contents/config/platform.json`, **Admin → Voice Input → Voice mode**):

```json
{
  "speech": {
    "voiceMode": {
      "enabled": true,
      "appDefault": false,
      "ttsModelId": "",
      "listeningStyle": "hands-free",
      "bargeIn": true,
      "endOfTurnSilenceMs": 800,
      "thinkingLevel": "low",
      "maxSessionMinutes": 30,
      "systemPrompt": {}
    }
  }
}
```

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `enabled` | `false` | Turns voice mode on for the instance (the `voiceMode` feature must be on as well). |
| `appDefault` | `false` | Whether apps that do not set `inputMode.voiceMode.enabled` have voice mode. |
| `ttsModelId` | `""` | The text-to-speech model that speaks. Empty uses `speech.tts.defaultModelId`. |
| `listeningStyle` | `"hands-free"` | `"hands-free"` or `"push-to-talk"`. Users can change it in the voice settings. |
| `bargeIn` | `true` | Whether the user can interrupt the answer by speaking. Users can change it in the voice settings. |
| `endOfTurnSilenceMs` | `800` | Hands-free: the pause that ends the user's turn, 300 to 3000. |
| `thinkingLevel` | `"low"` | `"minimal"`, `"low"`, `"medium"` or `"high"`. Reasoning models add seconds of silence before the answer, so a spoken turn asks for this level. A level that the app or the request already sets stays, and models that do not reason are not sent one. |
| `maxSessionMinutes` | `30` | A voice session ends after this many minutes, 1 to 240. The session also stays under the hard limit `speech.realtime.maxSessionSeconds`. |
| `systemPrompt` | `{}` | Optional voice style instruction per language (`{ "en": "…", "de": "…" }`). It replaces the built-in text. |

Saved in the admin page, they take effect without a restart. The text-to-speech model and the other speech settings are described under [Text-to-Speech](text-to-speech.md#voice-mode).

**The voice style instruction.** In voice mode the server adds a short instruction after the app's own system prompt: answer conversationally and briefly, lead with the answer, usually one to four sentences, no tables, code blocks, headings, lists, URLs or emoji unless asked, say numbers the way they are spoken, and say when something was put in the chat. The built-in text exists in English and German and is shown under the fields in the admin page. `systemPrompt` replaces it. The text for the user's language is used first, then the English one, then the built-in text for the language. Leave a language out to keep the built-in text.

**App** (`contents/apps/*.json`, next to `inputMode.microphone`; the app editor writes it):

```json
{
  "inputMode": {
    "microphone": { "enabled": true, "mode": "manual", "showTranscript": true },
    "voiceMode": {
      "enabled": true,
      "listeningStyle": "push-to-talk",
      "ttsModelId": "voxtral-mini-tts",
      "voice": "de_anna"
    }
  }
}
```

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `enabled` | the platform `appDefault` | `true` turns voice mode on for this app, `false` off. |
| `listeningStyle` | the platform value | `"hands-free"` or `"push-to-talk"`. |
| `ttsModelId` | the platform value | The text-to-speech model of this app, for example a German voice model for a German app. |
| `voice` | the model's voice | A voice id of that model, for example a custom voice. Empty uses the voice settings of the model (`tts.voice`, `tts.voices`). |

An app without `inputMode.voiceMode` simply follows the platform, and nothing needs migrating. An app with `inputMode.microphone.enabled: false` has no voice mode, whatever it sets here. The app editor shows the voice mode controls greyed out in that case, and leaves out every field that follows the platform.

### Limits

- **Session length:** `maxSessionMinutes`, then the voice view closes with a message.
- **Connections:** voice mode counts against the realtime limits (`speech.realtime.maxConnectionsPerUser` and `maxConnections`, see [Runtime limits and tuning](voice-transcription.md#runtime-limits-and-tuning)). A session sends keepalive messages while the app thinks and speaks, so a long answer does not end it.
- **Nobody speaking:** a session in which nothing was said for ten minutes (no audio and no turn, only keepalives, for example a microphone left open or muted) ends with a message, so that it does not hold a connection for the whole session length.
- **Speech output:** every piece of an answer is a request to `/api/voice/speech`, counted by the inference rate limit (`rateLimit.inferenceApi`). Interrupting aborts the requests of the interrupted answer.

### Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| No waveform button | One of the conditions in [When voice mode is available](#when-voice-mode-is-available) fails: the feature is off, the platform switch is off, the app has voice mode or the microphone off, no text-to-speech model, the user's groups may not use it, or the browser has no microphone or `AudioWorklet` (HTTP instead of HTTPS). |
| "Microphone access was blocked" | The browser denied the microphone. Allow it for the site in the browser settings. |
| The app answers its own voice | Laptop speakers without headphones. Use headphones, turn interrupting off, or use push-to-talk. |
| Turns end too early or too late | Change **End of turn after silence** (`endOfTurnSilenceMs`). Noisy rooms need a longer pause. |
| Answers start slowly | A reasoning model: set **Reasoning effort** to `minimal` or `low`, or use an app model that does not reason. |
| "The connection to speech recognition was lost" | The transcription socket broke and one reconnect did not bring it back. Check the model under **Admin → Models → Test**, and the realtime limits. |
| "Voice mode ended because nothing was said for a while" | Ten minutes without speech (see [Limits](#limits)). Start it again. |
| "Voice detection could not be loaded" | `/vad/` is blocked or not reachable: a proxy rule, a Content Security Policy without `'wasm-unsafe-eval'`, or a very slow first download. See [Deployment notes](#deployment-notes). |
| The app answers but nothing is heard, a note says the answer could not be spoken | The text-to-speech model failed (no API key, no permission, rate limit). The answer is in the chat. Check the model under **Admin → Models → Test**. |
