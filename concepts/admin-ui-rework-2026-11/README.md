# Admin UI rework — plan and first increment ("Now")

**Date:** 2026-11-17 · **Epic:** #3739 (sub-epics #3740–#3747) · **Input:** [`../admin-ui-review-2026-11/`](../admin-ui-review-2026-11/README.md) · **Status:** plan agreed; Now phase in implementation as eleven draft PRs.

This folder turns the November review into a delivery plan. A panel of seven experts (product manager, UX designer, UI designer, technical writer, quality engineer, on-prem iHub admin, security expert) worked independently from the review reports and the current code. Their full reports, each with a pre-mortem, open questions and the choices they made on their own, are in [`panel/`](panel/). This README merges them. The merge order of the Now PRs and how their conflicts resolve are in [`merge-order-and-conflicts.md`](merge-order-and-conflicts.md).

| File | Expert |
|---|---|
| [panel/01-product-manager.md](panel/01-product-manager.md) | Scope, waves, metrics, release framing, upgrade impact |
| [panel/02-ux-designer.md](panel/02-ux-designer.md) | Load states, unsaved guard, confirmation tiers, refusal UX, microcopy |
| [panel/03-ui-designer.md](panel/03-ui-designer.md) | Visible controls, tokens, dark mode, dialog and error visuals |
| [panel/04-technical-writer.md](panel/04-technical-writer.md) | Doc fixes with corrected text, `admin-ui.md`, en/de copy, release notes, i18n ratchet |
| [panel/05-quality-engineer.md](panel/05-quality-engineer.md) | Test plan, isolated safety e2e, ratchets, CI wiring |
| [panel/06-on-prem-admin.md](panel/06-on-prem-admin.md) | Upgrade impact, scripts, break-glass, backup, subpath |
| [panel/07-security.md](panel/07-security.md) | Server invariants, redaction, If-Match, OAuth, TLS/SSRF |

---

## 1. Principles agreed by the panel

1. **The Now phase is a safety release, not a redesign.** It removes lockouts, silent data loss and one-click destruction. IA, wizards and the Tier 1 field components wait for Next.
2. **Fix once, in shared code.** Every theme gets one hook, component or server layer, then a sweep, then a shrink-only ratchet test so it cannot regress.
3. **The server is the authority for invariants.** A client gate stops the common case; the server refuses everything else (scripts, stale tabs, future pages). Invariants run inside the file lock, on the stored data, and fail closed.
4. **A page that failed to load renders no form** — not a disabled form. Retry is in place, never a page reload.
5. **Hand edits on disk are never refused.** The admin API is guarded; the file system stays break-glass.
6. **Every refusal is problem+json with a registry code**, mapped to en+de text on the client.
7. **Tests fail on today's code** and never mock the module they fix.

## 2. Decisions taken

The user answered these on 2026-11-17 (asked with the panel's recommendation first).

| # | Question | Decision | Effect on Now |
|---|---|---|---|
| — | Lockout refusal: absolute, audited override, or client-only? | **Absolute refusal**, no override flag. Existing 403 (last-admin user delete) and 400 (last admin group) codes stay. | PR 2. Local→SSO cut-over: enable SSO, sign in with it as admin, then disable local. Break-glass = edit `platform.json` on disk + restart (documented). |
| 6 | Config writes | **Optional `If-Match` (412) and a scoped `PATCH /api/admin/configs/platform` now.** | PR 3. `If-Match` stays optional; making it required needs another decision. |
| 7 | Remove chat questions / rater names from logs (OB-B4, OB-B28) | **Deferred.** | Not in Now. Only the DPO doc is corrected to state what is logged today (OB-B5). |
| 9 | Admin rate limit | **Migration 100→500 for untouched defaults + per-user keying.** | PR 10, migration `V255` (renumbered from `V254` when main's #3751 took `V254`). Main's #3751 ships `adminApi` at 300 per user (`anonymousLimit` 500); main's value won, so V255 now raises an untouched 100 to that shipped value. |
| 4 | Machine OAuth clients: `[]` = none? | **UI fix + clean server break**: `[]` means no access for client-credentials clients. | PR 9, `breaking-changes.md`. |
| 10 | Secrets in backups | **(a) callout only**; export format unchanged. | PR 5. |
| 12 | Prompt "Linked App" | **Relabel "Opens in app"**, fix docs. | PR 11. |
| 14 | TLS allowlist grants SSRF trust | **(a) show the coupling**; behaviour unchanged. Splitting the lists (b, with a migration) is Next. | PR 9. |
| — | Admin rescue (`ensureFirstUserIsAdmin`) when no admin is left | **Unchanged**: the next OIDC or proxy user to sign in still becomes admin. PR 2's guards keep the admin API from reaching that state. | Documented in "Recover admin access". |
| — | `ADMIN_SECRET` (documented, read by no code) | **Delete the claim** from the docs; a real break-glass is Next. | PR 2. |
| — | Workflow run dialog `message` → `input` | **Clean break**, in `breaking-changes.md`. | PR 7. |
| — | App wizard templates | **List every enabled app**; `allowInheritance` keeps its runtime meaning. | PR 7. |
| — | Admin restyle (indigo primary, gray-500/400 field borders for WCAG 1.4.11) | **Approved.** | PR 6. |

Decisions 1, 2, 3, 5, 8, 11 (beyond the US/"Benutzer"/*Sie* wording used in new copy) and 13 do not touch the Now phase and stay open on #3739.

## 3. The Now increment: eleven draft PRs

One PR per theme; each merges on its own. Waves: 1 = safety (1–3), 2 = guards and dialogs (4–6), 3 = contracts, security hygiene, docs (7–11).

| PR | Branch | Closes | Notes |
|---|---|---|---|
| 1 Load gating | `claude/admin-now-load-gating` | ID-B1 (client), IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5 (+UX-N4), SH-B2, ID-B11 | `useAdminConfigLoad`, `AdminLoadGate`, `AdminLoadError` with in-place Retry and `Retry-After` countdown; `useAdminResourceEditor` returns `loadError`. Auth page has no default config left to post. |
| 2 Lockout and last-admin guards | `claude/admin-now-server-guards` | ID-B1 (server), ID-B2, ID-B3, ID-B4 | `server/utils/authInvariants.js`; 409 codes for lockout, last admin, inherited group; `isLastAdmin` fails closed; `active` must be boolean; isolated safety e2e config. |
| 3 Config writes | `claude/admin-now-config-writes` (stacked on 2) | PL-B4 (incl. the auth page's own `jwkUrl` loss), CU-B3, OB-B10 | One redaction module (`restoreRedacted`, `assertNoMarkers`), `jwkUrl` no longer stripped, omitted secret = keep / `null` = clear; SHA-256 file revision, optional `If-Match` → 412 `PRECONDITION_FAILED`; scoped `PATCH` sharing one writer with POST (same validators, lockout invariant, audit, snapshot) over an allowlist of sections; snapshot reads redacted. |
| 4 Unsaved-changes guards | `claude/admin-now-unsaved-guards` | CU-B4 (rest), AX-B6, OB-B16, PL-B14, IN-B12 (pages), AI-B20, UX-N1, UX-N5 | Hook intercepts `go` and browser Back, ignores same-path query changes, never stacks; `AdminSettingsPage` guards itself and uses `AdminSaveBar`. |
| 5 Named confirmations | `claude/admin-now-confirmations` | PL-B1, PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14, IN-B3 (client), IN-B12 (modals), ID-B15, CU-B24, PL-B2 (callout), UX-N2, UX-N3 | `ConfirmDialog` v2 (consequences, typed token, busy, error, blocked), overlay stack, `Modal isDirty`, `SecretRevealDialog`, ESLint `no-alert` + ratchet at 0. Backup import is staged and typed-confirmed. |
| 6 Visible controls | `claude/admin-now-visual-controls` | AI-B3, ID-B7, ID-B9, CU-B6, PL-B5, PL-B6, SH-B9 (= ID-B8, OB-B17, PL-B19) | Admin-scoped `@layer base` rule on `html[data-surface=admin]`, tokens, `formStyles` retune, shared theme store, pre-paint script, sidebar theme toggle, hygiene ratchet. |
| 7 AI and workflow contracts | `claude/admin-now-contract-ai-workflows` | AI-B1, AI-B4, AI-B6, AX-B2, AX-B3, AX-B4, AX-B5, AX-B10 (display), AX-B11, AX-B12, AX-B20, AX-B32, AX-B1/AX-B21 (hide + doc), AX-B16 | Round-trip test per editor touched. |
| 8 Short links, i18n, integrations, logs | `claude/admin-now-contract-cu-in` | CU-B1, CU-B2, CU-B7, CU-B8, CU-B9, CU-B10, IN-B2, IN-B4, IN-B5, OB-B3 | Subpath e2e for short links. |
| 9 Security hygiene | `claude/admin-now-security-quick-fixes` | ID-B6 (decision 4), PL-B12 (shown, D14a), OB-B13 | Plus `no-store` on secret responses, masked env-override log. |
| 10 Admin rate limit | `claude/admin-now-rate-limit` | PL-B18 (decision 9) | `V255` (was `V254`); per-user key. |
| 11 Honest Overview, docs, ratchet | `claude/admin-now-docs-honesty` | SH-B1, SH-B3, OB-B5, AI-B7, AI-B15, SH-B14 (= OB-B12), IN-B23, CU-B12; translation ratchet for AX-B7, SH-B13, AI-B14, CU-B22 | No translation of the 1,270 missing keys in Now; the ratchet stops growth. |

**Cut from Now:** OB-B4 and OB-B28 (decision 7 deferred); AX-B7 full German (M, needs a translator); the agent scheduler fix (AX-B1 "fix next"); the generic used-by service (only group inheritance and the credential dialog in Now).

**Merge order:** 1 → 2 → 3 first (the P0 path); the rest in any order. All PRs touch `shared/i18n/{en,de}.json` and `docs/releases/next/fixes.md`, so later PRs need a rebase after each merge.

## 4. Shared components, hooks and server layers

| Layer | Where | Used by |
|---|---|---|
| `useAdminConfigLoad`, `AdminLoadGate`, `AdminLoadError` (`onRetry`, `retryAfterSeconds`, `status`) | `client/src/features/admin/` | PR 1, every config page |
| `useUnsavedChanges` v2, `UnsavedChangesDialog`, `useSavedBaseline`, `useDirtyReport`; `AdminSettingsPage` guards itself | `client/src/features/admin/` | PR 4 |
| `ConfirmDialog` v2, `useOverlayStack`, `Modal isDirty`, `SecretRevealDialog` | `client/src/shared/` | PR 5 |
| `useSurface`, theme store, admin tokens, `formStyles` retune | `client/src/shared/`, `client/tailwind.css`, `App.css` | PR 6 |
| `authInvariants.js` (sign-in route, usable admins, fail closed) | `server/utils/` | PR 2, PR 3 (PATCH), rollback, setup |
| `redactedSecrets.js`, `configRevision.js`, one platform writer for POST and PATCH | `server/utils/`, `server/routes/admin/configs.js` | PR 3 |
| `mapProblemErrorsToFields` | `client/src/` | PR 8 (IN-B4), later every editor |
| Registry codes `AUTH_LOCKOUT`, `LAST_ADMIN`, `GROUP_IN_USE`, `PRECONDITION_FAILED` (final names in the PRs) | `shared/apiErrors.js` + `apiErrors.*` en/de | PR 2, PR 3 |

## 5. Test plan

- **Server (jest, supertest):** invariant matrix (local, OIDC, LDAP, proxy, NTLM, inherited admin group, inactive admin, disabled method, env override, evaluator error → refuse); file unchanged on every refusal; concurrent demotion of the last two admins → one wins; inherited group delete; GET→write-back round trip leaves `platform.json` identical (fails today on `jwkUrl`); If-Match fresh/stale/absent/`*`; PATCH allowlist and secret rules; migration `V254` both cases; rate-limit keying; `[]` = none for machine clients.
- **Client (jest + RTL):** load hook states and stale responses; auth page after a failed load has no Save, no fields, no "All valid"; real-router unsaved-guard hook (push, replace, `go(-1)`, POP, same-path, markSaved-then-navigate); `ConfirmDialog` naming, focus, typed token, unique ids; backup import sends nothing before confirm; round-trip per editor touched.
- **Ratchets (shrink-only baselines):** load-gate coverage, unsaved-guard coverage, native dialogs (0), admin class hygiene, missing translation keys.
- **E2E (Playwright):** load gating (`page.route().fulfill(429)`, no write after clicking everything), unsaved guards, confirmations (intercepted writes, no native dialogs), visible controls in light/dark/auto-dark with computed contrast; destructive guards in an isolated config (`playwright.admin-safety.config.js`, own contents dir and ports, `workers: 1`, `retries: 0`); subpath (`/ihub`) for docs deep links and short links.
- **Manual walk:** every changed flow against a running production build at `/` and `/ihub/`, screenshots in the PRs.

## 6. Docs plan

- Each PR updates the topic page it changes (`admin-ui.md` sections: When a page can't load, Unsaved changes, Confirmations, Backup import) and adds one `docs/releases/next/` entry via `document-feature`; script-visible changes (new 409s, `[]` for machine clients) go to `breaking-changes.md` with route, condition, status and code.
- PR 11 fixes harmful docs by harm: compliance (`pii-data-handling.md`: uploads are stored; what is logged today), wrong outcomes (`prompts.md`, `apps.md`, `AUTHENTICATION_QUICK_START.md`, `troubleshooting.md`, `GETTING_STARTED.md`), wrong in-product pointers; it qualifies "You do not need to edit JSON files".
- PR 2 adds "Recover admin access" and removes the stale `ADMIN_SECRET` claim.
- Next: docs wave 1 and the `admin-ui.md` map (README "Documentation plan").

## 7. Risks and mitigations (merged pre-mortems)

| Risk | Mitigation |
|---|---|
| Lockout guard blocks a legitimate SSO cut-over, or misses an OIDC-mapping-only admin | Route-based check of the *caller* plus "some admin can still sign in"; refusal text names the safe order; fixtures for mapping-only, proxy, NTLM; break-glass doc. |
| Guard fails open, or runs outside the lock (TOCTOU) | Invariants run inside `updateJson`/`updatePlatform`; evaluation errors refuse; concurrency test. |
| A new writer (rollback, setup, PATCH) bypasses the invariants | One writer for POST and PATCH; rollback and setup call the same check; test enumerates platform writers. |
| PATCH reopens sections with their own validated routes (`ssl`, `ssrf`, `cors`, `rateLimit`, `proxy`, `logging`) | Allowlist; unknown or excluded keys → 400; one test per excluded section. |
| Redaction merge keeps a secret the admin meant to clear | Omitted/marker = keep, explicit `null` = clear; test per secret field. |
| If-Match false 412 after a save (lazy encryption changes the file) | Revision computed after the write and returned as `ETag`; client stores it from the response; e2e saves twice. |
| Load gating makes 429s a wall of errors behind NAT | Decision 9 (PR 10), Retry with `Retry-After` countdown, optional sources never gate. |
| Unsaved guard nags on tabs or after load; Back button traps | Same-path passthrough; baseline taken after load normalisation; one guard per navigator; POP failure falls back to allowing navigation; tests for each. |
| Admin restyle leaks into the end-user chat (test panel embeds it) | Scope on `html[data-surface=admin]`, `data-surface=app` opt-out, `:where()` keeps end-user specificity; e2e checks the attribute is gone after leaving the admin. |
| Pre-paint script fights embed mode | Script skips `embed`/`mode`; parity unit test. |
| Scripts break on new 409s, `[]` semantics, or the rate-limit migration overwrites a tuned value | `breaking-changes.md` table; migration touches only exact shipped values and logs skips. |
| i18n gaps in the new safety dialogs | en+de in the same PR; translation ratchet; *Sie*, „…", "Benutzer". |
| Docs drift (`admin-ui.md` promises more than the code) | Each PR edits the sentence it makes true; ratchet tests name the remaining gaps. |
| Destructive e2e locks out the shared CI instance | Isolated safety config, own contents and ports, `reuseExistingServer: false`. |
| Parallel PRs conflict (i18n, `fixes.md`, `Modal`) | Merge order above; rebase after each merge; migration number `V254` reserved for PR 10 (taken by main's #3751 in the end; PR 10 is `V255`). |
| Scope creep turns S rows into M | Fixed ID list per PR; new findings go to #3739, not into the PR. |

## 8. New defects found by the panel and the implementers

Not in the November review; triaged into Now where they sit on the same code path, otherwise Next.

| Finding | Source | Where |
|---|---|---|
| ID-B1 also turns **anonymous access on** (page defaults) | Admin | PR 1 removes the defaults |
| Every `/admin/auth` save erases proxy-JWT `jwkUrl` | Admin, security | PR 3 |
| `isLastAdmin` reads outside the lock, ignores inheritance and fails open | Security, QE | PR 2 |
| Losing the last admin route lets `ensureFirstUserIsAdmin` promote the next OIDC/proxy user | Security, admin | PR 2 prevents reaching the state through the API; the rescue rule itself → Next (needs a decision) |
| `active: "false"` is stored and read as active | Security | PR 2 |
| Group cache freeze means revocations silently stop applying | Security | PR 2 |
| Change-history snapshots return `jwtSecret` in plain text | Security | PR 3 |
| `configOverrides.js` logs `IHUB_PLATFORM__*` values (secrets) at `info` | Security | PR 9 |
| No `Cache-Control: no-store` on secret-bearing responses | Security | PR 9 |
| OTLP exporter headers stored and returned in clear | Security | Next |
| Group changes may only apply at token expiry (`jwtAuth` uses token groups) | Security | Next: verify, then fix |
| `ADMIN_SECRET` documented but read by no code | Admin | PR 2 docs |
| Backups carry no iHub version; restoring a newer backup half-migrates | Admin | Next (restore wizard WZ-22) |
| UX-N1 tab switch on `/admin/ui` opens the leave dialog; UX-N2 one Escape closes two dialogs; UX-N3 duplicate dialog ids; UX-N4 `/admin/ui` load error dead end; UX-N5 `AdminSettingsPage` English-only save bar | UX | PRs 1, 4, 5 |
| An unlayered global dark-input rule overrides admin `dark:` classes and red error borders | UI | PR 6 |
| `INPUT_CLASS` itself fails WCAG 1.4.11 (1.47:1) | UI | PR 6 |
| Switching tabs on an integration's Settings and on Usage Reports → Limits drops edits without asking | Implementer (PR 4) | Next |
| Many admin pages use keys missing from `en.json` (English fallback only) | Implementer (PR 5), TW | Ratchet in PR 11; fill-in → Next |
| `NodeConfigPanel.jsx` (workflows) still uses `window.confirm` | Implementer (PR 5) | Next |

## 9. Open questions (not asked; panel defaults applied)

| Question | Default used |
|---|---|
| Self-demotion when another admin exists? | Allowed; self-deactivate and self-delete always refused. |
| Platform rollback after a secret rotation: restore the old secret or keep the current? | Keep the current secret. |
| Who scripts against the admin API (user PUT, platform POST, OAuth client create)? | Assume some on-prem customers do; every contract change in `breaking-changes.md`. |
| Is a DPIA based on `pii-data-handling.md` already with customers? | Changelog bullet plus a note asking support to inform known DPO contacts. |
| German copy owner for 1,270 missing keys? | Not in Now; one German reviewer per area PR in Next. |
| Should `docs/` say it is English-only? | One line in `docs/README.md`. |
| Data router migration (`useBlocker`)? | Not now; the hook keeps the navigator patch with POP handling. |
| Should the admin have its own theme preference? | Shared with the end-user app. |
| Backup import token | `window.location.host`. |
| Cross-browser runs for safety e2e? | Chromium only. |

## 10. Choices made without asking

- Eleven themed PRs instead of one per roadmap row; PR 3 stacked on PR 2 because both edit the platform writer.
- New refusals use 409 with new registry codes; `If-Match` mismatch uses 412 with a new code, not the storage `ETAG_MISMATCH` (409).
- Revision = SHA-256 of the stored file, compared under the lock; not the cache ETag.
- `jwkUrl` is shown (URL secrets masked) instead of stripped; it is not a secret.
- Client-only confirmation is acceptable for backup import (accident threat, pre-import copy kept); not for lockout or last admin.
- Hiding the agent schedule field must round-trip an existing `schedule`.
- Ratchets are unit tests with baseline files, following `known-routes-sync` and the a11y `KNOWN_VIOLATIONS` pattern.
- New German copy uses *Sie*, „…" and "Benutzer"; US English.
- Safety e2e runs against its own contents dir and ports; simulated failures use `route.fulfill`, never real 429s.

## 11. Next and Later

Planned on the sub-epics, not built in this increment:

- **Next:** config resource completion (audit diffs and a platform history view on redacted snapshots, OB-B6); used-by and invariant service (AI-B12, AX-B13, CU-B14, ID-B12, IN-PM3); Tier 1–2 components (`AdminField`/`AdminInput`/`AdminButton`, `AdminPageHeader`, `AdminPage` frame); round-trip tests and referential validation for every editor; access explainer (ID-PM1); IA step 1–2; Setup progress / Needs attention and one shell call; wizards WZ-1, 2, 3, 7, 21, 22; docs wave 1 and the `admin-ui.md` map; AX-B7 German; agent scheduler; decision 14 (b) migration; decision 10 (c) backup format; group changes at token expiry; OTLP header secrets; the remaining borderless fields (ratchet to zero).
- **Later:** Governance & privacy hub and WZ-20 (with decision 7 and 8), branding drafts, one-page workflow editor, OIDC and service-client wizards, admin roles (decision 5), item-level audience (decisions 1–2), fields for every JSON-only setting.
