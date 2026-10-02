# EU AI Act Transparency (Art. 50)

iHub Apps implements the transparency duties of Article 50 of the EU AI Act: people are told they are talking to an AI, and everything iHub generates carries machine-readable marks that iHub itself can detect. This page explains what iHub does, how to configure it, and where the gaps are.

> This is an engineering description, not legal advice. Have your legal or compliance team confirm your role (provider or deployer) and the exemptions you rely on. The design background is in `concepts/2026-09-27 EU AI Act Content Marking.md`.

## At a glance

| Duty | What iHub does | Where you configure it |
| --- | --- | --- |
| **50(1)** tell people they interact with an AI | Notice before the first message, persistent "AI" badge at the input, "AI generated" chip on every answer, a system-prompt guardrail ("admit being an AI when asked"), periodic reminders in sensitive apps, AI labels on Jira comments, Outlook inserts, workflow HTTP requests and shared chats | Admin → EU AI Act → Settings; per app in the app editor |
| **50(2)** mark output machine-readably and make it detectable | Images: signed C2PA manifest + TrustMark invisible watermark + XMP. Exports: signed iHub manifest + format metadata + visible label. Text: vLLM watermark for self-hosted models; a signed text signpost in text exports. A provenance record per output. `/verify`, `POST /api/provenance/verify`, `ihub verify` | Admin → EU AI Act (Settings, Certificates, Detection, Models) |
| **50(4)** deployer labelling | Visible export label, optional EU-style "AI" icon, "human reviewed" flag with the editorial-responsibility contact | Export dialog; Settings |
| **50(5)** accessible information | Labels, badges and detection results with text, icons and ARIA attributes (WCAG 2.1 AA) | — |

All of this is behind the feature flag **EU AI Act Transparency** (`aiTransparency`, category AI, **on by default**). Switching it off makes the installation non-conforming, and the EU AI Act page says so.

## Your role: provider or deployer

- Whoever puts iHub into service **under their own name or trademark**, or runs a **modified** iHub under their own name, is the **provider** of that installation (Art. 3(3)). Providers carry the 50(1) and 50(2) duties.
- A company that runs iHub **unmodified** under its authority, without its own name on it, may be a **deployer**. Deployers carry 50(4).
- iHub's own planning treats every self-installer conservatively as a provider. That is why every compliance feature is available in every installation and the defaults are compliant.

Record your role and legal entity under **Admin → EU AI Act → Settings → Provider details**. They appear in records, in the signing certificate of a new installation and in the compliance report. See the [Compliance Kit](eu-ai-act-compliance-kit.md) for what each role has to do outside the software.

## The EU AI Act page

**Admin → EU AI Act** (`/admin/eu-ai-act`) shows whether the installation conforms and where to fix it:

- **Overview**: a traffic-light checklist — disclosure, signing certificate, image marking, server-side exports, detection, text watermarking per model, signpost, provider details, editorial responsibility, terms of service, provenance records — each with a link to the place it is fixed. Below it, the warnings.
- **Models**: the marking capability registry (see [Models](#models-the-marking-registry)).
- **Apps**: disclosure status, opt-outs and exemptions per app.
- **Settings**, **Certificates**, **Detection**: described below.
- **Compliance report**: a signed PDF of the current state.

### Start-page warnings and dismissals

When the installation does not conform, admins see a banner on the start page and on the admin overview (never non-admins). Warnings about **models** (no text marking, missing key group), **certificates** (expiring, expired, missing) and **apps** (temperature 0) can be dismissed with a justification of at least 10 characters. The dismissal is stored with who, when, the reason, the installation URL and ID and the iHub version, and written to the audit log.

A dismissal:

- hides the banner entry but **never changes the conformance status** on the EU AI Act page or in the report;
- is tied to the state it was made for — enable another unmarked model, or change a model's marking, and the warning is back;
- is removed from backups and exports like every other installation record.

"Signing disabled", "C2PA unavailable", "no detection available", missing provider details and a missing terms-of-service clause cannot be dismissed.

## Interaction disclosure (50(1))

Settings (Admin → EU AI Act → Settings → Interaction disclosure):

| Setting | Default | Effect |
| --- | --- | --- |
| `interactionDisclosure.enabled` | on | The whole disclosure. Off makes the installation non-conforming. |
| `firstTurnNotice` | on | "You are chatting with an AI system…" is shown in the empty chat, **before** the first message. Apps can set their own text (`aiTransparency.firstTurnNotice`, localized). |
| `persistentBadge` | on | An "AI" badge next to the input, with screen-reader text. |
| `guardrail` | on | Appends a rule to every chat-like system prompt (chat, API app turns, MCP, A2A — also when an app's prompt is bypassed): the model always says it is an AI when asked. |
| `reminderInterval` | 5 | In apps marked **sensitive** (legal, finance, health, complaints, vulnerable users), a reminder after every N answers. Apps can override it. |
| `labels.messageBadge` | on | The "AI generated" chip on every answer; clicking it shows model, time, marking status and a link to `/verify`. |
| `labels.outbound` | on | AI labels on content sent to people: Jira comments written by the Jira tool, Outlook inserts/replies from the add-in, `X-AI-Generated`/`X-AI-Provenance` headers and a `{{aiLabel}}` template variable in the workflow HTTP node (a node can set `aiLabel: false`), a label on shared chats. |

### Switching the disclosure off for one app

The guidelines (¶45) accept an "obvious interaction" exception, e.g. an internal assistant for trained, AI-literate staff. Only an **admin** can switch the disclosure off, per app, with a reason (App editor → EU AI Act, or the Apps tab of the EU AI Act page). The opt-out is recorded **in the app config** as `aiTransparency.disclosureOptOut`:

```json
{
  "disabledBy": "u123",
  "disabledByName": "Ada Admin",
  "disabledAt": "2026-09-28T09:12:00Z",
  "reason": "Internal assistant for trained staff only",
  "installationUrl": "https://ihub.example.com",
  "installationId": "0b8f…",
  "ihubVersion": "5.6.0"
}
```

and in the audit log. Content admins see the status but cannot change it; the generic app save ignores any client-sent record.

### Installation records never travel

Opt-outs, exemptions, unmarked-model acknowledgements, dismissals and expert approvals are decisions for **one** installation. They are removed whenever configuration leaves it and dropped when it arrives:

- app and model downloads in the admin UI;
- the backup export (`/api/admin/backup/export`) — the backup also leaves out `contents/.installation-id`;
- backup import, app upload/creation and marketplace installs;
- a record whose `installationId` is not this installation's is ignored at runtime (the disclosure stays on).

The importing admin has to decide again.

## Models: the marking registry

Every model declares how its output is marked in `contentMarking`:

```json
"contentMarking": {
  "textWatermark": { "scheme": "vllm-gumbel", "keyGroup": "acme", "perRequest": false },
  "imageWatermark": "upstream:synthid",
  "notes": "vLLM started with --watermark-config, see docs"
}
```

| `textWatermark` | Meaning |
| --- | --- |
| `"none"` | Not marked. Free-form text over 200 tokens is **non-conforming**. |
| `"upstream:<vendor>"` | The vendor marks the text. Only use it with a written vendor statement (CoP Measure 4.2). |
| `{ "scheme": "vllm-gumbel", "keyGroup": "…" }` | iHub-managed vLLM watermark (below). `perRequest: true` also sends `watermarking: true` per request (vLLM RFC #53916) — only for servers that accept it. |

`imageWatermark` names an upstream image mark (Gemini images: `upstream:synthid`). iHub adds its own image layers on top in every case.

Shipped models: cloud models are `"none"` (no vendor documents text marking today), Gemini image models carry `upstream:synthid`, transcription models are out of scope (transcription is standard editing). Migration V148 sets these defaults for existing installations without overwriting a block you set.

**Enabling an unmarked model needs a justification.** The model list and the model editor flag "Not marked" models. Switching one on (toggle, bulk enable, save, create) asks for a justification; the acknowledgement is stored in `contentMarking.acknowledgement` with who, when and the installation, and audit-logged. It documents the gap — **the model stays non-conforming** in the list, on the EU AI Act page and in the report (CoP Sub-measure 1.1.2).

**Temperature 0**: a distortion-free watermark has nothing to embed with greedy decoding. iHub does not force a minimum temperature; apps that run a watermarking model at `preferredTemperature: 0` are reported as non-conforming.

**Strict mode** (`text.strictMode`, off) is reserved for the open decision whether to block unmarked long text instead of flagging it.

## Images

Every generated image is marked in the LLM client, **before** it is streamed, stored or served — so the live preview, the stored artifact, the download, shared chats and the inference API all carry the same marked bytes:

1. **TrustMark** invisible watermark (Adobe, variant P, BCH_5) with a random 61-bit ID — the ID is also the C2PA soft binding and leads to the provenance record even after metadata was stripped. It survives JPEG re-compression, resizing and screenshots (measured by the benchmark).
2. **IPTC/XMP** `Iptc4xmpExt:DigitalSourceType = trainedAlgorithmicMedia` for tools that don't read C2PA.
3. A **signed C2PA manifest**: `c2pa.created` with digital source type `trainedAlgorithmicMedia`, `c2pa.watermarked`, the soft binding, and an iHub assertion with the content ID and the signpost. No personal data.

Upstream marks are kept: Google SynthID lives in the pixels; a C2PA manifest the image arrived with, and those of uploaded images in an edit, become ingredients.

Settings: `images.c2pa` (on), `images.watermark` (`trustmark` | `none`), `images.watermarkStrength` (0.95), `images.xmp` (on), `images.trustmarkModelPath`. TrustMark needs two ONNX models (~65 MB). iHub downloads them in the background after startup into `contents/data/trustmark-models` (network access once, through the configured proxy) and checks each file against a pinned SHA-256; the server stays available while it does. A download that gets no data for 30 seconds is abandoned and retried after 15 minutes; until it succeeds, images carry the C2PA manifest and XMP but no watermark. For offline installations copy `encoder_P.onnx` and `decoder_P.onnx` from `https://cai-watermark.adobe.net/watermarking/trustmark-models/` there or point `trustmarkModelPath` at them.

## Signing certificates

C2PA signatures need an X.509 chain. No certificate ships with iHub:

- **Auto (default)**: on first start iHub generates an **installation root CA** and a **C2PA signing certificate** (ECDSA P-256, `digitalSignature`, EKU e-mail protection, your organization in the subject). The root key signs the leaf and is discarded.
- **Custom**: upload a PEM chain + key or a PKCS#12 file from your PKI or a CA on the C2PA Trust List. iHub checks chain, EKU, key match, the C2PA certificate profile and expiry, and signs and verifies a test image before switching.
- **CSR**: iHub generates the key and a CSR; you send the CSR to your CA and paste the issued certificate. The private key never leaves the installation.

Every switch keeps the previous certificate as **detect-only**: it no longer signs, but content signed with it still verifies, and you can switch back (rollback). "Issue new installation certificate" rotates the auto CA.

Keys are encrypted with `contents/.encryption-key` (AES-256-GCM) in `contents/.ai-provenance/keystore.json`; nothing is logged or returned in plaintext. Back up the encryption key together with `contents/`.

**Trust**: signatures validate cryptographically everywhere. Public validators (e.g. the Content Credentials site) show an auto-generated or company certificate as *untrusted* until its root is on the C2PA Trust List — accepted for now. iHub's own detector trusts its roots (active and detect-only) plus the PEM certificates in `signing.trustedAnchors` (other installations of the same customer). Each installation publishes its root at `/.well-known/ai-provenance`.

**Time-stamping**: set `signing.tsaUrl` to an RFC 3161 time-stamp authority. Without one (offline installations), the signing time comes from the local clock.

A one-click IntraFind certificate for registered installations is planned (issue #2578) and not available yet.

### Platform support

C2PA signing and TrustMark use `@contentauth/c2pa-node`, an optional native dependency (pinned to 0.9.7, ~45 MB) with prebuilt binaries for Linux (glibc, x64/arm64), macOS and Windows x64. Where it is missing — **the Alpine-based Docker image**, Windows on ARM — iHub runs normally, but signing is unavailable and the EU AI Act page shows it as non-conforming. Use `docker/Dockerfile.glibc` (Debian slim) for a container with signing. The iHub binary ships the addon for its platform. CI runs a sign + verify smoke test on Linux, macOS and Windows.

## Exports

All exports are generated **on the server** (`POST /api/exports`), because signing keys never leave the server and the browser print dialog does not work reliably in embedded hosts. Formats: PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, HTML, JSON, JSONL — from chats, the canvas, the Markdown viewer, workflow results and admin artifacts.

In the export dialog the user **selects the messages**. For stored chats the client sends message IDs and the server loads the content; for unstored chats it sends the selected messages. Every assistant message is checked against its provenance record: a match is signed as **verified**, anything else (edited, unknown) as **asserted** with action `c2pa.edited`. Canvas and Markdown-viewer content is always "AI-assisted, edited by user". The manifest never claims more than the server can prove.

What each file carries:

| Format | Metadata | Signed manifest (JWS with the signing chain) |
| --- | --- | --- |
| PDF | XMP `DigitalSourceType`, Info, keywords | In the Info dictionary, bound to every other byte |
| DOCX, PPTX, XLSX | `docProps/custom.xml`: `ai:generated`, `ai:system`, `ai:provider`, `ai:manifestId` | `ihub/provenance.jws` part, bound to every other part |
| HTML | `<meta name="ai-generated">`, JSON-LD | `<script type="application/ihub-provenance+jws">` |
| Markdown | YAML front-matter | text signpost |
| TXT, CSV | label line / `ai_generated` column | text signpost |
| JSON, JSONL | `aiGenerated`, `provenance` | JWS over the canonical JSON |

Plus a visible label ("AI-generated content — created with iHub Apps") in the header or colophon, an optional "AI" icon (`labels.euIcon`: `off`, `optional` = user's choice, `always`) and, when the user ticks "reviewed by a human", the editorial-responsibility contact.

c2pa-rs does not yet write C2PA manifests into PDF or Office files. iHub's manifest uses the same certificate and a C2PA-style structure; it moves to embedded C2PA once c2pa-rs supports it. Every export is also recorded server-side (manifest ID → file hash), so `/verify` recognises it even without the embedded manifest, and `GET /api/exports/manifests/:id` returns the signed manifest as a sidecar.

`platform.pdfExport.watermark` (the old CSS watermark) is no longer used; the AI label replaces it.

## Text

- **Self-hosted models (vLLM)**: see [Text watermarking with vLLM](#text-watermarking-with-vllm).
- **Cloud models** cannot be watermarked by iHub. They stay flagged until the vendor marks its output (then set `upstream:<vendor>` with a written statement).
- **Text signpost** (`text.signpost.exports` on, `text.signpost.clipboard` off; both overridable per app): a C2PA text manifest wrapper (C2PA 2.4 Appendix A.8: ZERO WIDTH NO-BREAK SPACE + Unicode variation selectors) appended to text exports and, if enabled, to copied text. It carries a signed pointer to this installation's `/.well-known/ai-provenance` and a hash of the text. It is not a watermark — trivially removed — and never added to the live chat. The wrapper round-trips through independent implementations (encypherai `c2pa-text`); the payload is an iHub JWS until c2pa-rs signs manifests for unstructured text.
- **Provenance records** (`provenance.enabled` on, `provenance.retentionDays` 365): a record per assistant message, API completion, MCP/A2A result, image and export — content hash, model, time, marking status and a random content ID, **never the content**. They exist whether chat persistence is on or off and are deleted after the retention period (CoP 1.1.3).

### Text watermarking with vLLM

1. **Create a key group** (EU AI Act → Detection → Key groups), e.g. one per customer. iHub generates the secret key and stores it encrypted.
2. **Start vLLM with the key**: "Show vLLM config" reveals the `--watermark-config` (audited):
   ```bash
   vllm serve <model> --watermark-config '{"algorithm":"gumbel","key":<key>,"context_width":4}'
   ```
3. **Point the model at the key group**: `contentMarking.textWatermark = { "scheme": "vllm-gumbel", "keyGroup": "<id>" }`.
4. **Run a detector** and set its URL on the key group. `docker/watermark-detector/` is a reference service that runs vLLM's detection primitives on CPU:
   ```
   POST <detectorUrl>
   { "text": "...", "tokenizer": "<HF model id>", "algorithm": "gumbel", "key": <key>, "context_width": 4 }
   → { "p_value": 1.2e-9, "score": 312.4, "num_tokens": 240, "is_watermarked": true }
   ```
   Keep it on an internal network: requests carry the key. iHub tests every key version (newest first) with a Bonferroni-corrected threshold (1 % overall).

Watermarking is **server-owned**: the per-request setting comes only from the model configuration. Client-supplied `watermarking`, `extra_body`, `vllm_xargs` and similar fields are stripped from chat requests and the OpenAI-compatible API.

**Several installations, one key**: export the key group as an encrypted bundle (passphrase ≥ 12 characters, scrypt + AES-256-GCM) and import it elsewhere; both then watermark and detect with the same key. **Rotation** creates a new key version; older versions stay detect-only.

## Detection

- **`/verify`** — a page for everyone allowed to use the detector: upload a file or paste text, see which technique found which mark, download a **signed report** (content hash, detector ID, timestamp).
- **`POST /api/provenance/verify`** — the same as an API; see the [detection API](eu-ai-act-detection-api.md).
- **Admin detection page** (EU AI Act → Detection): test upload, access settings, expert approvals, key groups, detection log, self-test.
- **`ihub verify <file|->`** — the downloadable iHub binary as an offline detector: no server, no upload. `npm run verify -- <file>` in a source checkout. Options: `--json`, `--report <file>`, `--trust-anchor <pem>`, `--text-watermark` (inside an installation), `--sign`. Exit codes: 0 mark found, 1 not detected, 2 inconclusive, 3 error.

Access (`detection.access`): `internal` (admins and approved experts), `authenticated` (every signed-in user, default) or `public` (anyone, e.g. for publicly shared chats). Requests are rate-limited (`detection.rateLimit`, 30 per 15 minutes). **Free-form text watermark detection** is limited to admins and approved experts (CoP 2.1.2) — approve them with a reason on the Detection tab.

**Zero retention**: submitted content only lives in memory for the request. The detection log keeps metadata only — time, requester, content hash, kind, verdict, techniques — for `detection.log.retentionDays` (90).

**Interoperability (signpost)**: every marked output points to the issuing installation's `/.well-known/ai-provenance` (C2PA assertion in images and files, the text signpost, `X-AI-Provenance` headers). That document lists the detector endpoint, the supported techniques and the trust anchor, so a verifier needs no prior knowledge (CoP Measure 3.4(c) option ii). Set `installationUrl` so the signpost has an absolute URL.

## API and MCP responses

- OpenAI-compatible API (`/api/inference/v1/chat/completions`, Responses, Conversations): responses carry `ihub_provenance` (streaming: on the usage chunk when the request sets `stream_options.include_usage`, since clients without it do not expect a chunk with empty `choices`) and the headers `X-AI-Generated: true`, `X-AI-Provenance`, `X-AI-Content-Id`.
- MCP tool results of apps carry `_meta.provenance`; A2A task artifacts carry `metadata.provenance`.
- Chat: the `run/ended` event and stored assistant messages carry `provenance`.

```json
"ihub_provenance": {
  "contentId": "prv_…",
  "contentHash": "sha256:…",
  "aiGenerated": true,
  "generatedAt": "2026-09-29T10:00:00.000Z",
  "generator": { "name": "iHub Apps", "version": "5.6.0" },
  "model": { "id": "local-vllm", "provider": "local" },
  "kind": "inference",
  "marking": { "status": "marked", "technique": "vllm-gumbel", "required": true, "tokens": 412 },
  "conforming": true
}
```

## Robustness tests and compliance report

The marking benchmark measures what the markers survive: TrustMark after JPEG q90/70/50, resize 75 %/50 %, crop and a screenshot-like pass (TPR on marked, FPR on unmarked samples); C2PA validity; the PDF manifest intact and a one-byte change detected; PDF→text; the text signpost through normalisation and whitespace, and truncation, homoglyphs and character insertion detected as changes; with a detector, text-watermark false positives on held-out human text. Run it from EU AI Act → Detection ("Run self-test" / "Run full benchmark"), with `npm run test:marking-benchmark [-- --full]`, or nightly in CI (`.github/workflows/ai-provenance.yml`). Reports are kept in `contents/data/ai-provenance/benchmarks/`.

The **compliance report** (EU AI Act page → Download compliance report) is a signed PDF generated from the current state: provider and contacts, the checklist, marking techniques per modality and model, every opt-out, exemption, acknowledgement and dismissal with its justification, the certificate chain, detection settings and the latest test results.

## Settings reference

All settings live in `platform.aiTransparency` (`contents/config/platform.json`) and are edited on the EU AI Act page (`PUT /api/admin/ai-transparency/settings`). Defaults: `shared/aiTransparency.js`.

| Key | Default |
| --- | --- |
| `provider.legalEntity`, `.contact`, `.address`, `.role` | `""`, `""`, `""`, `provider` |
| `editorialResponsibility.contact`, `.policyUrl` | `""` |
| `termsOfService.markRemovalClause`, `.url` | `false`, `""` |
| `interactionDisclosure.enabled`, `.firstTurnNotice`, `.persistentBadge`, `.guardrail`, `.reminderInterval` | `true`, `true`, `true`, `true`, `5` |
| `labels.messageBadge`, `.euIcon`, `.exportLabel`, `.outbound` | `true`, `optional`, `true`, `true` |
| `images.c2pa`, `.watermark`, `.watermarkStrength`, `.trustmarkModelPath`, `.xmp` | `true`, `trustmark`, `0.95`, `""`, `true` |
| `text.watermarkMinTokens`, `.signpost.exports`, `.signpost.clipboard`, `.strictMode` | `200`, `true`, `false`, `false` |
| `provenance.enabled`, `.retentionDays` | `true`, `365` |
| `exports.sign` | `true` |
| `signing.enabled`, `.tsaUrl`, `.trustedAnchors`, `.organization`, `.commonName` | `true`, `""`, `[]`, `""`, `""` |
| `detection.enabled`, `.access`, `.rateLimit.windowMinutes`, `.rateLimit.limit`, `.log.enabled`, `.log.retentionDays` | `true`, `authenticated`, `15`, `30`, `true`, `90` |
| `installationUrl` | `""` (falls back to `mcpServer.publicUrl`) |

Per app (`app.aiTransparency`): `sensitive`, `reminderInterval`, `firstTurnNotice`, `signpost.exports`/`signpost.clipboard`; admin-only records `disclosureOptOut`, `exemption` (`standardEditing` | `b2bTechnical`, with a justification).

## Known limitations

- Cloud-model text is not watermarked; those models stay flagged.
- C2PA is embedded into images only; PDFs and Office files carry the signed iHub manifest instead.
- The text signpost payload is an iHub JWS inside a C2PA text wrapper, not yet a C2PA manifest store.
- The Alpine Docker image has no C2PA addon; use `docker/Dockerfile.glibc`.
- The IntraFind certificate (issue #2578), fingerprint store, post-hoc watermarking of cloud-model text and HSM/KMS key storage (issue #2579) are future work.
