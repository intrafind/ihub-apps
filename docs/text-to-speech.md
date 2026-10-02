# Read Aloud (Text-to-Speech)

Read aloud puts a **play button** on every chat message. Clicking it sends the
message to a text-to-speech (TTS) model, and the audio starts playing while the
model is still generating it. That is usually within a second, however long the
answer is.

Two providers are supported: [Mistral Voxtral TTS](https://mistral.ai/news/voxtral-tts/)
(`voxtral-mini-tts-latest`) and Google's
[Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation) (`gemini-3.8-flash-tts`,
and the faster, cheaper `gemini-3.8-flash-lite-tts`).

## Using it

- The play button sits in a message's action row, next to copy and download.
  It appears on assistant answers and on your own messages once they are
  complete. It does not appear while an answer is still streaming.
- **Play** starts reading. While the message is playing the button turns into
  **pause**. Click it again to pause, and once more to resume from the same
  spot. **Stop** (the square next to it) ends playback.
- Only one message plays at a time. Starting another message stops the current
  one, and so does leaving the chat.
- Playing one of the last five messages you listened to to the end replays it
  from memory, with no second request and no second charge. Only recordings of
  up to 10 minutes are kept; a longer message is requested again.
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

   For Google, the models `gemini-3.8-flash-tts.json` and
   `gemini-3.8-flash-lite-tts.json` ship the same way (migration `V149` adds
   them to existing installations). They use the Google key of the Gemini chat
   models: a key on the model, the `google` provider key, or `GOOGLE_API_KEY`.
2. **Switch it on.** Open **Admin → Voice Input → Read aloud
   (text-to-speech)**. Tick **Show a read-aloud button on chat messages**,
   choose the model and save. The **Test** field on the same page speaks a
   sentence with the selected model, so you can try a voice before saving.
3. **Permissions.** Users only see the button when their groups may use the
   TTS model (`permissions.models` in `groups.json`, or `*`).

To turn read aloud off for a single app, set `features.textToSpeech: false` in
the app's configuration.

## Voices

### Gemini voices

The Gemini TTS models have 30 prebuilt voices, such as `Kore` (the default),
`Puck`, `Charon`, `Leda` or `Zephyr`; the model editor suggests all of them.
**Every voice speaks every language** — Gemini detects the language from the
text, across more than 100 languages — so one voice usually suffices. The
**Voice** field also takes the id of a voice from Google's voice library or of
a voice you designed with Google (`voice_…`); iHub does not list or create
those, so the voice manager below is Mistral-only.

### Languages and accents (Voxtral)

Voxtral TTS speaks English, French, German, Spanish, Dutch, Portuguese,
Italian, Hindi and Arabic. **Every voice reads every one of these
languages**: the model takes the language from the text, and there is no
language setting. What a voice keeps is its accent. `en_paul_neutral` reads
German correctly, but with an American accent. For native-sounding speech,
give each language a voice recorded in it.

### Preset voices

Mistral ships 30 preset voices: English (US and British) and French, each in
several moods. There is **no German preset**. Some examples:

| Voice id | Language |
| --- | --- |
| `en_paul_neutral` (default) | English (US) |
| `en_paul_cheerful`, `en_paul_confident` | English (US) |
| `gb_jane_neutral`, `gb_oliver_neutral` | English (UK) |
| `fr_marie_neutral`, `fr_marie_happy` | French |

**Admin → Models → (your TTS model) → Show voices** lists all of them.

### A voice per language

On the TTS model, **Voices per language** sets the voice for messages in a
given language. For example, `de` uses your German voice and `fr` uses
`fr_marie_neutral`. A message in any other language uses the model's
**Voice**.

The language is detected from the message itself, not from the user's UI
language. An English answer in a German UI is read with the English voice.
The UI language decides only when the text is too short to tell, such as a
one-word reply. One message is always read with one voice.

## Using a custom voice

A custom voice is cloned from a single recording of a speaker. It is the way
to get a German voice, or the voice of a specific person.

> **Get consent first.** Only clone the voice of someone who agreed to it: an
> employee who said yes, or a voice actor licensed for it. iHub asks you to
> confirm this before it creates a voice.

### What makes a good sample

- 10–30 seconds of **one** person speaking naturally, in the language the
  voice will mostly read (at least 5 seconds).
- A quiet room, no music, no other voices, no echo. A headset or a decent USB
  microphone is better than a laptop microphone.
- Read a few varied sentences in the tone you want answers in.

### In iHub (recommended)

1. Open **Admin → Models**, then the TTS model (e.g. *Voxtral TTS (Read
   aloud)*). The model must be saved and have a Mistral API key. It does not
   have to be enabled yet.
2. Under **Create a custom voice**, enter a name (e.g. *Anna (German)*). Tick
   the language of the recording and, optionally, the gender.
3. Either click **Record with microphone**, speak, and click **Stop
   recording**, then listen to the preview. Or click **Upload audio file**
   and pick an audio file of up to 10 MB. WAV is the safest format; Mistral
   decides which other formats it accepts. A recording made here is always
   sent as WAV.
4. Tick the consent box and click **Create voice**. The voice is created in
   your Mistral account straight away.
5. Click **Use for German** (or **Use as voice** for every language). Then
   **save the model**.
6. Check it: on **Admin → Voice Input → Read aloud**, type a German sentence
   into **Test** and play it.

**Show voices** lists your custom voices next to the presets. **Delete**
removes a custom voice from the Mistral account. Delete it from the models
that use it first, or those models can no longer speak with it.

### With the Mistral API

The same works without iHub. Create the voice from a sample file:

```bash
curl https://api.mistral.ai/v1/audio/voices \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Anna (German)\",
       \"sample_audio\": \"$(base64 -w0 anna.wav)\",
       \"sample_filename\": \"anna.wav\",
       \"languages\": [\"de\"],
       \"gender\": \"female\"}"
```

The answer contains the voice's `id` (a UUID). Put it into the model's
**Voice** or **Voices per language** field, or into `tts.voice` /
`tts.voices` in the model file. `GET /v1/audio/voices?type=custom` lists your
voices, and `DELETE /v1/audio/voices/<id>` deletes one. See Mistral's
[voices documentation](https://docs.mistral.ai/studio/audio/text_to_speech/voices).

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
  "tts": {
    "voice": "en_paul_neutral",
    "voices": {
      "de": "01a0f7a6-649d-732a-a05e-08d06a84cc42",
      "fr": "fr_marie_neutral"
    }
  },
  "enabled": true
}
```

| Field | Meaning |
| --- | --- |
| `modelType` | `"tts"` marks a text-to-speech model. TTS models never show up in the chat model selector and are never picked as the default chat model. |
| `provider` | `"mistral"` or `"google"`. A TTS model on any other provider fails validation. |
| `url` | Optional. The speech endpoint; it stays on the server. Mistral: leave it out to use `https://api.mistral.ai/v1/audio/speech`. Google: the model's `…/models/<model>:streamGenerateContent` URL, or the API base, under which `models/<modelId>` is used; iHub always streams with `?alt=sse`. |
| `modelId` | Required. The provider's model id: `voxtral-mini-tts-latest`, `gemini-3.8-flash-tts` or `gemini-3.8-flash-lite-tts`. |
| `tts.voice` | The voice id. Empty uses `en_paul_neutral` (Mistral) or `Kore` (Google). |
| `tts.voices` | Optional. A voice id per language (`en`, `de`, `fr`, `es`, `it`, `nl`, `pt`, `hi`, `ar`), used for messages written in that language. |
| `apiKey` | Optional. Stored encrypted. Without one, the provider key (`mistral` / `google`) or `MISTRAL_API_KEY` / `GOOGLE_API_KEY` is used. Google keys are sent in the `x-goog-api-key` header, never in the URL. |

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

- **Endpoint.** `POST /api/voice/speech` with
  `{ "text": "…", "modelId"?: "…", "language"?: "de" }` answers with raw
  16-bit little-endian mono PCM. The response headers describe the format:
  `X-Audio-Encoding: pcm_s16le`, `X-Audio-Sample-Rate: 24000` and
  `X-Audio-Channels: 1`. `X-Speech-Language` names the language the voice
  was chosen for. Without a `modelId` the platform default is used, and only
  while read aloud is switched on. With a `modelId`, any enabled TTS model
  the user may use is accepted. `language` is the UI language and only
  counts when the text is too short to tell.
- **Voices (admin).** `GET`/`POST /api/admin/models/:id/tts/voices` lists the
  provider's voices and creates a custom one
  (`{ name, audio: <base64>, filename, languages, gender }`).
  `DELETE /api/admin/models/:id/tts/voices/:voiceId` deletes a custom voice.
  All three use the model's stored key, and creating and deleting are
  recorded in the audit log.
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
  (`rateLimit.inferenceApi`). A replay of one of the last five finished
  messages plays from memory, if its audio is at most 10 minutes long (about
  29 MB; 64 MB for all five together).
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
A provider exports `sampleRate`, `resolveUpstream(model, { language })` and
`synthesize({ cfg, text, signal, onAudio })`. `resolveUpstream` picks the
voice for the message's language. `synthesize` streams 16-bit mono PCM at
`sampleRate` to `onAudio`, waiting for each call to return. The provider id
must also be listed in `TTS_PROVIDERS`
(`server/validators/modelConfigSchema.js`). The browser player stays the same
for every provider.

A provider that manages voices also exports `listVoices(cfg)`,
`createVoice(cfg, { name, audio, filename, languages, gender })` and
`deleteVoice(cfg, voiceId)`. They back the admin voice routes. The model
editor shows the voices panel for Mistral models only (`ModelFormEditor.jsx`),
so a new provider with voices needs adding there too.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No play button | Read aloud is switched off, no model is chosen, the model is disabled, the user's groups may not use the model, or the app sets `features.textToSpeech: false`. |
| Button turns red with "Mistral rejected the API key" | The model, provider or `MISTRAL_API_KEY` key is missing or wrong. **Admin → Models → Test** on the TTS model checks it. |
| "Read aloud is not configured" | `speech.tts.enabled` is off or `speech.tts.defaultModelId` is empty. |
| Audio stops early on very long answers | The answer is longer than `speech.tts.maxCharacters`. |
| German is read with an English accent | No German voice is set. Create a custom voice and use it for German (see [Using a custom voice](#using-a-custom-voice)). |
| The wrong language voice is used | The message is too short or mixes languages. The UI language decides then. `X-Speech-Language` on the `/api/voice/speech` response shows what was chosen. |
| "Could not create the voice" | Mistral rejected the sample, for example because it was too short or too noisy. Its message is shown next to the button. |
