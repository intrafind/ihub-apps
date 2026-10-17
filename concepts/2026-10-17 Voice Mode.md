# Voice Mode — Spoken Conversation with an App

Issue: [#2243](https://github.com/intrafind/ihub-apps/issues/2243), step 2. Step 1 was read aloud
([#2642](https://github.com/intrafind/ihub-apps/issues/2642), see
`concepts/2026-10-01 read aloud text-to-speech.md`).

## Goal

A **voice mode button** in the chat input. Pressing it starts a hands-free conversation with the
app's model: the user speaks, the app answers out loud, the user speaks again — no typing and no
clicking between turns. The user can interrupt the answer by speaking. Ending voice mode returns to
the normal chat, and every turn is in the chat history as text.

Voice mode must keep everything an app is: its system prompt, its chat model, its tools, sources,
RAG, web search and permissions. It is a different way of talking to the same app, not a separate
product.

---

## 1. How the big platforms do it

### 1.1 ChatGPT (OpenAI)

- **UX.** A waveform button next to the composer starts voice. A full-screen view shows an animated
  orb (or the chat with live captions). The user can interrupt at any time. Camera and screen
  sharing work on mobile. When voice ends, the transcript stays in the conversation.
- **Architecture: native speech-to-speech.** One model hears audio and produces audio, without an
  STT → LLM → TTS chain. *Advanced Voice Mode* was turn-based. In July 2026 **GPT-Live** replaced
  it as the default ChatGPT Voice experience. GPT-Live is *full-duplex*: it listens and speaks at
  the same time.
- **Delegation.** GPT-Live answers simple questions itself. For web search, deeper reasoning or
  bigger tasks it **hands the request to the frontier text model (GPT-5.5) in the background** and
  speaks the result when it arrives. A fast voice model handles the conversation, and a strong
  text model does the hard work. iHub does not plan native speech-to-speech (§5).
- **Developer API.**
  - Realtime API (`gpt-realtime-2`, May 2026) over WebRTC or WebSocket. The browser either gets an
    **ephemeral client secret** from our server (`POST /v1/realtime/client_secrets`), or our server
    brokers the SDP exchange (`POST /v1/realtime/calls`, the "unified interface").
  - Turn detection runs on the server: `server_vad` (silence-based) or `semantic_vad` (a model
    decides whether the user has finished; `eagerness` low/medium/high).
  - When VAD hears the user, the in-flight response is cancelled and unplayed audio is truncated.
  - A separate `POST /v1/live/sessions` (`gpt-live-1`) exposes GPT-Live itself.
  - Streaming STT: `gpt-realtime-whisper`.

### 1.2 Claude (Anthropic)

- **UX.** A waveform icon next to the microphone (mobile) or bottom right (web/desktop). There are
  two listening styles:
  - **Hands-free (default):** Claude answers when the user pauses. If it cuts in too early, the
    user keeps talking and Claude stops and listens.
  - **Push-to-talk:** hold to speak, release to send. Meant for noisy places.

  Users choose from a few preset voices (no cloning) and can set the pace. Text and voice mix in
  the same conversation and context carries over. Transcripts are saved in the chat history.
  Non-English languages are in beta, with a voice language setting separate from the UI language.
- **Architecture: cascaded.** Voice mode uses the **same text chat models** as normal chat.
  Speech is transcribed, Claude answers in text, and the text is spoken (ElevenLabs does the TTS
  according to Anthropic's trust center). The Claude API has no audio input or output. Claude Code's
  voice mode is push-to-talk dictation into a text prompt.
- **Tools.** Web search and connectors (Gmail, Calendar, Docs, Slack) work in voice mode. Some
  results "can't be displayed", and several tool calls add a short delay.
- **Consequence.** Voice mode inherits everything text chat can do (model choice, tools, memory),
  and pays for it with more latency than native speech-to-speech.

### 1.3 Gemini Live (Google)

- **UX.** A "Live" button opens a full-screen conversation. The user can interrupt at any time,
  pause, or share the camera or screen (Project Astra).
- **Architecture: native audio.** The Live API is a stateful **WebSocket**. Input is 16 kHz PCM16
  and output is 24 kHz PCM16; JPEG frames up to 1 fps can be added for video.
- **Features:**
  - barge-in
  - configurable automatic activity detection: start/end sensitivity, prefix padding, silence
    duration; it can be turned off so the client sends activity signals itself
  - *affective dialog*: adapts tone to the user
  - *proactive audio*: the model decides whether to answer at all
  - function calling (also asynchronous) and Google Search grounding
  - transcripts of both input and output audio
  - session resumption and context compression for long sessions
- **Client access.** Browsers connect directly with **ephemeral tokens**, or a backend relays the
  stream. Google says direct is faster.

### 1.4 What they have in common

| Aspect | ChatGPT | Claude | Gemini Live |
| --- | --- | --- | --- |
| Entry point | Waveform button by the composer | Waveform button by the mic | "Live" button |
| Pipeline | Native S2S (full-duplex) + delegation to text model | Cascaded STT → chat model → TTS | Native audio model |
| Turn taking | Server VAD / semantic VAD | Pause detection; push-to-talk option | Server VAD, configurable |
| Interrupt (barge-in) | Yes | Yes (keep talking) | Yes |
| Tools / search | Via delegation | Same tools as text chat | Function calling + Search |
| Transcript in history | Yes | Yes | Yes |
| Voices | Presets | Presets + pace | Presets |
| Modes mix in one chat | Yes | Yes | Yes |

**Two architectures:**

1. **Cascaded** (Claude, and most production voice agents in 2026): STT → LLM → TTS. Any model,
   any tool, easy to debug, each part can be swapped. Latency is higher, and prosody and emotion
   in the user's voice are lost.
2. **Native speech-to-speech** (ChatGPT, Gemini): lowest latency and the most natural turn taking,
   but locked to one vendor's voice model. Tools, RAG and the app's own model need extra work, and
   on-premise options are rare.

The latency that users feel is spent mostly in three places:

- **end-of-turn detection**: about 200–800 ms of waiting for silence; the biggest lever
- **LLM time to first token**
- **TTS time to first audio**

Every cascaded system streams the LLM output into TTS **sentence by sentence**, instead of waiting
for the whole answer.

---

## 2. What iHub already has

Most of the parts exist. Voice mode is mainly orchestration.

| Building block | Where | State |
| --- | --- | --- |
| Mic capture → 16 kHz PCM16 (AudioWorklet) | `client/src/utils/realtimeTranscriptionCore.js` (`createPcmCapturePipeline`) | ✅ |
| Simple client-side VAD (RMS, 1200 ms hang) | `client/src/utils/modelRecognitionService.js` | ✅ (too simple for barge-in) |
| Streaming STT relay (Voxtral/vLLM, Mistral, Gemini Live, Whisper batch) | `server/websocket/realtimeTranscription.js`, `server/transcription/*`, WS `/api/voice/realtime` | ✅ one utterance per session |
| Browser / Azure STT | `client/src/features/voice/utils/speechService.js` | ✅ |
| Chat turn with tools, sources, RAG, SSE v2 events | `useAppChat.sendMessage` → `server/services/chat/ChatService.js` → `AgentLoop` | ✅ |
| Answer complete callback | `useAppChat` `onMessageComplete`, `run/ended` | ✅ |
| Streamed TTS (Mistral Voxtral, Gemini TTS), Markdown → speech | `POST /api/voice/speech`, `server/tts/*` (`toSpeechText`, `splitSpeechText`) | ✅ whole message per request |
| Gap-free PCM playback | `client/src/features/voice/utils/pcmStreamPlayer.js` | ✅ |
| Model permissions for STT/TTS models | `resolveTtsModel`, WS bridge | ✅ fail closed |
| Feature flags | `server/featureRegistry.js`, `useFeatureFlags()` | ✅ |

What is missing:

- a multi-turn STT session
- good turn detection and barge-in
- sentence-incremental TTS while the answer streams
- a voice-optimized answer style
- the voice mode UI itself

---

## 3. Recommendation

**Build cascaded voice mode, orchestrated in the browser on top of the existing endpoints.
Native speech-to-speech is not planned (decision 2026-10-17, §7).**

Why cascaded:

- **It is the only design that keeps the app intact.** It works with every chat model iHub
  supports (OpenAI, Anthropic, Google, Mistral, Bedrock, local vLLM) and keeps the app's tools,
  sources, RAG and system prompt. This is what Claude does.
- **Fully on-premise is possible.** Voxtral realtime STT on vLLM, a local LLM and self-hosted TTS
  can be combined, which matters to our customers. Native S2S today is OpenAI and Google cloud only.
- **About 80 % of the code exists.** The STT, TTS and chat paths are built, permission-checked,
  rate-limited and documented.
- **Audio stays where the admin chose to send it.** Speech goes only to the speech service the
  app already uses for voice input (§4.3). No new cloud vendor gets the user's voice.

---

## 4. Design — cascaded voice mode

### 4.1 User experience

**Entry.** A waveform button (`VoiceModeButton`) sits in `ChatInput.jsx` **directly next to the
mic button**, like Claude (decision 2026-10-17). The Send button stays as it is. On mobile, where
the mic lives in `ChatInputActionsMenu.jsx`, the voice mode button sits beside it there. The button
shows only when voice mode is available (§4.6). The first click asks for microphone permission and
unlocks the `AudioContext`, because autoplay needs a user gesture.

**Voice view** (`VoiceModeOverlay`) covers the message area and leaves the header visible:

```
┌──────────────────────────────────────────┐
│  App name                     [⚙] [✕]    │
│                                          │
│                ( ◉ orb )                 │   ← animates with mic level / speech
│                Listening…                │   ← state label (aria-live)
│                                          │
│  "What were the Q3 figures for…"         │   ← live user caption (interim → final)
│  The Q3 revenue was 4.2 million, …       │   ← assistant caption (what is being spoken)
│                                          │
│   [🎤 Mute]   [✋ Hold to talk]   [✕ End]   │
└──────────────────────────────────────────┘
```

- **States.** These drive the orb, the label and the sounds:
  - `connecting`
  - `listening`
  - `user-speaking`
  - `thinking`: STT is finished and the LLM is running; tool chips such as "Searching the web…"
    show here
  - `speaking`
  - `paused`: muted
  - `error`
- **Hands-free (default).** The turn ends after a configurable silence (default 800 ms).
- **Push-to-talk.** Hold the on-screen button or the **Space** bar. Release sends the turn.
- **Interrupt (barge-in).** Speaking while the app speaks stops playback within about 200 ms,
  cancels the LLM stream if it is still running (`POST …/stop`), and starts a new user turn. A tap
  on the orb also stops the answer.
- **Captions.** Captions are on by default and are the accessible alternative to audio. The full
  history is in the normal message list behind the overlay.
- **Settings (⚙).**
  - listening style (hands-free / push-to-talk)
  - voice, from the TTS model's `tts.voices`
  - interrupt on/off: helps on laptop speakers without headphones
  - captions on/off

  Stored per user in `localStorage`, like other UI preferences.
- **End (✕ / Esc).** Closes the mic, the STT socket and playback, and returns to text chat in
  **the same chat**. The user can continue by typing, and can reopen voice later.
- **Keyboard.** Ctrl/Cmd+Shift+V toggles voice mode. Ctrl/Cmd+M stays dictation.

### 4.2 Turn loop

```
          ┌──────────────── barge-in (user speech while speaking) ───────────────┐
          ▼                                                                       │
 [listening] ─speech start─▶ [user-speaking] ─end of turn─▶ [thinking] ─first audio─▶ [speaking]
     ▲                            │ (VAD silence / PTT release)  │ LLM streams,        │
     │                            ▼                              │ sentences → TTS     │
     │                  STT final transcript ──▶ sendMessage ────┘                     │
     └─────────────────────────────── playback queue drained ─────────────────────────┘
```

The state machine is a pure reducer (`voiceModeReducer.js`) driven by events from four sources:

- mic VAD
- STT socket
- chat SSE
- player

Being pure, it can be unit-tested without audio.

### 4.3 Listening: STT and turn detection

**One mic stream for the whole session.** It is opened with
`getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
Browser echo cancellation is what lets us listen while we speak.

**VAD.** The RMS threshold in `modelRecognitionService.js` is fine for dictation. For a hands-free
loop with barge-in it triggers on keyboard noise and on our own TTS leaking through the speakers.
Voice mode replaces it with **Silero VAD in the browser** (`@ricky0123/vad-web`; ONNX
Runtime Web, about 2 MB, self-hosted under `/vad/`, no CDN). Silero returns a speech probability per
32 ms frame. Parameters, configurable on the platform:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `endOfTurnSilenceMs` | 800 | Silence that ends the turn (hands-free) |
| `minSpeechMs` | 250 | Shorter blips are ignored |
| `preRollMs` | 300 | Audio before the detected speech start is kept, so the first syllable is not cut |
| `bargeInMinSpeechMs` | 350 | Speech needed during playback to interrupt; higher than `minSpeechMs` against echo |
| `bargeInThresholdBoost` | 0.15 | Raises the speech probability threshold while we are speaking |

**STT transport.** Voice mode supports **every speech service voice input has** (decision
2026-10-17). It uses the one the app's voice input already resolves to (`resolveSpeechService`: the
app's `settings.speechRecognition.service`, else `platform.speech.defaultService`). No separate
choice is made for voice mode. Whatever an admin set up for dictation also drives voice mode.

| Service | Turn end | Barge-in while the app speaks | Notes |
| --- | --- | --- | --- |
| `model` | Our VAD → `commit` | Our VAD on the echo-cancelled stream | Best latency with a streaming model; works on-premise |
| `azure` | Our VAD → `stopContinuousRecognitionAsync`, final result | Our VAD; Azure is fed the same stream | The SDK takes a push stream (`AudioConfig.fromStreamInput`), so it gets our echo-cancelled, VAD-gated audio |
| `browser` (and `custom`, which maps to it) | Our VAD → `recognition.stop()`, final result | Our VAD; the recognizer is paused while the app speaks and restarted on barge-in | Zero setup. Chrome sends audio to Google, Safari to Apple. Firefox has no Web Speech API, so voice mode is hidden there for this service |

Details per service:

- **`model`.** The existing `/api/voice/realtime` bridge with a streaming
  transcription model (Voxtral realtime, Mistral realtime, Gemini Live transcription). Today a
  session is one utterance: `start` → audio → `stop` → `done` → close. Voice mode needs **many
  turns over one socket**, so we extend the protocol in a backwards-compatible way:

  | Direction | Frame | Meaning |
  | --- | --- | --- |
  | client → server | `{"type":"start","modelId","conversation":true}` | Multi-turn session |
  | client → server | binary | PCM16, sent **only while VAD reports speech** (plus pre-roll) |
  | client → server | `{"type":"commit"}` | End of this user turn: flush and return its final text |
  | server → client | `{"type":"final","text","turn":n}` | The final transcript of turn *n* |
  | client → server | `{"type":"keepalive"}` | Sent while the app thinks or speaks |
  | client → server | `{"type":"stop"}` | End of the voice session (unchanged) |

  - **Why gate on VAD.** Audio goes upstream only while the user speaks. A GPU-backed Voxtral
    session is not fed silence while the app speaks, so cost and load stay as they are today.
  - **Why `keepalive`.** It keeps the 60 s idle timeout from closing the session during a long
    spoken answer. The 4200 s session cap and the per-user connection caps stay.
  - **Streaming providers** forward `commit` as their "input audio buffer commit" (vLLM/Mistral)
    or end-of-activity signal (Gemini Live).
  - **Batch providers** (Whisper, Gemini transcribe) transcribe the audio buffered since the last
    commit, then send `final`. They work, with about 0.5–1.5 s more latency.
  - Interim `delta` frames drive the live caption.
- **`azure`.** Runs in continuous recognition mode (already implemented in
  `azureRecognitionService.js` for manual dictation). Instead of the default microphone, it gets a
  push stream fed from the voice session's echo-cancelled mic, gated by our VAD. Our end-of-turn
  ends the utterance, and the recognizer's final result is the turn. No new server code is needed;
  the token still comes from `GET /api/voice/azure/token`.
- **`browser`.** The Web Speech API opens its own microphone and cannot take our stream. It runs
  in continuous mode with interim results for the caption, and our VAD on the parallel
  echo-cancelled stream decides the turn end. Its echo handling is outside our control, so while
  the app speaks the recognizer is **paused**, which keeps the app's own voice out of the
  transcript. Barge-in is detected by our VAD, which stops playback and restarts the recognizer.
  The first ~300 ms of the interruption can be lost, because pre-roll audio cannot be replayed
  into the browser recognizer. Push-to-talk avoids this. No new server code is needed.

**Push-to-talk** skips VAD: press starts the audio, release sends `commit`.

### 4.4 Thinking: the chat turn

The final transcript is sent with the **existing** `useAppChat.sendMessage`, with the same app, model,
tools, sources and chat ID. The SSE v2 event stream is unchanged. Additions:

- **`voiceMode: true` in `chatPostSchema`** (`server/validators/index.js`). `RequestBuilder.js`
  then adds a voice style instruction after the app's system prompt. Admins can change it in
  `platform.speech.voiceMode.systemPrompt`; it is localized. Default (English):

  > The user is talking to you by voice and hears your answer read aloud. Answer conversationally
  > and briefly: lead with the answer, usually 1–4 sentences. Do not use tables, code blocks,
  > headings, bullet lists, URLs, or emoji unless the user asks for them. Say numbers and units
  > the way they are spoken. If the answer is long, give a summary and offer details.

- **Thinking level.** Reasoning models add seconds of silence. Voice mode sends
  `thinkingLevel: platform.speech.voiceMode.thinkingLevel` (default `low`) unless the app requires
  more.
- **Messages are marked** with `metadata.inputMode: "voice"`, so the history can show a small
  waveform icon next to voice turns. Audio is never stored, as with dictation and transcription
  today.
- **Tool events.**
  - `tool/started` sets the state label: "Searching the web…", "Looking in the documents…".
    Optionally a short earcon plays every 3 s while the app thinks, so the user knows it is still
    working.
  - `interaction/raised` (ask_user / clarification): the question is spoken, and the user's next
    utterance answers it through the existing interaction answer path.
  - Results the voice cannot carry (images, charts, long tables) stay in the chat. The style
    prompt tells the model to say "I've put the table in the chat".

### 4.5 Speaking: sentence-streamed TTS

`/api/voice/speech` currently takes one whole message. Waiting for `run/ended` would add the full
generation time to every answer. Instead, **the client cuts the streaming text into speakable
chunks and synthesizes them in order** (`speechQueue.js`):

1. Append each `step/delta` of kind `text` to a buffer. `thinking` deltas are ignored.
2. Cut a chunk at a sentence end (`. ! ? …` followed by a space or newline) or a paragraph break,
   but **never inside an open code fence or a table**. Those are skipped server-side by
   `toSpeechText` anyway; cutting inside them would produce broken Markdown.
3. **The first chunk is short** (≥ 1 sentence, ≥ 30 characters), so audio starts as soon as
   possible. **Later chunks are larger** (≥ 250 characters, up to 1,500), so there are fewer
   requests and the prosody stays natural.
4. Each chunk becomes a `POST /api/voice/speech` request:
   - The **next chunk is requested while the current one plays**. Voxtral generates 7–10× faster
     than real time, so playback stays gap-free after the first chunk.
   - At most **2 requests are in flight**.
   - All chunks feed **one** `PcmStreamPlayer`, which already schedules buffers back to back.
   - **One language, so one voice, for the whole answer.** Today `language` is only a fallback
     hint: the endpoint detects the language from each request's own text
     (`voiceRoutes.js`, `detectSpeechLanguage`). A short chunk could therefore get a different
     voice. The first chunk's response states the language it picked (`X-Speech-Language`). The
     client sends it with every later chunk as `{ language, languageFixed: true }`, and the
     endpoint then uses it as given instead of detecting again.
5. On `run/ended`, the rest of the buffer is flushed. When the player drains, the state returns to
   `listening`.
6. **Barge-in or End** aborts all in-flight TTS fetches (the server aborts upstream on close),
   stops the player, and posts `/stop` if the run is still streaming.

**Load.** A typical answer of 3–6 chunks is well inside the inference limiter (500 requests/min).
Voice answers are short by prompt, and `maxCharacters` still caps every request. No new server
endpoint is needed. The only change to `/api/voice/speech` is the `languageFixed` flag.

*Rejected for now:* a server-side endpoint that taps the run's text deltas and synthesizes them
in one stream. It is fewer round trips, but it couples TTS to `RunStream` and needs run-to-TTS
affinity across cluster workers. Reconsider if the per-chunk overhead turns out to matter.

### 4.6 Configuration and gating

**Feature flag.** `voiceMode` in `server/featureRegistry.js`, `category: 'preview'`,
`default: false`.

**Platform** (`contents/config/platform.json`, `speech.voiceMode`; added by migration):

```jsonc
"speech": {
  "voiceMode": {
    "enabled": false,
    "appDefault": false,       // voice mode for apps that don't set inputMode.voiceMode.enabled
    "ttsModelId": "",          // empty → speech.tts.defaultModelId
    "listeningStyle": "hands-free",   // "hands-free" | "push-to-talk"
    "bargeIn": true,
    "endOfTurnSilenceMs": 800,
    "thinkingLevel": "low",
    "maxSessionMinutes": 30,
    "systemPrompt": {}         // optional { "en": "...", "de": "..." } override
  }
}
```

There is no separate STT model setting. Voice mode uses the speech service the app's voice input
resolves to (§4.3).

**App: part of the voice input configuration** (decision 2026-10-17). Voice mode is configured
per app next to the microphone settings, in `inputMode` (`contents/apps/*.json`,
`inputModeSchema` in `appConfigSchema.js`):

```jsonc
"inputMode": {
  "microphone": { "enabled": true, "mode": "manual", "showTranscript": true },
  "voiceMode": {
    "enabled": true,                 // absent → platform speech.voiceMode.appDefault
    "listeningStyle": "hands-free",  // optional, overrides the platform default
    "ttsModelId": "",                // optional, e.g. a German voice model for a German HR app
    "voice": ""                      // optional voice of that model
  }
}
```

- It sits beside `microphone` because voice mode *is* voice input. It shares the app's speech
  service (`settings.speechRecognition`), and an app with `microphone.enabled: false` has no voice
  mode either.
- The platform switch turns the feature on for the instance. `appDefault` decides apps that say
  nothing; each app can turn it on or off explicitly. With the default `appDefault: false`,
  voice mode is opt-in per app; an admin can flip it to make it opt-out.
- No app migration is needed: an absent `inputMode.voiceMode` means "follow the platform".

**Available when all of these hold** (checked in a `useVoiceModeAvailability(app)` hook, like
`useReadAloudAvailability`):

1. the feature flag is on and `speech.voiceMode.enabled` is true
2. the app allows voice input (`inputMode.microphone.enabled !== false`) and voice mode is on for
   it (`inputMode.voiceMode.enabled`, else `appDefault`)
3. a TTS model is configured (the app's `ttsModelId`, else the platform's) and the user is allowed
   to use it (`GET /api/models?type=tts`)
4. the app's speech service works here: a permitted transcription model for `model`, Azure
   configured for `azure`, Web Speech API support for `browser`
5. the browser has `getUserMedia` and `AudioWorklet`

The server enforces the same rules: model permissions on the WS bridge and `/api/voice/speech`, and
`requireFeature('voiceMode')` on the conversation-mode `start`. No new group capability is
needed: permission to the app, the STT model and the TTS model is enough.

**Admin UI.**

- **Admin → Voice Input** (`AdminVoiceInputPage.jsx`) gets a "Voice mode" section: the platform
  switch, `appDefault`, the TTS model picker and the parameters above. A "Try it" button runs a
  session with the platform's default speech service.
- **App editor:** in the voice input section (`InputModeSection.jsx`), under the microphone
  settings. It has a three-way "Voice mode" control (platform default / on / off) and the
  optional listening style, TTS model and voice.

**Migration** (`create-migration` skill): it adds the `speech.voiceMode` defaults to
`platform.json`. The feature flag needs no migration, because the registry default applies when
the key is absent.

### 4.7 Code layout

**Client** (`client/src/features/voice/`):

| File | Purpose |
| --- | --- |
| `components/VoiceModeButton.jsx` | Entry button in `ChatInput.jsx` (and `ChatInputActionsMenu.jsx` on mobile) |
| `components/VoiceModeOverlay.jsx` | Orb, state label, captions, controls, settings popover |
| `hooks/useVoiceMode.js` | Wires the reducer to mic, STT, `useAppChat` (`sendMessage`, stop, SSE events) and the speech queue |
| `hooks/useVoiceModeAvailability.js` | Gating (§4.6) |
| `utils/voiceModeReducer.js` | Pure state machine (§4.2) |
| `utils/voiceSession.js` | One mic stream, Silero VAD, pre-roll ring buffer, and one STT adapter per service: conversation socket (`model`), push-stream recognizer (`azure`), Web Speech recognizer (`browser`) |
| `utils/speechQueue.js` | Delta → chunk cutting, ordered TTS fetches, `PcmStreamPlayer`, abort |
| `utils/speakableChunker.js` | The pure chunking function (§4.5), unit-tested |

AppChat renders the overlay and passes it the `useAppChat` handle. **There is no new top-level
route**, so the `KNOWN_ROUTES` / `index.html` rule does not apply. The Office panel
(`OfficeChatPanel.jsx`) can reuse the overlay later.

**Server:**

| File | Change |
| --- | --- |
| `server/websocket/realtimeTranscription.js` | `conversation` mode, `commit`, `keepalive`, turn-numbered `final`, feature check |
| `server/transcription/*Provider.js` | A `commitFrames()` per streaming provider; batch providers transcribe per commit |
| `server/routes/voiceRoutes.js` | `languageFixed` on `/api/voice/speech`: use `language` as given, skip detection |
| `server/validators/index.js` | `voiceMode` in `chatPostSchema` |
| `server/services/chat/RequestBuilder.js` | Voice style instruction, thinking level |
| `server/validators/platformConfigSchema.js` | `speech.voiceMode` |
| `server/validators/appConfigSchema.js` | `inputMode.voiceMode` |
| `server/featureRegistry.js` | `voiceMode` flag |
| `server/migrations/V{NNN}__add_voice_mode_defaults.js` | Platform defaults |

**i18n.** A `voiceMode.*` namespace in `shared/i18n/en.json` and `de.json` (states, controls,
errors, settings), and `admin.voiceInput.voiceMode.*`.

### 4.8 Latency budget

Target: **under 2 s from the end of the user's speech to the first audio**, with a cloud LLM.

| Stage | Expected | Lever |
| --- | --- | --- |
| End-of-turn silence | 800 ms (configurable) | Lower to 500–600 ms; semantic end-of-turn later |
| STT final after commit | 100–300 ms (streaming) / 500–1500 ms (batch) | Prefer streaming models |
| LLM time to first token | 300–1000 ms (model, thinking off/low) | Low thinking level, short style prompt |
| First sentence complete | +150–400 ms | Short first chunk |
| TTS time to first audio | 500–1900 ms (Voxtral, measured 2026-10-01) | Faster TTS provider (§6) |
| **Total** | **≈ 1.9–4.4 s** | |

TTS is the weakest link today. The UI covers the wait with the `thinking` animation and an
optional earcon. A faster TTS provider (see follow-ups) is the cheapest improvement.

Every turn logs its stage timings at debug level (`voiceMode.timing`: `vadEnd → sttFinal →
firstToken → firstChunk → firstAudio`), so we can measure p50/p90 per deployment.

### 4.9 Edge cases

- **Echo and self-interruption on laptop speakers.** Echo cancellation, the higher barge-in
  threshold and the longer minimum duration handle it. If false interruptions still happen
  (detected as barge-ins with an empty transcript), auto-raise the threshold for the session, and
  recommend headphones in the UI.
- **Empty or garbage transcripts** (cough, "uh"). Turns with fewer than 2 characters, or that are
  only filler words, are dropped silently.
- **Tab hidden or screen locked.** Mobile browsers stop the mic. Voice mode moves to `paused` and
  says so. It never silently records in the background.
- **iOS Safari.** The `AudioContext` must be created in the click. Use a single context for VAD
  and playback where possible.
- **Errors.**
  - STT socket loss: reconnect once, then fall back to the `error` state with "Tap to retry".
  - TTS failure: keep the caption and continue the loop without audio.
  - Chat error: speak a short localized error message.
- **The user types while the overlay is open.** Not possible: the overlay owns the input area.
  Closing voice mode returns the composer.
- **Multi-node.** The WS bridge already supports sticky sessions. The TTS and chat calls are
  stateless HTTP.

### 4.10 Testing

- **Unit:**
  - `voiceModeReducer` transitions, including barge-in during `thinking` and during `speaking`
  - `speakableChunker`: code fences, tables, abbreviations such as "e.g." and "z. B.", decimals,
    German and English
  - the gating hook
- **Server:**
  - conversation mode on the WS bridge with a fake upstream: multiple commits, keepalive vs idle
    timeout, batch provider per commit
  - the `voiceMode` request flag adds the instruction
  - the migration
  - `inputMode.voiceMode` validation, and resolving it against `appDefault`
- **E2E (Playwright).** Chromium with `--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=question.wav`, against stub
  STT/TTS providers. Assert that the turn is sent, captions appear, and the transcript persists
  after End. Run it once per speech service: `model` against a stub transcription provider,
  `azure` with a mocked SDK, and `browser` with a stubbed `SpeechRecognition`.

---

## 5. Not planned: native speech-to-speech

Native speech-to-speech (OpenAI Realtime / GPT-Live, Gemini Live native audio) is **out of scope**
(decision 2026-10-17). It would send the user's voice to OpenAI or Google cloud, bypass the app's
own chat model, and need a separate bridge for tools and sources. The cascaded design keeps audio
with the speech service the admin already chose, and keeps every app capability.

What the research still feeds into the cascaded design: barge-in, hands-free plus push-to-talk,
preset voices, transcripts in the chat history, and the latency levers in §4.8 and §6.

---

## 6. Follow-ups (not in this concept)

- **More TTS providers**, mainly for latency:
  - OpenAI-compatible `/v1/audio/speech`, which also covers self-hosted Kokoro or Piper via
    Speaches, and self-hosted Voxtral TTS on vLLM-Omni
  - Azure Speech
- **Semantic end-of-turn detection** (a small turn-detector model, or the provider's own like
  `semantic_vad`), so pauses mid-thought don't end the turn.
- **Speculative LLM start** on a stable interim transcript, cancelled if the user keeps talking.
- **Camera and screen sharing** in voice mode (the Gemini Live pattern), for vision models.
- **Usage tracking** for STT seconds and TTS characters per user/app.

## 7. Decisions (2026-10-17)

1. **Button placement:** a separate voice mode button **next to the mic**, as in Claude. Send is
   unchanged (§4.1).
2. **Native speech-to-speech:** not planned (§5).
3. **Speech services:** voice mode supports **all voice input services**: transcription model,
   Azure and browser. It uses whichever the app's voice input is configured with (§4.3).
4. **Per-app control:** voice mode is configured **per app as part of the voice input
   configuration** (`inputMode.voiceMode`), with a platform switch and a platform default for apps
   that don't set it (§4.6).

## 8. Phasing

| Phase | Scope | Done when |
| --- | --- | --- |
| **1a** | Overlay, reducer, push-to-talk, all three speech services (`model`, `azure`, `browser`), chunked TTS, voice style prompt, gating, migration | A user holds Space, asks a question, hears the answer, and the transcript is in the chat |
| **1b** | Hands-free with Silero VAD, STT conversation mode (`commit`/`keepalive`), barge-in, tool status, `interaction/raised`, settings popover, admin section and app editor (`inputMode.voiceMode`) | Three turns in a row without touching anything; interrupting stops audio in < 300 ms |
| **2** | Latency work: faster TTS provider, timings dashboard, tuned defaults | p50 end-of-speech → first audio < 2 s on the reference setup |

## Sources

- OpenAI: [Introducing GPT-Live](https://openai.com/index/introducing-gpt-live) ·
  [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc.md) ·
  [Neowin on next-gen ChatGPT Voice](https://www.neowin.net/news/openais-next-generation-chatgpt-voice-will-make-advanced-voice-mode-look-outdated/) ·
  [GPT-Realtime-2 overview](https://www.dsebastien.net/2026-05-07-gpt-realtime-2-openais-voice-model-gets-gpt-5-class-reasoning/) ·
  [Stanford CS 224G realtime voice workshop](https://web.stanford.edu/class/cs224g/lectures/CS%20224G%202026%20Lecture%2017%20-%20Workshop%20Building%20and%20Scaling%20Realtime%20Voice%20AI%20Apps.pdf)
- Anthropic: [Using voice mode (Claude Help Center)](https://support.claude.com/en/articles/11101966-using-voice-mode) ·
  [Simon Willison on Claude voice mode](https://simonwillison.net/2025/May/31/using-voice-mode-on-claude-mobile-apps) ·
  [Claude voice features explained](https://www.datastudios.org/post/claude-voice-features-explained-current-status-and-upcoming-real-time-updates)
- Google: [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live) ·
  [Vertex AI Live API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api) ·
  [Live API WebSockets reference](https://ai.google.dev/api/live) ·
  [Gemini Live camera & screen sharing](https://www.gsmarena.com/gemini_live_with_camera_and_screen_sharing_is_now_available_to_all_android_users-news-67447.php)
- Cascaded pipelines & tooling: [Cascaded vs speech-to-speech 2026](https://futureagi.com/blog/cascaded-voice-ai-vs-speech-to-speech-2026/) ·
  [Voice agent stack 2026](https://techsy.io/en/resources/researches/primers/voice-agent-stack-2026) ·
  [How real-time voice AI works](https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts) ·
  [ricky0123/vad (Silero VAD for the browser)](https://github.com/ricky0123/vad) ·
  [Speaches (self-hosted OpenAI-compatible STT/TTS)](https://railway.com/deploy/speaches-stt-tts-api)
