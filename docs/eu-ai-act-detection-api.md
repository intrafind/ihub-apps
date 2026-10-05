# AI Content Detection API

Every iHub Apps installation runs its own detector for the AI markings it applies (EU AI Act Art. 50(2); Code of Practice Measures 2.1, 2.3 and 3.4). This page is the public specification for verifiers, integrators, authorities, researchers and fact-checkers. Operators configure detection as described in [EU AI Act Transparency](eu-ai-act.md#detection).

## 1. Find the detector: the signpost

Marked content tells you which installation produced it:

| Content | Where the signpost is |
| --- | --- |
| Images | C2PA manifest, assertion `com.intrafind.ihub.provenance` → `signpost` |
| PDF, DOCX, PPTX, XLSX, HTML, JSON | signed iHub manifest → `signpost` (HTML also `<link rel="provenance">`) |
| Text files, copied text | C2PA text wrapper at the end of the text (see §4) → JWS payload `signpost` |
| API responses | `X-AI-Provenance` response header |

The signpost is the URL of the installation's **`/.well-known/ai-provenance`** document:

```http
GET /.well-known/ai-provenance
```

```json
{
  "version": 1,
  "issuer": { "system": "iHub Apps", "provider": "ACME GmbH", "installationId": "0b8f…", "installationUrl": "https://ihub.example.com" },
  "detector": {
    "enabled": true,
    "access": "public",
    "endpoint": "https://ihub.example.com/api/provenance/verify",
    "ui": "https://ihub.example.com/verify",
    "methods": ["POST multipart/form-data (field \"file\")", "POST application/json {\"text\": \"...\"}"],
    "reportVerification": "https://ihub.example.com/api/provenance/report/verify",
    "signedReports": true,
    "retention": "none"
  },
  "techniques": [
    { "id": "c2pa", "description": "Signed C2PA manifest", "formats": ["image/png", "image/jpeg", "…"] },
    { "id": "trustmark", "variant": "P", "version": "BCH_5", "payloadBits": 61, "softBindingAlg": "com.adobe.trustmark.P" },
    { "id": "xmp", "description": "IPTC Iptc4xmpExt:DigitalSourceType" },
    { "id": "ihub-manifest", "formats": ["pdf", "docx", "pptx", "xlsx", "html", "json", "jsonl"] },
    { "id": "text-signpost", "payload": "ihub-text-signpost+jws" },
    { "id": "text-watermark", "access": "approved experts" }
  ],
  "trustAnchors": ["-----BEGIN CERTIFICATE-----\n…"],
  "trustAnchorUrl": "https://ihub.example.com/api/provenance/trust-anchor.pem"
}
```

`access` is `public` (anyone), `authenticated` (users of the installation) or `internal` (admins and approved experts). Ask the operator for access if the detector is not public. Free-form text watermark detection is always limited to approved experts.

## 2. Verify content

```http
POST /api/provenance/verify
Content-Type: multipart/form-data; boundary=…

(field "file": the file)
```

or

```http
POST /api/provenance/verify
Content-Type: application/json

{ "text": "…" }
```

Response:

```json
{
  "result": {
    "verdict": "ai-generated",
    "aiGenerated": true,
    "techniques": [
      { "technique": "c2pa", "label": "C2PA manifest (signed metadata)", "found": true, "valid": true, "trusted": true,
        "detail": "iHub Apps · declares AI-generated content · validation: Trusted" },
      { "technique": "trustmark", "found": true, "valid": true, "trusted": true, "detail": "Watermark id prv_img…" },
      { "technique": "xmp", "found": true, "valid": true },
      { "technique": "provenance-record", "found": true, "detail": "Generated here on 2026-09-29T10:00:00Z by gemini-3-pro-image" }
    ],
    "content": { "sha256": "sha256:…", "mimeType": "image/png", "size": 225709, "kind": "image" },
    "provenance": { "contentId": "prv_img…", "generatedAt": "…", "model": { "id": "gemini-3-pro-image", "provider": "google" } },
    "detector": { "id": "0b8f…", "installationUrl": "https://ihub.example.com", "version": "5.6.0" },
    "checkedAt": "2026-09-29T10:05:00Z",
    "summary": "AI-generated content: found by …"
  },
  "report": "eyJhbGciOiJFUzI1NiIs…",
  "reportPayload": { "typ": "ihub-detection-report", "v": 1, "detector": {…}, "checkedAt": "…", "content": {…}, "verdict": "ai-generated", "techniques": [ … ] }
}
```

- `verdict`: `ai-generated` (a valid mark was found), `not-detected` (no mark of this installation — this does **not** prove human authorship), `inconclusive` (a mark is present but does not validate, e.g. the content was changed, or nothing could be checked).
- Each technique says whether it found a mark (`found`), whether the mark validates (`valid`) and whether the signer chains to a trust anchor of this installation (`trusted`). `skipped` explains checks that did not run (`experts-only`, `too-short`, `no-detector`, `unavailable`).
- Status codes: `400` missing input or file too large, `401`/`403` access denied, `404` detection disabled, `429` rate limit.
- Submitted content is not stored. The installation logs metadata only (time, requester, hash, verdict).

`GET /api/provenance/info` tells a caller whether it may verify and use text detection.

## 3. Signed reports

`report` is a compact JWS (RFC 7515, `typ: ihub-detection-report+jws`, ES256) over `reportPayload`, with the installation's certificate chain in `x5c`. Check it at the installation:

```http
POST /api/provenance/report/verify
{ "report": "eyJ…" }
→ { "valid": true, "trusted": true, "payload": { … }, "signer": { "subject": "CN=… Content Signer, O=…" }, "errors": [] }
```

or offline with any JOSE library: verify the signature with the public key of the first `x5c` certificate and check that the chain ends at the installation's trust anchor.

## 4. Formats

### iHub manifest (exports)

A compact JWS (`typ: ihub-export-manifest+jws`) signed with the installation's C2PA signing certificate. Payload fields: `manifestId`, `format`, `title`, `createdAt`, `generator`, `installationId`, `signpost`, `aiGenerated`, `digitalSourceType` (IPTC), `action` (`c2pa.created` | `c2pa.edited`), `verification` (`verified` | `asserted`), `humanReviewed`, `messages[]` (`role`, `contentHash`, `verification`, `contentId`), and `binding`:

| Format | Where | `binding.method` | Hash input (SHA-256) |
| --- | --- | --- | --- |
| PDF | Info dictionary key `/IHubProvenance`, string `IHUBSIG[<jws, space-padded>]` | `pdf-placeholder` | every byte except the characters between `IHUBSIG[` and `]` |
| DOCX, PPTX, XLSX | part `ihub/provenance.jws` (package relationship `https://ihub.intrafind.com/relationships/ai-provenance`) | `ooxml-parts` | for each other part, sorted by name: `name\0sha256hex(content)\n` |
| HTML | `<script type="application/ihub-provenance+jws" id="ihub-provenance">` | `html-without-manifest` | the page with that element's content removed |
| JSON | `provenance.signature` | `json-canonical` | canonical JSON (sorted keys) of the document without `provenance` |
| JSONL | first line `{"type":"provenance", …, "signature": …}` | `jsonl-lines` | the remaining lines joined with `\n` |

### Text signpost (C2PA text wrapper)

Appended to text (C2PA 2.4, Appendix A.8): U+FEFF, then one Unicode variation selector per byte (0–15 → U+FE00–U+FE0F, 16–255 → U+E0100–U+E01EF) of `"C2PATXT\0"`, a version byte `1`, a 32-bit big-endian length and the payload. The payload is a JWS (`typ: ihub-text-signpost+jws`) with `hash` (SHA-256 of the NFC-normalised text without the wrapper, trailing whitespace per line removed), `cid`, `signpost`, `iss`, `iat`. Any C2PA text implementation can extract the payload (e.g. `extractManifest` of encypherai `c2pa-text`).

### Images

- C2PA manifest (read with `c2patool`, `c2pa-rs`, `c2pa-node`, the Content Credentials site).
- TrustMark soft binding `com.adobe.trustmark.P`: the decoded 61-bit payload, as 16 hex digits prefixed `prv_img`, is the image's content ID at the issuing installation.
- XMP `Iptc4xmpExt:DigitalSourceType = http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`.

## 5. Offline detection

Download the iHub binary for your platform and run:

```bash
ihub verify picture.png report.pdf answer.txt
ihub verify --json --trust-anchor ihub-trust-anchor.pem document.docx
cat answer.txt | ihub verify -
```

It runs the same checks locally without uploading anything. Signers count as trusted when they chain to a `--trust-anchor` (download it from `trustAnchorUrl`). Text watermark detection needs the installation's keys and is not available offline.
