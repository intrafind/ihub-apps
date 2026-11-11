# #3329 AI Act admin overview page: PM + engineering analysis

Epic #3324, stack position 6 of 6 (3325 -> 3326 -> 3327 -> 3331 -> 3328 -> 3329). Written 2026-11-11 against `/workspace/ihub-apps`
(plain main, none of the sibling code exists yet). Everything about sibling APIs is a **requirement to reconcile**, not a fact.
Context: marking duty for existing systems is due 2026-12-02, detection interop 2027-02-02 (concept `concepts/2026-09-27 EU AI Act Content Marking.md`).

---------------------------------------------------------------------------------------------------

# Part 1: Product Manager

## 1.1 What and why
One admin page, `/admin/eu-ai-act`, that answers three questions without reading config files:
1. **Is this installation set up for Art. 50 right now?** (traffic-light config check, each red/amber row links to where it is fixed)
2. **Can I operate the few things the Act makes me operate?** (re-ask acknowledgements, rotate watermark keys, export evidence)
3. **Does it actually work?** (self-test of the vLLM watermark loop, verification of a pasted text/image/audio)

Why it matters: a deployer (and, for self-installers, a provider) must be able to show an auditor *what was configured and that it worked*.
The page is that evidence: audit readiness as a glance, not a document hunt. It also protects us: self-installers get the same
visibility IntraFind uses, so "compliant defaults" are checkable.
It replaces the 6-tab page of #2619: one page, one card per topic, no gates/banners/reports.

**Honesty rule (copy, not just UI):** green means "configured as designed", not "legally compliant". The page header says so.

## 1.2 User stories (admin)
MoSCoW in brackets. All stories hold for role `admin` only (`adminAuth`).
- **US1 [M]** As an admin I want one traffic-light list of all Art. 50 settings so that I see in under 10 seconds what is missing.
  - AC: each check has level ok/warn/error, a plain sentence and (if fixable) a link to the exact admin page. Overall level = worst.
- **US2 [M]** As an admin of a vLLM installation I want red when a watermarked model has no active key, no/unreachable detector, or a failed self-test, so that I do not claim marking we do not deliver.
- **US3 [M]** As an admin I want to see counts (acknowledged / pending / total) and run Request again, Remove all and CSV export here, so that I need not hunt on the users page.
- **US4 [M]** As an admin I want to list keys (key_id, created, active/retired), add or generate a key, and see the matching `--watermark-config` once, so that I can rotate keys and reconfigure vLLM.
- **US5 [M]** As an admin I want to reveal an existing key on purpose (audit-logged) so that I can rebuild a vLLM node.
- **US6 [M]** As an admin I want to delete a retired key only after a clear warning, so that I do not make old output undetectable by accident.
- **US7 [S]** As an admin I want a per-model self-test (generate ~300 tokens at temperature 1, call detector) so that I know vLLM and iHub share the same key.
- **US8 [M]** As an admin (or auditor next to me) I want to paste text or upload an image/audio file and see which technique matched (hash record, watermark + `key_id`, C2PA, provider-declared) so that I can answer "is this ours?" (CoP 2.3).
- **US9 [S]** As an admin I want a "Re-check" button, and the page to say when the data was computed, so that I trust what I see after a fix.

## 1.3 Success criteria
- Fresh install with defaults: page loads in < 1 s, no errors, shows the real defaults (warn for unmarked models, not a blank page).
- 7 acceptance criteria of the issue pass as e2e/unit tests (see 2.9).
- A vLLM model with a deliberately wrong key shows red after self-test, green after vLLM is updated and the test is rerun.
- Admin can complete: rotate key, copy snippet, retire old, verify old-key text still matches, in < 5 minutes without docs.
- Page passes axe (WCAG 2.2 AA) in light and dark, keyboard only, EN + DE complete.

## 1.4 Non-goals (v1)
Justification gates, start-page banners, dismissals, installation binding, compliance report/certificate PDF (all stated in the issue);
legal assessment/score; editing platform/model settings on this page (links only, see Q1); auto-running the self-test; cross-installation key sharing;
building the detector service; key backup/escrow tooling; non-admin (content admin) access.

## 1.5 Open questions for the PM / sibling analyses (decide before build)
| # | Question | My recommendation |
|---|----------|-------------------|
| Q1 | Issue lists "Detector URL and token per model" in the keys card. Edit here or in the model editor? | Show status + link to the model editor (`/admin/models/:id`); secrets keep the existing model save/redact path. No new secret-write endpoint. |
| Q2 | Issue says 3329 adds **only** `GET /status`, but the self-test needs a server-side action (LLM call + detector call). Who owns it? | 3329 adds `POST /api/admin/eu-ai-act/models/{modelId}/_self-test`. Update the issue text; it is one more endpoint, not a sibling responsibility. |
| Q3 | Severity of "provider-marked without statementRef" and "model not marked". | Both **warn** (hint, no gate per #3327). Only the vLLM chain (key, detector, self-test) is **error**. |
| Q4 | Ack feature off / enforcement off: warn or ok? | **warn** (optional, Art. 4 literacy, not Art. 50); never error. |
| Q5 | Anonymous acknowledgements live only in the audit log. Counts? | Counts cover registered users only; label says so. |
| Q6 | Image/audio models (#3328) in the model rows? | Yes if `contentMarking.image/audio` exists; same by/statementRef rules. Needs sibling field names. |
| Q7 | JSON number precision: vLLM Gumbel key can exceed 2^53. | Admin API carries the key as a **string**; ask #3331 to confirm detector wire format (number vs string). |

## 1.6 Risks
1. **Self-test costs tokens and needs a live vLLM + detector.** Mitigate: manual button only, never on page load/status; one per model at a time; min 30 s between runs per model; max 2 attempts;
   button text says "uses about 400 tokens"; logged as usage `kind:'diagnostic'`. Output that is too short is **"inconclusive" (amber)**, not red (stochastic temp-1 text may stop early).
2. **Revealing a key** is the most sensitive action. POST (not GET), `Cache-Control: no-store`, audit entry, shown in a dialog, auto-hidden after 30 s, never stored in client state outside the dialog, never in status/list responses or logs.
3. **Deleting a retired key makes older output undetectable** (hash lookup only finds exact text; edited/pasted-in-part text is lost). Dialog must say so, name the key_id, and (if 3327 can count) how many records used it. Active key cannot be deleted.
4. **Key changed, vLLM not updated**: new output is marked with the old key, detected with the new one. Status shows self-test stale (amber) after any key change and red if the rerun fails. Page text says "update vLLM, then re-run self-test".
5. **No detector exists yet** (3331: "implementation open"). Until it does, real installs cannot turn green; CI uses a mock. Not a 3329 blocker, a schedule risk to the 2027-02-02 date.
6. **Schedule**: this issue is last in the stack and the 2026-12-02 date is about 3 weeks away. Cut line if needed: Must = status + keys + verification; Should = self-test, ack card (the ack actions already exist on the users page).
7. **Duplication**: ack actions exist on the users page (#3326). Reuse one component/hook, or the two drift.
8. **Slow status**: live detector pings could hold the page. Mitigate with parallel pings, 3 s timeout, 30 s cache, `?refresh=true` (see 2.3).
9. **Lost encryption key** (`contents/.encryption-key`) makes stored watermark keys unrecoverable. Show a warn line on the keys card ("back up the encryption key") and link to `docs/encryption-key-management.md`.

---------------------------------------------------------------------------------------------------

# Part 2: Senior Engineer (how)

## 2.1 What exists today (verified)
| Area | Where |
|---|---|
| Admin shell | `client/src/features/admin/components/AdminLayout.jsx:56` (builds nav, renders `<Outlet/>` in `<main id="admin-main-content">` at :90) |
| Nav data | `AdminSidebarNavData.js`: sections `observability` :265, `platform` :328 (`features` :333, `security` :347). Items are auto-sorted by label, gated by `showAdminPage(key)` |
| Command palette | `AdminCommandPalette.jsx:11-45` **static** list of `{label, href}`; needs its own entry (not derived from nav data) |
| Routes | `client/src/App.jsx`: lazy imports :37-182, admin `<Route path="admin">` :536-, e.g. `security` :862, `audit-log` :853. `/admin` is already a known route (no change to `runtimeBasePath.js` / `client/index.html`) |
| Page patterns | `AdminSystemResourcesPage.jsx` (local `Section` card :64, polling :15, status badge, `STORAGE_STATUS_STYLES` in `utils/systemResourcesFormat.js:58`); `AdminOverview.jsx` (`StatCard`); `ModelsSetupStrip.jsx` (step/CTA) |
| Shared UI | `shared/components/ConfirmDialog.jsx` (focus trap, `danger`), `Modal.jsx`, `Switch.jsx`, `Icon.jsx`, `Drawer.jsx`; `StatusBadge.jsx` is for job states, not reusable for traffic lights |
| Admin API client | `client/src/api/adminApi.js:19` `makeAdminApiCall(url, {method, body, responseType})`; per-area modules like `usageReportsAdminApi.js` |
| Server admin routes | `server/routes/admin/*.js`, `export default function registerAdmin...Routes(app)`; registered in `server/routes/adminRoutes.js` (imports :62-63, calls :124-125). Closest analogues: `system.js` (read-only GET, `Cache-Control: no-store`), `overview.js` (stats from `configCache`), `models.js:1052` (`POST .../_test` with `llmClient.complete`, `ServiceError` mapping) |
| Auth | `server/middleware/adminAuth.js` (`adminAuth` throws `ServiceError('FORBIDDEN')`) |
| Outbound HTTP | `server/utils/httpConfig.js:796` `httpFetch(url, options, forceIgnoreSSL)` applies SSL whitelist + proxy; `getTlsBypassOptions` :235; private-IP test `server/utils/ssrfGuard.js:157 isPrivateIP` |
| Config | `configCache.getPlatform()` `server/configCache.js:953`, `getModels(true)` :793 (enabled + disabled), `get('config/users.json')` |
| Audit | `logAudit({req, action, resource, resourceId, summary, details})` `server/services/AuditLogService.js:178` (action enum: create/update/delete/toggle/import/export/login/logout) |
| LLM call | `server/services/loop/LLMClient.js:1184 complete(params)` (`telemetry:{kind:'diagnostic', purpose}` pattern) |
| Persisted small state | `server/utils/sharedJsonFile.js` (cluster-safe) / `atomicWrite.js:56 atomicWriteJSON` |
| i18n | **single files** `shared/i18n/en.json`, `shared/i18n/de.json`; admin keys under `admin.*` (`admin.nav` :2375, `admin.systemResources` :2520, `admin.auditLog` :4409). Call style `t('key', 'English default', {vars})`. Tests: `translation-keys-exist.test.jsx`, `admin-sidebar-i18n.test.jsx` |
| Tests | Jest unit: `tests/unit/server/*.test.js` (supertest + `jest.mock('adminAuth')`, e.g. `adminDocsRoutes.test.js`), `tests/unit/client/*.test.jsx` (e.g. `admin-system-resources-page.test.jsx` stubs `makeAdminApiCall` + `react-i18next`). Playwright: `tests/e2e/*.spec.js` (`admin-usage-reports.spec.js` pattern: sign in via `request.post('/api/auth/local/login', admin/password123)`), `accessibility.spec.js` (admin page list + `KNOWN` baseline), `route-crawl.spec.js` (crawls `/admin` links, also subpath config) |
| Guard scripts | `scripts/check-api-guidelines.js`, `check-client-api-contract.js` (every client call must match a server route), `audit-admin-endpoints.js` (adminAuth on all `/admin`), `check-a11y-diff.js` |

## 2.2 Requirements on sibling APIs (to reconcile later)
Names below are proposals that follow `docs/api-guidelines.md`; whatever was really built wins, 3329 adapts. "Server" = imported by the status service, "HTTP" = called by the browser.

| # | From | Needed (kind) | Contract 3329 depends on |
|---|---|---|---|
| R1 | 3325 | Server | `isGuardrailActive()` (or exported constant text) from `server/services/provenance/guardrail.js`; platform keys + reader for the notice: `{ enabled, text: {en,de} }` per language, plus the admin route/anchor where it is edited |
| R2 | 3326 | Server | platform `aiAcknowledgement: { enabled, enforce, requiredVersion, text, policyUrl }` (names TBC) and `getAcknowledgementStats()` -> `{ acknowledged, pending, total }` using valid = `version >= requiredVersion`, registered users only |
| R3 | 3326 | HTTP | Request again: `POST /api/admin/ai-acknowledgements/_request-again` -> `200 { requiredVersion }`. Remove all: `DELETE /api/admin/ai-acknowledgements` -> `204`. Export: `GET /api/admin/ai-acknowledgements/_export?status=acknowledged\|pending` -> `text/csv` (+ `Content-Disposition`). Every action audit-logged server-side |
| R4 | 3326 | Client | the confirm + call logic of the users page extracted into a hook/component (`useAcknowledgementActions`, `AcknowledgementActions`) so the card imports it instead of re-implementing |
| R5 | 3327 | Config | model `contentMarking.text = { by: 'ihub'\|'provider'\|'none', scheme, keyId?, statementRef?, detectorUrl? }` (+ detector token field, redacted in admin GET as `hasDetectorToken`), `platform.provenance.retentionDays`; a helper `getTextMarking(model)` that returns the normalized object |
| R6 | 3327+3331 | HTTP | `POST /api/provenance/verify`: JSON `{ text }` or `{ hash }`, or multipart `file` (3328). Response must be **per technique**, never one boolean: `{ verdict, results: [ { technique: 'hash-record'\|'watermark'\|'c2pa'\|'provider-declared', status: 'match'\|'no-match'\|'too-short'\|'unavailable'\|'not-applicable', keyId?, pValue?, record?, detail? } ] }`. `unavailable` (detector down) must be distinguishable from `no-match` |
| R7 | 3327 | Optional | count of provenance records per `keyId` (`recordCount` in the key list or a counts action) for the delete warning |
| R8 | 3331 | HTTP | `GET /api/admin/watermark-keys` -> `{ items: [{ keyId, createdAt, status: 'active'\|'retired' }] }`; never contains key material |
| R9 | 3331 | HTTP | `POST /api/admin/watermark-keys` body `{ generate: true }` or `{ key: "<string>" }` -> `201` + `Location`; body `{ keyId, createdAt, status, key, watermarkConfigSnippet }`. Server generates `keyId`. Key is a **string** (R-Q7) |
| R10 | 3331 | HTTP | `POST /api/admin/watermark-keys/{keyId}/_reveal` -> `200 { keyId, key, watermarkConfigSnippet }`, `Cache-Control: no-store`, audit entry |
| R11 | 3331 | HTTP | `DELETE /api/admin/watermark-keys/{keyId}` -> `204`; `409 CONFLICT` for the active key; audit entry |
| R12 | 3331 | Server | `getActiveKeyId()`, `listKeys()` (no secrets), `pingDetector(model)` -> `{ reachable, httpStatus, latencyMs, errorCode? }` **sending no keys**, `detect({ model, text })` (keys + wire format owned by 3331), and the generation path used by chat must also be usable by `llmClient.complete` for the self-test so the marked request is the production one |
| R13 | 3331 | Config | per-model detector fields editable in the existing model editor/`PUT /api/admin/models/{id}`; detector URL rule (HTTPS or private net) exposed as a helper so the status can warn |
| R14 | 3328 | HTTP | verify accepts image/audio multipart; result carries `c2pa: { present, valid, issuer, digitalSourceType }` and `declared: 'synthid'\|null`; accepted MIME types and size limit exposed as constants or in the 413/415 problem body so the upload control can show them |
| R15 | all | Convention | each admin action writes `logAudit`; the 3329 UI adds nothing to audit except the self-test |

## 2.3 New endpoints (3329)

### `GET /api/admin/eu-ai-act/status` (`adminAuth`)
- New file `server/routes/admin/euAiAct.js`: `registerAdminEuAiActRoutes(app)`; register in `server/routes/adminRoutes.js` next to :63/:125.
- Path is fixed by the issue (`eu-ai-act` is a namespace, not a plural noun; note it in the PR and check `scripts/check-api-guidelines.js` passes).
- Pure read, `Cache-Control: no-store`. No secrets ever (no key, no token; only `hasDetectorToken`).
- Query: `refresh=true` bypasses the detector ping cache (rate-limited to 1 per detector per 5 s).
- Response (200):
```json
{
  "generatedAt": "2026-11-11T09:00:00Z",
  "summary": { "level": "warn", "counts": { "ok": 7, "warn": 2, "error": 1 } },
  "checks": [
    { "id": "guardrail.active", "scope": "platform", "level": "ok",
      "messageKey": "admin.euAiAct.checks.guardrail.ok", "message": "The AI disclosure rule is part of every system prompt.",
      "params": {}, "fix": null },
    { "id": "ack.enforcement", "scope": "platform", "level": "warn",
      "messageKey": "admin.euAiAct.checks.ack.enforcementOff", "message": "Enforcement is off; users are asked but not blocked.",
      "params": {}, "fix": { "href": "/admin/auth", "labelKey": "admin.euAiAct.fix.openSettings" } },
    { "id": "model.watermark.detector", "scope": "model", "modelId": "vllm-llama", "level": "error",
      "messageKey": "admin.euAiAct.checks.model.detectorUnreachable", "message": "The detector did not answer.",
      "params": { "model": "vllm-llama", "reason": "ECONNREFUSED", "latencyMs": null, "checkedAt": "2026-11-11T09:00:00Z" },
      "fix": { "href": "/admin/models/vllm-llama", "labelKey": "admin.euAiAct.fix.openModel" } }
  ],
  "models": [
    { "modelId": "vllm-llama", "name": { "en": "Llama" }, "marking": "ihub", "scheme": "vllm-gumbel",
      "statementRef": null, "activeKeyId": "wm-2026-2", "detector": { "configured": true, "hasToken": true },
      "selfTest": { "state": "never|passed|failed|inconclusive|stale", "at": null, "keyId": null } }
  ],
  "acknowledgements": { "enabled": true, "enforced": true, "requiredVersion": 3,
                        "counts": { "acknowledged": 41, "pending": 9, "total": 50 } },
  "provenance": { "retentionDays": 365 }
}
```
- **Traffic-light contract:** `level` in `ok|warn|error` (ordered ok<warn<error), `id` stable dotted string (the client may key a11y/test ids on it, never on the message), `messageKey` + `params` + English `message` fallback, `fix` = `{ href, labelKey }` with an **app-relative** href (React Router adds the base path; same rule as `Link to`), or `null`. The server decides level and label; the client only renders (mirrors the "Run Activity" rule in CLAUDE.md).
- `models[]` is for the table (data only); the same facts reappear as checks, so the client never re-derives levels.

**Check catalogue (server decides; `checks/*.js` pure functions `(ctx) => Check[]`)**
| id | error | warn | ok | fix |
|---|---|---|---|---|
| `guardrail.active` | rule missing from assembly (R1) | - | present | none |
| `notice.text` | - | notice on but text empty for a language in `ui.languages`, or notice disabled | on + text set | notice settings (R1) |
| `ack.enabled` | - | feature off | on | `/admin/auth` or where 3326 puts it |
| `ack.enforcement` | - | off | on | same |
| `ack.version` | - | - | always ok, `params.requiredVersion` | none |
| `model.marking` (per enabled model) | - | `none`, or `provider` without `statementRef` | `ihub`, or `provider` with statement | `/admin/models/{id}` |
| `model.watermark.key` (`by:'ihub'`) | no active key | - | active key | keys card anchor `#watermark-keys` |
| `model.watermark.detector` | no URL/token, unreachable, 401/403, 5xx | http:// to non-private host (keys sent in body) | answered | `/admin/models/{id}` |
| `model.watermark.selftest` | last run failed for the active key | never run, stale after key change, inconclusive | passed for the active key | self-test button anchor |
| `provenance.retention` | - | `retentionDays` missing/0/invalid | >= 1 | platform settings |
Disabled models are skipped (count in `params`). Summary level = worst. Only models with `contentMarking.text.by === 'ihub'` get the three watermark checks (never infer "vLLM" from `provider`).

**Detector probe** (`server/services/euAiAct/detectorProbe.js`)
- Calls R12 `pingDetector`; implemented with `httpFetch()` so `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist` and proxy apply (CLAUDE.md rule); no bare fetch. Timeout 3 s via `AbortSignal`, all models in parallel (`Promise.allSettled`), at most 8 at once.
- **Never sends key material** in a probe; a 4xx on an empty/invalid body counts as "reachable", 401/403 as "token rejected", network error/5xx/timeout as unreachable. (Agree with 3331 whether a `GET /health` exists.)
- In-process `Map<detectorUrl, {result, at}>` TTL 30 s; cluster workers each have their own cache, which is fine for a read-only probe.

### `POST /api/admin/eu-ai-act/models/{modelId}/_self-test` (`adminAuth`) (Q2)
- Action on a model; per api-guidelines "a test answers 200 with its report when it ran". Not runnable (model not `ihub`-marked, no active key, no detector) -> `400 BAD_REQUEST`/`409 CONFLICT` problem+json.
- Flow (`server/services/euAiAct/selfTest.js`): fixed neutral prompt asking for ~400 words -> `llmClient.complete({ model, temperature: 1, maxTokens: 450, telemetry: { kind: 'diagnostic', purpose: 'watermark-self-test', user } })` through the **production marking path** (R12) -> `detect()` with active + retired keys -> verdict.
- Response: `{ state: 'passed'|'failed'|'inconclusive', keyId, matchedKeyId, numScoredTokens, pValue, tokensGenerated, durationMs, steps: [{ id: 'generate'|'detect', ok, detail }] }`. `inconclusive` = fewer than ~200 scored tokens or greedy; one automatic retry. `failed` includes the case "matched a retired key" (message: vLLM still runs the old key).
- Guards: per-model mutex + 30 s cooldown (`429 RATE_LIMITED` with `Retry-After`), timeout 60 s.
- Persists last result per model `{ at, state, keyId }` in a cluster-safe file (`sharedJsonFile.js`, e.g. `contents/data/eu-ai-act/self-tests.json`); the status check marks it `stale` when `keyId !== activeKeyId`.
- `logAudit({ action:'create', resource:'eu-ai-act-self-test', resourceId: modelId, summary, details:{state} })`.
- Add the route to `swagger` JSDoc like siblings; add the new error codes only if no generic one fits (use `CONFLICT`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `TIMEOUT` from `shared/apiErrors.js`).

## 2.4 Client implementation
Files (all new unless noted; each with the two-line SPDX header):
- `client/src/features/admin/pages/AdminEuAiActPage.jsx`: page shell, title/description, honesty note, "Re-check" button, `aria-live="polite"` region for the summary, renders the cards in order.
- `.../components/eu-ai-act/`:
  - `TrafficLight.jsx` + `euAiActLevels.js` (level -> icon/text/colours; always icon + visible text, never colour alone; dark-mode tokens next to `STORAGE_STATUS_STYLES`).
  - `ConfigCheckCard.jsx` (groups checks by `scope`: platform, then one block per model; row = level, message, fix `<Link>`), `CheckRow.jsx`.
  - `AcknowledgementsCard.jsx` (counts + R4 actions + CSV export via blob download).
  - `WatermarkKeysCard.jsx` (keys table, per-model rows with detector state + SelfTest button), `KeyCreateDialog.jsx` (add/generate, one-time reveal + snippet + "update vLLM" reminder), `KeyRevealDialog.jsx` (confirm, auto-hide 30 s, copy), `KeyDeleteDialog.jsx` (reuse `ConfirmDialog`, `danger`, text from 1.6 #3), `SelfTestButton.jsx` (cost hint, busy state, result in `role="status"`).
  - `VerificationCard.jsx` (tabs-free: textarea + file input, submit, per-technique result list; empty/too-short/unavailable states).
- `client/src/api/euAiActAdminApi.js`: `fetchEuAiActStatus({refresh})`, `runSelfTest(modelId)`, `fetchWatermarkKeys`, `createWatermarkKey`, `revealWatermarkKey`, `deleteWatermarkKey`, `requestAcknowledgementsAgain`, `removeAllAcknowledgements`, `exportAcknowledgements`, `verifyProvenance` (thin wrappers over `makeAdminApiCall`; `check-client-api-contract.js` will verify paths against the routes).
- `client/src/features/admin/hooks/useEuAiActStatus.js`: load on mount, `refresh()`, visibility-aware (no polling; the page is a snapshot plus manual re-check; after any key/ack/self-test action, reload status).
- Edits to existing files:
  - `AdminSidebarNavData.js`: new item in `platform` section (after `security` :347), `key: 'eu-ai-act'`, `href: '/admin/eu-ai-act'`, `label: t('admin.nav.euAiAct','EU AI Act')`, icon `ScaleIcon`/`ShieldCheckIcon` (already imported :17), `visible: showAdminPage('system')`.
  - `AdminCommandPalette.jsx:~38`: add `{ label: 'EU AI Act', href: '/admin/eu-ai-act' }`.
  - `App.jsx`: `lazyWithRetry` import near :44; `<Route path="eu-ai-act" ...>` inside `showAdminPage('system')` next to `security` :862.
  - `shared/i18n/en.json` + `de.json`: `admin.nav.euAiAct`, `admin.euAiAct.*` (page, cards, every check `messageKey`, fix labels, dialogs, errors). Check-message keys are used server-side only as ids, so `translation-keys-exist.test.jsx` must see them: add them to both files and to the test's key scan if it only scans `t(` calls.
- A11y (follow `a11y-audit` skill, no visual design here): headings per card (`h2`), tables with `<caption>`/`scope`, every control labelled, dialogs via `ConfirmDialog`/`Modal` (focus trap, return focus), results announced through `role="status"`, destructive and reveal buttons keyboard reachable, 320 px width reflow, new row in `tests/e2e/accessibility.spec.js` admin page list (no baseline entry allowed without a reason).
- Subpath: only relative `<Link>`/`apiClient` use; test `/ihub/admin/eu-ai-act` cold load (route-crawl subpath config picks it up through the sidebar link).

## 2.5 Caching and performance
- Config-derived checks: computed per request from `configCache` (in-memory, sub-millisecond). No caching needed; configCache already reloads platform/models.
- Detector pings: 30 s TTL cache, 3 s timeout, parallel. Status p95 target: < 300 ms cached, < 3.5 s with a dead detector.
- Self-test: never cached, never part of status; only the stored last result is read.
- Acknowledgement counts: R2 helper reads `users.json` through `configCache`; O(users). If large, ask 3326 to maintain a counter.

## 2.6 Security
- All new routes `adminAuth` (checked by `scripts/audit-admin-endpoints.js`); anonymous never passes (default local admin `admin`/`password123` for tests).
- Secrets: status and key list carry none. Reveal/create return key once, `no-store`. No key/token in logs, errors or `details` (add a test that greps the status JSON for the seeded key and token).
- SSL whitelist rule: probe + self-test detection go through `httpFetch`; add unit tests with a whitelisted and a non-whitelisted host (CLAUDE.md requirement).
- Upload in verification: use the 3328 limits; client also caps size before upload.

## 2.7 Docs and release notes
- `docs/` : new topic file `docs/eu-ai-act.md` only if no sibling created one (else extend it) and add to `docs/SUMMARY.md`; mention in `docs/admin-ui.md`.
- `docs/releases/next/features.md`: entry via `/document-feature` (admin-visible).
- No config migration needed in 3329 (no new config fields; siblings own theirs).

## 2.8 Component/size breakdown and ordered checklist
| Step | Task | Size |
|---|---|---|
| 1 | Reconcile R1-R15 against what the sibling branches really expose; write the mapping at the top of `euAiActStatusService.js` | S (0.5 d) |
| 2 | `server/services/euAiAct/checks/*.js` pure check functions + `statusService.buildStatus()` + `detectorProbe.js` | M (1.5 d) |
| 3 | `server/routes/admin/euAiAct.js` GET status, register in `adminRoutes.js`, swagger JSDoc | S |
| 4 | `selfTest.js` + `selfTestStore.js` + POST `_self-test` + audit | M (1 d) |
| 5 | Server unit tests (2.9) | M (1 d) |
| 6 | `euAiActAdminApi.js`, `useEuAiActStatus`, nav item, palette entry, route, i18n skeleton (EN/DE) | S |
| 7 | `AdminEuAiActPage`, `TrafficLight`, `ConfigCheckCard` | M (1 d) |
| 8 | `AcknowledgementsCard` (reuses R4) | S |
| 9 | `WatermarkKeysCard` + create/reveal/delete dialogs + `SelfTestButton` | L (2 d) |
| 10 | `VerificationCard` (text + file, per-technique results) | M (1 d) |
| 11 | Client unit tests, Playwright e2e, axe row, subpath crawl | M (1.5 d) |
| 12 | Docs, release note, `npm run lint:fix && npm run format:fix`, `node scripts/check-client-api-contract.js`, `check-api-guidelines.js`, `reuse lint` | S |
Total about 10-11 engineer-days; the Must set (steps 1-3, 5-7, 9 without self-test, 10) is about 6-7 days.

## 2.9 Test plan
Server (Jest, supertest, mock `adminAuth` like `adminDocsRoutes.test.js`; plus one unmocked test that a non-admin gets 403):
- each check function: table-driven cases for ok/warn/error (no key; no URL; unreachable; 401; self-test failed/stale; `provider` without statementRef; retention 0; disabled model skipped).
- status shape: every check has `id`, `level`, `messageKey`; summary = worst; no secret fields (seed a key + token, assert absent from JSON).
- detector probe: mock `httpFetch`; whitelisted host vs non-whitelisted host (TLS options), timeout, cache hit within TTL, `refresh=true` bypass.
- self-test: passed, failed (wrong key / old key matched), inconclusive (<200 tokens), not runnable (409), cooldown (429), audit entry written, stores key id.
Client (Jest + RTL; stub `makeAdminApiCall` and `react-i18next` as in `admin-system-resources-page.test.jsx`):
- renders each level with text (not colour only), fix link targets, empty states, error state with retry.
- keys card: list without secrets, generate shows key + snippet once and not after close, reveal hides after 30 s (fake timers), delete shows consequence text and calls DELETE only after confirm, active key has no delete.
- verification: text and file flows, `too-short` and `unavailable` are not rendered as "not watermarked".
- nav: item present with `showAdminPage('system')`, hidden when false; `admin-sidebar-i18n.test.jsx` still passes.
Playwright (`tests/e2e/admin-eu-ai-act.spec.js`, login `admin`/`password123` once per file; detector = tiny local mock server started in the spec, no live vLLM):
- `/api/admin/eu-ai-act/status` 200 for admin, 401/403 anonymous (acceptance: adminAuth).
- page loads, checks visible, fix link navigates.
- model with `by:'ihub'`, no key -> red; add key via UI; detector mock down -> red; mock up -> green; self-test against mock green; wrong-key mock -> red.
- rotate key: old key listed as retired; verify text marked with old key (mock) still reports old `key_id`.
- ack: Request again changes `requiredVersion`, export downloads CSV, Remove all after confirm.
- verify: paste text -> result; upload small PNG -> result.
- `accessibility.spec.js`: add `/admin/eu-ai-act`; `route-crawl.spec.js` picks the page up through the sidebar; run once under `/ihub` subpath config.

## 2.10 Technical risks
- **Key precision**: JSON numbers above 2^53 corrupt in JS; use strings in all admin payloads and make 3331 confirm the detector wire format (R9, Q7).
- **Self-test fidelity**: it only proves the loop if it uses the production request builder (server-owned `watermarking:true`, same adapter). Calling the provider directly would give a false green.
- **Cluster mode**: self-test store and ping cache; use `sharedJsonFile.js` for the former, per-worker cache for the latter. Two admins running self-tests at once on different workers: the cooldown is per worker unless stored; acceptable, note it.
- **Status drift**: if siblings rename config fields, the check functions break silently; the table-driven tests read the real defaults from `server/defaults/config/*.json` to catch it.
- **Bundle size**: lazy route keeps the page out of the main chunk; verification file upload must not read the whole file into state beyond the cap.
