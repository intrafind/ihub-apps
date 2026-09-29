# Inference API: Apps, Responses and Conversations — Implementation Notes

Implements intrafind/ihub-apps#2580. The issue is the specification; this note records how it
was built and the decisions the issue left open. User-facing documentation:
`docs/openai-compatible-api.md` and `docs/structured-output.md` ("External API usage").

## Layout

| Module | Role |
| --- | --- |
| `server/routes/openaiProxy.js` | `/models` (models + `app:<appId>`), `/chat/completions` (plain path unchanged on the wire, app path new), registers the two routes below |
| `server/routes/inference/responses.js` | `POST /responses` |
| `server/routes/inference/conversations.js` | `/conversations` CRUD and items |
| `server/services/inference/modelIdentifier.js` | Parses `app:<appId>[/<modelId>]`, checks app + model permissions and the app's model rules |
| `server/services/inference/promptVariables.js` | `prompt.variables` validation, coercion, localized defaults |
| `server/services/inference/structuredOutput.js` | `response_format` / `text.format` / app `outputSchema` → one format; provider support; ajv validation |
| `server/services/inference/appTurn.js` | App turns on `ChatService` (prepare, run, template rules) |
| `server/services/inference/plainTurn.js` | Plain-model turns on `LLMClient`, with validation and retry |
| `server/services/inference/inputContent.js` | Responses input / Chat Completions parts → chat messages; PDF and text extraction |
| `server/services/inference/conversations.js` | Chat ↔ conversation mapping, items, binding, busy check |
| `server/services/inference/responsesWire.js` | Response object, output items, streaming events |
| `server/services/loop/seams/structuredOutputSeam.js` | Validates the final answer inside the agent loop |

## Decisions

**Retry inside the run.** An app turn is one `ChatService.runTurn` on the agent loop. The loop
gained an `onAnswer` seam hook: a seam can reject a tool-free answer, and the loop appends it plus
a correction and lets the model answer again (while a round is left). The structured-output seam
uses it for the one retry. That keeps a retry inside one run — one ledger run, one stored turn,
tools still available — instead of a second turn the caller would have to reconcile. Plain models
do not use the loop; `plainTurn.js` retries with a second `LLMClient` call under the same ledger
run.

**Streaming and validation.** A streamed answer can only be checked once it is complete.

- `/responses`: the rejected attempt's message item is closed `incomplete`, the retry streams as a
  new item, and `response.completed` carries only the validated output. The OpenAI SDKs take the
  completed event's response as final, so `get_final_response()` / `finalResponse()` is right.
- `/chat/completions`: chunks cannot be taken back, so a streamed answer is validated at the end
  **without** a retry (a second attempt would be concatenated to the first), and an invalid one
  ends the stream with an in-band error, which the SDKs raise.

**What the caller gets is the validated JSON.** `content` / `output_text` is the canonical
`JSON.stringify` of the parsed value (fences and prose removed), and the Responses message part
carries the object as `parsed`. The stored answer keeps both (`content`, `output`).

**Error shapes.** `/chat/completions` keeps its flat `{ error, code }` body (golden-tested,
existing callers parse it); `/responses` and `/conversations` use OpenAI's nested
`{ error: { message, type, param, code } }`. LLM errors keep their canonical codes (`RATE_LIMITED`,
…); errors the API makes itself use lower-case snake codes.

**App tool calls are `ihub_tool_call` items**, not `function_call` — a `function_call` item tells an
agent framework to run the call itself. Unknown item types are tolerated by both SDKs.

**The app is authoritative.** For an app, `system`/`developer` messages, `instructions`,
`response_format`/`text.format` and `tools` are refused with 400 rather than ignored, so a caller
never believes an override took effect.

**Template rules** (`turnPrompt`): first turn / stateless → template with this turn's variables;
follow-up without variables → raw input, system prompt on the chat's stored `variables` (the
field the chat UI's start form also keeps); follow-up with variables → template again, stored set
replaced. "First turn" means no answer a turn produced (an assistant message with a `runId`) yet. An app with `sendChatHistory: false` has no history carrying the earlier
rendering, so its template wraps every turn (on the stored variables when none are sent).

**Conversation binding and ownership.** The chat stores `binding: 'app' | 'model'` with `appId`;
a UI-started chat counts as bound to its app. Ownership is `authorizeChat`, with the principal in
the ledger identity mode, so OAuth client-credentials chats belong to the client id. Chats record
`origin: { createdVia, clientId?, authMode? }`; UI turns now write `createdVia: 'ui'`.

**Concurrent turns → 409.** `ChatRepository.claimRun` checks and claims `activeRunId` inside the
chat lock. A run on record counts as alive while it is in flight anywhere in the cluster
(`activeRequests` / durable mark) or was claimed in the last 30 s, so a chat left `running` by a
dead process unlocks itself. UI turns keep superseding.

**Durability.** A conversation turn is marked durable and is stored even when the client
disconnects mid-way; a stateless turn is aborted with its client.

**Files.** `input_file` / `file` parts are decoded on the server: PDFs through `pdfjs-dist`, text
types as UTF-8. Scanned PDFs, other binary types, `file_id`, `file_url` and remote image URLs are
400s — iHub has no files API and does not fetch URLs for the caller.

## Not done

- `previous_response_id`, stored/retrievable responses, `background`, hosted tools and caller
  function tools on `/responses` (400 with a message).
- The chat UI still applies the app template on every turn; tracked separately per the issue.
