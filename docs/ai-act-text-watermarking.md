# Text Watermarking (vLLM) and Detection

EU AI Act Art. 50(2) asks providers of systems that generate synthetic text to mark the output in a
machine-readable way and make it detectable. For **self-hosted vLLM models** iHub does this with vLLM's text
watermark. For hosted models (OpenAI, Anthropic, Gemini, …) iHub cannot watermark; use
`contentMarking.text.by: "provider"` with the provider's written statement ([Provenance Records](provenance.md)).

The watermark is **statistical**. It survives light edits, but not paraphrasing, translation or heavy rewriting, and
a missing hit is **never proof that a person wrote a text**. The exact-text hash lookup of the provenance records
and the watermark detector complement each other: `_verify` tries the hash first and the detector second.

## How it fits together

```
iHub  -- watermarking:true -->  vLLM (--watermark-config key, enforce)   answer is watermarked
iHub  -- text + all keys  -->   detector (HTTPS/internal, bearer)         p-value per key
```

- **Server-owned.** iHub adds `watermarking: true` to the request of every model marked `by: "ihub"`. Nothing a
  client sends (`watermarking: false`, `extra_body`, the flattened SDK form) reaches vLLM; with `enforce: true`
  on the vLLM side a client could not switch it off either.
- **Keys live in iHub** (`contents/config/watermark-keys.json`, encrypted with `contents/.encryption-key`). The key
  value is never sent to vLLM by iHub; **you** copy it into vLLM's start command. It goes to the detector in the
  request body, which is why the detector is a sensitive component (see below).
- **Records** of watermarked answers carry `model.watermark = {by: "ihub", scheme: "vllm-gumbel", key_id,
  applied}`. A request that cannot be marked is recorded `applied: false` with `reason`: `greedy`,
  `structured_output` or `no_active_key`.

## Prerequisites

- A vLLM build **with the watermarking feature**. vLLM labels it a *developer preview*; there is no release
  number we could verify. Check that it is active: the Prometheus counter
  `vllm:watermark_requests_total{status="watermarked|skipped|not_watermarked"}` exists only when
  `--watermark-config` is set.
- A detector service (below). vLLM itself has no detection endpoint, only an example server
  (`examples/basic/online_serving/watermark_detection_server.py`).

## Setup

1. **Create a key.** `POST /api/admin/watermark-keys` with `{}` (generate) or `{ "key": "123456789012" }`. The
   response carries the key once, as a string, and the vLLM flag:

   ```
   --watermark-config '{"algorithm":"gumbel","key":123456789012,"enforce":true}'
   ```

   The key is a **safe integer** (1 to 9007199254740991): vLLM takes an integer, and larger numbers lose precision
   in JSON. Keys below 2^32 are accepted with a `weakKey` warning.
2. **Start vLLM with that flag**, plus the usual model flags
   ([vLLM Server Start Parameters](vllm-server-parameters.md)). `enforce: true` makes the watermark apply even when a
   request says otherwise. If you set `context_width`, set the same `contextWidth` on the iHub model.
3. **Configure the model** (**Admin → Models → Output marking**, or JSON):

   ```json
   "contentMarking": { "text": {
     "by": "ihub", "scheme": "vllm-gumbel",
     "detectorUrl": "https://detector.internal:8443/detect",
     "detectorCredentialRef": "wm-detector",
     "tokenizer": "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
     "algorithm": "gumbel", "prf": "philox", "contextWidth": 4
   } }
   ```

   `by: "ihub"` is accepted for `provider: "local"` and for `provider: "openai"` (pointed at vLLM) only; any other
   provider fails validation, because the `watermarking` request field would be rejected by a hosted API.
   `detectorCredentialRef` is the id of a `bearer` credential (**Admin → Credentials**). `tokenizer` defaults to the
   model's `modelId`. `keyId` is not used with `ihub`: the key store decides.
4. **Sample explicitly.** Set `sampling.temperature` (and not `topK: 1`) on the model. If it is unset, vLLM uses the
   model's `generation_config.json`, which iHub cannot see, and that file may say temperature 0 (greedy: no
   watermark) while iHub reports `applied: true`.
5. **Run the self-test:** `POST /api/admin/watermark-detectors/{modelId}/_self-test` (one real generation of about
   350 words at temperature 1).

| `diagnosis` | Meaning |
| --- | --- |
| `keys_match` | iHub and vLLM use the same key. |
| `matches_retired_key` | vLLM still runs an older key: restart it with the active key's flag. |
| `no_watermark_found` | Key mismatch, vLLM without watermarking, or tokenizer/context-width mismatch. |
| `too_short` | The answer had too few scored tokens to decide. |
| `detector_unreachable` | See `_test`. |
| `not_applied` / `no_keys` | iHub did not request a mark (see `reason`) / no key exists yet. |

`POST /api/admin/watermark-detectors/{modelId}/_test` checks URL, TLS, token and response contract with a
throwaway random key; no real key leaves iHub.

## Rotation

1. `POST /api/admin/watermark-keys` (new key becomes **active**, the previous one **retired**).
2. **Restart vLLM right away** with the new `--watermark-config`, then run the self-test.
3. Retired keys stay in the store and are tried by the detector, so older text is still recognised and reports its
   **old** `keyId`. Delete one only deliberately: text made with it can no longer be recognised, and its id is never
   reused. Key ids are `wm-<product>-<installation id>-<year>-<seq>`, for example
   `wm-ihub-inst_3c0d2b6e-5a41-4e0f-9d1c-7b8a2f4e6c10-2026-2`. The installation id is the one in
   `generator.installation_id` of every provenance object (`IHUB_INSTALLATION_ID` overrides it), so an id says
   where it comes from and ids from two installations never collide. `POST .../{keyId}/_activate` re-activates a retired key (rollback).

Output generated between "rotate in iHub" and "restart vLLM" is recorded under the new `key_id` but marked with
the old key. A reveal (`POST .../{keyId}/_reveal`) is `Cache-Control: no-store`, written to the audit log **before**
the key is returned, and refused (`503`) when the audit log cannot be written.

**Backup.** The keys are encrypted with `contents/.encryption-key`. A backup restored without that file, or on
another installation, loses them (the retired ones included). There is no key export.

## Detector contract

iHub does not ship a detector. It calls one over HTTP:

```
POST <detectorUrl>
Authorization: Bearer <token of detectorCredentialRef>
{ "text": "...", "tokenizer": "...", "algorithm": "gumbel", "prf": "philox", "context_width": 4,
  "keys": [ { "key_id": "wm-ihub-inst_3c0d2b6e-5a41-4e0f-9d1c-7b8a2f4e6c10-2026-2", "key": 123456789012 }, { "key_id": "wm-ihub-inst_3c0d2b6e-5a41-4e0f-9d1c-7b8a2f4e6c10-2026-1", "key": 987654321 } ] }

200 { "num_scored_tokens": 240,
      "results": [ { "key_id": "wm-ihub-inst_3c0d2b6e-5a41-4e0f-9d1c-7b8a2f4e6c10-2026-2", "p_value": 0.47 }, { "key_id": "wm-ihub-inst_3c0d2b6e-5a41-4e0f-9d1c-7b8a2f4e6c10-2026-1", "p_value": 1.2e-9 } ] }
```

- Active key first. `key` is a safe integer; accept a decimal string as well if you can.
- Tokenize with `add_special_tokens=False` and keep vLLM's `deduplicate_contexts` at its default, or the p-values
  are not calibrated. `num_scored_tokens` is lower than the raw token count (repeated contexts are skipped).
- vLLM's example detector answers one key at a time and `is_watermarked` at p < 0.01: put a thin multi-key adapter
  in front. iHub **ignores `is_watermarked`** and any `key_id` it did not send.
- **The detector holds every key.** Run it on an internal network, require the bearer token, and **do not log
  request bodies**. A compromised detector would allow removing or forging watermarks.
- iHub accepts `https:`; plain `http:` only for loopback and private addresses (or a host on `ssl.domainWhitelist` /
  `ssrf.allowedHosts`); never a link-local or cloud-metadata address, never a URL with credentials, never a
  redirect. The check runs at call time and DNS is pinned. Without a token iHub sends nothing. The call uses iHub's
  HTTP client, so `ssl.ignoreInvalidCertificates` with `ssl.domainWhitelist` and the proxy apply.
- A mock for tests is `server/tests/helpers/mockWatermarkDetector.js`.

### How iHub decides

iHub decides from `p_value`, not from the detector's flag: **detected** when `p < alpha / (keys x detectors)`
(Bonferroni; `alpha` defaults to `1e-4`). A *negative* with fewer than `minScoredTokens` scored tokens (default 200)
is **too short to tell**; a positive stays *detected* at any length, since a small p-value is valid at any length.
Tunables in `platform.json` (all optional): `provenance.watermark.alpha`, `.minScoredTokens`,
`.detectorTimeoutMs` (15000). Measure the false-positive rate on real, unwatermarked traffic before relying on a
threshold; vLLM's documentation recommends the same.

Detection re-tokenizes the final text, so anything changed after generation (citation markers, footers, Markdown
rewriting) lowers the score. Only the visible answer counts toward the 200 tokens; hidden reasoning tokens are
marked too but are not in the answer.

## Limits

| Limit | Consequence |
| --- | --- |
| Hosted models | Not watermarked by iHub; use `by: "provider"` with a written statement. |
| Greedy decoding (temperature 0, `topK` 1) | No watermark; recorded `applied: false`, `reason: "greedy"`. |
| Structured output (JSON schema, `json_object`) | Grammar-constrained decoding gives a weak mark; recorded `applied: false`, `reason: "structured_output"`. |
| Fewer than about 200 scored tokens | Cannot be decided: "too short to tell". |
| Paraphrase, translation, heavy editing, summaries | The mark weakens or disappears. A miss is not proof of human origin. |
| Beam search, some speculative-decoding setups | Not marked or weak (iHub never sends beam search). |
| One key set for the installation | All `by: "ihub"` models share it; two vLLM servers on different keys give permanent "not detected" for one. |
| Workflows, scheduled tasks, Slack/Teams/Office | Records of these have no model config and report no watermark. |

## Unverified vLLM facts

These come from vLLM's documentation and memory and were **not** tested against a running server. Check them on your
vLLM before relying on them:

- What vLLM answers to `watermarking: true` when it was started **without** `--watermark-config` (error or ignored).
  iHub does not assume either; the self-test is the check.
- The accepted range of `key`. iHub limits itself to safe integers.
- That a temperature below `1e-5` is treated as greedy (iHub uses that threshold to decide `reason: "greedy"`).
- The feature's maturity: vLLM calls it a developer preview, and `dual_key_gumbel` and SynthID-Text are out of scope.

## Deployer duties

The provider duty of Art. 50(2) is only part of the picture. Operators who run iHub for others should also:

- keep the disclosure and acknowledgement features on ([EU AI Act](ai-act.md));
- keep `provenance.storeRecords` on so the exact-text lookup works, and tell users that "not found" proves nothing;
- **not remove or defeat marks** in the output. Stripping or rewriting a watermark (for example paraphrasing
  watermarked text to pass it off as human-written) can breach the terms of use of the model and the AI Act's
  marking obligations; do not offer that as a feature of your deployment.

## API summary

| Method and path | Result |
| --- | --- |
| `GET /api/admin/watermark-keys` | `{ items: [{ keyId, status, source, label?, createdAt, createdBy?, retiredAt? }], nextCursor: null }`, never a key |
| `POST /api/admin/watermark-keys` `{ key?, label? }` | `201` + `Location`; item plus `key` (string), `vllmConfigSnippet`, `weakKey?` |
| `POST /api/admin/watermark-keys/{keyId}/_activate` | `200` item |
| `POST /api/admin/watermark-keys/{keyId}/_reveal` | `200 { keyId, key, vllmConfigSnippet }`, audited first |
| `DELETE /api/admin/watermark-keys/{keyId}` | `204`; `409 WATERMARK_KEY_ACTIVE` for the active key |
| `GET /api/admin/watermark-detectors` | `{ items: [{ modelId, detectorUrl, tokenizer, algorithm, prf, contextWidth, credentialRef, hasActiveKey, urlPolicyOk, urlPolicyProblem? }], nextCursor: null }` |
| `POST /api/admin/watermark-detectors/{modelId}/_test` | `200 { reachable, authenticated, contractValid, latencyMs, error? }` |
| `POST /api/admin/watermark-detectors/{modelId}/_self-test` | `200 { ok, diagnosis, status, matchedKeyId?, scoredTokens, pValue?, reason? }` |
| `POST /api/provenance/_verify` | adds `watermark: { status, scheme?, technique?, keyId?, pValue?, scoredTokens?, keysChecked?, detectorsChecked? }` for a text with no record |
