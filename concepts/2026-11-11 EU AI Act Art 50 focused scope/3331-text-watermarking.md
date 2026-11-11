# #3331 Text watermarking with vLLM + detection: PM and engineering analysis

Epic #3324, stack position 4 of 6 (after 3327, before 3328/3329). Written against `/workspace/ihub-apps` at HEAD `ed5557a`, where **the latest migration on disk is `V240`** and none of the 3325/3326/3327 code exists yet. Anything marked (assumed) is a contract with 3327 that must be re-checked when that branch lands.

---

# Part 1: Product Manager

## 1. What and why

- **Obligation.** Art. 50(2) AI Act (providers of systems generating synthetic text) applies from **2026-12-02**. The Code of Practice (CoP) 1.1.2 asks for imperceptible watermarking of free-form text, meaningful above roughly 200 tokens. (I could not verify the CoP wording itself; the 200-token figure comes from the issue.)
- **What we ship.** For self-hosted vLLM models, iHub (a) tells vLLM to watermark, (b) owns and rotates the secret keys, (c) records which key was used, and (d) can answer "is this text ours?" even when no record matches (edited copy, record expired). The hash lookup from 3327 only proves exact-text origin; the watermark survives light edits.
- **What we do not ship.** The detector service (contract + mock only), hosted-model marking (3327 `by: "provider"`), key sharing between installations.

## 2. User stories

1. As an **operator running vLLM**, I want iHub to generate and hold the watermark key and give me the exact `--watermark-config` snippet, so that I do not manage secrets in two places.
2. As an **operator**, I want to rotate the key without losing the ability to recognise older output, so that a leaked or aged key is not a compliance dead end.
3. As an **operator**, I want to see immediately when vLLM and iHub disagree about the key (self-test, 3329), so that I do not silently ship unmarked text.
4. As an **auditor / verifier** (internal compliance, a customer, a regulator), I want to paste a text and get "ours, watermarked with key X, p = 1e-9", "no evidence", or "too short to tell", so that I get an honest answer rather than a false "not ours".
5. As a **platform admin**, I want key reveal and every key change in the audit log, so that handling of the secret is itself accountable.
6. As the **3329 admin page developer**, I want a stable key/detector API, so that the page is pure UI.

## 3. Success criteria

- Output of at least 200 scored tokens from a vLLM model with `by: "ihub"` is detected via `/api/provenance/verify` (mock in CI, real detector once it exists).
- After rotation, text generated under the retired key is still detected and reports the **old** `key_id`.
- A greedy request is never claimed as marked (`watermark.applied: false`, with a reason).
- No client can switch marking off (`watermarking: false` or an `extra_body` override has no effect).
- A key value appears only (a) in the response that generated or explicitly revealed it, (b) encrypted on disk, (c) in the request body to the configured detector. Never in logs, audit entries, non-admin responses, or the vLLM request.
- Detector calls obey the SSL whitelist and the "HTTPS or internal network" rule.

## 4. Non-goals

Key groups / encrypted key bundles; building the detector; marking hosted models (OpenAI, Anthropic, Gemini); marking images/audio (3328); dual-key Gumbel (`dual_key_gumbel`) and SynthID-Text (the latter is "planned, not implemented" in vLLM); watermark survival guarantees against paraphrase/translation; the admin UI (3329).

## 5. Known gaps to state in the operator docs and UI

| Gap | Consequence |
|---|---|
| Hosted models cannot be watermarked by us | Covered only by `by: "provider"` + written statement (3327) |
| Greedy decoding (temperature 0, `top_k` 1) | No watermark; recorded `applied: false` |
| Text under about 200 scored tokens | Detector cannot decide; verify answers "too short" |
| Paraphrase, translation, heavy editing, summarising | Watermark weakens or disappears; a missing hit is **not** proof of human origin |
| Beam search, structured output / grammars, some speculative-decoding setups | Not marked, or weak (vLLM docs) |
| vLLM `generation_config.json` supplies temperature 0 when the iHub model sets no `sampling.temperature` | iHub cannot see this and would claim `applied: true`; operators must set `sampling` explicitly |
| Operator forgets `--watermark-config`, or runs a build without watermarking | vLLM may ignore the extra field; iHub cannot tell. Only the self-test (3329) or the `vllm:watermark_requests_total` metric reveals it |

## 6. Ambiguities and risks (decisions needed; recommendation first)

1. **Key sent to the detector in the request body.** The detector is a second place that holds every key, and the one reachable over a network. Recommend: bearer token required; HTTPS, or plain HTTP only to loopback/private addresses; redirects refused; key never logged by iHub; operator docs say the detector must not log request bodies. Residual risk: a compromised detector leaks all keys and allows removing/spoofing watermarks. Accept for v1, document it.
2. **Key reveal.** Deliberate admin action (needed to reconfigure vLLM). Recommend: `POST` (not `GET`), `Cache-Control: no-store`, audit entry **written before** the key is returned, and the reveal **fails closed** if the audit write fails. Open: should reveal need a recent re-login? (Out of scope; note for security review.)
3. **iHub key and vLLM key diverge** (rotation in iHub, vLLM not restarted; or the reverse). Effect: new output is marked with the old vLLM key but recorded with the new `key_id`, and detection with the new key fails. Most likely real-world failure. Mitigation: after rotation iHub shows the snippet and a "vLLM not yet updated" hint; the 3329 self-test goes red and also tries **all** keys: if a retired key matches it says "vLLM is still on `wm-2026-1`". Open: block recording `key_id` until a self-test passes? Recommend no (too heavy), warn only.
4. **Short-text answer.** Recommend: a *negative* below the threshold becomes `too_short`; a *positive* (p below threshold) stays `detected` even if short, because a small p-value is valid at any length. Needs PM/legal confirmation, since the issue says "under ~200 scored tokens is answered with too short to tell". Also `num_scored_tokens` is lower than the raw token count (vLLM de-duplicates repeated contexts by default), so 200 scored is stricter than 200 tokens; the threshold is configurable.
5. **False-positive rate and wording.** The vLLM example detector flags `is_watermarked` at p < 0.01 by default; over several keys and detectors that is far too loose for "this came from iHub". Recommend iHub decides from `p_value` itself: default alpha 1e-4, Bonferroni-corrected by the number of (key, detector) tests; UI says "consistent with our watermark, p = ...", never "proven". vLLM's docs also say to measure false positives on real unwatermarked traffic; put that in the operator guide.
6. **One active key for the installation vs. several vLLM servers.** The issue defines one installation-wide key set. Two vLLM servers started with different keys cannot both be right. v1: all `by: "ihub"` models share the key set; documented. 3327's `contentMarking.text.keyId?` conflicts with this; recommend it is **not used** for `by: "ihub"`. Confirm with the 3327 author.
7. **Who may call `/api/provenance/verify`, and how often.** It now triggers outbound detector calls with the keys and CPU-heavy tokenization. If anonymous callers are allowed (3327 decision), add rate limiting and a text size cap (suggest 200 000 chars), and consider hash lookup only for anonymous callers. Needs a decision.
8. **Verify without a known model.** A pasted text does not say which model produced it, but detection needs the right tokenizer. Recommend: try each distinct detector (`detectorUrl` + tokenizer + context width) among `by: "ihub"` models, in parallel with a concurrency cap; accept an optional `modelId` to narrow; correct for multiplicity.
9. **Key deletion.** Deleting a retired key makes all older output undetectable, and its `key_id` must never be reused. Confirmation dialog (UI) says so; no automatic expiry.
10. **Structured-output requests** (JSON schema / `json_object`): vLLM applies grammar before watermark sampling, so detection is weak. Recommend `applied: false, reason: "structured_output"`. Confirm.
11. **Backup/restore.** Keys are encrypted with `contents/.encryption-key`. A backup restored on another installation, or after losing that key file, loses the keys (retired ones included). State in docs; no export in v1.

---

# Part 2: Senior engineer

## 7. vLLM facts, checked against docs.vllm.ai/en/latest/features/watermarking/ and the example server on GitHub

Correct in the issue: `--watermark-config`; Gumbel is the default, a dual-key variant exists (`dual_key_gumbel`, extra `alpha`); per-request `watermarking` (omitted or true = on, false = off unless `enforce`); `enforce`; greedy and `top_k=1` cannot be marked; detection needs tokenizer + key + algorithm settings and no weights; no detection endpoint, only `examples/basic/online_serving/watermark_detection_server.py`.

Corrections / additions to carry into the design:
- **`key` is an integer** (`--key type=int` in the example server; docs example `42`). The snippet must print it unquoted. The range is not documented. JavaScript numbers lose precision above 2^53, so v1 keys are **safe integers** (generate with `crypto.randomInt(1, 2**48)`; accept 1..2^53-1 when entered). Suggest the detector contract also accepts the key as a decimal string. Check vLLM source for the real key width before widening.
- **No `prf` generation field.** `philox` is the only PRF; `prf` is a *detector* parameter. Generation fields: `context_width` (default 4, above 16 warns), `deduplicate_contexts` (default `single_turn`), `allow_target_only_watermarking`. The detector must tokenize with `add_special_tokens=False` and keep `deduplicate_contexts` at the calibrated default; write both into the contract doc.
- **The page does not mention `extra_body`.** That is an OpenAI-SDK client concept; the SDK merges it into top-level JSON, so the server only ever sees a top-level `watermarking`. "Stripping `extra_body`" is moot (see 8.3).
- **Example server:** `POST /detect {text}` returns `{score, p_value, num_scored_tokens, is_watermarked}`; `is_watermarked` uses `--p-value-threshold` default 0.01; binds 127.0.0.1; no auth; one key; no minimum-length handling. Our contract (multi-key, bearer) is a superset of that response.
- **Maturity:** labelled "developer preview"; no release number given. The operator guide must say "needs a vLLM build with watermarking" and give the check: Prometheus counter `vllm:watermark_requests_total{status=watermarked|skipped|not_watermarked}` exists only when `--watermark-config` is set.
- The docs recommend testing candidate configs and correcting for multiple testing (Bonferroni), and measuring the false-positive rate on real traffic. Not in the issue; adopted above.
- Not verified (I could not read vLLM source): what vLLM answers when `watermarking: true` arrives but no `--watermark-config` is set (400, or ignored). Test against a real vLLM; the adapter must not assume either.
- From memory, not verified: vLLM treats temperature below 1e-5 as greedy (`_SAMPLING_EPS`). I use `temperature <= 1e-5`.

## 8. Findings in the codebase

1. **vLLM is two providers.** `provider: "local"` is `server/adapters/vllm.js` (registry `server/adapters/index.js:17-23`). CLAUDE.md and `docs/local-llm-providers.md` also tell operators to use `provider: "openai"` for vLLM (`server/adapters/openai.js`). Both build the OpenAI-shaped chat body. Marking must work for both and must **never** be sent to real OpenAI (unknown field gives a 400). So `by: "ihub"` is only allowed for `local` and `openai` (schema rule, 9.2).
2. **One choke point for all LLM requests.** `LLMClient.execute` (`server/services/loop/LLMClient.js`) calls `createCompletionRequest` at line 826 and `defaultTransport` (line 1776) does `httpFetch(url, {body: JSON.stringify(request.body)})`. Chat, `/api/inference/v1/chat/completions` (`routes/openaiProxy.js:354`), workflows and agents all go through it. No other file builds a body for these providers.
3. **Client overrides cannot reach vLLM today.** `handleModelCompletion` (`openaiProxy.js:362-375`) destructures a fixed list (`model, messages, stream, stream_options, tools, tool_choice, max_tokens, response_format, prompt`); the app path (`:717`) reads named fields only; adapters build the body from model config and options only. `watermarking` / `extra_body` are dropped structurally. The work is a **regression test** that pins this (plus a code comment), not a stripper. Do not add a generic body passthrough later.
4. **Sampling comes only from the model.** `BaseAdapter.resolveSampling` (`adapters/BaseAdapter.js:67-75`) reads `model.sampling` (`validators/modelConfigSchema.js:63`) and returns `{}` when `supportsTemperature === false`. Apps, prompts, workflows and agents set no temperature. So greedy detection is a pure function of the model config. When `sampling.temperature` is unset vLLM uses `generation_config.json` (gap in section 5).
5. **Secrets pattern.** `TokenStorageService.encryptString/decryptString/isEncrypted` produce `ENC[AES256_GCM,...]` (`services/TokenStorageService.js:807,845,917`). Platform secrets are decrypted into the cache (`utils/configSecrets.js` `decryptPlatformSecrets`, hooked at `configCache.js:147`) and re-encrypted on every save by `ConfigStore.writeJson` (`services/config/ConfigStore.js:600-607`), which only knows `speech.azure.subscriptionKey`. The central credential store (`config/credentials.json`, `CredentialService.resolveSecret(ref)`, admin CRUD with redaction in `routes/admin/credentials.js`) already holds `bearer` credentials.
6. **Model schema and exposure.** `modelConfigSchema.js` is `.strict()`; 3327 adds `contentMarking`; `superRefine` is at line 326. `routes/modelRoutes.js:25-38` `sanitizeModelForPublic` is what non-admin model lists pass through (strips `apiKey`; `url` for TTS/transcription). Admin model reads mask `apiKey` (`routes/admin/models.js:410,608`).
7. **Audit.** `logAudit` (`services/AuditLogService.js`, ~line 158) never throws and returns `null` on failure. Allowed actions (`validators/auditEntrySchema.js`): `create update delete toggle execute import export login logout read share revoke request requestDecision`; `read` fits a reveal. The global `middleware/auditLogger.js` logs request bodies (redacted by key name via `SENSITIVE_KEY_RE`, line 39) when `audit.verbosity` is `request`/`full`, **but only if the route did not call `logAudit` itself** (`_auditLogged`). `SENSITIVE_KEY_RE` does **not** match a bare `key`.
8. **Outbound rules.** `httpFetch` (`utils/httpConfig.js:796`) applies proxy + whitelist (`shouldIgnoreSSLForURL` :172, `createAgent` :650) and accepts a `lookup` option to pin DNS. `utils/ssrfGuard.js` has `isPrivateIP`, `isAlwaysBlockedIP` (loopback and metadata are always blocked there, so `assertPublicTarget({allowPrivate:true})` cannot be used as-is for a sidecar detector on 127.0.0.1), `createPinnedLookup`. `utils/boundedBodyReader.js` `readBoundedBody` caps response size. `outboundRecorder` (admin action tests) records raw request bodies; the detector call must never run inside `recordOutbound`.
9. **Atomic read-modify-write exists:** `ConfigStore.updateJson(relPath, mutate)` (`:681`), queued per process and etag/lock-safe across processes. `routes/admin/credentials.js` is the template for an admin route (adminAuth, `sendCreated`, `ServiceError`, `logAudit`).
10. **Migrations.** Latest on disk: **V240** (`V240__footer_text_translation_reference.js`). Issues 3326/3327 say "after V226": stale. Expected: 3325/3326/3327 take V241..V243. **3331 needs no migration**: the key store is a brand-new file (no migration for new files per CLAUDE.md) and the new model fields are optional. Platform tunables get code defaults. If the team wants `provenance.watermark` defaults seeded in platform.json, that is the next free number after the stack (probably V244): run `ls server/migrations | tail` on the branch and use the `create-migration` skill.

## 9. Design

### 9.1 Files

```
server/services/provenance/watermark/
  watermarkPlan.js        pure: planTextWatermark(model, sampling, options, activeKeyId)
  WatermarkKeyStore.js    encrypted key store, rotation, reveal
  DetectorClient.js       one detector call via httpFetch; URL policy; response validation
  detect.js               detectWatermark(text, {modelId?}): fan-out, multiplicity, too_short
  selfTest.js             generate ~300 tokens, detect, diagnose
server/routes/admin/watermarkKeys.js         key API (register in routes/adminRoutes.js)
server/routes/admin/watermarkDetectors.js    detector list / test / self-test
server/tests/helpers/mockWatermarkDetector.js  mock for CI and dev
```
Modified: `adapters/BaseAdapter.js` (shared helper), `adapters/vllm.js`, `adapters/openai.js`, `services/loop/LLMClient.js`, `validators/modelConfigSchema.js`, `routes/modelRoutes.js`, `middleware/auditLogger.js`, `shared/apiErrors.js`, 3327's `turnProvenance.js` and verify route (assumed), docs.

### 9.2 Model config (extends 3327's `contentMarking.text`)

```jsonc
"contentMarking": { "text": {
  "by": "ihub", "scheme": "vllm-gumbel",
  "detectorUrl": "https://detector.internal:8443/detect",      // optional; without it verify cannot detect (red in 3329)
  "detectorCredentialRef": "wm-detector",                       // id of a `bearer` entry in credentials.json
  "tokenizer": "mistralai/Mistral-Small-3.2-24B-Instruct-2506", // HF id/path the detector loads; default model.modelId
  "algorithm": "gumbel", "prf": "philox", "contextWidth": 4      // must equal the vLLM server settings
}}
```
`superRefine` (line 326): `by:"ihub"` requires `provider` in `local|openai` and `scheme === "vllm-gumbel"`; `detectorUrl` must be http(s); `contextWidth` int 1..16; `algorithm` enum `["gumbel"]`; `keyId` rejected for `by:"ihub"` (6.6). The detector token goes through **`detectorCredentialRef`**, not an inline secret: no new encryption or redaction path in model files; the credentials page and `CredentialService` already do both. (Alternative considered: inline `detectorToken` encrypted like model `apiKey`, `routes/admin/models.js:646`. Rejected: mask/restore logic in several routes. 3329 shows a credential dropdown plus a link to the credentials page.) `sanitizeModelForPublic` (`modelRoutes.js:25`) must also delete `contentMarking.text.detectorUrl`, `detectorCredentialRef`, `tokenizer` (internal hostnames); keep `by`/`scheme` for the "not marked" hint.

### 9.3 Generation (server-owned marking)

- `planTextWatermark(model, sampling, options, activeKeyId)` returns `{by, scheme, applied, keyId, reason}`:
  - `by !== "ihub"`: returns null (nothing added to the body).
  - `reason: "greedy"` when `sampling.temperature <= 1e-5` or `sampling.topK === 1` (use `adapter.resolveSampling(model)`, so `supportsTemperature:false` yields no greedy claim).
  - `reason: "structured_output"` when `options.responseSchema` or `responseFormat === "json"` (6.10).
  - `reason: "no_active_key"` when the store has no active key (flag still sent; vLLM may mark with its own key; we do not claim it).
  - else `applied: true, keyId: <active key_id>`.
- Adapters: `body.watermarking = true` iff a plan exists, in `vllm.js` right after the sampling lines (~`:48-50`) and in `openai.js` (~`:44-46`); shared lookup in `BaseAdapter` (`applyTextWatermark(body, model, options, sampling)`). Always `true`; never read from anything client-supplied. Also set a **non-wire** field on the returned request: `request.marking = { text: plan }`. `defaultTransport` ignores extra fields; the JSON body is unchanged.
- `LLMClient.js:848`: `meta = {..., marking: request.marking}`; `ResultAccumulator.snapshot()` (`:296-318`) adds `marking: this.meta.marking ?? null`. 3327's `turnProvenance.js` (assumed) maps it to `model.watermark = {by, scheme, key_id, applied}` plus an optional additive `reason`. Tool loops: use the marking of the step that produced the final text; if any text-producing step was `applied:false`, the turn is `applied:false`.
- The active-key lookup used by adapters is a synchronous in-memory snapshot of `key_id`s (refreshed on every key change and on startup); adapters never await disk and never hold key values.

### 9.4 Key store

- File `contents/config/watermark-keys.json` through `configStore.updateJson` / `readJsonStrict` (atomic, multi-worker safe; a corrupt file throws, never resets to empty, same rule as `credentials.js:readStore`). **Not** in `platform.json`: platform is rewritten whole from a client copy by `POST /api/admin/configs/platform` (a stale tab would overwrite key status), it would need new decrypt/redact/re-encrypt code in `configSecrets.js`, `configs.js` and `ConfigStore.writeJson`, and the decrypted copy would sit in `configCache`. **Do not** load this file into `configCache`; decrypt at use only.
- Shape:
```json
{ "version": 1, "nextSeq": { "2026": 3 },
  "keys": [
    { "keyId": "wm-2026-2", "status": "active", "key": "ENC[AES256_GCM,...]",
      "source": "generated", "createdAt": "...", "createdBy": "admin", "label": "Q4 rotation" },
    { "keyId": "wm-2026-1", "status": "retired", "key": "ENC[...]", "retiredAt": "...", "createdAt": "..." } ] }
```
  `keyId = wm-<year>-<seq>`, server-assigned, never reused (the counter survives deletion). Invariant asserted inside every mutation: exactly one `active` once any key exists (zero keys is the initial state). Reject a value equal to an existing key (decrypt-compare) with 409. Entered keys below 2^32 return `weakKey: true` (warning only; operators may reuse an existing vLLM key).
- Service API (for 3329 and verify): `list()`, `create({key?, label?}, actor)`, `activate(keyId, actor)`, `reveal(keyId, actor)`, `remove(keyId, actor)`, `getActiveKeyId()`, `getKeysForDetection()` (active first, then retired; only `DetectorClient` may call it), `buildVllmConfigSnippet(keyValue, {contextWidth})` giving `--watermark-config '{"algorithm":"gumbel","key":<int>,"enforce":true}'`.
- Encryption: `tokenStorageService.encryptString(String(key))`; initialise the encryption key first if needed (pattern in `encryptPlatformSecrets`, `configSecrets.js:85-95`).

### 9.5 API surface (admin, `adminAuth`; follows `docs/api-guidelines.md`)

All under `/api/admin` via `buildServerPath`. Errors: `throw new ServiceError(code, ...)`. Add a `WATERMARK_ERROR_CODES` group to `shared/apiErrors.js`: `WATERMARK_KEY_NOT_FOUND:404`, `WATERMARK_KEY_ACTIVE:409`, `WATERMARK_KEY_DUPLICATE:409`, `WATERMARK_KEY_INVALID:400`, `WATERMARK_DETECTOR_NOT_CONFIGURED:409`, `WATERMARK_DETECTOR_UNREACHABLE:502`, `WATERMARK_AUDIT_UNAVAILABLE:503`; plus `apiErrors.<CODE>` client i18n keys.

| Method and path | Result |
|---|---|
| `GET /watermark-keys` | `200 { items: [{keyId, status, source, label?, createdAt, createdBy, retiredAt?}], nextCursor: null }`; never a key value |
| `POST /watermark-keys` body `{ key?, label? }` | `201` + `Location: /api/admin/watermark-keys/{keyId}`; body = item plus `key` and `vllmConfigSnippet` (shown once; no `key` in the request means generate). New key becomes active; previous active becomes retired, in one atomic update |
| `POST /watermark-keys/{keyId}/_activate` | `200` item. Re-activates a retired key (rollback when vLLM was not updated); previous active becomes retired |
| `POST /watermark-keys/{keyId}/_reveal` | `200 { keyId, key, vllmConfigSnippet }` with `Cache-Control: no-store`. Audit `read` first; `503 WATERMARK_AUDIT_UNAVAILABLE` if `logAudit` returned `null` |
| `DELETE /watermark-keys/{keyId}` | `204`; `409 WATERMARK_KEY_ACTIVE` if active. The confirmation is a UI dialog; server has no second gate |
| `GET /watermark-detectors` | `200 { items: [{modelId, detectorUrl, tokenizer, algorithm, prf, contextWidth, credentialRef, hasActiveKey, urlPolicyOk, urlPolicyProblem?}], nextCursor: null }` for every model with `by:"ihub"`; static config, no network |
| `POST /watermark-detectors/{modelId}/_test` | `200 { reachable, authenticated, contractValid, latencyMs, error? }`. Calls the detector with a **throwaway random key** and a fixed sentence: proves URL/TLS/token/schema without sending a real key. This is the "live ping" for 3329's status card. "Not reachable" is a result (200), not an error |
| `POST /watermark-detectors/{modelId}/_self-test` | `200 { ok, diagnosis, matchedKeyId?, scoredTokens, pValue, status }`. Calls the model through `llmClient` using a clone `{...model, sampling:{temperature:1}}` (`maxOutputTokens` ~400, prompt asks for ~350 words), then detects with all keys. `diagnosis`: `keys_match`, `matches_retired_key`, `no_watermark_found` (key mismatch, or vLLM not watermarking), `too_short`, `detector_unreachable`. Audit `execute`. One real generation: admin-only, no retries |

The verify extension (3327's `POST /api/provenance/verify`, assumed) returns an additive `watermark` object for text input:
```json
"watermark": { "status": "detected|not_detected|too_short|unavailable|not_configured",
  "scheme": "vllm-gumbel", "technique": "gumbel-max", "keyId": "wm-2026-1", "pValue": 1.2e-9,
  "scoredTokens": 240, "keysChecked": 2, "detectorsChecked": 1 }
```
`unavailable` (detector down, timeout) never turns the request into a 5xx; the hash result is still returned. No key values anywhere in it.

### 9.6 Verify / detection flow (`detect.js`)

1. Hash lookup (3327). **Hit:** return the record (with its `key_id`); no detector call (saves time, avoids sending keys).
2. **Miss:** candidates = distinct `(detectorUrl, tokenizer, algorithm, prf, contextWidth, credentialRef)` among enabled `by:"ihub"` models with a `detectorUrl`, narrowed by optional `modelId`. None gives `not_configured`.
3. No keys in the store gives `not_configured`. Else `keys = getKeysForDetection()`.
4. Call each candidate (parallel, cap 3, per-call timeout 15 s, platform override `provenance.watermark.detectorTimeoutMs`). Text is sent **as given** (no NFC/trim: those change tokens), size capped.
5. Decide in iHub: per result, `p_value < alpha / (keys x detectors)` (alpha default 1e-4, override `provenance.watermark.alpha`). Lowest p gives `keyId`. Ignore the detector's `is_watermarked` and any `key_id` we did not send.
6. Not detected and best `num_scored_tokens < minScoredTokens` (default 200, override): `too_short`. Else `not_detected`.
7. Tunables are read with code defaults from `configCache.getPlatform()?.provenance?.watermark` (no migration).

### 9.7 Detector client (`DetectorClient.js`)

- `httpFetch(url, { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body, signal, redirect:'error' })`. **`redirect:'error'` is mandatory**: a redirect would forward the bearer token and all keys to another host. Token from `CredentialService.tryResolveSecret(detectorCredentialRef)`; without a token refuse to send keys (`WATERMARK_DETECTOR_NOT_CONFIGURED`): keys must never go out unauthenticated.
- URL policy `assertDetectorUrlAllowed(url)`, run at call time (not only at config save): `https:` always allowed; `http:` only where **every resolved address** is loopback or `isPrivateIP`, or the host is in `ssrf.allowedHosts` (`isSsrfTrustedHost`). Refuse userinfo and link-local/metadata addresses (169.254.0.0/16). Pin resolved addresses with `createPinnedLookup` (pass `lookup` to `httpFetch`) against DNS rebinding. Write a small loopback+private helper; do not use `assertPublicTarget(allowPrivate)` because it blocks loopback.
- Response: `readBoundedBody(res, 64 KB)`, parse, Zod-validate (`num_scored_tokens` int, `results[]` with `key_id`, `p_value` in [0,1], optional `score`, `is_watermarked`). Non-2xx maps to `WATERMARK_DETECTOR_UNREACHABLE` (401/403 recorded as `authenticated:false` for `_test`).
- Logging: URL (through `redactUrlSecrets`), status, duration, `keysSent` count, `scoredTokens`. Never the body, any key, or the text. Redact key values by value (`utils/secretRedaction.js`) in any error message built from the response.
- SSL: no code beyond using `httpFetch`; `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist` apply automatically.

### 9.8 Audit and log hygiene

| Event | `logAudit` |
|---|---|
| create / generate | `create`, resource `watermarkKey`, id `keyId`, details `{source, previousActiveKeyId}` |
| activate | `update`, details `{from, to}` |
| reveal | `read`, written before responding, summary "Revealed watermark key wm-2026-1" |
| delete | `delete` |
| self-test | `execute`, resource `watermarkDetector`, id `modelId` |

Never put a key or token in `details`/`summary`. Fix the global middleware: extend `SENSITIVE_KEY_RE` (`middleware/auditLogger.js:39`) with `|^key$` so a rejected `POST /watermark-keys` (a validation 400 before our explicit audit call) does not log `{"key":123}` at `audit.verbosity: request|full`. Also call `logAudit` on failure paths of create.

### 9.9 Mock detector (CI)

`server/tests/helpers/mockWatermarkDetector.js`: `startMockDetector({ token })` returns `{url, close, calls, markText(text, keyValue), setMode('ok'|'401'|'500'|'slow'|'badJson'|'redirect')}`, built on `node:http`. Scoring is a simulation, not Gumbel: text registered through `markText` whose key is among the request's `keys` gets `p_value 1e-9`; everything else `0.47`; `num_scored_tokens = round(words * 1.3)`. It records every request body so tests assert exactly which keys were sent. Optional dev script `npm run mock:detector` for 3329 UI work. One test gated on `WATERMARK_DETECTOR_URL` for a real detector later.

## 10. Tests (under `server/tests/`, run by `scripts/run-server-tests.js`; jest style as `httpConfig.fetch-ssl-whitelist.test.js`)

1. `watermarkPlan.test.js`: greedy matrix (temp 0, 1e-6, `topK` 1, `supportsTemperature:false`, unset), `no_active_key`, structured output, provider restriction.
2. `watermark-adapters.test.js`: vllm and openai bodies contain `watermarking:true` only for `by:"ihub"`; absent for `by:"none"`/unset; `request.marking` carries `applied/keyId`; wire body has no `marking`.
3. `watermark-inference-override.test.js` (**acceptance**): `new LLMClient({transport})` capturing the JSON body, `registerOpenAIProxyRoutes(app,{llmClient})` with supertest; send `watermarking:false`, `extra_body:{watermarking:false}` and the SDK-flattened top-level form to `/api/inference/v1/chat/completions` for a model and an app (`model:"app:..."`), stream and non-stream: captured body has `watermarking:true`. Same through the chat path.
4. `watermarkKeyStore.test.js`: ciphertext on disk (`ENC[`; plaintext key absent from the raw file); rotation keeps the old key `retired`; exactly one active under `Promise.all` of 5 creates; ids unique and not reused after delete; duplicate value 409; delete-active 409; corrupt file throws and is not overwritten; `activate` swaps correctly.
5. `adminWatermarkKeys.test.js`: anonymous and non-admin get 401/403 on every route; list responses contain no key value (stringify and search); reveal writes the audit entry (`flushAuditLog`, read the file) before responding and returns 503 when `logAudit` is stubbed to `null`; create/activate/delete each write one entry; no entry contains a key; with `audit.verbosity:"full"` a rejected create leaves no key in the log; a logger spy across create/rotate/detect sees no key value or token.
6. `modelRoutes` test: non-admin model list has no `detectorUrl`/`detectorCredentialRef`/`tokenizer`.
7. `detectorClient.test.js` against the mock: request shape (`Authorization`, `keys` active first, `text`, `tokenizer`, `algorithm`, `prf`, `context_width`); 401, 500, bad JSON, oversize, timeout; redirect refused (assert the second host is never hit); no credential configured refuses before any network call.
8. **`detectorClient.ssl-whitelist.test.js` (required by CLAUDE.md):** (a) decision level as in the existing test: `ssl:{ignoreInvalidCertificates:true, domainWhitelist:['detector.internal']}`; `shouldIgnoreSSLForURL` true for `https://detector.internal/detect`, false for `https://other.example/detect`, false when `ignoreInvalidCertificates` is off; (b) one real TLS case with a self-signed cert generated at test time with `openssl` (skip if absent; there is no `selfsigned` dependency): whitelisted `127.0.0.1` succeeds, non-whitelisted fails with a certificate error (`DEPTH_ZERO_SELF_SIGNED_CERT`). Both calls go through `DetectorClient`, so a bare `fetch` fails the test.
9. `detectorUrlPolicy.test.js`: https public ok; http to `127.0.0.1`, `10.x`, `192.168.x`, `[::1]` ok; http to a public IP / public DNS name refused; DNS name resolving to mixed private+public refused; `169.254.169.254` refused; `user:pw@` refused.
10. `watermarkVerify.test.js`: hash hit makes zero detector calls; miss sends active + retired keys; text marked with the retired key returns the old `keyId` after rotation (**acceptance**); short negative gives `too_short`; short positive stays `detected`; with two keys Bonferroni applies (p between alpha/2 and alpha is `not_detected`); detector down gives `unavailable` with HTTP 200; no keys gives `not_configured`; unknown `key_id` in a detector response ignored.
11. `watermarkSelfTest.test.js`: the model clone uses `temperature:1`; diagnosis `matches_retired_key` when the mock only knows the old key.
12. `modelConfigSchema` tests: `by:"ihub"` rejected for `anthropic`/`google`/`mistral`/`bedrock`; `keyId` rejected; `contextWidth` bounds; `detectorUrl` scheme.

## 11. Docs and changelog

- Operator guide: new `docs/ai-act-text-watermarking.md` (add to `docs/SUMMARY.md`), plus a short "Watermarking" section and link in `docs/vllm-server-parameters.md`. Contents: prerequisites (vLLM build with watermarking, developer preview; check `vllm:watermark_requests_total`), start command with `enforce:true` and `context_width`, why `deduplicate_contexts` stays default, model config example, greedy / `generation_config.json` caveat, rotation procedure (create key in iHub, update vLLM `--watermark-config`, restart, run self-test), what retired keys do, backup / `.encryption-key` caveat, detector contract (request/response, tokenize with `add_special_tokens=False`, must not log bodies, HTTPS or internal network, bearer), the limits table from section 5, false-positive calibration advice.
- Link from `docs/local-llm-providers.md` (vLLM section). Add `@swagger` blocks to the new routes like the other admin routes.
- Release note in `docs/releases/next/features.md` through the `/document-feature` skill (visible to admins). If 3327 already added an AI Act entry, extend it.
- SPDX header on every new `.js` (`reuse annotate ...` as in CLAUDE.md). Run `npm run lint:fix && npm run format:fix`.

## 12. Pitfalls

- Never send `watermarking` to a non-vLLM `openai` model: the schema rule is the only guard, so make it a validation error, not a warning.
- JSON numbers above 2^53 corrupt keys. Safe-integer keys only in v1; never `Number()` a larger decimal string.
- The in-memory active-key snapshot holds ids only; key values exist only inside `WatermarkKeyStore` call frames.
- `logAudit` swallows errors: check its return value for reveal.
- Do not keep key status in `platform.json` or `configCache`; check `routes/admin/configs.js` and `routes/admin/backup.js` do not expose the file decrypted (a backup carries ciphertext, usable only with the same `.encryption-key`).
- Detection re-tokenizes the final text, so any post-generation change by iHub (citation markers, footers, markdown rewriting) lowers the score. Self-test on the raw answer; tell 3327 that the hashed text and the watermarked text may differ slightly.
- Reasoning tokens (hidden with `include_reasoning:false`) are also marked but are not in the answer: the 200-token threshold applies to visible answer text only.
- `n > 1`, streaming and non-streaming are fine; beam search is not (iHub never sends it).
- `redirect:'error'` on the detector call; pin DNS; never inside `recordOutbound`.
- Per-model detectors but one key set: a second vLLM with another key gives permanent `not_detected` for its output.
- Rotation does not retro-fit: output generated between "rotate in iHub" and "restart vLLM" is recorded under the new `key_id` but marked with the old key. Document the order: restart vLLM right after rotating, then run the self-test.
- Rate limit and size-cap the verify endpoint (existing limiters in `middleware/rateLimiting.js`).

## 13. Ordered implementation checklist (S = under half a day, M = about a day, L = 2+ days)

1. (S) Rebase on 3327; confirm: `contentMarking.text` schema, how `turnProvenance` gets `model.watermark`, verify route auth and shape, the `keyId?` decision. Re-check the migration number.
2. (S) Schema: extend `contentMarking.text` + `superRefine` rules + tests (12); `sanitizeModelForPublic` + test (6).
3. (M) `WatermarkKeyStore` + `shared/apiErrors.js` codes + tests (4).
4. (M) `watermarkPlan`, `BaseAdapter` helper, `vllm.js`/`openai.js`, `LLMClient` meta/snapshot, wire into `turnProvenance`; tests (1, 2, 3).
5. (M) Admin key routes + audit + `SENSITIVE_KEY_RE` fix + register in `adminRoutes.js` + swagger blocks; tests (5).
6. (M) `DetectorClient` + URL policy + mock detector; tests (7, 8, 9).
7. (M) `detect.js` + verify route extension; tests (10).
8. (M) Detector list / `_test` / `_self-test` routes + `selfTest.js`; tests (11). Hand the endpoint table in 9.5 to the 3329 owner.
9. (S) Docs (section 11), changelog, SPDX headers, lint/format, `timeout 10s node server/server.js` boot check.
10. (S, optional) Smoke test against real vLLM with the example detection server behind a thin multi-key adapter; record what vLLM does for `watermarking:true` without a config.

Total about 6 to 8 engineering days, dominated by detector-client policy/tests and key-store concurrency tests.
