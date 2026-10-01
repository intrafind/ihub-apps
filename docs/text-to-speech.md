# Read Aloud (Text-to-Speech)

Read aloud puts a **play button** on every chat message. Clicking it sends the
message to a text-to-speech (TTS) model, and the audio starts playing while the
model is still generating it. That is usually within a second, however long the
answer is.

The first supported provider is [Mistral Voxtral TTS](https://mistral.ai/news/voxtral-tts/)
(`voxtral-mini-tts-latest`).

## Using it

- The play button sits in a message's action row, next to copy and download.
  It appears on assistant answers and on your own messages once they are
  complete. It does not appear while an answer is still streaming.
- **Play** starts reading. While the message is playing the button turns into
  **pause**. Click it again to pause, and once more to resume from the same
  spot. **Stop** (the square next to it) ends playback.
- Only one message plays at a time. Starting another message stops the current
  one, and so does leaving the chat.
- Playing a message you have already listened to replays it from memory. There
  is no second request and no second charge.
- What is read is the message's text. Markdown is removed first: formatting
  marks, links (their text is kept), images, code blocks, tables (read cell by
  cell), raw URLs and citation markers such as `[1]` are not read out. A
  model's reasoning is never read.

## Setting it up

1. **Model.** A fresh installation already has the model
   `contents/models/voxtral-mini-tts.json`, and migration `V141` adds it to
   existing installations. It ships **disabled**. Open **Admin → Models →
   Voxtral TTS (Read aloud)**, give it a Mistral API key, and enable it. Instead
   of a key on the model you can use the `mistral` provider key from
   Admin → Providers, or the `MISTRAL_API_KEY` environment variable, the same
   keys the Mistral chat models use.
2. **Switch it on.** Open **Admin → Voice Input → Read aloud
   (text-to-speech)**. Tick **Show a read-aloud button on chat messages**,
   choose the model and save. The **Test** field on the same page speaks a
   sentence with the selected model, so you can try a voice before saving.
3. **Permissions.** Users only see the button when their groups may use the
   TTS model (`permissions.models` in `groups.json`, or `*`).

To turn read aloud off for a single app, set `features.textToSpeech: false` in
the app's configuration.

### Voices

The voice belongs to the model: `tts.voice` (Admin → Models → *Voice*). Mistral
ships preset voices in English (US and British) and French, each in several
moods, for example:

| Voice id | Language |
| --- | --- |
| `en_paul_neutral` (default) | English (US) |
| `en_paul_cheerful`, `en_paul_confident` | English (US) |
| `gb_jane_neutral`, `gb_oliver_neutral` | English (UK) |
| `fr_marie_neutral`, `fr_marie_happy` | French |

A voice you created in the Mistral console works too: enter its id. Voxtral
TTS speaks English, French, German, Spanish, Dutch, Portuguese, Italian, Hindi
and Arabic, and any voice can read any of them. To use different voices, for
example one per language, create one TTS model per voice.

## Configuration reference

### Model (`contents/models/*.json`)

```json
{
  "id": "voxtral-mini-tts",
  "modelId": "voxtral-mini-tts-latest",
  "name": { "en": "Voxtral TTS (Read aloud)" },
  "description": { "en": "Mistral's Voxtral text-to-speech model." },
  "url": "https://api.mistral.ai/v1/audio/speech",
  "provider": "mistral",
  "modelType": "tts",
  "tts": { "voice": "en_paul_neutral" },
  "enabled": true
}
```

| Field | Meaning |
| --- | --- |
| `modelType` | `"tts"` marks a text-to-speech model. TTS models never show up in the chat model selector and are never picked as the default chat model. |
| `provider` | `"mistral"`. A TTS model on any other provider fails validation. |
| `url` | The speech endpoint. Empty uses `https://api.mistral.ai/v1/audio/speech`. It stays on the server. |
| `modelId` | The provider's model id. Empty uses `voxtral-mini-tts-latest`. |
| `tts.voice` | The voice id. Empty uses `en_paul_neutral`. |
| `apiKey` | Optional. Stored encrypted. Without one, the `mistral` provider key or `MISTRAL_API_KEY` is used. |

### Platform (`contents/config/platform.json`)

```json
{
  "speech": {
    "tts": {
      "enabled": true,
      "defaultModelId": "voxtral-mini-tts",
      "maxCharacters": 20000
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `speech.tts.enabled` | `false` | Shows the read-aloud button in chats. |
| `speech.tts.defaultModelId` | `""` | The TTS model that reads messages. |
| `speech.tts.maxCharacters` | `20000` | The most characters of one message that are read, counted after Markdown is removed. Anything beyond is cut. |

These settings take effect without a restart.

### App (`contents/apps/*.json`)

```json
{ "features": { "textToSpeech": false } }
```

Turns the button off for that app. Without this setting, the app follows the
platform switch.

## How it works

```
Browser                         iHub server                         Mistral
───────                         ───────────                         ───────
click ▶ ─ POST /api/voice/speech { text } ─▶ checks the model and permission,
                                        strips Markdown, splits it into
                                        pieces of ≤ 1,500 characters
                                        ── POST /v1/audio/speech (stream, pcm) ─▶
                                        ◀─ SSE speech.audio.delta (float32) ─
◀─ chunked 16-bit PCM, 24 kHz ──────── converts to 16-bit, streams on
plays with Web Audio as it arrives      next piece once one is finished …
```

- **Endpoint.** `POST /api/voice/speech` with `{ "text": "…", "modelId"?: "…" }`
  answers with raw 16-bit little-endian mono PCM. The response headers
  describe the format: `X-Audio-Encoding: pcm_s16le`,
  `X-Audio-Sample-Rate: 24000` and `X-Audio-Channels: 1`. Without a `modelId`
  the platform default is used, and only while read aloud is switched on.
  With a `modelId`, any enabled TTS model the user may use is accepted.
- **Errors** before the first audio byte are JSON with a status: `400` (no
  text), `403` (model not permitted), `404` (not a TTS model), `413` (input
  over 200,000 characters), `422` (nothing left to read once Markdown is
  removed), `502` (the provider failed, for example a rejected API key), and
  `503` (read aloud not configured, or the model is disabled). If the provider
  fails in the middle of a stream, the response is cut off and the player
  reports the error after playing what arrived.
- **Cost control.** When playback stops, or the user leaves the chat, the
  request is aborted and the server aborts the provider request with it.
  Requests count against the inference rate limiter
  (`rateLimit.inferenceApi`). A replay of a message that already finished
  plays from memory.
- **Long answers.** The server synthesizes the pieces one after another into a
  single stream. Voxtral generates audio several times faster than it plays,
  so the listener never hears the gap between pieces. The browser decodes only
  about 15 seconds ahead of what is playing, so a long answer costs its
  16-bit audio in memory and not minutes of decoded buffers.
- **Secrets.** The model's `url` and `apiKey` never reach the browser.
  `GET /api/models?type=tts` lists the TTS models a user may use, with both
  fields removed.

### Adding a provider

TTS providers live in `server/tts/` and are registered in `server/tts/index.js`.
A provider exports `sampleRate`, `resolveUpstream(model)` and
`synthesize({ cfg, text, signal, onAudio })`. `synthesize` streams 16-bit mono
PCM at `sampleRate` to `onAudio`, waiting for each call to return. It must
also accept the provider id in `TTS_PROVIDERS` (`server/validators/modelConfigSchema.js`).
The browser player stays the same for every provider.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No play button | Read aloud is switched off, no model is chosen, the model is disabled, the user's groups may not use the model, or the app sets `features.textToSpeech: false`. |
| Button turns red with "Mistral rejected the API key" | The model, provider or `MISTRAL_API_KEY` key is missing or wrong. **Admin → Models → Test** on the TTS model checks it. |
| "Read aloud is not configured" | `speech.tts.enabled` is off or `speech.tts.defaultModelId` is empty. |
| Audio stops early on very long answers | The answer is longer than `speech.tts.maxCharacters`. |
