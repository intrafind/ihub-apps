# Senior PM view: admin UI rework, "Now" phase

Author: senior product manager (panel member). Date: 2026-11-16. Read-only review of `/workspace/ihub-apps` at HEAD `24ec91d`.
Sources: `concepts/admin-ui-review-2026-11/README.md` (Roadmap → Now, 16 rows; Decisions 1–14) and reports 01–08. I re-checked the findings this plan depends on against current code (see "Verified on HEAD" below).

### Verified on HEAD (2026-11-16)

| Finding | Still true? | Evidence today |
|---|---|---|
| ID-B1 (P0) | Yes | `AdminAuthPage.jsx:40` seeds a default `config`; `:107-124` `catch` only calls `setMessage`; Save at `:265` is `disabled={saving}` only |
| Theme 1 server side | Yes | `configs.js:277` is a whole-object `POST /api/admin/configs/platform`; `:371-379` replace whole auth blocks (`newConfig.x \|\| existingConfig.x`); no `If-Match` anywhere in `server/` (grep: 0 hits); `server/utils/etag.js` only builds list ETags |
| ID-B2 | Yes | `isLastAdmin` is checked only on DELETE (`server/routes/admin/auth.js:660`), not on PUT |
| CU-B3 | Yes | `server/routes/admin/ui.js:238-249` writes the whole `ui.json` blindly |
| CU-B4 | **Partly fixed** | `AdminUICustomization.jsx:81` now calls `useUnsavedChanges` (after #3726). Overrides and template editor still need checking |
| AX-B6 | Yes | The guard is on the form page (`AdminWorkflowEditPage.jsx:59`), not on the canvas (`features/workflows/editor/`) |
| Theme 3 root cause | Yes | `AdminSettingsPage.jsx:33,134` has a `dirty` bar but no `useUnsavedChanges`; `Modal.jsx:17` `closeOnBackdropClick = true` and no `dirty` prop |
| Theme 5 root cause | Yes | `ConfirmDialog.jsx:19-27` takes only `title`/`message`/labels/`danger`; 30 native `confirm/alert/prompt` calls in `client/src/features/admin`; no `no-alert` ESLint rule |
| PL-B1 | Yes | `AdminBackupPage.jsx:68,246`: `onChange={handleImportConfig}` POSTs on pick |
| AI-B2 | Yes | `AdminModelsPage.jsx:197,552`: Enable All with no confirm |
| ID-B6 | Yes | `server/routes/admin/oauthClients.js:263-267`: `[]` becomes `['*']` |
| OB-B4 | Yes | `server/utils.js:383-393`: `CHAT_REQUEST` at `info` with `query: logEntry.query` and the username |
| OB-B28 | Yes | `server/utils.js:360-371`: feedback logs `user` at `info` |
| SH-B1 | Yes | `server/routes/staticRoutes.js:109-110`: any path ending in `.ext` returns 404 |
| PL-B12 | Yes | `server/utils/httpConfig.js:158-164` |
| Theme 10 | Yes | `tests/unit/client/translation-keys-exist.test.jsx:19` skips `features/admin` |
| PL-B18 | Yes | `server/defaults/config/platform.json:238-241`: `adminApi.limit: 100` |
| Baselines | — | 75 admin pages; 46 files in `features/admin` reference `AdminLoadError`; 19 files call `/admin/configs/platform`; 41 files use `ConfirmDialog`; latest migration `V253` |

---

## 1. Angle summary

- **The Now phase is a safety release, not a redesign.** Its job is that no admin action can lock someone out, delete data or silently fail. Anything that does not reduce harm (IA, wizards, new components beyond what the fixes need) waits for Next. I will cut scope to protect that message.
- **The 16 roadmap rows are too many to ship as 16 PRs and too coupled to ship as one.** I ship them as **9 themed draft PRs in 3 waves**. Each PR merges on its own, has one release-note entry, and has a test that proves the harm is gone.
- **Fix once in shared code, then sweep.** Five shared pieces close most P0/P1 items: a load gate (`useAdminConfigSection`), a server auth/admin invariant check, a redaction-preserving merge, guard wiring in `AdminSettingsPage`/`Modal`, and a named `ConfirmDialog` plus `no-alert`. Page-by-page patches without these would regress within a month.
- **The P0 (ID-B1) needs both a client and a server fix.** The client gate stops the common case. The server refusal ("this save leaves you no way to sign in") is the safety net for every other caller: scripts, stale tabs, and future pages. Both ship in wave 1.
- **Four Now items change shipped behaviour and need the user's approval before the PR leaves draft:** the last-admin/self guard (new 409s for scripted callers), removing question text from logs (decision 7, SIEM impact), feedback `chatId` storage (OB-B28), and, if pulled forward, the admin rate-limit default (decision 9). Everything else is a bug fix with no config or API shape change.
- **Two items are too big for "S" and I would cut or shrink them:** AX-B7 (217–320 German strings) and the full contract-bug row (16 IDs). In Now: the translation **ratchet** plus German for the safety dialogs this phase adds; contract bugs ship in three PRs by area, and anything not done by day 12 rolls to Next.
- **I would pull decision 9 (rate limit 100 → 500, per user) into Now.** Load gating makes every 429 visible as "Couldn't load", where before it was a silent empty form. Without the higher limit, wave 1 looks like a regression to admins behind a NAT. This needs a migration (`V254`) and approval.
- **No new admin endpoints in Now except additive error codes** and an optional `If-Match`. The `PATCH /configs/platform/{section}` config resource (theme 1 in full) is Next; Now ships the minimum that stops the data loss.
- **Success is measured, not felt:** zero writes after a failed load (e2e), zero native dialogs (lint), last-admin lockout impossible (unit plus e2e), the translation baseline only shrinks, and a re-run of the failed task walkthroughs (ID T6, CU T6, AX agent/approval) moves at least half to "success" or "partial".
- **Admins on existing installs must not have to do anything** for this release, except SIEM owners (log field removed) and anyone scripting user edits. The release notes say that in one "What you need to do" line per entry.

---

## 2. Now-phase plan

Three waves of about one week each. Waves 1 and 2 are the commitment; wave 3 is the stretch, and what is unfinished at day 12 moves to Next. Every PR is a **draft** until the decisions it is gated on are answered.

Legend: **[Gate D#]** needs README decision #; **[Behaviour]** changes shipped behaviour; **[Shape]** changes a config shape (migration); **[API]** changes an admin API contract. Any of these needs user approval under CLAUDE.md.

### Wave 1: stop the lockouts and the overwrites (days 1–5)

#### PR 1: Load gating ("no form until loaded")
- **Closes:** ID-B1 (client half), IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5, SH-B2 (Overview "fresh install"), AX-B9 (empty states on error).
- **Scope:** add `useAdminConfigSection` (see §3) and route every page that reads `/admin/configs/platform` (19 files) through it. Pages without the hook render `AdminLoadError` + Retry and **no** form, Save or Save bar. Empty states (`AdminEmptyState`, "Create your first…", "Add Registry") render only on a successful empty response. Overview shows "Couldn't load setup progress" instead of the fresh-install view.
- **Not in scope:** the one-call `/api/admin/shell` (Next), the full axios interceptor (only the 429 retry, below).
- **Done means:**
  - Given the platform GET fails (500, 429 or network), when an admin opens any of the 19 pages, then no input, Save or Save bar renders, and the page says "Couldn't load {thing}. {detail} [Try again]".
  - An e2e test stubs a failing GET for `/admin/auth`, `/admin/logging`, `/admin/telemetry`, `/admin/mcp-gateway` and the five Security cards, and asserts **zero** POST/PUT requests while the admin clicks every visible button.
  - A unit test fails if a page under `features/admin/pages` imports `makeAdminApiCall('/admin/configs/platform')` directly (forces new pages onto the hook).
  - On 429 the client waits for `Retry-After` and retries once before showing the error.
- **Risk:** low (client only, removes behaviour). **Approval:** none. **Release note:** `fixes.md`, admin audience.

#### PR 2: Lockout and last-admin guards (server)
- **Closes:** ID-B1 (server half), ID-B2, ID-B3, ID-B4.
- **Scope:**
  - In `POST /api/admin/configs/platform` (`configs.js:277`), refuse a save that leaves no enabled sign-in method, or disables the method the caller is signed in with, unless another admin-capable method stays enabled. Throw `ServiceError('AUTH_CONFIG_LOCKOUT', …)` → 409 problem+json with `detail` naming the method.
  - In user PUT (`auth.js:500-553`) apply the same `isLastAdmin` check the DELETE has (`:660`) to removing `admins`, disabling, and self-disable. 409 `LAST_ADMIN`.
  - ID-B3: user PUT keeps `active` when the body omits it; the editor sends the current value.
  - ID-B4: deleting a group that others `inherits` returns 409 `RESOURCE_IN_USE` with `details.usedBy: [groupIds]`, so the group cache never freezes.
  - New codes go in `shared/apiErrors.js` (additive).
- **Done means:**
  - Unit tests: last admin cannot be demoted, disabled or self-disabled (409); a second admin makes it allowed; an auth config with every method off returns 409 and leaves `platform.json` byte-identical.
  - E2e as `admin`/`password123`: untick Local auth while signed in locally, then Save, shows the server's `detail` in the error banner, and you can still sign in afterwards.
  - Saving a disabled user unchanged leaves `active: false`.
  - The UI maps 409 `detail` into the page (no "Request failed with status code 409").
- **Risk:** medium. A too-strict lockout rule could block legitimate migrations (for example local → OIDC). Mitigation: the rule counts OIDC/LDAP/proxy as valid sign-in routes **only if** at least one group mapping grants `admins`; otherwise the message says so and names the fix.
- **Approval:** **[Behaviour][API]** scripted `PUT` user calls that demote the last admin now get 409 instead of 200. I treat it as a safety fix with no compat shim, but this must be confirmed by the user before the PR leaves draft.
- **Release note:** `fixes.md` plus one line in `breaking-changes.md` for API callers.

#### PR 3: No redacted or whole-file overwrites
- **Closes:** PL-B4, CU-B3, OB-B10.
- **Scope (minimum to stop data loss, not the full config resource):**
  - Server: in `configs.js`, a `mergeRedactedSecrets(newBlock, existingBlock)` step keeps every value the GET redacted (the redaction markers and `proxyAuth.jwtProviders[].jwkUrl`) when the POST sends a marker or omits it. One helper, applied to every block that is redacted on read.
  - Client: `AdminAdvancedPage.jsx:38-42` and `ProvenanceSettingsCard.jsx:191-198` send only the block they own (as `AiNoticeSettingsCard.jsx:58-59` already does).
  - `ui.json` and platform: GET returns an `ETag`; POST honours `If-Match` **when sent** (412 `CONFIG_CHANGED` with "Someone changed this. Reload or overwrite.") **[Gate D6, optional If-Match as recommended]**. Admin pages always send it. Scripts that don't send it behave as today.
  - CU-B3 specifically: the `/admin/ui` save never writes `pages`; the server keeps the on-disk `pages`.
  - OB-B10: "Save Privacy Settings" sends only the privacy fields.
- **Done means:**
  - Round-trip test: GET platform (redacted), POST it back unchanged, and `platform.json` is semantically identical (secrets and `jwkUrl` intact).
  - Two-tab e2e: create a page in tab B, save `/admin/ui` in tab A, and the page still exists (412 shown in A, or `pages` preserved).
  - A POST without `If-Match` still succeeds (backward compatible).
- **Risk:** medium (touches the one config write path everyone uses). **Approval:** D6 as recommended (optional header) is additive; making it required is **not** in Now.
- **Release note:** `fixes.md`.

### Wave 2: stop silent loss and one-click destruction (days 4–10)

#### PR 4: Unsaved-changes guards at the frame level
- **Closes:** ID-B11, CU-B4 (remaining: overrides and template editor), AX-B6, OB-B16 (8 pages), PL-B14 (7 pages), IN-B12, AI-B20.
- **Scope:** `AdminSettingsPage` calls `useUnsavedChanges` itself from its `dirty` prop (PL-UX1), so every page built on it is covered at once. `Modal` gets a `dirty` prop: when true, Escape and backdrop ask before closing. The workflow canvas (`features/workflows/editor/`) gets the guard on Back, on the "Chat integration" link and on tab close. `AdminAuthPage` gets the guard directly (it is not on the frame).
- **Done means:** a parametrised e2e opens each guarded page, edits one field, clicks a sidebar link and expects the "Leave without saving?" dialog; after Save the same click navigates. `docs/admin-ui.md:513` is reworded to list where the guard applies (no promise beyond the code).
- **Risk:** low–medium. False positives (a dirty flag right after load because defaults are normalised) annoy admins. Mitigation: compare against the **normalised** loaded value, and a test asserts "not dirty after load" on every guarded page.
- **Approval:** none. **Release note:** `fixes.md`.

#### PR 5: Named confirmations and no native dialogs
- **Closes:** PL-B1, PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14, IN-B3 (plus CU-B24, ID-B15 for the `alert` part).
- **Scope:**
  - `ConfirmDialog` gains `itemName`, `consequences` (list) and `requireTypedName` (opt-in, for platform-wide actions only). Copy follows the README microcopy: name the object, its dependants and the undo path.
  - Replace all 30 `confirm/alert/prompt` calls in `features/admin`; add ESLint `no-alert` as **error** for `client/src/features/admin/**` (warn elsewhere).
  - PL-B1/PL-B7: Backup import becomes pick → summary (file name, size, the version it was exported from if present) → typed confirmation → import. Use `UploadConfigButton` with a new `accept` prop.
  - AI-B2: Enable All / Disable All confirm and never clear the default model; Disable All keeps the default enabled and says so.
  - IN-B3: credential delete gets a server in-use check (409 `RESOURCE_IN_USE`, `usedBy` installations) and the dialog lists the installations. This is the only "used-by" server work in Now; the generic used-by service is Next.
- **Done means:** lint has 0 `no-alert` hits in admin; choosing a ZIP makes no network request until the admin confirms (e2e asserts zero `/_import` calls); each listed action shows the item's name in the dialog (unit test per dialog); the import control works with the keyboard alone (axe plus a keyboard e2e).
- **Risk:** low. **Approval:** none (the 409 on credential delete is a new refusal; I count it as a bug fix, but I list it in the PR body). **Release note:** `fixes.md`.

#### PR 6: Visual P1s (quick wins)
- **Closes:** AI-B3, ID-B7, ID-B9, CU-B6, PL-B5, PL-B6, SH-B9 (= ID-B8, OB-B17, PL-B19).
- **Scope:** a scoped base CSS rule that gives admin `input/select/textarea` a 1 px border token in light and dark; `INPUT_CLASS` in the six editors; `useDarkMode` mounted in `AdminLayout` plus the pre-paint script; Cookies Save on the accent token; `dark:` label variants on `/admin/auth`. **Not** `AdminField`/`AdminInput` (Tier 1, Next).
- **Done means:** a Playwright check measures a border width ≥ 1 px on every input of the six named pages in light and dark; a cold load of `/admin/users/new` in dark mode renders dark at first paint; the axe baseline count does not grow (ratchet down where it drops).
- **Risk:** low. Possible spill into the end-user UI if the CSS rule isn't scoped: scope it under `[data-admin]`. **Release note:** one `fixes.md` entry ("Admin inputs are visible again in light and dark mode").

#### PR 7: Privacy and security fixes
- **Closes:** OB-B4, OB-B28, OB-B5 (doc), PL-B2 (callout), PL-B12 (show the coupling).
- **Scope:**
  - OB-B4 **[Gate D7][Behaviour]**: remove `query` from the `CHAT_REQUEST` log line (`server/utils.js:392`) for all installs. No content-logging switch in Now (it is a new feature: Next, if anyone asks).
  - OB-B28 **[Behaviour]**: drop `user` from the `FEEDBACK` info line (`server/utils.js:368`); stop writing the raw `chatId` to `feedback.jsonl` in the modes that promise anonymity; relabel "Anonymous (hashed)" to say what is stored. Existing `feedback.jsonl` lines are **not** rewritten (see questions).
  - OB-B5: correct `docs/pii-data-handling.md:29` (uploads are stored; where; how long).
  - PL-B2 **[D10: option (a) only in Now]**: a callout on the Backup page and in the docs that the export contains the encryption key, JWT keys and password hashes. The export format does not change.
  - PL-B12 **[D14: option (a) only in Now]**: the SSL allowlist card says "Hosts here are also trusted for outbound requests to private addresses (SSRF)". Separating the lists (option b plus a migration) is Next and needs approval.
- **Done means:** a unit test asserts the `CHAT_REQUEST` and `FEEDBACK` log objects have no `query` or `user` keys; a test asserts new feedback rows in anonymous mode have no raw `chatId`; the docs fix is reviewed by the tech writer; both callouts render in en and de.
- **Risk:** low technically, medium for customers who parse logs. **Approval:** D7 and the OB-B28 storage change. **Release note:** `breaking-changes.md` ("The chat request log line no longer contains the question text") with "What you need to do: SIEM rules that read `query` from `CHAT_REQUEST` must be changed".

### Wave 3: contract bugs, docs, German (days 8–14, stretch)

#### PR 8a / 8b / 8c: Contract bugs, split by area
Each fix comes with a **round-trip test** (load, save unchanged, file identical) for the editor it touches. That is the "done" bar for every row.
- **8a AI workspace and workflows:** AI-B1 (wizard writes `en-US`/`de-DE` keys: normalise to the base language), AI-B4, AI-B6, AX-B2 (`DualModeEditor` keeps JSON edits), AX-B3 (commas in group fields: a tag input), AX-B4 (Ask a Person needs ≥ 1 option: client validation plus server 400 with `errors[].pointer`), AX-B5, AX-B20 (canvas node type), AX-B12 (show the built-in `input`), AX-B11 (hide Publish), AX-B32 (step names in errors), AX-B10 **display only**: a computed "Visible to" column, no grant change **[D3 not needed for the display; the grant model stays as is]**, AX-B1/AX-B21: hide the agent schedule field and add a doc note ("schedules are not run yet"); the scheduler fix is Next.
- **8b Short links and localization:** CU-B1, CU-B2, CU-B8, CU-B9, CU-B10 (base path via `buildPath()`; redirect keeps the base path, with cold-load tests at `/` and `/ihub/`), CU-B7 ("Changed only" defaults to off).
- **8c Integrations:** IN-B2 (install-once integrations propose the right ID), IN-B4 (map `details.issues` → `errors[].pointer`, so field errors reach their fields; this is also the shared problem+json field mapper), IN-B5 (Jira's sign-in mode no longer "(later release)").
- **Also in 8a or a tiny PR:** OB-B3 (the log component filter never drops `error`; offer only components the server emits), AX-B16 (cancel interactions with their run).
- **Risk:** low each, but many. Cut rule: anything not merged by day 12 moves to Next without discussion.

#### PR 9: Honest Overview, docs deep links, harmful docs, least-privilege client UI, i18n ratchet
I bundle the small "honesty" items so they share one release-note story ("the admin tells the truth").
- SH-B3: the setup checklist computes its ticks (server-computed if the endpoint exists; otherwise hide the checklist rather than show constants).
- SH-B1: exempt `/admin/docs/` from the extension rule in `staticRoutes.js:109-110`; cold-load tests at `/admin/docs/x.md` and `/ihub/admin/docs/x.md`. No changelog entry (unreleased feature, SH §1).
- Harmful docs: OB-B5 (if not in PR 7), AI-B7 (relabel to "Opens in app" **[D12 as recommended]**), AI-B15, SH-B14 = OB-B12, IN-B23, CU-B12, and `AUTHENTICATION_QUICK_START.md:153` (`admin` → `admins`).
- ID-B6 **[D4 option (a)]**: the client editor shows "No apps (choose apps)" vs "All apps" explicitly, defaults new clients to an explicit choice, and warns on `*`. The server `[]` → `['*']` meaning does **not** change in Now.
- ID-B15: `SecretRevealDialog` (show once, copy, "I stored it"), replacing the `alert()` that shows the client secret.
- Translation ratchet: remove the `features/admin` exclusion (`translation-keys-exist.test.jsx:19`) and the `admin.` key skip behind a baseline file that can only shrink; every string added in PRs 1–9 has en and de. **AX-B7 in full (217+ strings) is cut from Now** unless a translator is assigned; the ratchet keeps it from growing. SH-B13, AI-B14 and CU-B22 shrink as a side effect only.

### What I cut or defer from the Now rows

| Item | Decision | Why |
|---|---|---|
| AX-B7 full German for Skills/Workflows/Agents | Defer to Next; ratchet now | 217–320 strings is M, not S; needs a translator review (*Sie*, "Benutzer", D11) |
| Agent scheduler fix (AX-B1 "fix next") | Next, as the README says | Now only hides the dead field |
| Full config resource (`PATCH …/{section}`, audit diffs, OB-B6) | Next | PR 3 stops the loss; the resource is the clean fix |
| Content-logging switch (D7) | Not planned until asked | A new feature, not a fix |
| `SecretRevealDialog` | Keep, but first to drop if wave 3 slips | Low harm today (the secret shows once in an alert) |
| Workflow "computed Groups column" | Display only | The grant model is D3 |
| Rate-limit default (D9) | **Pull into wave 1** if approved | Load gating makes 429s visible |

### Decisions that touch Now, and my recommendation for each

| # | Touches | My recommendation for Now |
|---|---|---|
| 3 | AX-B10 | Display only in Now; no grant migration. Agree with (b) for later |
| 4 | ID-B6 | (a) UI fix only. Leave (b)/(c) for the API revision |
| 6 | PR 3 | Optional `If-Match` now, admin UI always sends it; never required in Now |
| 7 | OB-B4 | Agree: remove `query` for all installs, release note for SIEMs. No debug-level fallback |
| 8 | OB-B28 (adjacent) | Now only removes logging and raw `chatId`; the "what admins can read" policy is Next |
| 9 | PR 1 | Pull forward: 100 → 500, per user. Migration `V254` that changes the value only if it still equals the shipped 100 (respects admin edits) |
| 10 | PL-B2 | (a) callout now; (c) Next, with the scripted-export question answered first |
| 11 | All new copy | US spelling and "Benutzer"/*Sie* now, since PRs 1–9 add strings; the nav renames are Next |
| 12 | AI-B7 | Agree: relabel only |
| 13 | ID-B30 | Not in Now (201 is easy, but it is an API contract change with no safety value) |
| 14 | PL-B12 | (a) in Now; (b) with migration in Next after approval |
| 1, 2, 5 | — | Not in Now |

Plus the two behaviour changes not covered by a numbered decision: **last-admin/self guard 409s** (PR 2) and **feedback `chatId` storage** (PR 7). I would add them to the decision list.

### Success metrics for the Now phase

| Metric | Baseline (HEAD) | Target at end of Now |
|---|---|---|
| P0/P1 items from the must-fix list closed | 0 of 47 | ≥ 30 (all of patterns A, B, C, G, J, N; most of D, E) |
| Admin pages that can write after a failed load | at least 7 known (theme 1) | 0, enforced by e2e plus the import lint test |
| Native `confirm/alert/prompt` in `features/admin` | 30 | 0 (ESLint error) |
| Last-admin / sign-in lockout paths | 3 (ID-B1, ID-B2 edit, self-disable) | 0, unit plus e2e |
| Editors with a round-trip test | per PR 8 scope | +1 per contract bug fixed |
| Missing admin translation keys (baseline file) | measured when the ratchet lands | never grows; −100 by end of Next |
| Task walkthroughs re-run (ID T6, CU T6, PL T7, OB T2) | mostly partial/failed | ≥ half improve one grade; no new "failed" |
| Support signal | — | No lockout or "my settings disappeared" tickets attributable to the release in the 4 weeks after it ships |

Burn-down is tracked on epic #3739 by finding ID; each PR body lists the IDs it closes.

### Release-note framing for admins

One entry per PR in `docs/releases/next/` via the `document-feature` skill (`audience: admin`), written as outcomes, not internals:

- **fixes.md (headline):** "Admin pages no longer offer Save when their settings failed to load. A failed load shows the reason and a Try again button instead of default values." What you need to do: nothing.
- **fixes.md:** "You can no longer lock yourself out: iHub refuses a sign-in configuration that leaves no way to sign in, and refuses to demote or disable the last administrator." What you need to do: nothing; scripts see a 409 (see breaking changes).
- **fixes.md:** "Saving a settings page no longer erases secrets that were hidden on screen, and two admins editing at once get a 'someone changed this' message instead of overwriting each other."
- **fixes.md:** unsaved-changes warning; named confirmations including "Importing a backup now asks first"; visible inputs in dark mode; the contract fixes grouped per area (short links, app wizard, integrations).
- **breaking-changes.md:** "The `CHAT_REQUEST` log line no longer contains the user's question" (SIEM action); "`PUT` on a user that would remove the last administrator returns 409" (script action); if D9 lands: "The admin API rate limit default is now 500 per user per minute" (no action).
- **Not in notes:** SH-B1 (unreleased docs site), test and lint changes.

### Upgrade impact for existing on-prem installs

| Change | Impact on an existing install | Migration? |
|---|---|---|
| Load gating, guards, dialogs, visuals | UI only | No |
| Lockout / last-admin refusals | New 409s on unsafe writes; nothing stored changes | No |
| Redaction-preserving merge, optional `If-Match` | Fixes silent erasure; scripts without the header unchanged | No |
| `CHAT_REQUEST` without `query` | Log consumers lose a field | No (code) |
| Feedback without raw `chatId` | New rows only; old rows unchanged | No (decide on a cleanup, see questions) |
| Rate limit 100 → 500 (if D9 is approved) | Fewer 429s | **Yes, `V254`**, only when the value equals the shipped default |
| `ui.json` save keeps `pages` | Fixes deletion | No |
| ID-B6 client editor | Existing clients keep `*`; the editor now shows it as "All apps" with a warning | No |

The release touches `platform.json` only through the existing write path and (optionally) `V254`. A restored pre-upgrade backup stays valid. Test the upgrade on a copy of a V253 `contents/` with: OIDC only, proxy-JWT with `jwkUrl`, two local admins, one local admin, a disabled user, and 100+ pages in `ui.json`.

---

## 3. Shared components, hooks and server layers I require

| Name | API sketch | Closes |
|---|---|---|
| `useAdminConfigSection(section, { select, defaults })` | returns `{ status: 'loading'\|'error'\|'ready', data, error, retry, save(partial), dirty, etag }`; renders nothing editable unless `ready`; `save` sends only `section`'s keys plus `If-Match` | ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5, PL-B4 (client), OB-B10 |
| `AdminDataBoundary` | `<AdminDataBoundary status error onRetry empty={<AdminEmptyState/>}>`; shows the empty state only on `ready && isEmpty` | SH-B2, AX-B9, IN-B7, CU-B21 |
| `apiErrorMessage(error, t)` and an axios 429 retry | reads problem+json `detail`/`code`; one retry on `Retry-After`; never "Request failed with status code N" | SH-B10, ID-B14, PL-B15, IN-B4 (with the pointer mapper) |
| `mapProblemErrorsToFields(problem)` | `errors[].pointer` → `{ fieldPath: message }` | IN-B4, AX-B4 |
| `AdminSettingsPage` + `Modal dirty` | the frame calls `useUnsavedChanges(saved, current)` when `dirty` is supplied; `Modal` with `dirty` confirms on Escape/backdrop | ID-B11, CU-B4, OB-B16, PL-B14, IN-B12, AI-B20 |
| `ConfirmDialog` v2 | adds `itemName`, `consequences[]`, `undoHint`, `requireTypedName`; all labels via `t()` | AI-B2, AI-B12, AX-B14, PL-B1, PL-B8, OB-B7, OB-B8, IN-B3 |
| ESLint `no-alert` (error in admin) and an import-lint test for direct platform-config calls | — | keeps themes 1 and 5 closed |
| Server `assertSignInRouteRemains(newAuthConfig, caller)` | pure function; used by `configs.js` POST and later by the PATCH resource | ID-B1 (server), ID-B2 (auth half) |
| Server `assertAdminInvariant(userChange, caller)` | last admin, self-demote, self-disable | ID-B2 |
| Server `mergeRedactedSecrets(newBlock, existingBlock, redactionMap)` | one map of which paths GET redacts; reused for write | PL-B4, and protects every future card |
| Server `checkIfMatch(req, currentEtag)` | optional: 412 `CONFIG_CHANGED` only when the header is present | CU-B3, multi-admin edits |
| `shared/apiErrors.js` codes | `AUTH_CONFIG_LOCKOUT`, `LAST_ADMIN`, `RESOURCE_IN_USE` (with `details.usedBy`), `CONFIG_CHANGED` | PRs 2, 3, 5 |
| Translation baseline file | `tests/unit/client/translation-baseline.json`; test fails if any key is added to it | theme 10 |

These are deliberately the **smallest** versions; Next grows them (the config resource, the used-by service, Tier 1 fields).

---

## 4. Next / Later notes

- **Next, first:** the config resource (`PATCH /api/admin/configs/platform/{section}` with `If-Match`, audit diffs, OB-B6) built on PR 3's helpers; then the used-by and invariant service (generalise PR 5's credential check); then Tier 1 field components (security forms first). These three remove the stopgaps from Now.
- **Next, value:** the access explainer (ID-PM1) is the single biggest usability win for "why can't X see Y"; the agent scheduler; AX-B7 German in full; docs wave 1 and the `admin-ui.md` map; IA step 1.
- **Decisions to settle early in Next** because they block design work: 1 and 2 (access model), 5 (admin roles), 14 (b) migration, 10 (c) backup format, 13 (API revision).
- **Later:** wizards beyond the day-1 spine, drafts for apps and branding, the privacy hub. Do not start them before the Now metrics hold for a release.

---

## 5. Pre-mortem

Assume the release shipped and failed. How?

1. **A legitimate SSO cut-over is blocked by the lockout rule.** An admin moving from local to OIDC cannot save because the rule doesn't see an admin route. *Mitigation:* the rule accepts OIDC/LDAP/proxy when a group mapping grants `admins`; the 409 `detail` says exactly which mapping is missing; a documented recovery (`adminRescue`) is linked from the message.
2. **Load gating turns rate limiting into a wall of errors.** Admins behind a NAT see "Couldn't load" on every page, and the release reads as a regression. *Mitigation:* D9 in wave 1, one 429 retry with `Retry-After`, the 429 template message.
3. **The redaction merge keeps a secret the admin meant to clear.** An admin empties the OIDC client secret, and the merge restores it. *Mitigation:* distinguish "marker sent / key omitted" (keep) from "empty string sent" (clear); round-trip and clear tests per secret field.
4. **The unsaved guard fires on clean pages.** Defaults normalised after load make every page "dirty", admins learn to click "Leave" blindly, and the guard loses its value. *Mitigation:* "not dirty after load" test on every guarded page; the guard compares normalised values.
5. **`If-Match` breaks an admin's own second tab or the Save→reload cycle.** A stale ETag after a successful save produces 412 on the next save. *Mitigation:* `save()` stores the new ETag from the response; e2e saves twice in a row.
6. **SIEM dashboards silently empty.** A customer's alerting on `CHAT_REQUEST.query` stops working and nobody reads the release notes. *Mitigation:* `breaking-changes.md` entry with "What you need to do"; mention in the upgrade section of the release mail; keep the `CHAT_REQUEST` event itself (only the field goes).
7. **Scope creep makes the "S" rows M.** The contract-bug row and German grow, waves 1–2 slip, and the P0 ships late. *Mitigation:* waves 1–2 merge independently; the day-12 cut rule; each PR has a fixed ID list in its body, and new findings go to #3739, not into the PR.
8. **i18n gaps in the new safety dialogs.** German admins see English lockout and import warnings, which is worst exactly where it matters. *Mitigation:* the ratchet test lands in PR 1 (not last), so every new key needs en and de from day 1.
9. **Docs drift.** `admin-ui.md:513` still promises the guard everywhere; release notes describe a "Try again" button the Overview doesn't have. *Mitigation:* each PR's checklist includes the docs line it changes; the TW reviews release entries before merge.
10. **Upgrade breaks a scripted provisioning tool.** A customer script creates users and then demotes the bootstrap admin, now refused with 409. *Mitigation:* the decision is made explicitly (approval gate), documented in `breaking-changes.md` with the exact error code and the fix (promote the new admin first).
11. **A security regression from the visual fix.** The scoped CSS or theme hook changes the end-user chat UI or the login page. *Mitigation:* scope to `[data-admin]`; visual snapshots of the chat and login pages in the PR.
12. **Backup import confirmation is bypassable.** The keyboard path or the old hidden input still triggers on change. *Mitigation:* e2e asserts zero `/_import` requests until confirmation, via mouse and keyboard.
13. **Migration `V254` overwrites an admin's chosen limit.** *Mitigation:* change the value only when it equals the shipped 100 and the key structure matches the default; log the change; a migration test for both cases.

---

## 6. Questions I have NOT asked

| Question | Why it matters | My default if unanswered |
|---|---|---|
| Who scripts against the admin API today (user PUT, platform POST, backup export)? | Decides whether PR 2's 409 and PR 3's `If-Match` need `Deprecation` notes | Assume a few on-prem customers do; ship as a documented breaking change, no shim |
| Is there a release date or tag for this increment? | Sets the cut-off for wave 3 | Day 14 from start; wave 3 leftovers roll to Next |
| Should existing `feedback.jsonl` rows with raw `chatId` be scrubbed? | A privacy promise ("anonymous") was broken for past data | Do not rewrite data in Now; document it and offer a one-off script in Next |
| Do customers rely on `ssl.domainWhitelist` granting SSRF trust? | Decides D14 (b) vs (c) in Next | Assume yes for some; (b) with a migration |
| Is a German translator available for AX-B7 in this window? | Decides whether AX-B7 stays in Now | No; ratchet only |
| What counts as an "admin sign-in route" for proxy auth? | PR 2's lockout rule | A proxy group mapping that yields `admins` counts |
| Are multiple admins editing at once common in production? | Priority of `If-Match` vs the redaction merge | Rare but costly; ship both, as small changes |
| Should the Now PRs land on one release branch or main? | Merge order and risk | `main`, behind no feature flag; each PR is safe alone |
| Do we have Playwright capacity in CI for the new e2e set (dark mode, 390 px, two-tab)? | CI time | Run the new e2e set in the existing admin job; tag the slow two-tab test nightly if needed |
| Does an existing helpdesk or support channel track lockouts? | Measuring the support metric | Use the GitHub issue tracker and the epic as the signal |

---

## 7. Decisions I made on my own

- **Nine PRs in three waves**, not one PR per roadmap row: it keeps each PR reviewable and lets the P0 ship first.
- **Wave order** (load gate, then server guards, then overwrites, then guards and dialogs, then contract bugs and docs): ordered by harm (lockout and data loss first) and by dependency (the hook in PR 1 is used by PR 3 and PR 4).
- **PR 2 ships the server-side lockout refusal in Now**, although the roadmap lists only "lockout refusal" loosely: a client-only fix leaves scripts and stale tabs able to lock out.
- **`If-Match` is optional** in Now (D6 as recommended); the admin UI always sends it.
- **The redaction-preserving merge is a server helper**, not a client fix, so every future card is protected.
- **AX-B7 full translation cut from Now**; the ratchet stays in.
- **D9 pulled into Now** (pending approval), because load gating makes the low limit visible.
- **OB-B28: new rows only**; no rewriting of existing data in Now.
- **ID-B6 and AX-B10 are display/UI fixes only**; the stored meaning of `[]` and the workflow grant model are unchanged.
- **A cut rule at day 12** for wave 3, with no renegotiation.
- **I count the credential-in-use 409 (IN-B3) and the group-inherited 409 (ID-B4) as bug fixes**, not API changes, because the current behaviour corrupts state; both are listed in the PR bodies so a reviewer can disagree.
- **No new admin endpoints in Now**, only additive error codes and an optional header, to keep upgrade impact near zero.
- **Release-note style:** outcome-first sentences with a "What you need to do" line, filed under `fixes.md` unless an external caller can break.
- **Proposed new error codes** (`AUTH_CONFIG_LOCKOUT`, `LAST_ADMIN`, `RESOURCE_IN_USE`, `CONFIG_CHANGED`): names are mine; the API owner may rename them before merge.
- I treated the README's "S" efforts as roughly right except for AX-B7 and the 16-ID contract row, which I re-sized from the evidence.
