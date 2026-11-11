# #3328 Provider marks on generated images and audio: PM and engineering analysis

Epic #3324 (EU AI Act Art. 50). Stack position: after #3331, before #3329. Repo state read: `/workspace/ihub-apps` (no `server/services/provenance/` yet; the records, store and verify route arrive with #3327/#3331, so everything below is written against their announced interface). Latest migration in this checkout is V240.

---------------------------------------------------------------------------------------------------

# Part 1 - Product Manager

## 1.1 What and why

- Art. 50(2) requires machine-readable marking and detectability of generated images and audio, not just text. CoP 1.1.1/1.1.2 asks for signed metadata plus a watermark for these formats; CoP 1.2 forbids removing existing marks of content we transform.
- Providers already mark their output: Gemini images carry SynthID (invisible); Nano Banana Pro via Vertex and OpenAI gpt-image carry a C2PA manifest. Our job in this issue is cheap and bounded: (a) do not destroy those marks, (b) record what the provider claims, (c) let `/api/provenance/verify` answer "did this file come from this installation, and what marks does it carry?".
- Why it matters commercially: it lets us say "relying on upstream marking, with evidence" (CoP 4.2 allows relying on upstream), without building signing infrastructure (#2814, #3330).

## 1.2 User stories

1. As a compliance officer (provider/operator of an iHub installation), I want generated images to keep their provider C2PA/SynthID/XMP end to end, so that we are not the party that removed a mark (CoP 1.2).
2. As a compliance officer, I want a provenance record per generated image and TTS clip (hash, model, time, provider marking), so that I can show what we generated and what marking we relied on.
3. As a third party (journalist, platform, customer) or an admin, I want to upload an image or audio file to `/api/provenance/verify` and learn whether this installation generated it and whether it carries a C2PA manifest, so that I can assess provenance.
4. As an admin, I want to declare per model what the provider marks (SynthID, with a written statement reference), so that "declared" is a documented fact, not a guess.
5. As an admin of the overview page (#3329), I want the verification card to show the C2PA result, so that one page covers text, image and audio.

## 1.3 Success criteria (testable)

- Bytes in = bytes out: for a generated image, SHA-256 at provider response == SHA-256 of the SSE payload == SHA-256 of the stored artifact == SHA-256 of `GET /api/chats/:chatId/artifacts/:id` == SHA-256 of the downloaded file. C2PA hard-binding validation of the downloaded file passes exactly when it passes for the original.
- Each generated image has exactly one record carrying `provider_marking`; the record never contains the bytes.
- Verify finds a generated image by its bytes (hash hit) and returns the C2PA read result for any uploaded image or audio file, also when there is no hash hit (an image generated elsewhere).
- A negative control proves the test is meaningful: re-encoding the fixture (flip one byte) makes validation report a mismatch.
- No new outbound connection bypasses `ssl.ignoreInvalidCertificates` / `ssl.domainWhitelist` (the C2PA reader must not fetch anything).

## 1.4 Non-goals

- No own C2PA signing, no own image/audio watermark (TrustMark, Pixel Seal), no certificate management (#2814, #3330).
- No SynthID detection (Google detection is a partner preview).
- No C2PA trust-list evaluation (we report the signer the manifest claims, not "trusted").
- No video. No exports (PDF/DOCX derive new files; they are not the generated asset).
- No new UI beyond what #3327/#3329 show; we only add fields.

## 1.5 Ambiguities, decisions needed, risks

| # | Item | Recommendation |
|---|------|----------------|
| A1 | **Only Gemini images are generated today.** `images` are produced only in `server/adapters/toolCalling/GoogleConverter.js:348-361` (non-stream) and `:423-436` (stream). No OpenAI/gpt-image path exists in this checkout, and the epic #2799 "Media generation" is not present (no hits in `concepts/`, `docs/`, `server/`). | gpt-image support belongs to #2799. #3328 must be provider-neutral at the `images[]` seam so that #2799 plugs in without changes. The "gpt-image sample" test can only be a file fixture until then. Confirm with the owner of #2799 where its output enters (it must go through `ResultAccumulator`, see 2.2). |
| A2 | **SynthID is "declared", never "detected".** `declared` must come from admin config plus a written statement (CoP 4.2), not from the response (Gemini responses carry no flag). | New per-model `contentMarking.image` / `contentMarking.audio` (same shape as #3327's `contentMarking.text`). Do not claim SynthID silently: a migration may preset `by: "provider", scheme: "synthid"` for Google image/TTS models without `statementRef`, which #3329 shows amber. PM to decide preset vs. opt-in. |
| A3 | **"Real Gemini sample / real gpt-image sample" cannot be produced in CI** (no network, no keys, paid APIs). | Acceptance is met with committed fixtures: (a) upstream-signed C2PA fixtures for the reader (2.7), (b) one tiny real Gemini image and one real gpt-image image generated once by a maintainer and committed (<=30 KB each, REUSE-annotated). Without (b) we only prove "we preserve any C2PA", not "we preserve what Google/OpenAI really emit". An optional manual test `PROVENANCE_REAL_SAMPLES=1` may call the APIs. PM decides whether (b) is required for the AC. |
| A4 | **Whether the Gemini API response really carries C2PA is unverified** (the concept doc says "check"). `concepts/2026-09-27 EU AI Act Content Marking.md` §5.2 lists it as open. Gemini image output via the Gemini API may be SynthID only. | The one-time real sample in A3(b) settles it; document the finding in `docs/`. Record `c2pa.present:false` honestly when absent. |
| A5 | **TTS audio is a raw PCM stream that is never stored and has no container.** `/api/voice/speech` streams headerless `pcm_s16le` (`server/routes/voiceRoutes.js:226-251`, `server/tts/index.js` `TTS_AUDIO_ENCODING`); the browser plays it, there is no download. It cannot carry C2PA/XMP at all, and SynthID (if the provider applies it) is in the signal. Art. 50 guidelines para 88 (ephemeral real-time content) may exempt it (concept doc §4); legal to confirm. | Scope TTS to: do not transcode (already true), record hash of the PCM per request, `c2pa.present:false`, `declared` from model config. Mark as Should, not Must. State plainly in docs that hash lookup only matches a captured raw PCM or a WAV wrapper of it (2.5). |
| A6 | **Volume of TTS records:** the client calls `/api/voice/speech` per speakable chunk, so one answer yields many records. | Platform switch `provenance.media.recordTts` (default on, record is ~0.4 KB, retention sweep applies). PM may prefer default off. |
| A7 | **Upload size for verify.** Provider images reach 5-25 MB (4K PNG); the artifact store cap is 10 MiB of base64 (`DEFAULT_MAX_ARTIFACT_BYTES`, `server/services/artifacts/artifactPolicy.js:~33`), so big images are NOT stored but must still be recorded and verifiable. TTS WAVs can be ~58 MB (20,000 chars at 24 kHz s16 mono). | `provenance.media.maxVerifyBytes`, default 50 MiB, 413 above. Record at generation time, not at storage time (2.2). |
| A8 | **Trust.** A valid C2PA signature from an untrusted/unknown CA is still "valid". We do not evaluate the trust list. | UI/API wording: "signed by <issuer> (trust not evaluated)". Never write "verified authentic". |
| A9 | **Adjacent finding, CoP 1.2 on inputs:** the client re-encodes every uploaded image through canvas to JPEG (`client/src/features/upload/utils/fileProcessing.js:513-529`, called at `:657`; default `resizeImages: true`, 1024 px). A user who re-uploads a Gemini image for editing loses C2PA/XMP and part of SynthID. | Not in the issue text, but it is the one real "strip" point in the product. Recommend a small follow-up in this issue: skip the canvas when the image is already within `maxResizeDimension` and size limits (send original bytes). PM decides: include, or separate ticket. |
| A10 | **Endpoint naming:** the epic fixes `POST /api/provenance/verify`; `docs/api-guidelines.md` section 1 wants `_verify` for non-CRUD actions. The linter `scripts/check-api-guidelines.js` (`ACTION_VERBS`) does not list `verify`, so CI will not object. | Decide once for #3327/#3331/#3328/#3329 (stack-wide). This document uses the epic's spelling. |
| A11 | **Who may call verify, and abuse.** Multipart upload to a public endpoint is a memory/CPU DoS surface (CoP 2.1.2 wants access suitable for the audience, may be limited in professional settings). | Follow #3327's auth decision; additionally apply the existing rate limiters (`server/middleware/rateLimiting.js`) and the size cap. Zero retention of uploaded content (CoP 2.1.3): never write the upload to disk. |

---------------------------------------------------------------------------------------------------

# Part 2 - Senior Engineer: how

## 2.1 Verdict on the pipeline

Today nothing in the server re-encodes a generated image. `sharp`, `jimp`, `canvas`, `image-size` are not server dependencies (only `pngjs`, used for OCR/PDF pages, `server/package.json:74`). The path is base64 string pass-through. So "preserve" is mostly a **regression guard plus a record**, not a refactor. Strip risk lies in the client upload path (A9), proxies/CDNs, and future code.

## 2.2 Every place a generated image or audio touches (and what could strip)

| # | Place | File:line | Strips today? | Action |
|---|-------|-----------|---------------|--------|
| 1 | Gemini response -> `images[]` `{mimeType, data(base64), thoughtSignature}` | `GoogleConverter.js:348-361`, `:423-436` | No. Thought images skipped by design. | Keep. Add provider-neutral note: any future provider (#2799) must emit the same `images[]` shape unchanged. |
| 2 | Accumulation `ResultAccumulator.push` | `server/services/loop/LLMClient.js:267` (called at `:1009`/`:1053`/`:1058` BEFORE `yield chunk`, so `onChunk` sees the mutated image objects) | No | **Hook point.** Stamp each image here (has `this.meta.model`, `runId`): `{ outputId, sha256 }` and kick off the record (2.4). One funnel for chat, agents, workflows, MCP, A2A. |
| 3 | Agent loop collect | `AgentLoop.js:645` | No | Nothing; stamps travel with the objects. |
| 4 | SSE delta (image) | `server/services/chat/chatChannel.js:73-92` | No (copies `mimeType`, `data`, `thoughtSignature`) | Add `provenance: { outputId, contentHash }` to the `image` object (server decides, client renders; CLAUDE.md rule). Never mutate `data`. |
| 5 | Chat store: `storeGeneratedArtifacts` -> `ArtifactRepository.put` | `chatMaterializer.js:153`, call at `:628`; `ArtifactRepository.js:259-311` (`toPayload` base64 -> raw Buffer, `blobs.put`, records `sha256`) | No. Size cap: refuses > 10 MiB base64 (`unavailable: 'too-large'`) and > 8 per batch. | Add `outputId`/`provenanceId` to the descriptor. Record exists even when storage refuses (record at #2, not here). Optionally assert in a test that `ref.sha256` equals the record hash. |
| 3b | `artifactMediaType` / kinds | `artifactPolicy.js:75-100` | n/a | No `audio` kind exists; add only if #2799 stores audio. |
| 6 | Serve artifact | `server/routes/chats.js:410-446` (`res.send(artifact.data)`, `nosniff`, immutable) | No. `compression` middleware (`server/middleware/compression.js`) is lossless transfer coding. | Keep. Add a route test (2.7). |
| 7 | Shared artifact serve + ZIP | `server/routes/chatShares.js` (`/api/shares/:shareId/artifacts/:id`), `artifactZip.js` | No (lossless) | Include in the bytes-equal test. |
| 8 | MCP result | `server/services/mcp/McpServerService.js:604-625` (`{type:'image', data, mimeType}`) | No | Add `_meta.provenance` per #3327 for images. |
| 9 | A2A result | `server/services/mcp/a2aHandler.js:428-460` (`fileArtifactsOf`) | No | Add `metadata.provenance`. |
| 10 | Client live render | `client/src/features/chat/components/GeneratedImage.jsx:~118-120` (`data:` URI), stored via `fetchChatArtifact` blob + `URL.createObjectURL` (`:~86`) | No | Keep. |
| 11 | Client download | `GeneratedImage.jsx:~178-181` (anchor on the same `src`) | No (original bytes) | Keep. Never switch to canvas `toBlob`. |
| 12 | Client base64 -> Blob | `client/src/features/chat/utils/artifactFiles.js:~286-297` (`atob`) | No | Keep. |
| 13 | **Client upload canvas re-encode (INPUT)** | `client/src/features/upload/utils/fileProcessing.js:513-529`, `:657`; TIFF path `:~440-470`; PDF page raster `:1186` | **Yes**, always JPEG-recompresses uploaded images, drops C2PA/XMP | A9: skip canvas when no resize needed; keep original `File` bytes. Pitfall: the server stores user pictures raw (`ChatFileService.js:~771`, `rasterImage.js` sniff only), so original bytes would then reach the model and the stored thumbnail. Check model token/size limits. |
| 14 | Server-side exports (chat -> PDF/DOCX) | `server/routes/exports.js`, `services/documents/*` (`pdfmake` re-encodes PNG, DOCX keeps bytes) | PDF: yes (new derived file) | Out of scope; document as "derivative, not the generated asset". |
| 15 | TTS: Google | `server/tts/googleTtsProvider.js:~277` (`inlineData.data` -> PCM, `createPcm16Aligner` only aligns bytes) | No | Keep passthrough. |
| 16 | TTS: Mistral | `server/tts/mistralTtsProvider.js:~60-75` float32 LE -> int16 LE | Sample-level conversion (inherent, no container to strip) | Document. `declared: null` for Mistral unless admin states otherwise. |
| 17 | TTS route | `voiceRoutes.js:132` (route), `:226-239` (`start()` headers), `:248-251` (`onAudio`), `:300` (`res.end()`) | No | Add `X-AI-Content-Id` in `start()`; incremental SHA-256 inside `onAudio`; write record after `:300`. |
| 18 | Deployment layer | Reverse proxy/CDN image optimisation (Cloudflare Polish/Mirage, nginx `image_filter`, Azure Front Door) | Possible | `docs/` deployment note: exclude `/api/chats/*/artifacts/*` and `/api/shares/*` from image optimisation. `docker/nginx.conf` has none today. |
| 19 | Browser "copy image" / Office add-in insert | Browser/Office re-encode | Possible, not ours | Document as out of our control. |

Rule to add to `docs/` and a code comment at #2: **no image or audio decode/encode between the provider response and the final response, ever.** Back it with a static test (2.7, "guard").

## 2.3 C2PA reading options in Node

| Option | Licence | Binary / install impact | Verdict |
|--------|---------|-------------------------|---------|
| **`@contentauth/c2pa-wasm` 0.14.0** (wasm-bindgen build of c2pa-rs, `WasmReader.fromBytes(format, bytes, contextJson)`) | MIT (c2pa-rs itself is MIT OR Apache-2.0) | **No native binary, no postinstall, no JS deps.** One 9 MB `c2pa_bg.wasm` (npm unpacked 9 MB). Pure ESM. Its d.ts states `fromBytes` uses no browser-only APIs and works on Node, Deno, Bun. Works identically on Alpine/musl, Windows, macOS, linux-arm. | **Recommended.** |
| `@contentauth/c2pa-node` 0.10.1 (Rust napi) | MIT | **Postinstall downloads a prebuilt `index.node` from the network** (`scripts/postinstall.cjs`, via `node-fetch`), 51 MB per platform. Targets only `*-linux-gnu`, apple darwin x64/arm64, `x86_64-pc-windows-msvc`; **no musl**, so our `node:alpine` image (`docker/Dockerfile:8,74`) would fall back to a Rust source build. Extra prod deps (`node-fetch`, `unzipper`, `cargo-cp-artifact`, ...). `npm install --omit=dev` in `build-sea.cjs:504` would need network per CI OS and break offline installs; also needs Node >=22 patched releases. | Rejected for reading. Better API (signing, trust) but we do not sign. |
| `@contentauth/c2pa-web` 0.16.1 | MIT | Browser/Worker wrapper around the same wasm | Not needed. Use the wasm package directly. |
| Own minimal presence parser | ours | zero deps | **Fallback** |

Licensing: iHub's licence (`LICENSES/LicenseRef-iHub-Apps.txt`, BSD-3 style plus attribution) is compatible with an MIT dependency. `node_modules` is outside REUSE; only files we vendor into the repo (fixtures, the optional copied wasm) need a `REUSE.toml` annotation with original copyright and `MIT OR Apache-2.0` (see the Adobe fixture note in 2.7). Keep the exact version pinned (0.x API churn); add to the server `package.json`, not the client.

SEA/Docker impact (recommended option): `build-sea.cjs` copies `server/node_modules` after `npm install --omit=dev` per OS, so the wasm file simply travels with it; nothing in `build-sea.cjs` changes. Resolve the wasm file with `createRequire(import.meta.url).resolve('@contentauth/c2pa-wasm/c2pa.wasm')` (the package exports `./c2pa.wasm`) and `initSync({ module: fs.readFileSync(path) })`, lazily on first use, singleton. Docker image grows by ~9 MB. Check `server/sea-server.cjs` still resolves it (the dist runs from a `node_modules` directory, not a single blob).

**Unverified:** this environment refused to execute downloaded package code, so the wasm reader was not run. The API surface above is read from the published `c2pa.d.ts`. Step 1 of the checklist is a 1-hour spike on Node 24 (load, read a fixture, time a 25 MB file, memory). If the spike fails, use the fallback.

Critical config (CLAUDE.md "Outbound Connections"): the c2pa-rs reader can fetch remote manifests and OCSP/timestamp data through the platform `fetch`, which would bypass `httpFetch()` and the SSL whitelist. Pass a context that disables all of it: `{ verify: { remote_manifest_fetch: false, ocsp_fetch: false, verify_trust: false } }` (setting names from c2pa-rs `Settings`; confirm against 0.14 in the spike). A remote-only manifest then yields `present: true, remote: true, validated: false`. Add a test that stubs `globalThis.fetch` to throw while reading a fixture, so any future fetch fails CI. This is the "whitelisted and non-whitelisted host" requirement satisfied by construction: there is no outbound connection.

**Fallback (`present` only, ~120 lines, `server/services/provenance/c2paPresence.js`):**
- JPEG: scan segments; an APP11 (`0xFFEB`) segment starting `JP` followed by a JUMBF `jumb` box whose `jumd` label is `c2pa` (verified in `C.jpg`/`CA.jpg` upstream fixtures: two APP11 segments with `JP`).
- PNG: chunk `caBX`. WebP/WAV (RIFF): chunk `C2PA`. HEIC/AVIF/MP4/M4A (ISOBMFF): `uuid` box `d8fec3d6-1b0e-483c-9297-5828877ec481`.
- Plus read `Iptc4xmpExt:DigitalSourceType` from the XMP packet (APP1 in JPEG, `iTXt` in PNG), plain text, gives `digitalSourceType` without C2PA parsing.
- Output `{ present, validated:false, issuer:null, digitalSourceType: <xmp or null> }`.

## 2.4 Data: record shape

New module `server/services/provenance/mediaMarking.js` (SPDX header; ESM). Extends the #3327 record (same store, `output_id`, `created_at`, `generator`, `model`); media-specific part:

```json
{
  "spec": "intrafind-provenance/1.0",
  "ai_generated": true,
  "kind": "image",
  "output_id": "01JC...",
  "created_at": "2026-11-11T09:00:00Z",
  "generator": { "product": "iHub Apps", "version": "x.y.z", "installation_id": "..." },
  "model": { "id": "gemini-3-pro-image", "provider": "google",
             "watermark": { "by": "provider", "scheme": "synthid", "applied": true, "statementRef": "https://..." } },
  "content_hash": { "alg": "sha-256", "normalization": "none", "value": "<hex of raw bytes>", "bytes": 1234567, "mime_type": "image/png" },
  "provider_marking": {
    "c2pa": { "present": true, "status": "present", "valid": true, "issuer": "Google LLC",
              "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
              "claimGenerator": "...", "signedAt": "2026-11-11T09:00:01Z", "trust": "not-evaluated" },
    "xmp": { "digitalSourceType": null },
    "declared": "synthid"
  }
}
```

- `provider_marking.c2pa.status`: `present | absent | unsupported_format | unreadable`; `valid`: true/false/null (null when absent). `issuer` from the manifest's signature certificate subject; `digitalSourceType` from the `c2pa.actions` assertion (`c2pa.created`) or XMP fallback.
- `declared` = `model.contentMarking[kind].scheme` when `by === "provider"`, else `null`. Single source of truth; do not duplicate the statement in the record.
- Audio (TTS): `kind: "audio"`, `content_hash.normalization: "none"`, hash over the exact `pcm_s16le` bytes streamed, plus `container: { encoding: "pcm_s16le", sample_rate: 24000, channels: 1 }`; `c2pa.status: "unsupported_format"`.
- Never store bytes or base64 (test, as in #3327). Index by `content_hash.value` so verify is O(1); #3327's store must expose `findByHash(hex)` and accept `normalization: "none"` (confirm with #3327; text uses `nfc-trim`).
- Do the C2PA read **after** the bytes are delivered (do not delay SSE): the stamp (`outputId`, hash; SHA-256 of 5 MB is ~10 ms) is synchronous in `ResultAccumulator.push`; the manifest read and record write run in the same tick chain but are awaited before `run/ended`, best effort (a failure costs the record, never the answer, as `storeGeneratedArtifacts` does).
- Model config (schema is `.strict()`, `server/validators/modelConfigSchema.js`): extend #3327's `contentMarking` with `image` and `audio` siblings `{ by: 'provider'|'none', scheme?: 'synthid'|string, statementRef? }`. A migration (`create-migration` skill) presets Google image/TTS models; take the next free number at rebase (V241+; the issues say "after V226", which is stale).
- Platform config (`server/validators/platformConfigSchema.js`, next to the `provenance` block from #3327): `provenance.media: { maxVerifyBytes: 52428800, recordTts: true, readC2pa: true }` with `prefault`s.

## 2.5 `POST /api/provenance/verify` for files

Same route as #3327 text/hash lookup; content negotiation, no second endpoint:
- JSON body `{ text | hash }` unchanged. `multipart/form-data` with one `file` field (and optional `kind`) for media. Any other content type -> `415 UNSUPPORTED_MEDIA_TYPE` (registry code exists, `shared/apiErrors.js:31`).
- Parsing: reuse the existing pattern, not a new library. `multer.memoryStorage()` with `limits: { fileSize, files: 1, fields: 10 }` exactly as `server/services/chatFiles/fileUploadRequest.js:44-76` (`parseChatFileMultipart`) and `server/routes/inference/files.js:55-80` do; throw `ServiceError('PAYLOAD_TOO_LARGE'|...)` on `LIMIT_FILE_SIZE` (413), `BAD_REQUEST` on count/format. Do not copy-paste a third version: extract `parseSingleFileMultipart(req, res, maxBytes)` next to `fileUploadRequest.js` only if cheap; otherwise import it (its quota error is chat-specific, so map to `PAYLOAD_TOO_LARGE`).
- Size: `provenance.media.maxVerifyBytes`, default 50 MiB. Memory only, never on disk (CoP 2.1.3 zero retention). Optionally pass through the active content scanner like `ChatFileService.js:~190`.
- Mime sniffing: never trust the client type. Images: reuse `sniffRasterImage` (`server/services/chatFiles/rasterImage.js:43`; PNG/JPEG/GIF/WebP/BMP). Extend with HEIC/AVIF/TIFF only for the verify path (put the wider sniffer in `provenance/`, do not widen the chat upload allowlist). Audio: add RIFF/WAVE, MP3 (`ID3` or `0xFFEx`), FLAC `fLaC`, OGG `OggS`, M4A `ftyp`. Unknown -> `415`. SVG is never accepted (script risk, same reasoning as `artifactPolicy`).
- Algorithm: (1) SHA-256 of the whole file -> `findByHash`; (2) for audio also hash the PCM payload of a WAV (`data` chunk) and of a raw file, because our TTS record hashes raw PCM (a user who wraps the PCM in a 44-byte WAV header would otherwise never match); (3) C2PA read (wasm; fallback parser). Steps 1 and 3 are independent: a miss in 1 still returns 3.
- Response (200; always a result, "not found" is a result, not a 404, as for `_test` in the guidelines):
```json
{ "kind": "image", "content_hash": { "alg": "sha-256", "value": "..." },
  "record": { "...provenance record or null" },
  "c2pa": { "present": true, "status": "present", "valid": true, "issuer": "...", "digitalSourceType": "...", "trust": "not-evaluated" },
  "declared": "synthid", "technique": ["metadata", "hash-lookup"], "synthid": "declared-not-detectable" }
```
  `technique` names what found it (CoP 2.3). `declared` is only available on a hash hit (it comes from the record), else `null`; never say "no SynthID" for a miss: say `synthid: "not-detectable"`.
- Errors: only `ServiceError` with registry codes (`shared/apiErrors.js`); add `UNSUPPORTED_MEDIA_TYPE`-style detail naming the accepted types. No `{ success }`. Pitfall: `scripts/check-api-guidelines.js` rule `hand-rolled-error` forbids `res.status(x).json({ error })`.
- Do not wait on the reader for > a few seconds: run it behind an `AbortSignal.timeout` equivalent (wasm is synchronous CPU; keep the size cap as the guard; consider a `worker_threads` worker later, not now).

## 2.6 Docs, changelog, UI

- `docs/models.md` (new `contentMarking.image/audio` fields), `docs/text-to-speech.md` (audio is not stored, hash-only, why), a short "Provider marks on images and audio" section in whatever doc #3327 creates for provenance (do not create a new file unless it must be added to `docs/SUMMARY.md`). Include the A9/18/19 deployment and "do not re-encode" notes and the A4 finding about what Gemini/OpenAI really embed.
- `docs/releases/next/features.md` via the `/document-feature` skill (admin- and user-visible). A9, if done, also gets a `fixes.md` entry.
- i18n: keys in `shared/i18n/en.json` and `de.json` for the verify card wording (#3329 renders). Result text must say "trust not evaluated" (A8).
- All new `.js` files get the two-line SPDX header (`reuse annotate ...`); the fixtures go into `REUSE.toml`.

## 2.7 Tests (`server/tests/`, Jest ESM; `npm run test:server`)

Fixtures, all synthetic or upstream-licensed, no network:
- **C2PA with a manifest, offline:** vendor one upstream c2pa-rs fixture (`sdk/tests/fixtures/C.jpg`, 132 KB, 2 APP11 JUMBF segments, downloaded and structure-checked here; or `CA.jpg`, 166 KB) into `server/tests/fixtures/provenance/`, annotate in `REUSE.toml` as Adobe, `MIT OR Apache-2.0` (check the upstream repo's licence files and copy the text into `LICENSES/` if `reuse lint` requires it). This is a real signed manifest, so the reader result, `valid`, and the hard-binding negative control are real.
- **Synthetic fixtures** (checked in as tiny base64 strings in a helper, no licence issue): a 1x1 PNG with a hand-built `caBX` chunk (for the fallback parser), a JPEG with an XMP packet carrying `DigitalSourceType`, a plain PNG (absent), a WAV with a `C2PA` chunk, a 1 s `pcm_s16le` buffer and its WAV wrapper. Optionally generate a freshly signed manifest at test time with `WasmBuilder` + a JS signer callback (its `SignerDefinition` is `{ sign(bytes), reserveSize, alg }`); only if the spike shows the certificate chain can be supplied offline, otherwise skip.
- **Provider-shaped samples (A3b):** `gemini-image-sample.png` and `gpt-image-sample.png`, produced once manually, committed, with a README stating how.

Tests:
1. `mediaMarking.test.js`: reader on each fixture -> `status`, `issuer`, `digitalSourceType`, `valid`; one flipped byte -> `valid:false` (negative control); remote-only manifest does not call `fetch` (stub `globalThis.fetch` to throw); fallback parser agrees on presence for the same fixtures; `declared` follows model config.
2. `generated-image-bytes-preserved.test.js`: feed a fixture as `chunk.images` through `ResultAccumulator.push` -> `createChatChannel.onChunk` (SSE payload `data` identical string) -> `storeGeneratedArtifacts` with an in-memory store -> `GET /api/chats/:chatId/artifacts/:id` (supertest as in `chat-persistence-artifacts.test.js`) -> SHA-256 equal at every hop and C2PA `valid` after. Same for the share route and ZIP.
3. Record written once per image, contains no `data`/base64 (deep-scan keys and values), exists when the artifact is refused for size (`too-large`).
4. `provenance-verify-media.test.js`: multipart upload of the generated bytes -> hash hit with record; of an unknown image -> `record:null` plus C2PA result; oversize -> 413; non-media/SVG/spoofed `Content-Type` -> 415; two files -> 400; JSON path unchanged.
5. TTS: extend `server/tests/tts-speech-route.test.js` / `googleTtsProvider.test.js`: the response carries `X-AI-Content-Id`, the record hash equals SHA-256 of the streamed bytes, WAV-wrapped upload verifies to the same record, aborted stream writes no record (`recordTts:false` writes none).
6. **Guard test:** read `server/services/**`, `server/routes/**`, `server/adapters/**` sources and fail if they import `sharp|jimp|canvas|jpeg-js|upng-js` (allowlist `pngjs` in the OCR/PDF files). Cheap regression insurance for the invariant in 2.2.
7. Migration test following `server/tests/migration-v103.test.js`.
8. Client: unit test for the A9 change (no canvas when under the limit) in `tests/unit/client/`.

## 2.8 Pitfalls

- **Hash identity:** hash the decoded raw bytes, not the base64 text; the same bytes via `toPayload` (`Buffer.from(data,'base64')`) and `Buffer.byteLength(data,'base64')` stay consistent. Do not hash after any "cleanup" of `data` (whitespace, URL-safe alphabet).
- **Dedup:** the same image served many times must not create records; only generation creates one (stamp `outputId` once, idempotent on `image.provenance`). A regenerated turn creates a new output (new bytes).
- **`thoughtSignature`:** irrelevant to marks; do not move it into the record.
- **Record before storage:** storage can refuse (size/count/disabled), and non-chat channels (MCP/A2A/agents/workflows) never call `storeGeneratedArtifacts`.
- **Memory:** verify upload (<=50 MiB) is copied into wasm memory (about 2x), plus 9 MB module; cap concurrency (rate limiter) and never log buffers (`logger` calls: sizes only).
- **Wasm on the main thread** blocks the event loop for the parse; fine at these sizes, note for later.
- **C2PA "valid" semantics:** validity = signature + data-hash binding, not trust. Providers rotate certs; do not fail on an expired or unknown CA, report `trust: "not-evaluated"`.
- **`image/jpg` alias** and `servedMediaType` (`artifactPolicy.js:150-170`): keep mime canonicalisation out of the hashed bytes.
- **#3327 coupling:** records store, `findByHash`, `normalization:"none"`, the `provenance` config block and verify route shape come from #3327/#3331; if they land differently, only `mediaMarking.js` glue and 2.5 change.
- **Gemini 4K PNGs exceed the artifact cap**; they are recorded and sent via SSE but not stored. Verify still works from the record.
- **Audio kind in `ARTIFACT_KINDS`** is absent; if #2799 stores audio it must add one, and the record writer must not depend on storage.

## 2.9 Ordered implementation checklist (rough size)

1. Spike (S, 1 h): `@contentauth/c2pa-wasm` on Node 24 in a scratch dir: load via `initSync`, read upstream `C.jpg`, flip-byte negative control, time and memory at 25 MB, confirm the context setting names that disable remote/OCSP/trust, confirm `signature_info.issuer` and the `c2pa.created` action shape. Decide wasm vs. fallback.
2. `c2paReader.js` (reader wrapper, lazy singleton, no network, size guard) + `c2paPresence.js` fallback + sniffers; unit tests and fixtures with REUSE entries (M).
3. `mediaMarking.js`: build `provider_marking`, record builder, `declared` from model config (S-M); depends on #3327 store.
4. Model schema + platform config + migration + `docs/models.md` (S-M).
5. Stamp and record at `ResultAccumulator.push` (`LLMClient.js:267`), `provenance` on the SSE image delta (`chatChannel.js:73-92`), descriptor id in `chatMaterializer.js`, MCP `_meta` (`McpServerService.js:604`), A2A `metadata` (`a2aHandler.js:428`) (M).
6. TTS: id header in `start()` (`voiceRoutes.js:226`), incremental hash in `onAudio` (`:248`), record after `:300`; `recordTts` switch (S-M).
7. Verify route: multipart branch, sniffers, WAV payload hash, response shape, errors, rate limit (M).
8. Bytes-preserved and guard tests, TTS tests (M).
9. A9 client fix, if the PM includes it (S-M, risk: input size and token limits).
10. Docs, `docs/releases/next/`, i18n keys, `npm run lint:fix && npm run format:fix`, `timeout 10s node server/server.js` boot check (S).

Total: roughly 5-7 engineer-days if #3327/#3331 land as described; 1 day extra for A9; +1 day if the manual real-sample generation and legal wording need iteration.
