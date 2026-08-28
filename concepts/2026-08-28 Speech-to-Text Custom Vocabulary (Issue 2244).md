# Speech-to-Text Custom Vocabulary (Hotwords)

**Issue:** [#2244](https://github.com/intrafind/ihub-apps/issues/2244)
**Builds on:** #1913 (realtime dictation via self-hosted vLLM/Voxtral), #1927 (Voxtral as a
first-class transcription model)
**Status:** Implemented, with a verified upstream caveat — see
[What the upstream actually supports](#what-the-upstream-actually-supports).

## Problem

A general-purpose speech model fails on exactly the words that carry the most meaning in an
enterprise transcript: product names, internal abbreviations, domain jargon, customer and
employee names. "Voxtral" comes back as "Vox Trawl", "Teilkasko" as "Teil Kasko". The audio is
fine and the model is fine — it simply has no reason to prefer a spelling it has rarely seen.

The fix is a **custom vocabulary**: hand the decoder a list of terms to pay extra attention to.
Which mechanism delivers that list, and whether the target endpoint honours it, turned out to be
the whole question — see below.

## What the upstream actually supports

The issue proposed `context_biasing: { words, bias_score }` via `extra_body`. **That shape does
not exist in vLLM.** Verified against `vllm-project/vllm` @ `94a54f5`:

| Path | Endpoint | Biasing field | Reaches Voxtral? |
| --- | --- | --- | --- |
| Realtime | `WS /v1/realtime` | **None.** `SessionUpdate` is `{type, model}` (`entrypoints/speech_to_text/realtime/protocol.py`), the handler reads only `event.get("model")`, and `transcribe_realtime()` calls `buffer_realtime_audio(audio_stream, input_stream, model_config)` — it never builds `SpeechToTextParams` at all. Sampling params are hardcoded (`temperature=0.0`), so there is no `logit_bias` hook either. | No |
| Batch | `POST /v1/audio/transcriptions` | `hotwords: str \| None` on `TranscriptionRequest`, carried through `SpeechToTextParams.hotwords`. | **No** — the only consumer is FunASR (`model_executor/models/funasr.py`, which interpolates it into a 热词列表 prompt). Voxtral's `get_generation_prompt` reads `audio`, `stt_config`, `model_config` and `language` only. |

`context_biasing` with ~100 phrases is real, but it belongs to Mistral's **hosted** Voxtral
Transcribe 2 API — a different product from the open-weights realtime model served by vLLM. The
issue's source conflated the two.

### What this means for the implementation

- The wire field is **`hotwords`** — vLLM's own name and shape (a single string), not an invented
  object. If and when vLLM plumbs speech-to-text params into a realtime session, iHub is already
  speaking the right vocabulary.
- **There is no per-term weight.** `bias_score` came from the hosted API's shape; vLLM has no
  equivalent, so exposing a "bias strength" knob would be a control that maps to nothing. Dropped.
- **On a stock vLLM realtime endpoint the list has no effect today.** That limitation is stated in
  the docs, in the admin UI, and in the changelog rather than being papered over. It is the open
  question for the PR: ship the plumbing now, or hold it until an endpoint applies it.

Rejected alternatives:

| Option | Why not |
| --- | --- |
| `logit_bias` (token level) | Requires the model's tokenizer inside iHub — a Python/HF dependency pinned to the exact upstream model — and biasing raw token ids also biases every other word sharing those tokens. The realtime path hardcodes its `SamplingParams` regardless, so there is nowhere to put it. |
| Route transcription through the batch `/v1/audio/transcriptions` endpoint to reach `hotwords` | A much larger change (a second transcription transport, losing the streaming deltas the chat UI renders) that still would not help, because Voxtral ignores `hotwords` there too. |

The realtime bridge already owns the vLLM wire protocol (`server/transcription/index.js` states
this boundary explicitly), so the payload is built there rather than in a provider adapter.

## Design

### Three configuration layers, merged

| Layer | Location | Intent |
| --- | --- | --- |
| Platform | `platform.speech.realtime.vocabulary` | Organization-wide terms. Applies to every session — dictation and model-based transcription alike. |
| Model | `<transcription model>.vocabulary` | Terms tied to one speech backend. |
| App | `<app>.transcription.vocabulary` | One app's subject area. Also applies to dictation inside that app. |

All three store the identical shape, so one Zod fragment
(`server/validators/common.js` → `speechVocabularySchema`) and one admin component
(`SpeechVocabularyEditor.jsx`) serve all of them:

```json
{ "enabled": true, "terms": ["Voxtral", "Teilkasko"] }
```

**Merged, not overridden.** Term lists are unioned least-to-most specific — an app that sets a
vocabulary must not silently lose the company names configured platform-wide.

**`enabled` defaults to true.** A block that lists terms is meant to be used; requiring a second
opt-in flag is the kind of trap where hand-edited config silently does nothing. `enabled: false`
is the temporary off switch.

### Opt-in on the wire

`hotwords` is added to `session.update` **only** when at least one term resolves, so an
installation that configures nothing keeps sending byte-identical frames. The migration therefore
seeds an **empty** term list rather than examples.

The admin **Test connection** button sends the same `session.update` a real session would. It no
longer resolves on the first frame: vLLM emits `session.created` on connect, *before* reading the
update, so declaring success there would race past any error the update provokes. The probe now
waits a short window after sending the update and reports success only if nothing rejected it.

### Terms stay server-side

The browser sends a model id and an app id; it never sends terms. The server resolves the app
layer from config and applies it only when the user is permitted to use that app — a mismatch
degrades transcription quality rather than failing the session, so an unpermitted app id is
ignored silently. `GET /api/models` strips `vocabulary` from transcription models alongside `url`
and `apiKey`, and `sanitizeAppForPublic` strips `transcription.vocabulary` from `/api/apps` and
`/api/apps/:appId`: a term list can name customers or staff, and the browser has no use for it.
For the same reason the bridge logs only *whether* hotwords were sent, never the terms. The
browser-supplied `appId` goes through the shared `isValidId` gate before any lookup.

## Implementation map

| Concern | File |
| --- | --- |
| Normalize / merge / render `hotwords` | `shared/speechVocabulary.js` |
| Shared Zod fragment | `server/validators/common.js` |
| Config schemas | `modelConfigSchema.js`, `platformConfigSchema.js`, `appConfigSchema.js` |
| Layer resolution + `session.update` | `server/websocket/realtimeTranscription.js` |
| Model-level terms surfaced to the bridge | `server/transcription/vllmRealtimeProvider.js` |
| Public API sanitization | `server/routes/modelRoutes.js`, `server/utils/publicApp.js` |
| Connection test | `server/routes/admin/configs.js` |
| Platform defaults | `server/migrations/V084__add_speech_vocabulary.js` |
| Admin UI (all three levels) | `client/src/features/admin/components/SpeechVocabularyEditor.jsx` |
| `appId` on the start frame | `transcribeAudioBuffer.js`, `vllmRealtimeRecognitionService.js`, `AppChat.jsx`, `useVoiceRecognition.js` |

Limits: 250 terms merged, 80 characters per term. Terms are deduped **case-sensitively**, and a
comma inside a term is folded to a space so it cannot split the joined string on the wire.

## Deliberately out of scope

- **Leading-space term variants.** The issue suggests listing both `"Voxtral"` and `" Voxtral"`
  because tokenizers distinguish them. That advice belongs to the token-level `logit_bias`
  approach; it does not survive a comma-joined `hotwords` string, and terms are trimmed at every
  layer. Dropped from the design and from the docs rather than half-promised.
- **A free-text biasing prompt.** OpenAI-style `prompt` biasing is a different mechanism with
  different failure modes. Nothing asked for it, and it would need its own upstream support.
- **Per-user or per-conversation vocabulary.** No requirement yet, and it would move term lists
  out of admin-controlled config into user input.
