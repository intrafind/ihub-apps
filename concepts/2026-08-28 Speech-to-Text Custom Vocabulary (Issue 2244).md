# Speech-to-Text Custom Vocabulary / Context Biasing

**Issue:** [#2244](https://github.com/intrafind/ihub-apps/issues/2244)
**Builds on:** #1913 (realtime dictation via self-hosted vLLM/Voxtral), #1927 (Voxtral as a
first-class transcription model)
**Status:** Implemented.

## Problem

A general-purpose speech model fails on exactly the words that carry the most meaning in an
enterprise transcript: product names, internal abbreviations, domain jargon, customer and
employee names. "Voxtral" comes back as "Vox Trawl", "Teilkasko" as "Teil Kasko". The audio is
fine and the model is fine — it simply has no reason to prefer a spelling it has rarely seen.

The fix is **context biasing** (also called custom vocabulary): hand the decoder a list of terms
and raise the likelihood of the token sequences that spell them.

## Options considered

The issue describes two mechanisms available on a vLLM-served Voxtral deployment.

| Option | How | Why not / why yes |
| --- | --- | --- |
| **`logit_bias` (token level)** | Tokenize each term in the client, then bias the resulting token ids. | Rejected. It requires the model's tokenizer server-side in iHub — a Python/HF dependency iHub does not have, pinned to the exact upstream model. Biasing individual token ids also biases every word that shares those tokens. |
| **`context_biasing` (word level)** | Send the words; the upstream tokenizes and biases the sequences. | **Chosen.** No tokenizer dependency, the upstream owns the model-specific part, and the payload is readable in a log or a config file. |

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
{ "enabled": true, "terms": ["Voxtral", "Teilkasko"], "biasScore": 3 }
```

**Merged, not overridden.** Term lists are unioned least-to-most specific — an app that sets a
vocabulary must not silently lose the company names configured platform-wide. The bias score is
the exception: the most specific layer that *explicitly* sets one wins, so a single app can turn
the pressure up without touching the platform. A layer that only lists terms inherits the score
already in effect.

**`enabled` defaults to true.** A block that lists terms is meant to be used; requiring a second
opt-in flag is the kind of trap where hand-edited config silently does nothing. `enabled: false`
is the temporary off switch, and a disabled layer contributes neither terms nor a bias score.

### Opt-in on the wire

`context_biasing` is added to `session.update` **only** when at least one term resolves. This is
the property that makes the change safe to ship: a vLLM build without biasing support may reject
an unknown session field, and an installation that configures nothing keeps sending byte-identical
frames. The migration therefore seeds an **empty** term list rather than examples.

The admin **Test connection** button sends the same payload a real session would, so an endpoint
that rejects the field is discovered in the admin UI rather than mid-dictation.

### Terms stay server-side

The browser sends a model id and an app id; it never sends terms. The server resolves the app
layer from config and applies it only when the user is permitted to use that app — a mismatch
degrades transcription quality rather than failing the session, so an unpermitted app id is
ignored silently. `GET /api/models` strips `vocabulary` from transcription models alongside `url`
and `apiKey`: a term list can name customers or staff, and the browser has no use for it. For the
same reason the bridge logs the term *count*, never the terms.

## Implementation map

| Concern | File |
| --- | --- |
| Normalize / merge / render payload | `shared/speechVocabulary.js` |
| Shared Zod fragment | `server/validators/common.js` |
| Config schemas | `modelConfigSchema.js`, `platformConfigSchema.js`, `appConfigSchema.js` |
| Layer resolution + `session.update` | `server/websocket/realtimeTranscription.js` |
| Model-level terms surfaced to the bridge | `server/transcription/vllmRealtimeProvider.js` |
| Public API sanitization | `server/routes/modelRoutes.js` |
| Connection test | `server/routes/admin/configs.js` |
| Platform defaults | `server/migrations/V084__add_speech_vocabulary.js` |
| Admin UI (all three levels) | `client/src/features/admin/components/SpeechVocabularyEditor.jsx` |
| `appId` on the start frame | `transcribeAudioBuffer.js`, `vllmRealtimeRecognitionService.js`, `AppChat.jsx`, `useVoiceRecognition.js` |

Limits: 250 terms merged, 80 characters per term, bias score `0`–`10` (default `3`). Terms are
deduped **case-sensitively** — `SAP` and `Sap` are different token sequences to the model.

## Deliberately out of scope

- **Automatic leading-space variants.** Tokenizers distinguish `"Voxtral"` from `" Voxtral"`, and
  the issue suggests listing both. Auto-expanding would silently double every list against a
  guess about the upstream tokenizer; the docs describe the manual option instead.
- **A free-text biasing prompt.** OpenAI-style `prompt` biasing is a different mechanism with
  different failure modes. Nothing asked for it, and it would need its own upstream support.
- **Per-user or per-conversation vocabulary.** No requirement yet, and it would move term lists
  out of admin-controlled config into user input.
