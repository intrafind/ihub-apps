# EU AI Act master switch and acknowledgement API move - PM + engineering analysis

Epic #3324. Written 2026-11-11 against `origin/claude/ai-act-integrations-acknowledgement` (tip `573915e`, stack steps 1-8). Line numbers are from that tip and drift; re-grep before editing. Intended home: `concepts/2026-11-11 EU AI Act Art 50 focused scope/2026-11-11 conformity-switch.md` (copy it there when the stack is next touched; this file was written outside the checkout on request).

Requirement (verbatim, product owner): "we should move all apis around acknowledgement behind eu-ai-act endpoint. we should be able to disable the eu-ai-act conformity. someone who does not want it, can disable it. it must be recorded who it was and when including a description why. this is stored in the server. it turns off all the features and requirements."

Facts that shape the design:
- Latest migration on the branch is **V244**; V245 is free. This design needs **no migration** (see 2.1).
- `eu-ai-act` is already the admin namespace: `GET /api/admin/eu-ai-act/status` (`server/routes/admin/euAiAct.js:35`, comment at :7 "a namespace, not a collection").
- The guardrail's "no switch" is stated in about a dozen places (list in 2.8). The test `server/tests/guardrail.test.js:92-98` fails if `guardrail.js` mentions `configCache|platform|process.env`.
- The generic admin platform save (`server/routes/admin/configs.js:318-350`) emits only named keys on top of `...existingConfig`, written whole from a client copy.

---

## Part 1 - Product

### 1.1 Why
Some deployments do not want or need Art. 50 measures: internal-only tools, non-EU operations, research sandboxes, test systems. Today the stack forces them on: a dialog before the first chat, a rule in every system prompt, provenance records, headers and, with vLLM, watermarking. The legal duty stays with the deployer, so iHub must not decide for them in either direction. The switch therefore has to be (a) available, (b) a **deliberate** act (written reason, explicit acceptance, admin human only), (c) **attributable** (who, when, why, stored on the server) and (d) **visible** (a permanent notice for admins, history for auditors). It must not be possible to flip it by accident, by a stale form, by an API key or by an environment variable.

**Supersedes an earlier decision, explicitly.** The briefs and docs say the guardrail "cannot be switched off" (`3325-ai-disclosure.md:28`, `docs/ai-act.md:25`). That decision is superseded **only** through this audited master switch. There is still no app setting, platform.json key, request field, environment variable or per-feature switch for the guardrail; the only way off is `POST /api/admin/eu-ai-act/conformity/_disable` with a recorded reason.

### 1.2 User stories
1. As an **admin of an internal-only deployment**, I want to turn all EU AI Act measures off after stating why, so that my users are not shown dialogs and notices that do not apply to us and nothing is marked or recorded.
2. As an **admin**, I want turning it off to demand a written reason and an explicit acceptance of responsibility, so that nobody does it casually.
3. As an **admin who changes their mind or whose situation changed**, I want to turn it back on in one step and have the measures resume without losing earlier data, so that re-enabling is safe.
4. As an **auditor / compliance officer**, I want to read who disabled or enabled the measures, when, why, and the full history of switches, so that I can reconstruct which period had no measures. Outputs generated in an off period carry no provenance, and the history says which period that was.
5. As an **end user**, I want to be left alone by dialogs and notices when my operator switched the measures off, and to see them when on.
6. As an **API integrator / MCP / A2A client**, I want the `provenance` member, `X-AI-*` headers and `_verify` to be present exactly when the measures are on, and to be able to see which state the server is in (`GET /api/configs/platform` -> `euAiAct.enabled`), so that I do not treat missing metadata as an error.
7. As an **admin of an EU-facing deployment**, I want a persistent notice on every EU AI Act admin page while it is off, so that nobody forgets.

### 1.3 Success criteria (measurable)
- Fresh install and upgrade: conformity is **on**, behaviour is unchanged from step 8 (test).
- `_disable` without a reason of at least 20 characters, without `acceptResponsibility: true`, or by a non-interactive principal (API key, OAuth token, agent): `400` / `403`, no state change (test).
- After `_disable`: chat POST without acknowledgement is not `428`; no guardrail text in the request that reaches the model; no `X-AI-Generated` header and no `provenance` member on OpenAI-proxy, Responses, MCP, A2A answers; no `watermarking` flag on a vLLM request; `_verify` answers `403 FEATURE_DISABLED`; status page runs no detector probe (e2e, same test).
- After `_enable`: every one of the above is back; existing acknowledgements, records and keys are intact (e2e).
- Every switch has exactly one `toggle` audit entry and one history entry with user id, name, UTC time, reason (test counts both).
- The record cannot be changed through `POST /api/admin/configs/platform` or any other generic config save (test).
- All 6 acknowledgement routes of the old layout are gone; no caller of the old paths remains (grep gate in the invariant test).

### 1.4 Non-goals
- Legal advice, a compliance certificate, or deciding whether Art. 50 applies to a deployment.
- Per-feature or per-app switches (the existing `aiDisclosure`, `aiAcknowledgement`, `provenance` settings stay as they are and apply only while conformity is on).
- Deleting data when disabled (records, acknowledgements, keys stay).
- Env var / infrastructure-as-code override (`IHUB_*`): it would bypass the record. Rejected on purpose.
- Re-authentication (password / SSO step-up): v1 relies on the admin session plus acceptance plus reason; multi-mode auth (OIDC, proxy, LDAP, NTLM) makes a uniform step-up a separate project.
- Notifying end users that measures are off.
- Backward-compat shims for the moved paths: nothing outside the stack calls them (`CLAUDE.md` asks before shims; this one is a clean break, PO already said "move").

### 1.5 Decisions, risks and ambiguities (proposed resolutions)

| # | Question | Resolution |
|---|---|---|
| D1 | Default for new installs and upgrades | **On.** An absent record means on. Upgrade changes nothing. |
| D2 | What does "all features and requirements" cover | Everything in the matrix 1.6; rule of thumb: **behaviour off, data kept, data management available**. |
| D3 | Reason on disable | Mandatory, trimmed, 20-1000 characters, plain text. |
| D4 | Reason on enable | Optional (max 1000), recorded when given. Re-enabling is the safe direction; no friction. |
| D5 | History | The record holds the last 100 switches (newest first) and the audit log holds all of them (audit retention applies, default 365 days; the record does not expire, so it is the durable evidence). |
| D6 | Who may toggle | Admin group (`adminAuth`) **and** an interactive session. Personal API keys, OAuth client tokens, delegated tokens and agents get `403 INTERACTIVE_SESSION_REQUIRED` (existing code, same pattern as `integrationRequests.js:205-210`). Who is taken from `req.user`, never the body. |
| D7 | Confirmation | Server: `acceptResponsibility: true` is required in the body (the statement version is stored). UI (designers): checkbox plus typing a phrase; this is client-side friction only and not checked by the server. |
| D8 | Re-authentication | Not in v1 (non-goal). Revisit if a customer's auditor demands it. |
| D9 | Already in the target state | `409 CONFLICT` with `details.enabled`. It makes two admins clicking at once safe: the second sees the first one's record. |
| D10 | Acknowledgements on re-enable | Existing acknowledgements stay valid per `requiredVersion`. No automatic "ask everyone again". The UI offers "Request again" after enabling (existing action). |
| D11 | Outputs from the off period | Stay without provenance. The history is the statement of the gap. Documented in the auditor section. |
| D12 | `_verify` while off | **Off** (`403 FEATURE_DISABLED`). The PO said "all features"; records remain and answer again after enabling. Alternative the PO may prefer: keep `_verify` as a read-only lookup. Flagged as OQ1. |
| D13 | Anonymous / public visibility | `GET /api/configs/platform` gets `euAiAct: { enabled }` only; never who or why. Admins read the record from the admin endpoint. |
| D14 | Hand-edited file | The helper honours "off" only when the record is complete (`enabled:false`, `changedAt`, `changedBy.id`, `reason`). A file that says off without a complete record is treated as **on**, logged at `warn`, and shown in the status as "invalid record". Not tamper-proof (a sysadmin owns the file system) but it blocks the silent edit and a broken file fails towards compliance. |
| D15 | Persistent admin notice | Banner on `/admin/eu-ai-act`, and on the three Advanced cards (2.6) while off. The notice shows who, when, why. |

Risks:
- **R1 vLLM keeps watermarking.** vLLM is started with `--watermark-config '{...,"enforce":true}'` (`WatermarkKeyStore.js:136-139`); `enforce` ignores the request flag. Off in iHub removes the flag, the claim and the records, not the operator's vLLM start-up flag. Docs and the disable dialog must say: restart vLLM without the flag to stop marking at the source.
- **R2 Legal responsibility wording** is a draft (1.7); needs legal review and DE translation by a lawyer, not by us.
- **R3 Stale clients.** A tab that cached `enabled:true` after disable sends a message: no 428, fine. A tab with `enabled:false` after re-enable: gets 428 and the existing reactive path (`AiAcknowledgementContext.jsx:279`) re-opens the dialog. Both safe.
- **R4 Multi-worker lag.** Writes await the cluster announcement (`refreshCacheEntry` -> `announceConfigChangeAndWait`, `configCache.js:498-501`); a worker that missed it self-heals at the 5 min TTL. For a switch that is acceptable, the write path returns after peers acknowledged.
- **R5 Bulk config import/restore** could overwrite the file. Check every writer of `contents/config` (grep `config/platform.json` writers, any import/restore endpoint) and make sure the new file is outside them, or goes through the same checks.
- **R6 Audit write is buffered** (`AuditLogService.js:215` `appender.append`), so the record, not the audit entry, is the source of truth; write the record first.
- **R7 Disabled bypass by mis-gating.** Mitigated by gating in the lowest shared function plus an invariant test (2.5).

### 1.6 What "all features and requirements" covers (every feature of steps 1-8)

Rule: **behaviour off, data kept, data management available.** "Off" means a silent no-op on runtime paths (never an error for a user or machine caller); explicit admin actions that cannot do anything while off answer `403 FEATURE_DISABLED`.

| # | Feature (step) | When disabled | Why |
|---|---|---|---|
| 1 | Guardrail rule in the system prompt (1) | **Off** | It is an Art. 50(1) measure; the PO wants all off. |
| 2 | iAssistant conversation preamble rule (1) | **Off** | Second path of the same rule. |
| 3 | First-turn notice (1) | **Off** (server sends `enabled:false`) | Art. 50(1) measure. |
| 4 | Acknowledgement dialog, 428 guard, `/me` (2, 8) | **Off** (guard no-op, `/me` answers `enabled:false, acknowledged:true`, `POST /me` -> `403 FEATURE_DISABLED`) | Requirement of the measures. |
| 5 | Stored acknowledgements, guest cookie validity, `requiredVersion` | **Kept** untouched | Evidence; GDPR. |
| 6 | Admin ack actions: `_export`, remove one, remove all, `_request-again` | **Available** | Data management and GDPR erasure must work any time; `_request-again` may be prepared (existing A10). |
| 7 | Provenance record creation, text (3) | **Off** | Art. 50(2) measure. |
| 8 | `provenance` member on responses, SSE `done`, MCP `_meta`, A2A metadata (3) | **Off** | Follows from 7. |
| 9 | `X-AI-Generated`, `X-AI-Content-Id` headers (3, 5) | **Off** | Same. |
| 10 | `POST /api/provenance/_verify`, text and file (3, 5) | **Off** (`403 FEATURE_DISABLED`) | OQ1. |
| 11 | Provenance retention sweep (3) | **Keeps running** | Data minimisation: stored records still expire on schedule. |
| 12 | Text watermark flag to vLLM, marking plan, `applied` claim (4) | **Off** | R1 caveat. |
| 13 | Key store and its admin endpoints (4) | **Kept and manageable** (list, create, activate, reveal, delete) | Keys are data needed to detect old text and to re-enable; deleting them would be destructive and irreversible. They have no runtime effect while off. |
| 14 | Detector client, `_test`, `_self-test`, status probes (4) | **Off** (`403 FEATURE_DISABLED` on the two admin actions; probes not run) | They are outbound connections that serve only the measure. |
| 15 | Image stamping and records (5) | **Off** | Art. 50(2) measure. Image bytes stay untouched in both states (the no-re-encode guard stays). |
| 16 | TTS record and headers (5) | **Off** | Same. |
| 17 | C2PA read at record time and at verify (5) | **Off** | Same. |
| 18 | Admin status checks and detector probes (6) | **Off**: status returns the record and a `disabled` summary, no checks, no probes | Nothing to check. |
| 19 | Per-model `contentMarking` schema validation (3, 4, 5) | **Structural validation stays**; semantic checks (status warnings) off | A model saved while off must still load after re-enable; shape errors would otherwise surface later. |
| 20 | Admin settings forms `aiDisclosure`, `aiAcknowledgement`, `provenance` (1, 2, 3, 7) | **Editable and stored, no effect**, with a notice | Admins can prepare before enabling. |
| 21 | Admin page `/admin/eu-ai-act` (6) | **Reachable**: banner, record, history, Enable button | The way back in. |

### 1.7 Statement of legal responsibility (draft, NOT legal advice, flag for legal review)
EN: "Regulation (EU) 2024/1689 (the EU AI Act) places transparency duties on providers and deployers of AI systems according to their role and use. Turning these measures off does not remove those duties. By turning them off you confirm that you have assessed that they are not required for your use of this system, or that you meet them in another way, and that you accept responsibility for this decision. Your name, the time and your reason are stored on this server and in the audit log."
DE translation and final wording: legal department. The statement has a version number (`statementVersion: 1`) stored in the record so a later wording change is traceable.

### 1.8 Open questions for the PO
- OQ1 `_verify` while off: off (proposed) or read-only lookup of retained records?
- OQ2 Should end users get any visible hint that measures are off? Proposed no (it would itself be an uninvited notice).
- OQ3 Confirmation phrase text and whether an auditor needs a step-up login (D8).
- OQ4 Also move `/api/admin/watermark-keys`, `/api/admin/watermark-detectors` to `/api/admin/eu-ai-act/...` for consistency? Cheap now (unmerged), but beyond the stated requirement (2.3 keeps them).

---

## Part 2 - Engineering

### 2.1 Single source of truth

**Storage: a dedicated file `contents/config/eu-ai-act-conformity.json`, not `platform.json`.**
- `platform.json` is rewritten whole by the generic admin save from client copies (`configs.js:318-350`, `...existingConfig` plus named keys) and is where `IHUB_*` overrides apply (`configCache.getPlatform()`). A stale tab or an override must never flip the switch or erase the record. Same reason the key store lives apart (`WatermarkKeyStore.js:13-14`).
- Pattern to copy: `config/credentials.json` (`configCache.js:150-158`): own loader, missing file is valid, `criticalConfigs` preload (list at `configCache.js:235-255`), getter `configCache.getEuAiActConformity()`, write with `configStore.updateJson` then `await configCache.refreshCacheEntry(file)` (which also announces to the other workers).
- No platform.json key, no env override, no admin platform form field for it. The platform save needs no change: it drops unnamed keys, and a test asserts `POST /api/admin/configs/platform` with `euAiAct: {enabled:false}` leaves the file untouched.

**Record shape** (schema `server/validators/euAiActConformitySchema.js`, zod, strict; add to `default-config-schema-validation`):
```json
{
  "version": 1,
  "enabled": false,
  "changedAt": "2026-11-12T09:30:00Z",
  "changedBy": { "id": "admin", "name": "Anna Admin" },
  "reason": "Internal research sandbox, no EU users, no public output.",
  "statementVersion": 1,
  "history": [
    { "enabled": false, "changedAt": "2026-11-12T09:30:00Z", "changedBy": { "id": "admin", "name": "Anna Admin" },
      "reason": "Internal research sandbox, ...", "statementVersion": 1 }
  ]
}
```
`history` is newest first, includes the current state as `history[0]`, capped at 100 (oldest dropped; audit log keeps more). `reason` is `null`/absent for an enable without a note. Times are RFC 3339 UTC (`api-guidelines.md` section 5).

**Helper** `server/services/euAiAct/conformity.js` (new, the **only** reader of the file; SPDX header):
- `isEuAiActEnabled()`: synchronous, never throws. Reads `configCache.getEuAiActConformity()`; returns `false` only for a complete valid "off" record (D14); anything else (missing, cache not initialised, malformed, incomplete) returns `true` and logs once at `warn` for the invalid cases.
- `getConformity()`: `{ enabled, changedAt, changedBy, reason, statementVersion, history, valid }` for the admin API and status.
- `setConformity({ enabled, reason, actor, statementVersion })`: inside `configStore.updateJson(FILE, current => ...)` (CAS, 16 attempts, `ConfigStore.js:681`). The mutate function reads the current state, throws `ServiceError('CONFLICT', ..., { details: { enabled } })` if already in the target state, prepends the history entry, truncates to 100 and returns the new document. Then `await configCache.refreshCacheEntry(FILE)`.
- `requireEuAiActEnabled(feature)`: Express middleware throwing `ServiceError('FEATURE_DISABLED', 'EU AI Act conformity is turned off on this server', { details: { feature } })`; used by `_verify` and the two detector actions.

**Startup default / migration.** Absent file means on. `server/defaults/config/eu-ai-act-conformity.json` ships `{ "version": 1, "enabled": true, "history": [] }` for fresh installs (the initial setup copies defaults). **No migration:** `CLAUDE.md` reserves migrations for changes to existing files and default entries; an upgraded install without the file behaves identically and the first toggle creates it. V245 stays free for the next feature. Add the schema to the default-config validation test so the shipped default is checked.

**Propagation.** `configCache.js`: add the key to `criticalConfigs` (:235) and a `CONFIG_LOADERS` entry (:143) with `load: async () => (await loadJson(FILE)) || null`; add the getter next to `getCredentials` (:960). The write path awaits `announceConfigChangeAndWait`, so peers have the new value before the response; the TTL reload (5 min in production) is the safety net.

### 2.2 API (new, admin only)
All under `/api/admin/eu-ai-act/conformity`, registered in a new `server/routes/admin/euAiActConformity.js` and wired in `server/routes/adminRoutes.js` beside `registerAdminEuAiActRoutes` (:55). OpenAPI comment first (`api-guidelines.md` section 9), tag `Admin - EU AI Act`. Rate limit: the existing `/admin` limiter (`server/middleware/setup.js:518`) is the strictest one; no extra limiter.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/eu-ai-act/conformity` | - | `200` the record (above) | `401/403` |
| `POST .../conformity/_disable` | `{ reason: string (20-1000), acceptResponsibility: true }` | `200` the new record | `400 VALIDATION_FAILED` with `errors: [{pointer:"/reason"\|"/acceptResponsibility", code, message}]`; `403 INTERACTIVE_SESSION_REQUIRED`; `409 CONFLICT` (already off, `details.enabled:false`) |
| `POST .../conformity/_enable` | `{ reason?: string (max 1000) }` | `200` the new record | `400`, `403 INTERACTIVE_SESSION_REQUIRED`, `409 CONFLICT` (already on) |

- Why actions and not `PUT`: the guideline permits `_action` for state transitions, and a distinct path makes an accidental whole-resource write by a stale form impossible and gives the audit log a clear verb. `204` is not used because the action returns the changed resource (`api-guidelines.md` section 1).
- Principal rule (D6): `isPersonalApiKey || isOAuthClient || isAgent || clientId` on `req.user` -> `INTERACTIVE_SESSION_REQUIRED`. `changedBy = { id: req.user.id, name: req.user.name || req.user.username || req.user.id }`. Unknown body members are rejected (`.strict()`), so no client can send `changedBy`.
- Audit (`logAudit`, `AuditLogService.js:178`): `action: 'toggle'` (already in the enum, `auditEntrySchema.js:12`), `resource: 'euAiActConformity'`, `resourceId: 'conformity'`, `summary: 'EU AI Act conformity switched off|on'`, `details: { from, to, reason, statementVersion }`. Explicit call sets `req._auditLogged`, so the safety net in `auditLogger.js:114` does not duplicate it. Also `logger.warn` on disable. Write the record first, then audit (R6).
- Errors reuse registry codes (`FEATURE_DISABLED` 403, `CONFLICT` 409, `VALIDATION_FAILED` 400, `INTERACTIVE_SESSION_REQUIRED` 403); no new code unless review wants a specific `EU_AI_ACT_*` one (then add to `shared/apiErrors.js` and `apiErrors` in `shared/i18n/en.json` and `de.json`).
- **Public config.** `GET /api/configs/platform` (`server/routes/chat/dataRoutes.js:793`) gets a top-level `euAiAct: { enabled }` next to `aiDisclosure` (:908) and `aiAcknowledgement` (:910). `enabled` only, no who/why. The route sets no ETag (plain `res.json`, :944), so nothing caches it stale. **`client/src/shared/contexts/PlatformConfigContext.jsx:78-87` rebuilds the object by hand and drops unnamed keys: add `euAiAct` there** (its own comment at :89 records that this bit before).
- Response shapes: `tests/contract/response-shapes.json`: add `GET /api/admin/eu-ai-act/conformity`; regenerate `GET /api/configs/platform` (:4795), `GET /api/admin/eu-ai-act/status` (:1411); renamed keys below. Run `node scripts/check-response-shapes.js --update` and read the diff.

### 2.3 The acknowledgement APIs move under `eu-ai-act` (part A)

| Today (stack tip) | New |
|---|---|
| `GET /api/ai-acknowledgements/me` (`aiAcknowledgementRoutes.js:40,101`) | `GET /api/eu-ai-act/acknowledgements/me` |
| `POST /api/ai-acknowledgements/me` (:157) | `POST /api/eu-ai-act/acknowledgements/me` (201 + `Location` = same path) |
| `POST /api/admin/ai-acknowledgements/_request-again` (`admin/aiAcknowledgements.js:66`) | `POST /api/admin/eu-ai-act/acknowledgements/_request-again` |
| `DELETE /api/admin/auth/users/:userId/ai-acknowledgements` (:102) | `DELETE /api/admin/eu-ai-act/users/{userId}/acknowledgements` |
| `DELETE /api/admin/ai-acknowledgements` (:135) | `DELETE /api/admin/eu-ai-act/acknowledgements` |
| `GET /api/admin/ai-acknowledgements/_export?status=` (:175) | `GET /api/admin/eu-ai-act/acknowledgements/_export?status=` |

Naming follows `api-guidelines.md` section 1 (plural kebab-case nouns, `_action` for non-CRUD, depth at most two levels). Download file name `ai-acknowledgements.csv` (:192) stays. `eu-ai-act` stays a namespace. Problem+json, status codes and bodies do not change; only paths. Keep `assertValidId(userId)` (`auth.js:503` pattern).

Callers and places to update (grep `ai-acknowledgement` on the branch gives exactly this set):
- Server: `server/routes/aiAcknowledgementRoutes.js` (ME_PATH :40, header comment :7-9, swagger blocks :86,143, tag), `server/routes/admin/aiAcknowledgements.js` (header :7-10, swagger :56,91,124,154, routes :66,102,135,175), **rate limiter** `server/middleware/setup.js:500-501` (`buildApiPath('/ai-acknowledgements')` -> `'/eu-ai-act'`, the public limiter; admin paths are already under `/admin`), `server/startup/routes.js:20,103` (no change unless the file is renamed).
- CORS: no path-based CORS code exists (`setup.js:326-431` is origin based); only the sentence in `docs/browser-extension.md:393`.
- Middleware path matching: none found beyond the limiter. The audit safety net derives `resource` from the path (`auditLogger.js:58-70`): the old paths produced `ai-acknowledgements` (user) and `ai-acknowledgements` (admin); the new ones produce `eu-ai-act` for any request without an explicit `logAudit`. The explicit entries keep `resource: 'aiAcknowledgement'` (unchanged). Check that no audit-log UI filter or doc lists the old derived name (grep `ai-acknowledgements` in `client/src/features/admin`, found none today).
- Web client: `client/src/api/endpoints/aiAcknowledgement.js:16,28`; `client/src/features/admin/hooks/useAiAcknowledgementAdmin.js:110,138,162,176` (the per-user delete moves from the `auth/users` prefix); `client/src/shared/contexts/PlatformConfigContext.jsx:83` (comment).
- Office pane, extension, Nextcloud, Teams: no own path. Office mounts `AiAcknowledgementProvider` (`OfficeApp.jsx:539`), the extension, Nextcloud and Teams mount `<App />` (`App.jsx:905`); all go through `endpoints/aiAcknowledgement.js`. Verify by grep over `client/office`, `client/extension`, `client/nextcloud`, `client/src/features/teams`: no literal path today.
- Tests: `server/tests/aiAcknowledgement.test.js` (31 refs); `tests/e2e/ai-acknowledgement.spec.js:30,114,116,127,132,138,139`; `tests/e2e/ai-acknowledgement-embedded.spec.js:36,209,292,305,310,324`; `tests/e2e/admin-eu-ai-act.spec.js:213,232`; `tests/unit/client/eu-ai-act-page.test.jsx:420`; comment in `tests/unit/client/office-app-routing.test.jsx:120`; `tests/config/e2e-contents.mjs:51` (comment only).
- Contract: `tests/contract/response-shapes.json:170,4174` (renamed keys).
- Docs: `docs/ai-act.md:103-109`, `docs/browser-extension.md:393`, `docs/pii-data-handling.md:337`, `docs/releases/next/breaking-changes.md:877`; concept briefs `3326-ai-acknowledgement.md` and `integrations-acknowledgement.md` get a one-line "paths superseded, see conformity-switch.md" note (history stays).
- Route-change check: `scripts/check-route-changes.js --strict` and `scripts/check-client-api-contract.js` must pass; the old paths never shipped, so they should stay quiet, but confirm and mention the move in `docs/releases/next/features.md` (not a breaking change entry; nothing shipped).
- `shared/apiErrors.js`, `.gitleaksignore:6`: unaffected.
- Keep as is (decision OQ4): `/api/admin/watermark-keys`, `/api/admin/watermark-detectors` (`client/src/api/euAiActAdminApi.js:22-79`) and `/api/provenance/_verify` (public contract, `verifyUrl` is embedded in every response, `turnProvenance.js:25`).

### 2.4 `aiAcknowledgement` and the guard when disabled
Make `getSettings()` (`aiAcknowledgementService.js:49-60`) return `enabled: isEuAiActEnabled() && raw.enabled !== false` and add `configuredEnabled: raw.enabled !== false`. One edit then covers the guard (`aiAcknowledgementRequired.js:77`, pure no-op, no users.json read), `GET /me` (:106 -> `{enabled:false,enforce:false,acknowledged:true,requiredVersion}`), `POST /me` (:164 -> `403 FEATURE_DISABLED`), `summary()` (:205) and the public config (`dataRoutes.js:910-913`). The status page and admin forms read `configuredEnabled` so they show what the admin configured. `isMachinePrincipal` (`:183`) needs no gate: the guard returns before it (:77-78).

### 2.5 Every gate point (and the invariant)
Principle: **gate in the lowest shared function, so no caller can bypass it; pure helpers stay pure.** Runtime paths no-op silently; they never throw because of the switch.

| # | Feature | Gate (file:line on the tip) | When disabled |
|---|---|---|---|
| 1 | Guardrail | `server/services/provenance/guardrail.js:79-81` `guardMessagesForModel`: `isEuAiActEnabled() && isGuardedModel(model)`. `LLMClient.js:553` default stays; `:696-698` unchanged. Test seam `opts.guardrail` stays. `guardrail.js` may import `conformity.js` only (update test `guardrail.test.js:92-98`). | messages returned as is |
| 2 | iAssistant rule | `server/adapters/iassistant-conversation.js:199`: use new `guardrail.js` export `disclosureRuleFor(text)` = enabled ? `appendRuleToText(text)` : text | preamble unchanged |
| 3 | First-turn notice | `dataRoutes.js:53-60` `aiDisclosureClientConfig(aiDisclosure, enabled)` returns `enabled:false`; `:908` passes the helper. Client unchanged (server decides, `shared/aiDisclosure.js`). | no notice rendered |
| 4 | Ack dialog / 428 | 2.4. Client `AiAcknowledgementContext.jsx:54,258,376` already treats `enabled:false` as no gate; mounts stay. | none |
| 5 | Provenance record | `turnProvenance.js:63-75` `recordTextOutput`: first line `if (!isEuAiActEnabled()) return null;`. Callers already null-safe: `ChatService.js:1247,1780`, `McpServerService.js:506`, `a2aHandler.js:720`, `openaiProxy.js:599,668`, `responses.js:869` (`if (provenance)`, `withProvenance(body, null)`). | returns null |
| 6 | Wire members | `httpProvenance.js:20-39`: gate inside `applyProvenanceHeaders` (also covers `openaiProxy.js:634,867`, `responsesWire.js:174`, `voiceRoutes.js:240`, which call it unconditionally with an early `newOutputId()`), `withProvenance`, `mcpMeta`, `a2aMetadata` (the MCP image `_meta` at `McpServerService.js:641` goes through `mcpMeta`) | no header, no member |
| 7 | `_verify` | `provenanceRoutes.js:148` add `requireEuAiActEnabled('provenance')` as the last middleware, after `limiter, maybeAuth` (so a caller who may not use `_verify` still gets `401`, not a hint about the switch); covers text (:184 `detectWatermark`) and file (:161 `verifyMediaFile`) | `403 FEATURE_DISABLED` |
| 8 | Watermark request flag | `BaseAdapter.js:93-98` `applyTextWatermark`: `if (!isEuAiActEnabled()) return undefined;` first. `planTextWatermark` (`watermarkPlan.js:47`) stays pure. `AgentLoop.js:349` combines null plans fine. | no `watermarking:true`, no plan, no `applied` claim |
| 9 | Keys | `WatermarkKeyStore` and `watermarkKeys.js:70-186`: **no gate** (data). `activeKeySnapshot` unchanged. | manageable |
| 10 | Detector actions | `watermarkDetectors.js:87,107` `requireEuAiActEnabled('watermark')`; list at :44 stays readable; `detect.js:145` `detectWatermark` also returns early (defence for MCP/other callers) | `403 FEATURE_DISABLED` |
| 11 | Image stamp/record | `mediaMarking.js:102` `stampGeneratedImage` returns `null`; `:179` `recordGeneratedImage` returns null (`LLMClient.js:274-281` already skips when `!stamp?.created`). Image `data` is never touched in either state. | no stamp, no record |
| 12 | TTS | `mediaMarking.js:236-248` `recordTtsOutput` returns null; header gate via 6 | none |
| 13 | C2PA | `mediaMarking.js:192` guard covers record time; `mediaVerify.js:167` unreachable (route gated in 7) | not read |
| 14 | Status | `statusService.js:44` `buildStatus`: when off return `{ generatedAt, conformity: <record>, summary:{level:'disabled'}, checks:[], models:[], acknowledgements:{configuredEnabled,...counts}, provenance }`, skip `probeDetectors` (:68), `readSelfTests`. When on, add `conformity` too. `checks.js:68-80` guardrail check text ("cannot be switched off", :75) reworded. | no checks, no outbound probes |
| 15 | Retention sweep | `provenanceRetention.js:47`: **no gate** | keeps running |
| 16 | Model config validation | `modelConfigSchema.js:112-161,450`, `modelRoutes.js:32`: **no gate** (structural) | validates as before |
| 17 | Admin forms | `configs.js:330-341,439-446` (`mergeSettingsForSave`, `mergeProvenanceForSave`): **no gate**; saves audited as today | stored, no effect |

**Invariant tests** (`server/tests/euAiActConformityGates.test.js`, style of `guardrail.test.js:100-118`, the createCompletionRequest walk):
1. Static: only `server/services/euAiAct/conformity.js` (and the cache loader) references `eu-ai-act-conformity.json` / `getEuAiActConformity`; the walk fails otherwise.
2. Static: callers of the *ungated* primitives `applyAiDisclosureGuardrail`, `appendRuleToText`, `planTextWatermark`, `buildProvenance`, `buildMediaRecord` are an allowlist (their gated wrappers and tests); a new file that imports one fails the test with "use the gated function".
3. Static: each file in the gate table (rows 1, 2, 5, 6, 8, 11, 12) imports `isEuAiActEnabled`; a dropped import fails.
4. Table-driven with the switch off: every row's entry point is called and asserted a no-op (`guardMessagesForModel`, `recordTextOutput` null, `applyProvenanceHeaders` sets nothing, `applyTextWatermark` undefined, `stampGeneratedImage` null, `recordTtsOutput` null, guard calls `next()` without a users read, `buildStatus` runs no probe). Then switch on and assert each is active again.
5. Grep gate: no source file under `server/`, `client/`, `tests/` contains the old paths `/ai-acknowledgements` or `auth/users/.*ai-acknowledgements`.

### 2.6 Admin UI effects (data and state only; visuals belong to UX/UI)
- `GET /api/admin/eu-ai-act/status` returns `conformity`; `useEuAiActStatus.js` passes it on; `AdminEuAiActPage.jsx` (53 lines) renders a banner with who/when/why while off, hides or greys the check, watermark, verification and acknowledgement cards, and shows the conformity card (history, Disable/Enable dialogs). New API wrapper in `client/src/api/euAiActAdminApi.js` (`fetchConformity`, `disableConformity`, `enableConformity`) over `makeAdminApiCall`.
- Advanced settings cards (`AdminAdvancedPage.jsx:9-10`: `AiNoticeSettingsCard`, `AiAcknowledgementSettingsCard`; plus `euAiAct/ProvenanceSettingsCard.jsx`): stay editable; a note "no effect while EU AI Act conformity is off" driven by `GET /api/configs/platform` -> `euAiAct.enabled`. Fix the card text `AiNoticeSettingsCard.jsx:13,79` ("always tell users they are AI").
- Users page `AdminUsersPage.jsx` ack column and actions: keep working (data management); the status column uses `configuredEnabled`.
- i18n EN+DE in one commit: `admin.euAiAct.conformity.*` (title, state on/off, statement text, reason label/help/min length, accept checkbox, confirm phrase, disable, enable, banner "off since {{date}} by {{name}}: {{reason}}", history columns, optional enable note), `admin.euAiAct.checks.*` rewording; `apiErrors` only if a new code is added. Key parity test (`en`/`de`) must pass. The DE legal statement is flagged "pending legal review" in a comment.
- No new top-level route, so the `KNOWN_ROUTES` / `client/index.html` sync rule does not apply.

### 2.7 Tests
Unit (`server/tests/`): `euAiActConformity.test.js` (default on, valid/invalid/incomplete record, CAS under 20 parallel toggles: exactly one wins, others `409`, history cap 100, name taken from `req.user`, body `changedBy` rejected, API key/OAuth/agent `403`, reason 19 vs 20 chars, missing `acceptResponsibility`); `euAiActConformityRoutes.test.js` (status codes, `application/problem+json` with `code`, audit entry count, platform save cannot change it, non-admin `403`; add the three routes to `admin-endpoints-security.test.js`); the gate invariant (2.5); per-gate tests extend `guardrail.test.js`, `llmClientGuardrail.test.js`, `provenance-records.test.js`, `provenance-channels.test.js`, `provenance-verify-route.test.js`, `watermark-model-config.test.js`, `watermark-adapters.test.js`, `tts-provenance.test.js`, `euAiActStatus.test.js`, `aiAcknowledgement.test.js` (off = no 428, `/me` shape, `POST` 403, admin actions still work). Moved-path tests: rename in place.
Client (`tests/unit/client/`): `PlatformConfigContext` keeps `euAiAct`; notice and dialog not rendered when off; page banner; dialogs validate length; `eu-ai-act-page.test.jsx` path update.
**End-to-end** `tests/e2e/eu-ai-act-conformity.spec.js` (Playwright, `admin`/`password123`; restores state in `afterAll` like `ai-acknowledgement.spec.js:30`):
1. enable acknowledgements (admin platform API), confirm 428 on chat POST, guardrail text present at the LLM stub, `X-AI-Generated` present on a Responses/OpenAI-proxy call, `_verify` 200;
2. `POST .../conformity/_disable` with reason: assert `200`, record has name/time/reason; then chat POST succeeds (no 428), stub request has no guardrail text, no `X-AI-Generated`, no `provenance` member, a vLLM-style stub model gets no `watermarking` flag (extend `e2e-llm-stub.mjs` to expose the last request body if it does not already), `_verify` is `403 FEATURE_DISABLED`, status shows `disabled` and runs no probe, `/api/configs/platform` has `euAiAct.enabled:false` and no who/why;
3. `_enable`: everything of step 1 is back, earlier acknowledgements and records are still there (users.json entry, `_export` row, stored record found by `_verify`).
Seed: `tests/config/e2e-contents.mjs:52` keeps `aiAcknowledgement.enabled:false` for the other specs; do **not** switch conformity off there (the other specs rely on guardrail and headers); the default file from `server/defaults` provides "on".

### 2.8 Docs and release note
- `docs/ai-act.md`: replace "Guardrail prompt (always on)" (:15) and "Not overridable" (:25-27) with the master-switch statement; new section **Turning EU AI Act conformity off** (who, reason rule, what stops, what is kept, vLLM caveat R1, the legal note 1.7 with "not legal advice", history and where to read it, API); update :103-109 to the new paths.
- Reword the "cannot be switched off" statements (superseded): `docs/llm-client.md:268`, `docs/platform.md:436`, `docs/apps.md:1714`, `docs/releases/next/features.md:1648`, `server/services/provenance/guardrail.js:10`, `server/services/euAiAct/checks.js:75`, `statusService.js:11`, `server/validators/appConfigSchema.js:583`, `platformConfigSchema.js:516`, `AiNoticeSettingsCard.jsx:13`, `guardrail.test.js:92`, and a note in `3325-ai-disclosure.md:28`.
- Per-feature docs: `docs/provenance.md`, `docs/ai-act-text-watermarking.md`, `docs/text-to-speech.md:348`, `docs/openai-compatible-api.md:234`, `docs/embed-mode.md`, `docs/browser-extension.md:393`: one line each "off while conformity is off".
- Release note via `/document-feature`: one entry in `docs/releases/next/features.md` (master switch, paths). Not in `breaking-changes.md` (nothing shipped; the existing acknowledgement entry at :877 gets the new path). New docs sections need no `SUMMARY.md` change (existing file).
- SPDX header on every new file (`reuse annotate ...`, `CLAUDE.md`).

### 2.9 Ordered checklist, commit order and size
Place it as step 9 on a new branch from step 8 (README forbids rebasing the stack); fold into the earlier PRs only if the owner asks.

| # | Commit | Content | Size |
|---|---|---|---|
| 1 | `refactor: move acknowledgement APIs under eu-ai-act` | 2.3: routes, limiter, client endpoint wrappers, admin hook, tests, response shapes, docs paths. Gate: grep invariant 5. | 0.75 d |
| 2 | `feat: conformity store, helper, endpoints` | schema, defaults file, `configCache` entry and getter, `conformity.js`, routes, audit, `euAiAct` in public config and `PlatformConfigContext`, unit and route tests | 1.5 d |
| 3 | `feat: gate all EU AI Act features` | 2.4 + gate table rows 1-14, `guardrail.test.js` update, invariant tests, per-gate tests | 1.5 d |
| 4 | `test: e2e disable and enable` | `eu-ai-act-conformity.spec.js`, stub extension, response-shape update | 0.75 d |
| 5 | `feat: admin UI for the switch` | status `conformity`, banner, dialogs, card notes, API wrappers, i18n EN+DE, client tests | 1.5 d |
| 6 | `docs: conformity switch` | 2.8, release note, concept note, lint/format, SPDX | 0.5 d |

Total about 6.5 person-days (size L). Run `npm run lint:fix && npm run format:fix`, `scripts/check-api-guidelines.js`, `npm run check:response-shapes`, `scripts/check-client-api-contract.js` before each push. PO decisions needed before commit 3: OQ1 (`_verify`), before commit 5: confirmation phrase and legal wording (1.7).
