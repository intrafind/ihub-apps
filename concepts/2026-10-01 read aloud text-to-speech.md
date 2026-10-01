# Read Aloud (Text-to-Speech) — Plan and Decisions

Issue: [#2642](https://github.com/intrafind/ihub-apps/issues/2642), step 1 of
[#2243](https://github.com/intrafind/ihub-apps/issues/2243).
User documentation: `docs/text-to-speech.md`.

## Goal

A play button behind every chat message. It reads the message aloud with a configured TTS
model, streams the audio, pauses and resumes, and stops. Mistral Voxtral TTS is the first
provider.

## Provider facts (measured against the Mistral API, 2026-10-01)

- `POST https://api.mistral.ai/v1/audio/speech` with
  `{ model, input, voice_id, response_format, stream: true }`. Models are
  `voxtral-mini-tts-2603` and `voxtral-mini-tts-latest`.
- A streamed request answers with SSE: `speech.audio.delta` events carry base64 `audio_data`, and
  a final `speech.audio.done` event carries `usage`.
- `pcm` is float32 LE, 24 kHz, mono. `wav` is 16-bit, 24 kHz. `mp3`, `opus` and `flac` are also
  available.
- Time to first audio was 0.5–1.9 s and **did not depend on input length**. A 200-character and a
  1,500-character input started equally fast.
- Generation runs about 7–10× faster than real time: 1,440 characters became 88 s of audio in
  12.6 s.
- 30 preset voices (`GET /v1/audio/voices`) in en_us, en_gb and fr_fr, each in several moods. The
  default here is `en_paul_neutral`.
- Mistral recommends about 300 words per request.

## Decisions

1. **The model type is `tts`, configured like transcription.** It is a first-class model file, so
   it gets the same key handling (model key → `mistral` provider key → `MISTRAL_API_KEY`),
   permissions, enable/disable and admin test. The voice is `tts.voice` on the model. One model
   per voice keeps the configuration flat; a per-language voice map is a follow-up.
2. **Server proxy, never browser → provider.** `POST /api/voice/speech` resolves the model,
   checks permissions, strips Markdown and streams. The key and URL stay on the server.
3. **Canonical wire format: 16-bit PCM, chunked HTTP.** The server converts Mistral's float32
   `pcm`, which also halves the bytes, and states the rate in `X-Audio-Sample-Rate`. Every future
   provider emits the same format (OpenAI's `pcm` already is), so the browser player never
   changes. MSE + MP3 was rejected: Firefox/Safari support differs, container framing is
   needed, and first audio takes ~3 s for `mp3` against ~0.8 s for `pcm`. A two-step "create job,
   then GET `<audio src>`" flow was rejected too: it needs server state, which breaks on
   multi-node deployments.
4. **Web Audio scheduling in the browser.** Each arriving piece becomes an `AudioBuffer`
   scheduled right after the previous one, so playback is gap-free. Pause and resume use
   `AudioContext.suspend()` and `resume()`. Stop aborts the fetch, and the server aborts the
   provider request on `res.close`. Only about 15 s are decoded ahead; the rest waits as 16-bit
   bytes (about 48 KB/s), so a 20-minute answer does not hold 230 MB of decoded buffers.
5. **Chunking on the server.** The speakable text is split at paragraph, then sentence, then word
   boundaries into pieces of at most 1,500 characters. The pieces are synthesized one after
   another into one stream. Because generation outruns playback, the next piece is buffered long
   before it is needed. There is no special short first piece, because time to first audio does
   not depend on length.
6. **Markdown → speech on the server** (`server/tts/speechText.js`), so every client gets the
   same result. Code, images, URLs, citations, footnotes and `<think>` blocks are dropped. Tables
   are read row by row, and headings and list items become sentences.
7. **One playback per page** (`client/src/features/voice/utils/readAloud.js`, a
   `useSyncExternalStore` store). Only the message being played re-renders. The last five
   finished recordings, up to 64 MB, replay without a request, which saves cost when a user
   listens twice.
8. **Gating.** `platform.speech.tts.enabled` and `defaultModelId` turn it on, the user must be
   allowed the model (the client checks `GET /api/models?type=tts`), and an app can opt out with
   `features.textToSpeech: false`. An explicit `modelId` in the API works for any enabled,
   permitted TTS model, the same rule chat models follow. The admin test uses it before saving.
9. **Non-chat models stay out of chat.** `filterModelsForApp`, the default-model fallback in
   `modelsLoader`, `LLMClient.resolveModel` and `/api/models/:id` now accept chat models only.
   Before, only `/api/models` filtered by type.

## Limits and costs

- `speech.tts.maxCharacters` (default 20,000) caps one message after Markdown is stripped. At
  $0.016 per 1,000 characters that is at most about $0.32 per play.
- `/api/voice/speech` sits behind the inference rate limiter.

## Follow-ups

- More providers: OpenAI-compatible `/v1/audio/speech` (OpenAI, self-hosted Voxtral via
  vLLM-Omni), Google, Azure.
- A voice per language (the answer's language → voice), and per-app model and voice overrides.
- Usage tracking: Mistral returns `usage` on `speech.audio.done`.
- Step 2 of #2243: a voice conversation (STT → LLM → TTS, with automatic playback).
