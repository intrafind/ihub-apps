# EU AI Act Art. 50 — AI Content Marking, Labelling & Detection

**Date:** 2026-09-27
**Status:** Concept / planning (enterprise feature)
**Scope:** Text, images and exports produced by iHub Apps, including open-weight models we host ourselves

> This is an engineering reading of the regulation. It is not legal advice. Legal/compliance must confirm the role split (provider vs. deployer) and the exemptions we rely on before we commit to a scope.

---

## 1. TL;DR

- **A visible "AI generated" label is not enough.** It covers only the *human-facing* duties: Art. 50(1) (telling people they are talking to an AI) and Art. 50(4) (deployers labelling deep fakes and published public-interest text). Art. 50(2) separately requires every output to be **marked in a machine-readable way** *and* **detectable**, and the provider must offer the means to detect it. The Commission guidelines (¶70) say marking without a detection tool does not comply.
- **The legal baseline is the final Code of Practice (CoP) of 10 June 2026** and the **Commission Art. 50 guidelines** (August 2026). The CoP asks for **at least two machine-readable layers**:
  1. **Digitally signed, time-stamped metadata** (in practice C2PA) wherever the format can carry metadata: images, audio, video, and "containerised text" (PDF, DOCX, HTML …).
  2. An **imperceptible watermark** in the content itself.
  - **Free-form text** (chat output) can't carry metadata, so a **watermark alone** is enough there. It is **required above 200 tokens**; shorter text is exempt.
  - **Logging and fingerprinting** are optional extras; on their own they are never enough.
- **Deadlines:**
  - Art. 50 has applied since **2 Aug 2026**. Chatbot disclosure (50(1)) has **no grace period**.
  - For systems already on the market before 2 Aug 2026, **machine-readable marking (50(2)) is due by 2 Dec 2026**. This grace period comes from the AI Omnibus, Reg. (EU) 2026/1744.
  - For CoP signatories, **interoperable watermark detection is due by 2 Feb 2027**.
  - Fines: up to €15 M or 3 % of worldwide turnover.
- **Role:** IntraFind puts iHub on the market under its own name, so IntraFind is the **provider** of a generative *and* interactive AI system (guidelines ¶11). The upstream model vendor (OpenAI, Google, Mistral, or an open-weight model) does not take over our duty. We may *rely* on their marking, but the responsibility stays with us. Our customers are **deployers**: they own the 50(4) labelling, and we should give them the tools for it (CoP Measure 1.4).
- **Open-weight models:** text watermarking needs control over sampling. Only models we run ourselves can have it. **vLLM now ships a native watermark** (Gumbel-max, `--watermark-config`, separate detection server; announced 24 Sep 2026). SynthID-Text (Apache-2.0), MarkLLM and Meta TextSeal are the open-source alternatives. Ollama, LM Studio and llama.cpp have nothing built in.
- **Images:** C2PA manifest (`c2pa-rs` / `c2pa-node`) plus an invisible watermark (Adobe **TrustMark**, MIT; or Meta **Pixel Seal**, MIT), linked as a C2PA *soft binding*. Gemini images arrive with SynthID already; we must keep it and add our own layers.
- **Exports:** all of our exports are built **in the browser**, and PDF goes through the print dialog. That means they cannot carry signed metadata today. We need a **server-side signing/export step**.

---

## 2. Legal situation (as of 2026-09-27)

### 2.1 The four obligations and who carries them

| Provision | Addressee | What | iHub impact |
|---|---|---|---|
| **50(1)** | Provider (IntraFind) | People must be told they are interacting with an AI system, clearly, at the latest at the first interaction | Chat UI, Teams/Outlook add-ins, agents that write to people, public shared chats |
| **50(2)** | Provider (IntraFind) | Outputs **marked machine-readably** and **detectable**. The solution must be effective, interoperable, robust and reliable "as far as technically feasible" | Text, images, exports, inference API, MCP/A2A outputs |
| **50(3)** | Deployer | Emotion recognition / biometric categorisation | Not in scope for iHub |
| **50(4)** | Deployer (customer) | Visibly label **deep fakes**, and **AI text published to inform the public on matters of public interest** (unless it had human review and someone holds editorial responsibility) | We supply the tools: label toggle, EU icon, editorial-review flag |
| **50(5)** | Both | Information must be clear, distinguishable and **accessible** (EAA, WCAG 2.1 AA), at the latest at first interaction or exposure | Badges, detection results, labels |

Notes from the guidelines:

- **Roles (¶10–¶15):** a company offering a chatbot or image generator under its own name is the provider, "regardless of whether … provided for free or for payment". A customer who modifies the system and puts it into service under *their* name also becomes a provider of that modified system. That is relevant for white-label deployments.
- **Model level (¶27):** Art. 50 does not bind GPAI *models* directly. Model providers are only *encouraged* to mark at model level so that downstream providers like us can comply.
- **Open source (¶23):** the FOSS exemption does **not** apply to Art. 50.

### 2.2 Timeline

| Date | Event |
|---|---|
| 2026-06-10 | Final Code of Practice on Transparency of AI-Generated Content published |
| 2026-07-27 | AI Omnibus (Reg. 2026/1744) in force. Grandfathering applies to 50(2) only |
| 2026-08-02 | Art. 50 applies. 50(1) disclosure is due now for everyone |
| ~2026-08-06 | Commission guidelines on Art. 50 finalised |
| **2026-12-02** | 50(2) marking and detection due for systems placed on the market before 2026-08-02. Anything *new* since 2026-08-02 is covered immediately |
| **2027-02-02** | CoP Measure 3.4(c): interoperable watermark detection (signpost, standard API, or a consortium detector) |

Content generated before 2026-08-02 does not need to be marked retroactively (guidelines ¶154).

### 2.3 Why "AI generated" as a label is not enough

The guidelines (¶38) list disclosures that are **insufficient on their own**:

- Disclosures only in the terms and conditions, a URL, or documentation.
- Generic statements such as "Services on this website use AI", or capability descriptions such as "this system uses LLMs".
- Machine-readable marks the user cannot perceive. These are fine for 50(2) but don't satisfy 50(1).
- Ambiguous signals (a generic "assistant" persona, human-like avatars).

The reverse also holds. A visible label is not "machine-readable" and gives nobody a way to *detect* the content after it has been copied out. So we need **both**:

- A **perceptible layer** (50(1), 50(4), 50(5)).
- A **machine-readable + detection layer** (50(2), 50(5)).

In addition, 50(1) requires the system to disclose its AI nature **whenever it is asked** about it, and to use periodic reminders in sensitive contexts: finance, legal, health, complaints, vulnerable users (¶40).

---

## 3. What the Code of Practice requires from providers (Section 1)

"Will" means mandatory for signatories; "optional" means encouraged or "may".

| Measure | Requirement | Mandatory? |
|---|---|---|
| **1.1** Multi-layer marking | At least **2 layers** for audio, image, video and containerised text: **1.1.1 signed metadata** + **1.1.2 imperceptible watermark**. Free-form text: watermark only. | will |
| 1.1.1 Signed metadata | Records whether content is AI-generated or AI-manipulated. **Digitally signed and time-stamped, tamper-evident.** Secure key handling, *except* where the deployment context (e.g. **local/on-prem**) doesn't allow secure key provisioning. No privacy- or business-sensitive data in it. | will |
| 1.1.2 Watermark | Imperceptible and hard to separate from the content. **Text > 200 tokens must be watermarked.** Can be post-hoc or at model/inference level. | will |
| 1.1.3 Fingerprinting / logging | Optional supplement. If used: output data only, privacy-preserving, and the **deployer controls what is logged and how long it is kept**. Never enough on its own. | optional |
| **1.2** Non-removal | Keep existing metadata marks on *input* content that we transform. **Prohibit removal in the AUP/ToS.** Never offer or advertise tools that strip marks. | will |
| 1.3 Rich provenance | System name, provider name, timestamp, optionally model ID/version, and the type of edit operation | optional |
| 1.4 Perceptible label function | Let deployers apply a visible label (EU icon) at generation time | optional (recommended for us) |
| **2.1** Detection solution | A detector for **every** marking technique we use. Delivered as a public spec, software/library, or a cloud API, **free of charge**. Always unlimited for authorities, researchers, media and fact-checkers. | will |
| 2.1.2 Access | Must suit the audience. **In professional settings with safeguards against further dissemination, access may be limited to the exposed persons.** Free-form text watermark detection may be limited to verified experts. Detection results must be **downloadable as a signed report**: content hash, detector ID, timestamp. | will |
| 2.1.3 Privacy | Zero retention of submitted content, data minimisation, GDPR-compliant, EU transfers rules apply | will |
| 2.1.4 Retirement | A replacement must stay backward compatible, or the detector goes to the authorities | will |
| 2.2 Forensic detection | Detection without prior marks; not yet mature | optional |
| **2.3** Result disclosure | Clear, and says *which* technique found it (metadata / watermark / forensic). Accessible (EAA, WCAG 2.1 AA). | will |
| **3.1–3.3** Effectiveness, reliability, robustness | Measured error rates (FPR/TPR) across content lengths and types, using held-out data. Robust to compression, format change, screenshots, crops, **paraphrase, translation, homoglyphs, character insertion**, print-and-scan, and to adversarial removal or forgery. | will |
| **3.4** Interoperability | Now: standard metadata (C2PA) and publish integration info. **By 2027-02-02:** one of a standard routing API, a public **signpost** in the content, a consortium detector, or an equivalent. | will |
| **4.1–4.4** Compliance | Documented compliance process; testing before release and regularly after; staff training; cooperation with market surveillance. Downstream providers **may rely on upstream or third-party test results**. | will |

Deployer section (Section 2), which we should support in the product:

- **EU icon:** "AI" acronym, variants "AI GENERATED" and "AI MODIFIED", SVG/PNG, free to use.
- **Placement:** visible without interaction. For published text: above the text, near the headline, or in the colophon. For images: top-right, embedded in the content.
- **Closed professional contexts:** disclosure may sit in the UI.
- **Editorial review:** a written policy naming the responsible person or entity. Individual reviews do **not** have to be logged.

---

## 4. Scope and exemptions that matter for iHub

From guidelines §4.1.3 and §4.3.

**Out of scope of 50(2):**

- Short outputs: single words, captions, alt-text, UI labels.
- **Source code, SQL, JSON/YAML, configs and schemas**, including code comments.
- Machine-to-machine output (agent-to-agent, tool calls, reasoning or chain of thought, web requests).
- Output that only retrieves, ranks or extracts existing content without summarising it.

**Exempt as "standard editing" or "no substantial alteration":**

- Grammar and spell checking, minor stylistic polishing.
- **Translations.**
- Format conversions.
- Transcriptions.

**Not exempt (must be marked):**

- **Summaries.**
- Paraphrasing or rewriting that changes style, structure or meaning.
- Generated images; object insertion or removal.

**B2B / industrial exemption (¶87):** applies only if **all three** conditions hold:

1. The output is strictly technical (engineering designs, technical instructions, *internal documentation before it is finalised*).
2. It is seen only by a limited, pre-defined set of professionals inside the provider or deployer organisation.
3. It is not intended to leave the company, with safeguards in place (isolation, RBAC).

Most iHub use cases (emails, marketing, reports, customer answers) do **not** qualify. We should still let admins declare it per app, with a recorded justification.

**Real-time ephemeral content (¶88):** exempt when marking isn't feasible and users are informed at session level.

**50(1) "obvious interaction" exception (¶45):** an **internal employee assistant for trained, AI-literate staff** is listed as an example of obvious interaction. Customer-facing or public iHub deployments do not qualify. The disclosure should stay on by default and be switchable off only per app, with a stated reason.

What follows for the product: marking must be **policy-driven per app, per content type and per length**, not a single global switch.

---

## 5. Methods and open-source tools per modality

### 5.1 Free-form text (chat, API, MCP)

**Generation-time watermarks** bias token sampling with a secret key. They need logits or sampler access, so they only work for **models we host ourselves**.

| Scheme | How | Open-source implementation | Notes |
|---|---|---|---|
| **Gumbel-max / Aaronson** | Keyed pseudo-random choice among tokens; does not distort the output distribution | **vLLM native** (`vllm serve … --watermark-config '{"algorithm":"gumbel","key":…}'`), plus an HTTP detection server example. RFC vllm#53916 adds per-request `SamplingParams.watermarking` | ~100 tokens enough for creative text at 1 % FPR; throughput cost within ±2 %. Detection needs the key and the tokenizer, not the GPU |
| **SynthID-Text** (tournament sampling) | Keyed g-functions over several tournament rounds | Google `synthid-text` (Apache-2.0), Hugging Face `transformers` integration; Bayesian/weighted-mean detectors. Planned in the vLLM RFC | Used in production by Google for Gemini. Detector needs training per key and tokenizer |
| **KGW** (red/green list) | Hash of previous token splits the vocabulary; green tokens get boosted | **MarkLLM** (THU-BPM, ~20 algorithms plus evaluation pipelines), vLLM custom logits processors | Simple and well studied; slight quality impact; weaker against paraphrase |
| **Meta TextSeal** | Part of Meta Seal / `content-seal` | MIT | Newer; evaluate |

Practical limits we must document (these are what CoP Measures 3.2/3.3 test):

- **Low-entropy output hurts watermarks.** Temperature 0 or greedy decoding, RAG answers that quote sources, tables, lists and code leave the sampler no freedom. At temperature 0 a distortion-free scheme has nothing to embed. We need to decide whether to enforce a minimum temperature or accept weaker marks.
- **Robustness:** heavy editing, paraphrasing, translation or re-generation by another model removes the mark. Copy-paste of longer passages survives.
- **Short text:** detection is unreliable below ~200 tokens, which is why the CoP exempts it.

**Cloud models (OpenAI, Anthropic, Google, Mistral, Bedrock):** we cannot watermark their tokens. Options:

1. Rely on the model provider's own watermark, e.g. Google SynthID on Gemini. Get it **in writing** (CoP Measure 4.2 allows relying on upstream tests), and record the dependency per model.
2. **Post-hoc text watermarking**, such as keyed synonym/lexical substitution or re-writing with a small local model. It works on any text, costs quality and latency, and is less robust. Worth a spike, not a default.
3. Treat these outputs as unwatermarked and **compensate with logging/fingerprints plus perceptible labels**. Honest, but *not sufficient alone* for text over 200 tokens under the CoP.

**Unicode-embedded provenance (a signpost, not a watermark):**

- The **C2PA text manifest** puts a signed C2PA manifest into invisible Unicode *variation selectors* at the end of the text (`C2PATXT\0` wrapper). Reference implementations: `encypherai/c2pa-text` (Rust/Go/Python) and `writerslogic/c2pa-unstructured-text`. It is still a **draft**, not in the C2PA 2.4 release.
- It survives copy-paste between apps. It is **trivially strippable** and some sanitizers remove it, so it must not be the only layer.
- It is a good candidate for the CoP 3.4 **signpost**, because it tells a verifier where to look.
- Zero-width-character schemes are the fragile predecessor. Avoid them.

**Logging / fingerprinting (optional supplement):**

- Store **keyed hashes of n-gram shingles** (winnowing or SimHash) per output, never plaintext. Retention and enablement are under deployer control (CoP 1.1.3).
- This allows "was this produced by *our* iHub?" lookups for partial or edited text, including for cloud models.
- Reuse the RunLog ledger and the `UserFingerprint` pepper pattern.

### 5.2 Images

| Layer | Tool | Licence | Use |
|---|---|---|---|
| Signed metadata | **C2PA** via `c2pa-rs`, **`c2pa-node`** (now in `c2pa-js`), `c2patool` | Apache-2.0 / MIT | Action `c2pa.created` with `digitalSourceType = http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`. Add `softwareAgent` (iHub + model), timestamp (RFC 3161 TSA). For edits of uploaded images: `c2pa.edited` with the original as an *ingredient*, so the input's manifest is kept (Measure 1.2) |
| Metadata fallback | IPTC/XMP `Iptc4xmpExt:DigitalSourceType` | — | Read by many CMS/DAM tools that don't parse C2PA yet |
| Invisible watermark | **Adobe TrustMark** | MIT | 100-bit payload, arbitrary resolution, official **C2PA soft binding**. Store a random ID (never user data); the ID looks up the manifest → "Durable Content Credentials" |
| Invisible watermark (alt.) | **Meta Pixel Seal / Video Seal / Watermark Anything** (Meta Seal suite) | MIT (check model-weight terms) | State-of-the-art robustness; localised detection |
| Legacy | `invisible-watermark` (DWT-DCT) | MIT | Weak against crops and re-encoding; not recommended |
| Upstream | Google **SynthID** (Gemini images) | proprietary | Arrives with the image. We must keep it (we store raw bytes today, which is good) and check whether the Gemini API response carries C2PA too |
| Visible | **EU icon** overlay (optional, deployer-controlled) | free | For deep-fake-capable apps; top-right corner |

C2PA signing requires an **X.509 signing certificate**. For verifiers to show "trusted" we need a cert from a CA on the C2PA trust list (C2PA conformance program). On-prem customers without secure key storage fall under the CoP 1.1.1 "local deployment" carve-out; document that per installation.

### 5.3 Exports (containerised text)

The CoP glossary lists PDF, Word and HTML as "containerised text", so the rule is **signed metadata + watermark**.

The watermark for these formats is the *text watermark carried in the content*. If the model watermarked the text and the export does not rewrite it, the export inherits it. For cloud-model text, this layer is the gap described in 5.1.

| Format | Signed metadata | Other markers |
|---|---|---|
| **PDF** | **C2PA supported by `c2pa-rs`**; plus XMP `DigitalSourceType` | Visible "AI" label/EU icon in header or colophon; embedded images keep their own C2PA |
| **DOCX / PPTX / XLSX** | `c2pa-rs` does not support OOXML yet. Use `docProps/custom.xml` properties (`ai:generated`, `ai:provider`, `ai:system`, `ai:manifestId`) plus a **sidecar `.c2pa`** or signed JSON manifest (a zip bundle, or a lookup via manifest ID) | Visible label in header/footer |
| **HTML** | `<meta>` + JSON-LD provenance + linked/sidecar C2PA manifest | Visible label |
| **Markdown / TXT / CSV / JSON(L)** | Front-matter or field (`"aiGenerated": true, "provenance": {...}`) + optional C2PA text manifest | — |
| **Clipboard / copy** | C2PA text manifest (variation selectors) as the signpost | HTML clipboard flavour can carry a label |
| **Mermaid SVG/PNG** | C2PA (SVG and PNG supported) | — |

---

## 6. Beyond watermarks — the other markers and measures we need

1. **Interaction disclosure (50(1), due now):**
   - A persistent "AI" badge near the input and output.
   - A first-turn notice.
   - A system-prompt guardrail so the model always admits being an AI when asked.
   - Periodic reminders for sensitive apps.
   - The same in the Teams and Outlook add-ins, public shared chats, and the MCP/A2A surfaces.
   - Content that agents or workflows send to *people* (Jira comments, Outlook drafts, webhooks) gets an AI label at the top (guidelines ¶36: "an email generated by an AI agent … features an AI label at the top").
2. **Per-message provenance in the UI:** "AI generated" / "AI modified" chip. Hover or click opens a second layer: model, time, marking status.
3. **Deployer labelling toolkit (50(4), CoP 1.4):**
   - The EU icon as an option on export and share.
   - "Human reviewed / editorial responsibility" flag on exports.
   - An admin page to record the editorial-responsibility contact (CoP Section 2, Commitment 4).
4. **Detection / verification:**
   - A `/verify` page and API.
   - Checks C2PA, TrustMark, text watermark (per key), and fingerprint lookup.
   - Signed downloadable report (hash, detector ID, timestamp).
   - Zero retention.
   - Access either tenant-internal (professional-setting carve-out) or public (e.g. for public shares).
   - Plus a **downloadable offline detector** for authorities and researchers.
5. **Preserve incoming marks:** image edit flows must carry C2PA from uploads forward as ingredients and must never re-encode away SynthID or C2PA.
6. **Legal / docs:**
   - AUP/ToS clause prohibiting removal of marks.
   - Customer-facing documentation of the marking techniques and detector integration (Measure 3.4(b)).
   - Internal compliance process document (4.1).
   - Staff training (4.3).
   - Contracts with model vendors covering their marking.
7. **Privacy by design (guidelines ¶94):** watermark payloads and manifests **must not contain user identity**. Use a random content ID and look up server-side under access control. Fingerprint logs must be deployer-controlled, with retention and deletion.
8. **Testing & monitoring (3.2, 3.3, 4.2):**
   - A robustness benchmark suite run in CI or nightly: JPEG re-compression, resize, crop, screenshot, PDF→text, paraphrase, translation, homoglyphs.
   - Record FPR/TPR per model and length bucket.
   - Re-run whenever a model or the watermark config changes.
9. **Accessibility (50(5)):** labels and detection results need ARIA and screen-reader text, high contrast, and WCAG 2.1 AA.
10. **Audit trail:** every marking-policy change and every exemption declared by admins goes to the audit log.

---

## 7. Where this lands in iHub today

| Output path | Code location | Marking today | Gap |
|---|---|---|---|
| Chat text (SSE v2) | `server/services/chat/chatChannel.js:84-107`, `RunStream.js:520` | None | Watermark (self-hosted), signpost, provenance fields, UI badge |
| Self-hosted models | `server/adapters/vllm.js:101-107`; `local-vllm.json` uses `provider: "openai"` | None; no pass-through for extra sampling params | Per-model `watermark` config; pass-through `extra_body` / `SamplingParams.watermarking` |
| Cloud models | `server/adapters/*` | Depends on vendor | Capability registry + documentation; fingerprint fallback |
| Images (Gemini only) | `GoogleConverter.js:285-297` → `chatMaterializer.js:85-150` → `ArtifactRepository.put:241`; served `immutable` (`routes/chats.js:250-285`) | SynthID from Google (not verified in code) | C2PA + TrustMark **before** `ArtifactRepository.put`; the base64 SSE delta must carry the signed bytes too (`chatChannel.js:91-106`) |
| Image download | `GeneratedImage.jsx:178-181` | Bytes untouched (good) | Download the signed artifact, not the raw SSE base64 |
| Chat export (PDF via print, DOCX, PPTX, XLSX, CSV, MD, HTML, JSON) | `client/src/api/endpoints/apps.js`, `client/src/utils/exportFormats.js`, `markdownExports.js`, canvas `ExportMenu.jsx`, admin `artifactDownload.js` | Visible CSS "watermark" in PDF, user-editable. `platform.pdfExport.watermark` is sent to the client but never read (`dataRoutes.js:951` vs `ExportDialog.jsx:61-68`) | **All client-side, so nothing can be signed** (the key must stay on the server). Needs a server step (see 8.3) |
| OpenAI-compatible API | `server/routes/openaiProxy.js:230, 401-448` | None | Text watermark (self-hosted) + response metadata (`ihub_provenance` field, `X-AI-Generated` header) |
| MCP / A2A | `McpServerService.js:484-488`, `a2aHandler.js:151` | None | Same as API; `_meta.provenance` in the MCP result |
| Jira comments, Outlook inserts, workflow HTTP node | `tools/jira.js:114,223`; `outlookMailActions.js:313`; `HttpNodeExecutor.js` | None | Configurable visible AI label/footer (50(1) for content sent to people) |
| Shared chats (can be public) | `routes/chatShares.js:492` | None | Visible labels + verify link; public detection access |
| OCR tool PDF text layer | `ocrProcessor.js:365-481` | None | Transcription counts as standard editing, so it's exempt. Document the decision |
| Disclaimer | `ui.json.disclaimer`, `AIDisclaimerBanner.jsx` (only after the first message) | Generic banner | Show **before** the first interaction; per-app wording |
| Logs | RunLog ledger (full text, default off), chat store (`ChatRepository.buildMessage:428`, `OPTIONAL_MESSAGE_FIELDS:156`) | — | Add `provenance { contentId, markings[], modelId, ts }`; fingerprint store |

---

## 8. Proposed architecture

### 8.1 Components (server)

```
server/services/provenance/
  ProvenanceService.js        # policy: which layers apply to (app, model, contentType, length)
  policy.js                   # exemptions: <200 tokens, code/JSON, translation apps, B2B declared, etc.
  signing/
    C2paSigner.js             # c2pa-node; cert + TSA from platform config (encrypted at rest)
    KeyStore.js               # reuse TokenStorageService AES-GCM; HSM/KMS option later
  image/
    ImageMarker.js            # TrustMark (Python sidecar or ONNX) + C2PA manifest + soft binding
  text/
    TextWatermarkRegistry.js  # per-model: { scheme: 'vllm-gumbel'|'synthid'|'upstream'|'none', keyId }
    TextSignpost.js           # optional C2PA text manifest (variation selectors) — config-gated
    Fingerprint.js            # keyed winnowing hashes → fingerprint store (deployer-controlled retention)
  export/
    ExportSigner.js           # PDF (C2PA + XMP), OOXML (custom props + sidecar), HTML/MD metadata
  detection/
    DetectionService.js       # C2PA verify, TrustMark decode, text watermark detect, fingerprint lookup
    ReportSigner.js           # signed detection report (hash, detector id, timestamp)
server/routes/provenance.js   # POST /api/provenance/verify, POST /api/provenance/sign-export, GET /.well-known/ai-provenance
```

Hook points:

1. **Images:** in `chatMaterializer.storeGeneratedArtifacts` / `ArtifactRepository.put`, sign and watermark *before* persisting. Emit the signed bytes in the SSE image delta, or emit an artifact reference instead of raw base64.
2. **Text:** on `step/completed` (`RunStream.js:520`), compute the provenance record and fingerprint, then attach `provenance` to the message (`OPTIONAL_MESSAGE_FIELDS`). The watermark itself happens in vLLM. For the signpost variant, add it only in *exports and copy*, never in the stream: invisible characters in the rendered chat break markdown, search and diffing.
3. **vLLM:** add `watermark` to the model schema and pass it through in `vllm.js` / `openai.js` (per-request enable once vllm#53916 lands). The server-side `--watermark-config` is the customer's vLLM ops job; iHub stores the matching **detection key** (encrypted) per model.
4. **API / MCP:** add a provenance field to the response plus a header, and document it.

### 8.2 Configuration

Create `platform.aiTransparency`. It is a new top-level section, so defaults come via `server/defaults/` plus a migration for existing installs (see CLAUDE.md "Config Migrations"). Add a feature-registry entry `aiTransparency` (category `ai`).

```jsonc
"aiTransparency": {
  "interactionDisclosure": { "enabled": true, "firstTurnNotice": true, "persistentBadge": true },
  "labels":   { "messageBadge": true, "euIcon": "optional", "exportLabel": true },
  "images":   { "c2pa": true, "watermark": "trustmark", "visibleIcon": false },
  "text":     { "watermarkMinTokens": 200, "signpost": false, "fingerprint": { "enabled": false, "retentionDays": 90 } },
  "exports":  { "sign": true },
  "signing":  { "certificate": "<encrypted>", "privateKey": "<encrypted>", "tsaUrl": "…" },
  "detection":{ "access": "authenticated" /* | "public" */, "zeroRetention": true }
}
```

Per-app overrides (`app.aiTransparency`):

- Disable 50(1) disclosure, with a mandatory `reason` (e.g. "internal trained staff").
- Declare `exemption: "standardEditing" | "b2bTechnical"`, with a `justification`.
- Choose the label style.

Per-model settings (`model.contentMarking`): `{ textWatermark: { scheme, keyId } | "upstream:<vendor>" | "none", imageWatermark: "upstream:synthid" }`. This drives both marking and the compliance report.

**Admin "AI Transparency" page:**

- A status matrix per model × modality: *marked / upstream / gap*.
- Certificate upload.
- Editorial-responsibility contact.
- An exportable **compliance report** for CoP 4.1.

### 8.3 Exports — decision needed

Exports are generated in the browser, but signing keys must stay on the server. Options:

- **A. Sign-on-server round-trip:** the client builds the file and POSTs it to `/api/provenance/sign-export`, which checks it, embeds or attaches the manifest and returns it. Least refactoring, but we sign bytes the client produced. The manifest should then bind to the server-known message IDs and hashes, so we only vouch for "contains AI output X".
- **B. Server-side export generation:** move PDF/DOCX/PPTX generation to the server. That means real PDFs instead of the print dialog (pdf-lib already exists server-side) and full control. Bigger change, and it also fixes print-dialog inconsistencies.
- **Recommendation:** **B for PDF and DOCX** (the most shared formats), **A for the rest**. Browser print-to-PDF stays as "unsigned quick print", clearly labelled.

### 8.4 Detection for on-prem customers

Each iHub installation is its own provider instance. That leaves three options:

- **(a)** Each installation runs its own `/verify` (tenant-internal access is allowed in professional settings, CoP 2.1.2).
- **(b)** Publish an offline detector: a CLI/library for C2PA + TrustMark + our text scheme spec.
- **(c)** Join a shared or consortium detector for the 2027-02-02 interoperability deadline.

Plan: (a) + (b) now, (c) to evaluate.

---

## 9. Roadmap

| Phase | Deadline | Scope |
|---|---|---|
| **0 — Now** | ASAP (overdue since 2026-08-02) | 50(1): disclosure before the first interaction, persistent badge, "are you an AI?" guardrail, labels on Outlook/Jira/agent outputs. Legal: AUP/ToS removal clause, role assessment, model-vendor marking statements. Compliance-process doc skeleton |
| **1 — Images & metadata** | **2026-12-02** | C2PA signing service + key management; TrustMark on Gemini images; keep SynthID; server-side signed PDF/DOCX; OOXML custom props + sidecar; provenance field on messages / API / MCP |
| **1b — Text** | **2026-12-02** | vLLM watermark integration (model schema, detection key, detector service); capability registry for cloud models; robustness/FPR test harness; `/verify` page + API with signed reports |
| **2 — Interoperability** | **2027-02-02** | Signpost (C2PA text manifest and/or C2PA soft binding) + publish detector integration info; offline detector package; decide on consortium participation |
| **3 — Hardening** | 2027 H1 | Fingerprint store; post-hoc text watermark spike for cloud models; EU icon second layer; HSM/KMS; red-team exercise; SynthID-Text / KGW options in vLLM |

---

## 10. Open questions

1. **Role:** is IntraFind the provider for every on-prem installation, or do customers become providers when they white-label or substantially configure iHub? This affects who signs (whose certificate) and who runs detection.
2. **Do we sign the Code of Practice?** It gives a presumption of conformity and ~190 organisations have signed. The SME/SMC simplifications may apply.
3. **Cloud-model text gap:** accept vendor marking + fingerprints, or invest in post-hoc watermarking? This needs a legal risk call.
4. **Temperature 0 apps:** force a minimum temperature for watermark-eligible apps, or document the reduced reliability?
5. **Signing identity:** one IntraFind C2PA certificate, or per-customer certificates (and who pays for trust-list CAs)?
6. **Default for internal deployments:** should the 50(1) disclosure be switchable off per app ("trained staff") or never?
7. **Signpost in copy/paste:** do customers accept invisible Unicode in copied text? It can break some downstream systems.

---

## 11. Sources

- Code of Practice on Transparency of AI-Generated Content, final, 2026-06-10 — <https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content> (PDF: <https://ec.europa.eu/newsroom/dae/redirection/document/129555>)
- Commission Guidelines on the transparency obligations under Art. 50 AI Act — <https://digital-strategy.ec.europa.eu/en/library/guidelines-transparency-obligations-providers-and-deployers-ai-systems>
- EU icons for labelling AI-generated content — <https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content>
- AI Omnibus / 50(2) grace period — <https://labs.cloudsecurityalliance.org/research/csa-research-note-eu-ai-act-article50-watermarking-deadline/>, <https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/>
- Freshfields summary of the final CoP — <https://www.freshfields.com/en/our-thinking/blogs/technology-quotient/eu-ai-act-unpacked-33-the-final-code-of-practice-on-transparency-of-ai-generate-102n4yx>
- vLLM watermarking — <https://vllm.ai/blog/2026-09-24-watermarking-in-vllm>, RFC <https://github.com/vllm-project/vllm/issues/53916>
- MarkLLM — <https://github.com/THU-BPM/MarkLLM>
- C2PA spec 2.4 — <https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html>; AI/ML guidance — <https://spec.c2pa.org/specifications/specifications/2.4/ai-ml/ai_ml.html>
- c2pa-rs supported formats — <https://github.com/contentauth/c2pa-rs/blob/main/docs/supported-formats.md>; c2pa-node — <https://github.com/contentauth/c2pa-node-v2>
- C2PA text embedding reference — <https://github.com/encypherai/c2pa-text>
- Adobe TrustMark — <https://github.com/adobe/trustmark>, <https://opensource.contentauthenticity.org/docs/trustmark/c2pa/>
- Meta Seal (Pixel Seal, Video Seal, AudioSeal, TextSeal) — <https://github.com/facebookresearch/content-seal>, <https://github.com/facebookresearch/videoseal>
