# Provenance Records

Every AI output that leaves iHub carries a small machine-readable **provenance object**, and a **record** of
it is kept so that anyone holding a text can ask "did this exact text come from this installation, when, and
from which model?". It is the supporting evidence for the marking duty of Art. 50(2) of the EU AI Act (see
[EU AI Act](ai-act.md)); it is not legal advice.

The record **never stores the output text**. It stores a hash of it.

## The provenance object

```json
"provenance": {
  "spec": "intrafind-provenance/1.0",
  "ai_generated": true,
  "generator": { "product": "iHub Apps", "version": "5.4.0", "installation_id": "inst_0b1f…" },
  "model": {
    "id": "gpt-4o",
    "watermark": { "by": "provider", "scheme": "synthid", "applied": true }
  },
  "output_id": "01JC8M2T6V0Q4W7R9XK3B5N1ZD",
  "created_at": "2026-11-05T10:12:03.412Z",
  "content_hash": { "alg": "sha-256", "normalization": "nfc-trim", "value": "9f86d0…" },
  "verify": "https://ihub.example.com/api/provenance/_verify"
}
```

| Field | Meaning |
| --- | --- |
| `output_id` | A sortable ID (ULID) allocated before the first byte of a response, so it can go into a header. Never derived from the content. |
| `generator.installation_id` | A random, stable, opaque ID (`inst_` + UUID), minted once and kept in the storage provider. Set `IHUB_INSTALLATION_ID` to manage it yourself. Copying `contents/` to a staging system copies it. |
| `model.id` | The model that answered. Workflows use `workflow:<id>`. |
| `model.watermark` | What the model declares about marking its output, see below. |
| `content_hash` | SHA-256 of the output text after the `nfc-trim` normalization. Missing when there is no text (a tool call only). |
| `verify` | Where to look the output up. Absolute when the public URL is known (`mcpServer.publicUrl`, or the request's own host); the site-relative path in stored chat messages. |

There is no `digital_source_type` for text (that vocabulary belongs to media) and no `signature`.

### `model.watermark`

Set per model with `contentMarking.text` (see [Models](models.md#output-marking-contentmarking)):

| `by` | Meaning | `applied` |
| --- | --- | --- |
| `none` (default) | No marking. | `false` |
| `provider` | The operator states that the provider marks the output (for example SynthID). | `true`, on the operator's written statement. iHub cannot check it. |
| `ihub` | iHub's own watermark. Not available yet; it is never reported as applied. | `false` |

## `nfc-trim`

The hash is over the text with, in this order: Unicode **NFC**; `\r\n` and lone `\r` turned into `\n`;
leading and trailing whitespace removed; then UTF-8, SHA-256, lowercase hex. Inner whitespace, case and
Markdown are kept. The name is frozen: a change would be a new name, never a redefinition.

Consequences: text copied from the rendered chat (Markdown rendered, `[1]` citation markers, list bullets) will
not match. The hash is over the text the API consumer receives: after structured-output validation, before
citation markers. For a multi-step agent run the whole answer is hashed, and the record is also indexed under
the hash of the final step's text, so a user who copied only the final answer still finds it.

## Where the object appears

| Channel | Where |
| --- | --- |
| Chat | On the stored assistant message (`provenance`) and on the `run/ended` event, live and in a replay of the run ledger. Under each finished answer an **AI generated: details** button (an info icon beside the "based on…" badge) opens model, time, marking, a shortened content hash with **Copy hash**, and the output ID. An answer without the object (no text, or stored before this feature) shows no button; a stopped answer that had already written text does show it. |
| Inference API (`/api/inference/v1/chat/completions`, `/responses`) | A top-level `provenance` member, plus the headers `X-AI-Generated: true` and `X-AI-Content-Id: <output_id>`. See [OpenAI-compatible API](openai-compatible-api.md#provenance). |
| MCP | `_meta.provenance` on an app or workflow `tools/call` result. |
| A2A | `metadata.provenance` on the Task and on the response artifact. |

An output without text, and an error, carries none. Everything that runs through the chat engine is recorded:
web chat, scheduled tasks, apps called by tools, the inference API, MCP and A2A. Workflow runs and the
Slack and Teams integrations do not go through it and get no record yet.

## Looking an output up

`POST /api/provenance/_verify` takes a text or a hash:

```bash
curl -X POST https://ihub.example.com/api/provenance/_verify \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "text": "The answer you were given." }'
# or  -d '{ "contentHash": "9f86d0…" }'
```

```json
{ "found": true, "normalization": "nfc-trim", "records": [ { "output_id": "01JC…", "created_at": "…", "model": { "id": "gpt-4o" }, "…": "…" } ] }
```

A miss answers **200** with `{ "found": false, "normalization": "nfc-trim" }`. A miss only means **no record
exists**: the text may have been edited, the record may have expired, or it came from elsewhere. It is not
proof of human authorship.

- Send exactly one of `text` and `contentHash` (`400` otherwise). `text` is capped at 256 KB (`413`).
- **Who may call.** By default any signed-in caller; set `provenance.verify.access` to `public` to let third
  parties verify. The lookup is a membership oracle for a candidate text, so it has its own rate limit
  (`provenanceVerifyApi`, 60 per minute and client by default; **Admin → Security → Rate limits**), the request
  body is never logged, and the route is excluded from the audit log.
- Storage not ready answers `503`, never `found: false`.

## Configuration

```json
"provenance": { "retentionDays": 365, "storeRecords": true, "verify": { "access": "authenticated" } }
```

- `retentionDays`: records older than this are removed by a daily sweep. `0` or less keeps them forever.
- `storeRecords`: `false` still attaches the object everywhere but keeps no records, so nothing can be looked up.
- `verify.access`: `authenticated` (default) or `public`.

Edit these in `platform.json`; migration V243 writes the defaults.

## What is stored

One document per content hash in the `provenance-records` namespace of the [storage provider](storage.md),
holding up to the 20 newest records for that hash (the same text answered many times, such as "Yes", must not
grow a document without bound). Each record is the provenance object without `verify`: spec, generator, model,
`output_id`, `created_at`, `content_hash`. **No text, prompt, user, chat or run ID.**

A short text's hash can be guessed by someone with disk access. They learn only that this installation once
produced that string, with no attribution. With `chats.enabled: false` the store is the only trace of outputs;
set `storeRecords` to `false` if that is not acceptable.

**Scale.** The filesystem provider keeps one file per hash in one directory. That is comfortable to roughly
one to two million records, and the daily sweep reads every document; a retention below 365 days lowers the
bound. A database provider answers the lookup and the sweep natively.
