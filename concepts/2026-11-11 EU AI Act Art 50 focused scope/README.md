# EU AI Act Art. 50: focused scope: epic plan (#3324)

Planning folder for epic [#3324](https://github.com/intrafind/ihub-apps/issues/3324). Each sub-issue was analysed by a product manager and a senior engineer (reading the real code). The three issues with a frontend part (#3325, #3326, #3329) were also designed by a UX designer and a UI designer.

Deadlines: Art. 50(1) disclosure applies now. Art. 50(2) machine-readable marking and detection is due **2026-12-02**.

## Documents

| File | Content |
| --- | --- |
| `3325-ai-disclosure.md` | PM + engineering brief: guardrail prompt and first-turn notice |
| `3326-ai-acknowledgement.md` | PM + engineering brief: acknowledgement dialog, 428 enforcement, admin actions |
| `3327-provenance-records.md` | PM + engineering brief: provenance records, object, `contentMarking`, verify endpoint |
| `3331-text-watermarking.md` | PM + engineering brief: vLLM watermark, key store with rotation, detector client |
| `3328-provider-marks-media.md` | PM + engineering brief: keep and record provider marks on images and audio |
| `3329-admin-overview-page.md` | PM + engineering brief: `/admin/eu-ai-act` page, status endpoint |
| `ux-design.md` | UX design for #3325, #3326, #3329 (flows, states, EN/DE copy, a11y) |
| `ui-design.md` | UI design for #3325, #3326, #3329 (components, classes, wireframes) |

## Stack

Branches are stacked: each branch is created from the one before it, and each draft PR targets the previous branch. The whole stack merges bottom to top.

| # | Issue | Branch | Base |
| --- | --- | --- | --- |
| 0 | planning docs (this folder) | `claude/epic-analysis-planning-45wief` | `main` |
| 1 | #3325 AI disclosure | `claude/ai-act-3325-disclosure` | 0 |
| 2 | #3326 acknowledgement | `claude/ai-act-3326-acknowledgement` | 1 |
| 3 | #3327 provenance records | `claude/ai-act-3327-provenance` | 2 |
| 4 | #3331 text watermarking | `claude/ai-act-3331-watermark` | 3 |
| 5 | #3328 provider marks (image/audio) | `claude/ai-act-3328-provider-marks` | 4 |
| 6 | #3329 admin overview page | `claude/ai-act-3329-admin-page` | 5 |

Order rationale: #3327 introduces the record store, the provenance object, `contentMarking` and the verify endpoint. #3331 and #3328 extend them. #3329 consumes everything, so it goes last. #3330 (optional signing) is a decision issue and is **not** implemented.

## Decisions taken across the analyses

These settle conflicts and open questions so each session can start without waiting. A session may raise an objection in its PR description, but should not silently deviate.

1. **Migration numbers.** The issues say "after V226"; that is stale. The latest migration on disk is **V240**. Every session takes the next free number at the time it cuts its branch (`ls server/migrations | sort -V | tail`), in stack order. Expected: #3325 V241 (if it needs one), #3326 next, #3327 next. #3331 needs no migration. `server/defaults/` must carry the same defaults, because fresh installs run no migrations.
2. **Verify endpoint name.** `docs/api-guidelines.md` forbids bare verbs, so the endpoint is **`POST /api/provenance/_verify`**, not `/verify`. #3327 creates it; #3331, #3328 and #3329 extend or consume it. The issue texts still say `/verify`.
3. **No `#2619` branch exists** in this checkout. `guardrail.js`, `records.js`, `ProvenanceStore.js`, `turnProvenance.js` and `httpProvenance.js` are written fresh to the issue spec.
4. **Guardrail injection** is a single point in `LLMClient.execute()` (after model resolution, before the request is built). See `3325-ai-disclosure.md`.
5. **Key encoding.** Watermark keys are stored as safe integers in v1 (`3331`), but admin API payloads carry the key as a **string**, so the browser never loses precision above 2^53 (`3329`).
6. **Self-test endpoint ownership.** #3331 owns the detector and self-test endpoints under `/api/admin/watermark-detectors`. #3329 consumes them rather than adding its own. Where the #3329 brief proposes different endpoint names, the endpoints actually built by #3331 win; the #3329 session reconciles.
7. **Marking claims.** Until #3331 exists, `contentMarking.text.by = "ihub"` must not report `applied: true`. #3327 offers only `provider` and `none` in the model UI until then.
8. **Wording of results** never over-claims. Allowed: "Detected", "Not detected", "Too short to tell", "Found", "Not found". Banned: "not watermarked", "human-written", "authentic". Every negative result says it is not proof of origin (`ux-design.md`).
9. **Tests for a default-on feature.** #3326 enforces by default, which breaks existing e2e and integration suites; `tests/config/e2e-contents.mjs` switches the feature off and only the new spec turns it on.
10. **Issue bodies are not edited.** Where a brief deviates from an issue's wording (migration number, `_verify`, self-test endpoint), the PR description names the deviation.

## Rules every implementation session follows

- Read this README, then your own brief, then `CLAUDE.md`. Use the briefs' file and line references as starting points and re-verify them against your branch, since earlier branches in the stack change the code.
- Implement the issue's acceptance criteria. Briefs list the ordered checklist, tests, docs and pitfalls.
- Run `npm run lint:fix && npm run format:fix` and the relevant tests before committing.
- Add a release-note entry in `docs/releases/next/` (use the `/document-feature` skill) and update the topic docs named in the brief.
- Add the SPDX header to every new source file.
- Commit, push your branch, and open a **draft PR whose base is the previous branch of the stack** (not `main`). Use the PR template if the repo has one.
- When the PR is open, message the coordinating session (id in the session prompt) with the branch name, PR URL, the migration number you took, and any deviation from the brief. The next session starts from your branch, so do not rebase or force-push it afterwards without telling the coordinator.

## Follow-ups added after the first review of the stack

The owner reviewed the six PRs and asked for two follow-ups. They extend the stack.

| # | Work | Branch | Base | PR |
| --- | --- | --- | --- | --- |
| 7 | Provenance settings form and "Make active" for watermark keys | `claude/ai-act-admin-settings-and-activate` | 6 | #3597 |
| 8 | Acknowledgement in the client integrations (Office/Outlook pane, browser extension, Nextcloud, Teams, embeds) | `claude/ai-act-integrations-acknowledgement` | 7 | next |

Step 7 found that the `aiDisclosure` and `aiAcknowledgement` platform settings already have admin forms under Admin → Advanced (`AiNoticeSettingsCard`, `AiAcknowledgementSettingsCard`). Nothing is missing there.

### Step 8: what the analysis found

Documents: `integrations-acknowledgement.md` (PM + engineering) and `integrations-acknowledgement-ux-ui.md` (UX + UI).

- The step 2 PR said the Office, extension and Teams embeds "get no dialog and show an error on a 428". That was incomplete: Office, the browser extension and Nextcloud authenticate with delegated OAuth tokens that carry a `clientId`, and `isMachinePrincipal` exempts those. They **never get a 428**. The gap is that these users are never asked, so no acknowledgement is recorded for them.
- Teams and `?embed=true` iframes are human principals that mount the full web app, so they already have the dialog (verify on a real host).
- The Outlook pane, the Outlook pop-out and the extension side panel share one root, `OfficeApp`. One provider mount covers all three.

### Decisions taken for step 8 (open questions in the analysis)

These were decided by the coordinating session on the owner's request ("we have to build it into our client integrations as well"). They are reversible; the PR description must name them.

1. **OQ1:** gate the three first-party delegated clients (identified by the `officeIntegration`, `browserExtension` and `nextcloudEmbed` `oauthClientId`s) as human principals. No migration. Other OAuth clients, personal API keys, MCP, A2A and the inference API stay exempt.
2. **OQ2:** accept that users who only use a Copilot-style agent and never reach a first-party UI are not asked.
3. **OQ3:** guests in cross-site anonymous embeds (cookies are dropped, `SameSite=lax`): client-side fallback "open iHub in its own tab"; no partitioned cookies.
4. **OQ4:** record the client kind on the acknowledgement entry if it is a small additive change; otherwise leave it out and say so.
5. UX questions: the pane menu entry "AI-use notice" is the review-later path; no auto-send after Confirm when the context (item, tab URL, selection) changed, the draft is kept with a status message; shared copy for Word, Excel and PowerPoint panes once they exist; a first-time Teams user may see the legacy `DisclaimerPopup` before the new dialog.

**Ship order inside the branch:** the server gating of the three clients must not land before the Office wiring, or those users would be blocked with no dialog. Keep both in one branch, and commit the client wiring first.

### Step 9: EU AI Act master switch and the acknowledgement API move

Requested by the owner after step 8. Documents: `eu-ai-act-switch.md` (PM + engineering analysis; read it fully, it has the 21-row feature matrix, the store, the endpoints, every gate point, tests and the commit order) and `eu-ai-act-switch-ux-ui.md` (UX + UI: flows, states, EN/DE copy, wireframes). The agent that wrote the engineering analysis worked from the step 8 tip before the stack resync and before several follow-up changes on lower branches: re-verify every file and line reference, and note the corrections below.

Requirement (owner, verbatim): "we should move all apis around acknowledgement behind eu-ai-act endpoint. we should be able to disable the eu-ai-act conformity. someone who does not want it, can disable it. it must be recorded who it was and when including a description why. this is stored in the server. it turns off all the features and requirements."

Decisions by the owner:
- **Who may switch:** admins. The analysis requires an interactive admin session (API keys, OAuth tokens and agents get 403), keep that.
- **Acknowledgements while off:** they just stay. The admin actions that delete or reset acknowledgements (remove one, remove all, request again) are disabled while the features are off. Read-only export stays.
- **Re-enabling:** acknowledgements that are still valid stay valid. Only users who have no valid acknowledgement are asked, at their next message. No automatic re-request, `requiredVersion` is not changed by the switch.
- **Notification:** the audit log only. Every toggle writes an audit entry (the analysis specifies it); no email, banner for end users or other channel.

Decisions taken by the coordinator on the analysis' open questions (reversible, name them in the PR):
1. `POST /api/provenance/_verify` is off while disabled and answers 403 `FEATURE_DISABLED` ("turns off all the features").
2. End users see no hint about the switch.
3. No typed confirmation phrase and no re-authentication; the disable dialog needs the mandatory reason (20-1000 characters) and the "legal duty stays with my organisation" checkbox, as designed. Wording marked [LEGAL] is a draft for legal review, not legal advice.
4. Only the acknowledgement APIs move under `eu-ai-act` (the owner's words). `/api/admin/watermark-keys`, `/api/admin/watermark-detectors` and `/api/provenance/_verify` stay where they are.
5. The UI calls it "EU AI Act features" (iHub cannot confer conformity); the record may keep the technical name `conformity` in the API as the analysis proposes, say so in the docs.
6. Keys, acknowledgements and provenance records are kept, the retention sweep keeps running, key management stays available while off (behaviour off, data kept).
7. Document that a vLLM started with `--watermark-config ... "enforce": true` keeps watermarking regardless of iHub; operators must restart vLLM without the flag when they disable the features.

Corrections to the engineering analysis caused by later changes on the stack:
- Read-aloud audio is not saved any more (step 5 follow-up): there is no TTS record, no `recordTtsOutput` and no `provenance.media.recordTts` setting. Drop those gates and rows.
- Step 1 left iAssistant alone (the preamble injection was removed): the "second guardrail path" in `iassistant-conversation.js` the analysis mentions may no longer exist. Verify; if it is gone no gate is needed there.
- The guardrail wording is configurable globally (`platform.aiDisclosure.guardrail.text`); the master switch is the only way to turn the guardrail off, and the docs, code comments and tests that say it "cannot be switched off" must be reworded to say "only through the audited switch".
- Migration numbers: take the next free one after the highest on your branch (`ls server/migrations | sort -V | tail`); the analysis expects none to be needed.

Commit order inside the branch: move the acknowledgement APIs first (and update every caller, the contract file, rate limiter, docs), then the store and endpoints, then the gates, then the e2e, then the UI, then docs and the release note.

### Step 9: as built

- Branch `claude/ai-act-eu-ai-act-switch`, base `claude/ai-act-integrations-acknowledgement`. No migration (the shipped default `server/defaults/config/eu-ai-act-conformity.json` is "on"; an absent file means on).
- Decisions 1-7 above were implemented as written. Owner's decision on admin actions: remove one, remove all and request again answer `403 FEATURE_DISABLED` while off; export stays.
- Deviations from the analysis: no gate in `iassistant-conversation.js` (the preamble injection no longer exists) and no TTS gates (read-aloud audio is not recorded); `GET /me` and `POST /me` follow the analysis (`POST` is `403 FEATURE_DISABLED`), and the client treats that answer as "done" so an open dialog never shows an error; provenance settings and the key store stay editable and manageable while off (no disabled fields), only the detector actions, verification and the acknowledgement delete/reset actions are disabled; `statusService` adds `summary.level: "disabled"`; the sidebar shows an "Off" badge.
