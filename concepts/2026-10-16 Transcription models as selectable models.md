# Transcription models as selectable models

## Why

On k3s01, transcribing an uploaded file with `gemini-3.5-transcribe-live` returned a few words and
stopped. The browser streamed the whole file at full speed; Gemini Live closes such a session with
`1011 Resource has been exhausted`, and the bridge treated any close after the first transcript as
normal, so nothing was logged and the truncated transcript looked complete.

The bug exposed a design problem: where audio went was not visible. With the app's transcription
toggle on, audio went to a hidden transcription model (`app.transcription.modelId` or the platform
default) and its transcript was auto-sent to the chat model; with it off, audio went to the chat
model. Mic and record used different backends.

## Decision

**Audio goes to the selected model.** Two buttons with fixed meanings:

- **Mic = dictation**: speech-to-text into the input field via the configured dictation service
  (a live transcription model, Azure or the browser). Independent of the selected chat model.
  Dictation pickers list only live (`transcriptionMode: 'stream'`) models.
- **Record = capture audio and send it to the selected model**, exactly like an uploaded file.

| Selected model                    | Text input | Record / audio+video upload                                  |
| --------------------------------- | ---------- | ------------------------------------------------------------ |
| Chat model with `supportsAudio`   | yes        | audio as `audioData` with the typed prompt                   |
| Chat model without audio          | yes        | disabled                                                     |
| Transcription model, live         | no         | turn per file, transcript streams back (files server-paced) |
| Transcription model, batch        | no         | turn per file, transcript at the end                         |

The per-app transcription toggle and `speech.transcription.defaultModelId` are removed (clean
break, migration V167).

## How it works

- `GET /api/models?type=chat,transcription` feeds the chat's model selector; transcription models
  carry `transcriptionMode`. Compare mode, workflows and magic prompt stay chat-only.
- A transcription turn still travels over `/api/voice/realtime` (chunked, backpressured, no JSON
  body limit). The `start` frame names the chat (`chatId`, `appId`, `attachment`); the bridge
  stores the file as the question and the transcript as the answer
  (`server/services/chat/transcriptionTurn.js`). With durable chats the server owns the history,
  so this is what lets a chat model selected next answer follow-ups.
- `start.source: 'file'` marks a whole file. The bridge feeds it to the upstream at the model's
  `maxRealtimeFactor` (google-live: 3×; measured: ~4× holds, ~8× fails) and rotates the upstream
  session before `maxSessionSeconds` (google-live: 540 s) or on Gemini's `goAway`. Both are
  overridable per model in `config`.
- Any upstream close other than 1000/1005 is reported (`upstream-closed`), even after text arrived.

## Not done

- No ETA shown while a paced file is transcribed (`ready.realtimeFactor` carries what it needs).
- Usage tracking of audio seconds per model.
