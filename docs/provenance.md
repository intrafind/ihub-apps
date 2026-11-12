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
  "content_hash": { "alg": "sha-256", "normalization": "nfc-trim", "value": "9f86d0…" }
}
```

| Field | Meaning |
| --- | --- |
| `output_id` | A sortable ID (ULID) allocated before the first byte of a response, so it can go into a header. Never derived from the content. |
| `generator.installation_id` | A random, stable, opaque ID (`inst_` + UUID), minted once and kept in the storage provider. Set `IHUB_INSTALLATION_ID` to manage it yourself. Copying `contents/` to a staging system copies it. |
| `model.id` | The model that answered. Workflows use `workflow:<id>`. |
| `model.watermark` | What the model declares about marking its output, see below. |
| `content_hash` | SHA-256 of the output text after the `nfc-trim` normalization. Missing when there is no text (a tool call only). |

The object carries no look-up URL: the address of an installation can change, so it is not stored. A client builds the URL from the public address of iHub plus the API path `/api/eu-ai-act/provenance/_verify` (see [Looking an output up](#looking-an-output-up)).

There is no `digital_source_type` for text (that vocabulary belongs to media) and no `signature`.

### `model.watermark`

Set per model with `contentMarking.text` (see [Models](models.md#output-marking-contentmarking)):

| `by` | Meaning | `applied` |
| --- | --- | --- |
| `none` (default) | No marking. | `false` |
| `provider` | The operator states that the provider marks the output (for example SynthID). | `true`, on the operator's written statement. iHub cannot check it. |
| `ihub` | iHub's own text watermark for self-hosted vLLM models ([Text Watermarking](ai-act-text-watermarking.md)). | `true` only when the request asked vLLM to mark and was neither greedy nor structured output; else `false` with a `reason` (`greedy`, `structured_output`, `no_active_key`). `key_id` names the key used. |

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
| Chat | On the stored assistant message (`provenance`) and on the `run/ended` event, live and in a replay of the run ledger. Under each finished answer an **AI generated: details** button (an info icon beside the "based on…" badge) opens the model (its display name and id), time, marking, a shortened content hash with **Copy hash**, and the output ID. An answer without the object (no text, or stored before this feature) shows no button; a stopped answer that had already written text does show it. |
> **Master switch.** While the [EU AI Act features are switched off](ai-act.md#switching-the-features-off) no record is made, no `provenance` member or `X-AI-*` header is sent and `_verify` answers `403 FEATURE_DISABLED`. Existing records are kept, expire on schedule and answer again after switching on.

| Inference API (`/api/inference/v1/chat/completions`, `/responses`) | A top-level `provenance` member, plus the headers `X-AI-Generated: true` and `X-AI-Content-Id: <output_id>`. See [OpenAI-compatible API](openai-compatible-api.md#provenance). |
| MCP | `_meta.provenance` on an app or workflow `tools/call` result. |
| A2A | `metadata.provenance` on the Task and on the response artifact. |

An output without text, and an error, carries none. Everything that runs through the chat engine is recorded:
web chat, scheduled tasks, apps called by tools, the inference API, MCP and A2A. Workflow runs and the
Slack and Teams integrations do not go through it and get no record yet.

## Looking an output up

`POST /api/eu-ai-act/provenance/_verify` takes a text or a hash:

```bash
curl -X POST https://ihub.example.com/api/eu-ai-act/provenance/_verify \
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

- **Watermark detection.** When no record matches a `text` and the caller is signed in, the answer also carries
  `watermark`: `{ "status": "detected" | "not_detected" | "too_short" | "unavailable" | "not_configured", "keyId?",
  "pValue?", "scoredTokens?", … }`. It comes from the detector of the models marked `by: "ihub"`, tried with the
  active and all retired keys; pass `modelId` to ask one model's detector only. "Not detected" and "Too short to
  tell" are not proof of human authorship. Details: [Text Watermarking](ai-act-text-watermarking.md).
- Send exactly one of `text` and `contentHash` (`400` otherwise). `text` is capped at 256 KB (`413`).
- **Who may call.** By default any signed-in caller; set `provenance.verify.access` to `public` to let third
  parties verify. The lookup is a membership oracle for a candidate text, so it has its own rate limit
  (`provenanceVerifyApi`, 60 per minute and client by default; **Admin → Security → Rate limits**), the request
  body is never logged, and the route is excluded from the audit log.
- Storage not ready answers `503`, never `found: false`.

## Configuration

```json
"provenance": {
  "retentionDays": 365,
  "storeRecords": true,
  "recordUser": "none",
  "verify": { "access": "authenticated" },
  "media": { "maxVerifyBytes": 52428800, "readC2pa": true }
}
```

- `retentionDays`: records older than this are removed by a daily sweep. `0` or less keeps them forever.
- `storeRecords`: `false` still attaches the object everywhere but keeps no records, so nothing can be looked up.
- `recordUser`: who a stored record names; see [Who a record names](#who-a-record-names). `none` (default),
  `anonymous`, `pseudonymous` or `identified`.
- `verify.access`: `authenticated` (default) or `public`.
- `media.maxVerifyBytes`: largest image or audio file `_verify` accepts (default 50 MiB, `413` above).
- `media.readC2pa`: read the C2PA manifest of generated images and uploaded files (default on).

Edit these in **Admin → EU AI Act → Provenance settings** or in `platform.json`; migrations V243, V244 and
V246 write the defaults.

## What is stored

One document per content hash in the `provenance-records` namespace of the [storage provider](storage.md),
holding up to the 20 newest records for that hash (the same text answered many times, such as "Yes", must not
grow a document without bound). Each record is the provenance object: spec, generator, model,
`output_id`, `created_at`, `content_hash`, and `user` only when `recordUser` asks for it (below). **No text,
prompt, name, email, chat or run ID.**

### Who a record names

`provenance.recordUser`:

| Mode | `user` in the record | |
| --- | --- | --- |
| `none` (default) | absent | The record describes the output only. |
| `anonymous` | `{ "mode": "anonymous", "id": "usr_<16 hex>" }` | A secured hash: the user id hashed with a secret only the server holds (the installation pepper `contents/.usage-pepper`, never shown in any UI or API). Records of one person share the value; the user cannot be determined from it. |
| `pseudonymous` | `{ "mode": "pseudonymous", "id": "<64 hex>" }` | A plain SHA-256 of the user id. Whoever knows a user id can compute it and attribute the record; the id cannot be read from it. |
| `identified` | `{ "mode": "identified", "id": "<user id>" }` | The user id, never name, email or groups. The records then hold personal data. |

- **Only in the stored record.** The provenance object in a chat message, an API response, an MCP or A2A
  result never carries `user`. `POST /api/eu-ai-act/provenance/_verify` returns it to admins only (the
  verification card on the EU AI Act page shows it); any other caller gets the record without it.
- **Applies from the moment it is saved.** Records already stored keep what they had.
- **Kept when a user is deleted**, like the rest of the record, until the retention period ends. With
  `pseudonymous` or `identified` the records hold personal data for that time: cover them in your data
  protection documentation.
- Machine callers (API keys, OAuth clients) are named by the id they act as; every anonymous visitor is `anonymous`.

A short text's hash can be guessed by someone with disk access. They learn only that this installation once
produced that string, with no attribution. With `chats.enabled: false` the store is the only trace of outputs;
set `storeRecords` to `false` if that is not acceptable.

**Scale.** The filesystem provider keeps one file per hash in one directory. That is comfortable to roughly
one to two million records, and the daily sweep reads every document; a retention below 365 days lowers the
bound. A database provider answers the lookup and the sweep natively.

## Images: provider marks (#3328)

iHub applies **no mark of its own** to images. The providers do: Gemini images carry SynthID in
the pixels, and some models (OpenAI gpt-image, Google models on Vertex) also embed a C2PA manifest. What iHub
does is (1) not destroy that mark, (2) record what the provider claims, (3) let anyone ask whether a file came
from this installation and what marks it carries.

### Bytes in, bytes out

Generated pictures pass through the server as the base64 string the provider sent: no decode, no encode, in
the stream, the artifact store, the serve routes, the share links, the ZIP and the download. The SHA-256 of
the original bytes equals that of the stored artifact and of the downloaded file, and a C2PA signature that
validates on the original validates on the download. This is a rule, not an accident: a test fails when an
image or audio library is imported on the server's request path.

Three places are not iHub's to control: a reverse proxy or CDN that optimises images (Cloudflare Polish or
Mirage, nginx `image_filter`, Azure Front Door; exclude `/api/chats/*/artifacts/*` and `/api/shares/*`), the
browser's "copy image", and Office when an add-in inserts a picture. PDF and Word exports are new derived
files, not the generated asset.

A picture a **user uploads** used to be re-encoded to JPEG in the browser, which drops C2PA and XMP and part
of a SynthID signal. A picture that is already within the upload size limit (`maxResizeDimension`, default
1024 px) and 4 MB, in JPEG, PNG, WebP or GIF, is now sent unchanged; larger ones are still resized.

### The record

Each generated image gets one record the moment it arrives, whether or not the artifact store keeps it (a 4K
PNG over the artifact cap is recorded, sent and not stored), and on every channel (chat, agents, workflows,
MCP, A2A). The SSE image delta and the stored message descriptor carry `provenance`, the object of a text
answer with `kind: "image"`, the model, the time and the hash of the raw bytes (the installation and the
provider marking are in the stored record, which is read after the picture was sent); the descriptor also
carries `outputId`. The MCP image block carries `_meta.provenance`; the A2A artifact `metadata.provenance`.

In the chat every generated picture has an **AI-generated image: details** button (an info icon next to
download and share) that opens the model, time, declared marking, a shortened hash with **Copy hash** and
the output ID, the same as under a text answer. A picture stored before this change has no button.

A media record is the usual provenance object with `kind: "image"`, `content_hash.normalization:
"none"` (the hash is over the raw bytes, not the base64 text), `content_hash.bytes` and `mime_type`, plus:

```json
"provider_marking": {
  "c2pa": { "present": true, "status": "present", "valid": true, "issuer": "Google LLC",
            "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
            "claimGenerator": "…", "signedAt": "2026-11-11T09:00:01Z", "trust": "not-evaluated" },
  "xmp": { "digitalSourceType": null },
  "declared": "synthid"
}
```

- `c2pa.status` is `present`, `absent`, `unsupported_format` or `unreadable`; `valid` is `true`, `false` or
  `null` (no manifest). `valid` means the signature and its binding to the file's bytes check out.
  **Trust is never evaluated**: a valid signature from an unknown signer is still `valid`, and the result
  always says `trust: "not-evaluated"`. It never says "authentic".
- `declared` is what **you** declared for the model (`contentMarking.image`, set in **Admin → Models**
  under *Image marking*, see [Models](models.md#output-marking-contentmarking)), never something iHub detected. SynthID has no public
  detector: iHub can say "declared", never "there is no SynthID".
- A record never holds the picture or audio.

### Verifying a file

`POST /api/eu-ai-act/provenance/_verify` with `multipart/form-data`, one `file` field (and an optional `kind` field,
`image` or `audio`, which must match the bytes):

```bash
curl -b cookies.txt -F "file=@picture.png" https://ihub.example.com/api/eu-ai-act/provenance/_verify
```

```json
{
  "found": true,
  "kind": "image",
  "normalization": "none",
  "contentHash": { "alg": "sha-256", "value": "…", "bytes": 1234567, "mimeType": "image/png" },
  "records": [ { "…": "provenance records, as for text, each with verify" } ],
  "c2pa": { "present": true, "status": "present", "valid": true, "issuer": "…",
            "digitalSourceType": "…", "claimGenerator": "…", "signedAt": "…",
            "trust": "not-evaluated", "xmpDigitalSourceType": null },
  "declared": "synthid",
  "technique": ["hash-lookup", "metadata"],
  "synthid": "declared-not-detectable",
  "caveats": ["trust-not-evaluated"]
}
```

- A miss is a `200` with `found: false` and no `records`; the `c2pa` read is still there, so a file generated
  elsewhere gets its manifest read. `caveats` then also holds `absence-is-not-proof`.
- Only generated images have records. An audio file gets its C2PA read and never a hash hit.
- `technique` names what produced evidence: `hash-lookup`, `metadata` (a C2PA manifest or XMP source type).
- `synthid` is `declared-not-detectable` when a matching record declares SynthID, else `not-detectable`.
- The type comes from the bytes (PNG, JPEG, WebP, GIF, BMP, TIFF, HEIC, AVIF; WAV, MP3, FLAC, OGG, M4A). SVG
  and anything else is `415`; more than one file is `400`; over `media.maxVerifyBytes` is `413`.
- The upload lives in memory only and is never logged or stored. The watermark detector is not called for
  files (it is for text only), so a public caller costs no detector call.
- The C2PA reader runs offline: remote manifests, OCSP and trust lists are switched off, so it makes no
  outbound connection and cannot bypass the SSL whitelist.

Real samples: CI has no Gemini or gpt-image key, so the tests use a signed upstream C2PA file and synthetic
fixtures. They prove that any provider C2PA is preserved, not what a provider really embeds. Generate one
image per provider model by hand and verify it once to find out; record the finding for your compliance file.
