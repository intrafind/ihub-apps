# Voxtral as a Transcription Model — Finalized Implementation Plan

**Issue:** [#1927](https://github.com/intrafind/ihub-apps/issues/1927)
**Builds on:** #1913 (realtime dictation via self-hosted vLLM/Voxtral)
**Status:** Finalized plan — verified against the codebase on 2026-07-09. Supersedes the draft
plan posted as an issue comment; see [Changes from the draft plan](#changes-from-the-draft-plan)
for what this review added or corrected.

## Goal

Let users transcribe a complete audio buffer — from an **uploaded audio file**, an **uploaded
video** (audio track extracted client-side), or a **browser recording** — through a self-hosted
**Voxtral transcription model** and render the transcript as an **assistant chat turn**
(streaming deltas), instead of dropping text into the input field. Transcription is modeled as a
**first-class `modelType: "transcription"` model** (maintainer decision on issue OQ#1) so other
STT backends can plug in later; dictation (#1913) keeps working unchanged on
`platform.speech.realtime`.

---

## Verified codebase findings

Every claim below was checked against the current `main` (d632e9a).

### Reusable end-to-end

| Component | Location | Verified state |
| --- | --- | --- |
| Realtime WS proxy | `server/websocket/realtimeTranscription.js` | Authenticated same-origin WS at `/api/voice/realtime`; lazy upstream open on first audio frame; speaks the vLLM realtime protocol (`session.update` → `input_audio_buffer.append/commit` → `transcription.delta/done`); relays `delta`/`final`; connection caps (50 total / 3 per user), 60 s idle timeout, 15 s no-audio grace, 256 KB `maxPayload`. Upstream comes only from `platform.speech.realtime` (`getRealtimeConfig()`, L215). |
| Client capture service | `client/src/utils/vllmRealtimeRecognitionService.js` | Mic-only (`getUserMedia`); AudioWorklet capture, `downsample()` + `floatTo16BitPCM()` helpers (L364–387); reassembles multiple `final` segments into committed text — the reassembly logic already handles multi-utterance sessions. |
| Video → audio extraction | `client/src/features/upload/utils/fileProcessing.js` → `extractAudioFromVideo()` (L299) | Decodes the video's audio track and renders WAV/PCM16 base64 client-side. **But not at 16 kHz mono — see gap G4.** |
| Unified upload picker | `client/src/features/upload/components/UnifiedUploader.jsx` | `processAudio` (L300) base64-reads audio; `processVideo` (L330) already calls `extractAudioFromVideo()` and returns a WAV selected-file with `extractedFromVideo`, `sampleRate`, `channels`, `duration` metadata. |
| Chat message store | `client/src/features/chat/hooks/useChatMessages.js` | `addAssistantMessage` (L227), `updateAssistantMessage` (L249), `appendToAssistantMessage` (L300). Messages persist in **sessionStorage**, so a locally-fabricated assistant turn survives reloads like any other message, and `getMessagesForApi()` (L499) includes it in follow-up history. |
| Dictation model selection | `server/validators/appConfigSchema.js` `settings.speechRecognition.service` | Enum already includes `'vllm-realtime'` — dictation stays on this path, untouched. |
| Test harness | `server/tests/realtimeTranscription.test.js` | Pure-function tests for the WS proxy exist; new logic follows the same style. |

### Latent gaps confirmed from the draft plan

- **`upload.videoUpload` is silently stripped by the app schema.** `uploadSchema`
  (`server/validators/appConfigSchema.js` L134–192) has only image/audio/file/cloudStorage
  blocks; nested Zod objects strip unknown keys, and `resourceLoader.js` (~L372) applies the
  parsed result. The client fully supports `videoUpload` (`useFileUploadHandler.js` L40, L89,
  L135–144) but config-driven video never reaches it.
- **Audio *and video* upload are double-gated on `selectedModel?.supportsAudio === true`**
  (`client/src/shared/hooks/useFileUploadHandler.js` L85–89: `audioUploadEnabled` L88 and
  `videoUploadEnabled` L89). Correct for the multimodal path; wrong when a transcription model
  handles the audio — the gate must be bypassed for transcription-enabled apps.
- **`useAppChat.js` does not re-export the assistant-message mutators** (return list at the end
  of the hook) — they must be surfaced to `AppChat.jsx`.
- **Migration numbering:** highest applied is `V072` → the new migration is `V073`.
- **`docs/releases/5.5.0/` exists** — changelog entry goes there.

### New gaps found in this finalization review

These are **not** in the draft plan and materially change the implementation:

- **G1 — Model schema rejects WebSocket URLs.** `modelConfigSchema.js` `url` refine (L84–88)
  only allows `http://`, `https://`, or `${ENV}` — the transcription model's `ws://…/v1/realtime`
  URL would **fail validation**. The refine must also accept `ws://`/`wss://` (either generally
  or conditionally for `modelType: 'transcription'`).
- **G2 — `GET /api/models` returns models unsanitized.** `configCache.getModelsForUser()`
  (L1618) only permission-filters; `modelRoutes.js` sends the result as-is. A transcription
  model's internal vLLM `url` and encrypted `apiKey` blob would reach every browser — directly
  violating the acceptance criterion *"the vLLM URL/API key never reach the browser."*
  Fix: sanitize the public models response — strip `apiKey` for **all** models (closes a
  pre-existing ciphertext leak for per-model keys) and strip `url` for transcription models.
- **G3 — Pre-`ready` frames are silently dropped; no backpressure.** The proxy buffers at most
  `MAX_PENDING_FRAMES = 250` frames (~1 MB ≈ 30 s of 16 kHz PCM16) while the upstream socket
  connects and **silently drops the rest**. The dictation client never waits for
  `{type:'ready'}` (harmless at mic speed, fatal when blasting a file). The buffer-streaming
  client MUST wait for `ready` before sending bulk audio and pace itself via
  `ws.bufferedAmount` so neither the browser socket nor the server→upstream socket buffers
  unbounded memory.
- **G4 — `extractAudioFromVideo()` does *not* output 16 kHz mono.** It renders through
  `OfflineAudioContext(numberOfChannels, length, sampleRate)` — i.e. the **original** rate
  (44.1/48 kHz) and channel count. The issue text's claim that it "already produces the right
  sample format" is wrong. Every source (uploaded audio, extracted video audio, recording)
  needs an explicit downmix-to-mono + resample-to-16 kHz step. Cleanest: render through
  `OfflineAudioContext(1, Math.ceil(duration * 16000), 16000)` which does both natively.
- **G5 — WS upgrade auth has no groups/permissions.** `authenticateUpgrade()` builds a minimal
  `{id, name}` user. Enforcing model permissions requires extracting `groups` from the JWT
  (the token payload carries them — `tokenService.js` L116) and running
  `enhanceUserWithPermissions()` — same as HTTP routes do.
- **G6 — Upgrade-time 503 pre-check is platform-only.** The upgrade handler rejects with 503
  when `platform.speech.realtime` is missing/disabled. With model-based transcription the check
  becomes: *platform realtime enabled OR ≥1 enabled `transcription` model exists*.
- **G7 — Upstream resolution happens at connect time.** `bridgeConnection()` resolves config
  immediately; model-based resolution must defer to the `{type:'start'}` frame (which will now
  carry `modelId`) so unknown-model / no-permission errors can be answered with a
  `{type:'error'}` frame before any audio flows.
- **G8 — End-of-transcription is ambiguous for files.** vLLM may emit multiple
  `transcription.done` segments mid-stream; the dictation client just waits 1.5 s after `stop`
  and closes — wrong for a file whose tail is still being processed. Extend the server protocol:
  after the client's `stop`, when the upstream delivers the next `transcription.done`, relay
  `{type:'final'}` **followed by `{type:'done'}`** and close the bridge cleanly. The client
  treats `done` (or socket close) as completion, with a generous overall timeout.
- **G9 — Transcription models must not leak into chat-model consumers.** `/api/models` feeds
  the chat `ModelSelector`, magic prompt, compare mode, workflows, and the default-model
  fallback. Filtering **server-side** (public `/api/models` returns `modelType === 'chat'`
  unless `?type=transcription` is requested) fixes all consumers at once, instead of patching
  each client component.
- **G10 — Browser codec support constrains client-side decode.** The multimodal
  `audioUpload.supportedFormats` default includes FLAC/OGG because the provider decodes
  server-side. `AudioContext.decodeAudioData` support varies (e.g. Safari lacks OGG). Decode
  failures must surface a clear per-format error, and docs must state that transcription
  decoding happens in the browser.
- **G11 — No usage tracking.** Transcription bypasses the chat pipeline, so no usage events are
  emitted. MVP decision: structured server-side logging only (connection open/close, model id,
  audio seconds); usage-event integration is follow-up work.
- **G12 — i18n.** All new UI strings need keys in `shared/i18n/en.json` and `de.json`.

---

## Design decisions (issue open questions resolved)

| # | Question | Decision |
| --- | --- | --- |
| OQ1 | How is Voxtral transcription selected? | **First-class `modelType: "transcription"` model** in `contents/models/` (maintainer direction). Credentials/URL live on the model; `platform.speech.realtime` remains the dictation backend and the no-`modelId` fallback. |
| OQ2 | Client vs. server decode/stream | **Client-side decode + stream over the existing WS** for MVP. Keeps all guards, no new upstream integration, no server-side ffmpeg/decode dependency. A server-side REST path for very long files / non-browser clients is deliberate follow-up. |
| OQ3 | Streaming vs. final-only | **Stream deltas** into the assistant bubble (`appendToAssistantMessage`), finalize with `updateAssistantMessage(id, full, false)`. |
| OQ4 | Length/size limits | Reuse per-app `audioUpload.maxFileSizeMB` / `videoUpload.maxFileSizeMB`; add `transcription.maxDurationSeconds` (default **900**) enforced client-side after decode (duration is known) and for recordings via a live timer. Connection caps/idle timers unchanged. |
| OQ5 | Relationship to multimodal `audioUpload` | **Coexist.** A dedicated `transcription` app-config block; when enabled, audio/video submissions route to Voxtral, otherwise the multimodal path applies. Both never fire for the same submission. |
| — | Endpoint | **Reuse `/api/voice/realtime`** with `modelId` on the `start` frame. All guards (origin check, auth, caps, timeouts, maxPayload) are inherited. A raw upstream URL is **never** accepted from the client — only a server-resolved model id. |
| — | Dictation convergence | Out of scope. `platform.speech.realtime` stays; convergence (dictation selecting a transcription model) is a possible follow-up. |
| — | Permissions | Transcription models get the same group-permission filtering as chat models (requires G5). |
| — | Chat history semantics | The flow adds a **user turn** carrying only text (`🎙 filename.mp3` context, no `audioData`) and an assistant turn with the transcript. Follow-up questions therefore never ship raw audio to a non-audio chat model (`getMessagesForApi` strips nothing else). |

---

## Implementation plan

### Phase 1 — Server foundation

1. **`server/validators/modelConfigSchema.js`**
   - Add `modelType: z.enum(['chat', 'transcription']).default('chat')` (existing models
     parse unchanged — no migration needed for the field itself).
   - Extend the provider enum with `'vllm-realtime'` (transcription-only provider).
   - Relax the `url` refine to accept `ws://` / `wss://` (G1).
   - Cross-field refine: `provider: 'vllm-realtime'` requires `modelType: 'transcription'`.
2. **Transcription provider registry** — new `server/transcription/index.js` +
   `server/transcription/vllmRealtimeProvider.js`. Deliberately parallel to (not part of)
   `server/adapters/` — that registry is chat-only (`getAdapter()`/`createCompletionRequest`).
   The provider exposes `resolveUpstream(model)` → `{ url, apiKey (decrypted via
   tokenStorageService), modelId }`. The registry maps `provider → implementation` so Whisper/
   Azure-batch providers can be added later.
3. **Generalize `server/websocket/realtimeTranscription.js`**
   - `{type:'start'}` may carry `modelId`. New `resolveTranscriptionUpstream({ modelId, user })`:
     look up the model in `configCache.getModels()`, require `modelType === 'transcription'`
     && `enabled`, enforce the user's model permissions, then resolve via the provider
     registry. No `modelId` → existing `getRealtimeConfig()` fallback (dictation unchanged).
   - Defer upstream-config resolution from connect time to the `start` frame (G7); reply
     `{type:'error'}` for unknown/forbidden/disabled models.
   - Extend `authenticateUpgrade()` to carry `groups` from the JWT and enhance permissions
     (G5). Anonymous users get anonymous-group permissions, same as HTTP.
   - Update the upgrade-time availability check to *platform realtime OR any enabled
     transcription model* (G6).
   - **Completion signaling (G8):** track that `stop` was received; when the next
     `transcription.done` arrives afterwards, send `{type:'final'}` then `{type:'done'}` and
     close the bridge. Dictation clients ignore the new frame type (their switch has a
     `default: break`), so this is backward-compatible.
4. **Sanitize the public models API (G2, G9)**
   - In `modelRoutes.js` (or a helper next to `getModelsForUser`): strip `apiKey` from every
     model in public responses; strip `url` from transcription models.
   - Public `GET /api/models` defaults to `modelType === 'chat'`; `?type=transcription`
     returns permitted transcription models (sanitized). Admin routes keep full access.
5. **Default model + migration**
   - `server/defaults/models/voxtral-mini-realtime.json`:
     `{ id, modelType: "transcription", provider: "vllm-realtime", modelId:
     "mistralai/Voxtral-Mini-4B-Realtime-2602", url: "ws://localhost:8080/v1/realtime",
     name/description (en/de), enabled: false }` (mirrors the `platform.speech.realtime`
     defaults).
   - `server/migrations/V073__seed_voxtral_transcription_model.js`: `addIfMissing`-seed the
     model file for existing installs; if `platform.speech.realtime` is configured, carry over
     `url`/`model`/`apiKey` (already encrypted at rest) into the seeded model for continuity.
6. **Admin model routes** (`server/routes/admin/models.js`): accept the new fields; the
   existing apiKey mask/encrypt handling applies as-is.

### Phase 2 — Client transcription core

7. **Extract a shared PCM/WS core** from `vllmRealtimeRecognitionService.js` (new
   `client/src/utils/realtimeTranscriptionCore.js`): WS framing, `downsample()`,
   `floatTo16BitPCM()`, delta/final reassembly. The dictation service keeps its public
   surface; both consume the core.
8. **Buffer-transcription client** (new `client/src/utils/transcribeAudioBuffer.js`):
   - Input: an `AudioBuffer` (any rate/channels) + `modelId` + callbacks
     `{ onDelta, onFinal, onError, onDone }`.
   - Downmix + resample to 16 kHz mono via `OfflineAudioContext(1, ceil(duration*16000),
     16000)` (G4).
   - Open the WS, send `{type:'start', modelId}`, **wait for `{type:'ready'}`** before
     streaming (G3), send PCM16 chunks (~32 KB, well under the 256 KB `maxPayload`) paced by
     `ws.bufferedAmount` (pause above a high-water mark), then `{type:'stop'}`; resolve on
     `{type:'done'}` or socket close, with an overall timeout.
9. **Decode utilities** (`fileProcessing.js`): add `decodeAudioFileToBuffer(file)`
   (`AudioContext.decodeAudioData` from the upload's base64/ArrayBuffer) with a distinct
   `audio-decode-error` for unsupported codecs (G10). Video keeps using
   `extractAudioFromVideo()` — its returned `audioBuffer` feeds step 8 directly (re-rendering
   to 16 kHz happens there).
10. **Recording**: reuse the AudioWorklet capture pipeline in a small recorder that accumulates
    Float32 frames into an `AudioBuffer` (VAD auto-stop disabled; explicit start/stop UI +
    elapsed timer + `maxDurationSeconds` cap), then hands the buffer to step 8.

### Phase 3 — Chat integration

11. **Expose mutators**: re-export `addAssistantMessage`, `updateAssistantMessage`,
    `appendToAssistantMessage` from `useAppChat.js`.
12. **`transcribeToChat({ source })` in `AppChat.jsx`**: add a text-only user turn
    (`🎙 meeting.mp4` / "Recording, 2:31"), add an assistant placeholder, stream deltas via
    `appendToAssistantMessage`, finalize with `updateAssistantMessage(id, transcript, false)`.
    On error: finalize the bubble with a localized error message. No `audioData` is stored on
    either message.
13. **Submit rerouting**: in the `AppChat` submit path, when `app.transcription.enabled` and
    the selected file is audio (or extracted-from-video audio), route to `transcribeToChat`
    instead of attaching `audioData` to the chat request.
14. **Record control**: add a record→transcribe action in `ChatInput.jsx` /
    `ChatInputActionsMenu.jsx`, visible when `app.transcription.enabled &&
    app.transcription.inputs.record` — distinct from the dictation mic
    (`VoiceInputComponent`).
15. **Gate fix**: in `useFileUploadHandler.createUploadConfig(app, selectedModel)`, treat
    `audioUploadEnabled`/`videoUploadEnabled` as enabled when the app has transcription
    configured, regardless of `selectedModel.supportsAudio` (covers both L88 and L89).

### Phase 4 — Configuration & admin UI

16. **`appConfigSchema.js`**
    - Add the missing `videoUpload` block to `uploadSchema`:
      `{ enabled, extractAudio (default true), maxFileSizeMB (default 50), supportedFormats
      (default mp4/webm/quicktime) }` — matching the client defaults already in
      `useFileUploadHandler.js` L135–144.
    - Add a `transcription` block:
      `{ enabled: false, modelId: string, inputs: { upload: true, record: true, video: true },
      streaming: true, maxDurationSeconds: 900 }`.
17. **App editor** (`AppFormEditor.jsx`): Transcription section (enable toggle, transcription-
    model picker fed by `GET /api/models?type=transcription`, input toggles, max duration) and
    the missing video-upload toggle.
18. **Admin model editor** (`AdminModelEditPage.jsx` / `AdminModelsPage.jsx`): `modelType`
    selector; for transcription models show url (ws://)/modelId/apiKey and hide chat-only
    fields (contextWindow, tokens, tools…); type badge in the list. Reuse the Voice-Input
    page's "Test connection" (`testRealtimeConnection`) for the model's endpoint.

### Phase 5 — Errors, i18n, docs, tests

19. **Errors** surfaced in the assistant bubble (localized): endpoint unreachable / rejected
    (upstream diagnostics already exist), model not permitted, decode failure (per-format,
    G10), file too large, duration cap exceeded, connection cap (429), WS `{type:'error'}`.
20. **i18n**: all new strings in `shared/i18n/en.json` + `de.json` (G12).
21. **Docs**: `docs/models.md` (transcription model type), `docs/microphone-feature.md`
    (dictation vs. transcription), `docs/audio-file-support.md` (Voxtral vs. multimodal paths,
    browser-decode format caveats), `docs/audio-extraction.md`; changelog entry via
    `/document-feature` under `docs/releases/5.5.0/`.
22. **Tests** (style of `server/tests/realtimeTranscription.test.js`):
    - `resolveTranscriptionUpstream`: model lookup, `modelType`/`enabled` enforcement,
      permission denial, platform fallback, decryption path.
    - Protocol: `stop` → post-stop `done` → `{type:'final'}` + `{type:'done'}` ordering.
    - Model schema: `modelType` default, ws:// URL acceptance, provider/modelType refine.
    - Public models sanitization: no `apiKey` anywhere, no `url` on transcription models,
      default chat-only filter.
    - Client core (pure functions): downmix/resample framing, chunk sizing ≤ maxPayload,
      bufferedAmount pacing state machine.
    - App schema: `videoUpload` and `transcription` blocks survive parsing.

---

## File map

| Area | Files |
| --- | --- |
| Model schema/type | `server/validators/modelConfigSchema.js`; `server/defaults/models/voxtral-mini-realtime.json` |
| Transcription providers | new `server/transcription/` (registry + vLLM realtime provider); `server/websocket/realtimeTranscription.js` |
| Models API sanitization | `server/routes/modelRoutes.js`, `server/configCache.js` (`getModelsForUser` helper) |
| Admin (server) | `server/routes/admin/models.js` |
| Migration | `server/migrations/V073__seed_voxtral_transcription_model.js` |
| Client transcription core | `client/src/utils/realtimeTranscriptionCore.js` (new), `client/src/utils/transcribeAudioBuffer.js` (new), `client/src/utils/vllmRealtimeRecognitionService.js` (refactor onto core) |
| Decode/record | `client/src/features/upload/utils/fileProcessing.js` |
| Chat rendering | `client/src/features/chat/hooks/useAppChat.js`, `client/src/features/apps/pages/AppChat.jsx` |
| Upload/record UI + gate | `client/src/features/upload/components/UnifiedUploader.jsx`, `client/src/features/chat/components/ChatInput.jsx`, `ChatInputActionsMenu.jsx`, `client/src/shared/hooks/useFileUploadHandler.js` |
| App config + editor | `server/validators/appConfigSchema.js`, `client/src/features/admin/components/AppFormEditor.jsx` |
| Admin model editor | `client/src/features/admin/pages/AdminModelEditPage.jsx`, `AdminModelsPage.jsx` |
| i18n | `shared/i18n/en.json`, `shared/i18n/de.json` |
| Docs | `docs/models.md`, `docs/microphone-feature.md`, `docs/audio-file-support.md`, `docs/audio-extraction.md`, `docs/releases/5.5.0/` |

## Acceptance criteria → plan mapping

| Criterion | Covered by |
| --- | --- |
| Upload audio → Voxtral transcript as chat answer | Phases 2–3 (steps 8–9, 12–13) |
| Upload video → extracted audio → transcript as chat answer | Steps 9, 13, 16 (`videoUpload` schema) |
| Record in browser → transcript as chat answer | Steps 10, 14 |
| Self-hosted endpoint; URL/key never reach the browser | Steps 3–4 (server-resolved `modelId` only; sanitized models API — G2) |
| Transcript is an assistant message, not input text | Steps 11–12 |
| Clear errors | Step 19 |
| Docs + changelog | Steps 20–21 |

## Out of scope (unchanged from issue)

Speaker diarization, timestamped/word-level transcripts, non-Voxtral batch providers,
server-side REST decode for very long files (explicit follow-up candidate), dictation
convergence onto transcription models, usage-event tracking for transcription (G11 — log-only
for MVP).

---

## Changes from the draft plan

The draft plan (issue comment of 2026-07-09) was verified claim-by-claim; all its findings
held. This finalization **adds** gaps G1–G12 above, of which the load-bearing ones are:

1. **G1** — the model schema would reject the ws:// URL the draft's default model file uses.
2. **G2** — without models-API sanitization, the design would violate the "URL/key never reach
   the browser" acceptance criterion.
3. **G3** — without wait-for-`ready` + backpressure, file streaming silently loses everything
   past ~30 s of audio.
4. **G4** — the issue's assumption that extracted audio is already 16 kHz mono is wrong; an
   explicit resample/downmix stage is required for all three sources.
5. **G5/G6/G7** — permission enforcement needs upgrade-auth enhancement, and both the 503
   pre-check and config-resolution timing must change.
6. **G8** — a `{type:'done'}` completion frame is added to the WS protocol; the dictation
   client's 1.5 s heuristic is not sound for files.
7. **G9** — chat-model consumers are protected server-side (default chat-only `/api/models`)
   rather than patching each client component.
