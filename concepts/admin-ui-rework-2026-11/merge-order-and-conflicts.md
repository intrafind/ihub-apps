# Merge order and conflict resolutions (Now PRs)

Recorded from a local integration of all eleven Now branches on top of `main` (2026-11-17). Merge the PRs in this order and resolve the same way: #3767 (server guards), #3769 (config writes, stacked on #3767), #3757 (load gating), #3758 (unsaved guards), #3759 (confirmations), #3760 (visual controls), #3762 (docs honesty), #3761 (rate limit), #3763 (contract CU/IN), #3764 (contract AI/workflows), #3765 (security quick fixes).

**Watch out:** where load gating replaced a page's load effect, the unsaved-guard baseline must be set in the gate's `onLoad` callback. A clean auto-merge can silently leave the leave-guard off (seen on `AdminVoiceInputPage`); check every page listed in section 4.


Branch `local/admin-now-integration` (local only), base `origin/main`. Merge order:
server-guards, config-writes, load-gating, unsaved-guards, confirmations, visual-controls,
docs-honesty, rate-limit, contract-cu-in, contract-ai-workflows, security-quick-fixes.

server-guards and config-writes merged cleanly.

`docs/releases/next/*.md`: every conflict there is two branches appending sections at the end of
the same file. Resolved as a union, HEAD's sections first, then the incoming branch's, separated
by one blank line. No text was edited.

## 3. load-gating

### client/src/features/admin/pages/AdminAuthPage.jsx
- **Imports hunk:** HEAD (server-guards) added `apiErrorMessage`; load-gating added
  `useAdminConfigLoad` + `useUnsavedChanges`. Kept all three imports.
- **Save-error hunk (`catch` in `handleSave`):** server-guards localizes lockout refusals through
  `apiErrorMessage(error, t, getAdminApiErrorMessage(error))`; load-gating moved the sentence into
  `t('admin.auth.saveFailed', 'Failed to save configuration: {{error}}', { error })`. Kept
  load-gating's i18n key, with `error: apiErrorMessage(error, t, getAdminApiErrorMessage(error))`
  so an AUTH_LOCKOUT refusal is still shown in the admin's language.
- **Message banner hunk:** load-gating wrapped banner + DualModeEditor in `<AdminLoadGate>{() => (...)}`;
  server-guards added `role=alert|status` (already in load-gating) and
  `data-testid="admin-auth-message"` on the banner. Took load-gating's structure and added the
  `data-testid` to its banner div.

### client/src/features/admin/pages/AdminUserEditPage.jsx
- **`loadResource` hunk:** load-gating removed the `try/catch` that rewrapped the error as
  `new Error(getAdminApiErrorMessage(err))` (so the load gate sees status/Retry-After);
  server-guards added `loadedUserRef.current = userData` (so `active` is sent only when changed).
  Kept load-gating's un-wrapped body and added `loadedUserRef.current = userData;` before the
  `return`. `getAdminApiErrorMessage` is still imported (used elsewhere in the file).

## 4. unsaved-guards (conflicts with load-gating; not in the original brief)

Pattern in all of them: load-gating replaced each page's/card's `useEffect` fetch with
`useAdminConfigLoad({ sources: { x: { load, onLoad } } })` (+ `AdminLoadGate`); unsaved-guards
kept the old `useEffect` fetch and added a "saved" snapshot set on load (`setSavedConfig(loaded)`,
`setSavedHosts`, `setSavedForm`, `setHasLoaded(true)` or `captureBaseline()`) plus
`useDirtyReport` / `useUnsavedChanges` / `UnsavedChangesDialog`.
**Rule used everywhere: keep load-gating's loader; move unsaved-guards' "snapshot on load" call
into the loader's `onLoad` (or `applyStatus`); union the imports.** If the snapshot call is lost,
the guard silently never fires (baseline stays `null` = "not loaded").

- `client/src/shared/components/AdminEditPageShell.jsx`: imports: kept load-gating's
  `AdminLoadError` + `useRetryCountdown` and `useTranslation` (still used by the load-error branch),
  dropped `ConfirmDialog` (unsaved-guards replaced it with `UnsavedChangesDialog`). Body hunk: kept
  `const { t } = useTranslation(); const retryAfterSeconds = useRetryCountdown(loadError);`.
- `components/CookieSettingsConfig.jsx`, `CorsConfig.jsx`, `SSLConfig.jsx`: imports union
  (`AdminLoadGate`, `useAdminConfigLoad`, `useDirtyReport`); load hunk = load-gating's
  `useAdminConfigLoad`, with `onLoad` building `const loaded = {...}` and calling
  `setConfig(loaded); setSavedConfig(loaded);`. Cookie: also kept unsaved-guards'
  `savedConfig` state + `useDirtyReport(savedConfig, config, onDirtyChange)` (they were inside
  the hunk). Dropped unsaved-guards' `loading` state (the gate owns loading).
- `components/SsrfConfig.jsx`: same; `onLoad` → `setAllowedHosts(loaded); setSavedHosts(loaded);`.
- `components/ToolApprovalConfig.jsx`: same; kept `savedForm` + `useDirtyReport`, `onLoad` →
  `setForm(loaded); setSavedForm(loaded);`.
- `components/ProxyConfig.jsx`, `RateLimitConfig.jsx`: import hunk only (union). Their
  `applyResponse` / `apply` (which load-gating passes as `onLoad`) already set the saved copy.
- `pages/AdminBrowserExtensionPage.jsx`, `AdminCopilotAgentPage.jsx`,
  `AdminOfficeIntegrationPage.jsx`, `AdminNextcloudEmbedPage.jsx`: load-gating extracted
  `applyStatus(data)` (used both as the gate's `onLoad` and by the post-save `loadStatus()`
  reload); unsaved-guards inlined the setters + `captureBaseline()` in `loadStatus`. Kept
  `applyStatus(await fetchStatus())` and appended `captureBaseline()` at the end of `applyStatus`,
  so the first gated load and every reload capture the baseline. React import:
  `{ useMemo, useState }` (unsaved-guards needs `useMemo`; `useEffect` no longer used).
- `pages/AdminFeedbackPage.jsx`: imports union; kept `settingsLoad = useAdminConfigLoad(...)`,
  added `setHasLoaded(true)` after `setDraft(next)` in its `onLoad`.
- `pages/AdminTelemetryPage.jsx`: imports union; `onLoad: platform => { const loaded =
  deepMerge(DEFAULT_TELEMETRY, platform.telemetry || {}); setConfig(loaded); setSavedConfig(loaded); }`.
- `pages/AdminMcpGatewayPage.jsx`: imports union; `onLoad: data => { setPlatform(data);
  setSavedPlatform(data); }`; JSX tail: kept load-gating's `)}` closing the ready branch and
  added `<UnsavedChangesDialog blocker={blocker} />` after it.
- `pages/AdminLoggingPage.jsx`: imports union; load hunk: kept load-gating's three-source
  loader (logging, platform, audit). unsaved-guards called `captureBaseline()` at the end of its
  sequential load; with three parallel `onLoad`s there is no single "end", so added after
  `useSavedBaseline`: `useEffect(() => { if (ready) captureBaseline(); }, [ready, captureBaseline]);`
  (`useAdminConfigLoad` runs every `onLoad` in the render that flips status to ready).
- i18n `shared/i18n/{en,de}.json`: both added sibling objects under `admin` (`load`,
  `browserExtension`, `cors` vs `settingsPage`): kept all, valid JSON, no duplicate keys.

### Auto-merged but semantically broken (fixed)
- `pages/AdminVoiceInputPage.jsx`: unsaved-guards added `hasLoaded` (guard off until loaded) and
  sets it in `fetchSpeech()`, but load-gating's first load goes through `useAdminConfigLoad`'s
  `onLoad`, which did not set it, so the guard never armed until after a save. Added
  `setHasLoaded(true)` to that `onLoad`.

## 5. confirmations

- `client/src/shared/components/ConfirmDialog.jsx` (vs server-guards):
  - JSDoc hunk: took confirmations' full prop docs and re-added server-guards' `hideConfirm` line.
  - Footer-buttons hunk: server-guards added `hideConfirm` (only the deny button, labelled
    `denyLabel`; used by `AdminGroupsPage` for a refused group delete, with `denyLabel=Close`);
    confirmations added `blocked={{reason}}` (reason + a single Close button) and the
    busy/typed-confirmation confirm button (`handleConfirm`, `aria-disabled`, spinner). Took
    confirmations' buttons; the confirm button renders only when `!blocked && !hideConfirm`.
    Deny label stays `blocked ? Close : denyLabel || Cancel`. `hideConfirm = false` is still in the
    props destructuring (auto-merged). Follow-up for the authors: `AdminGroupsPage` could move
    to `blocked={{ reason }}` and `hideConfirm` could then go.
- `components/integrations/IntegrationInstallForm.jsx` React import: `use` (unsaved-guards) +
  `useRef` (confirmations) → `{ use, useEffect, useMemo, useRef, useState }`.
- `pages/AdminCredentialsPage.jsx`: imports union; state hunk union (unsaved-guards'
  `formBaseline` + `useUnsavedChanges`, then confirmations' `useConfirmAction`, `headingRef`,
  `checkingId`/`checkingRef`); JSX tail: both `<UnsavedChangesDialog blocker={blocker} />` and
  `<ConfirmDialog {...confirmDialogProps} />`.
- `pages/AdminOAuthClientEditPage.jsx`: import union (`UnsavedChangesDialog` + `SecretRevealDialog`).
- `pages/AdminScheduledTasksPage.jsx`: imports union; JSX tail keeps both dialogs.
- `pages/AdminSkillEditPage.jsx`, `pages/AdminWorkflowEditPage.jsx`: imports union; JSX tail:
  unsaved-guards' `<UnsavedChangesDialog blocker={blocker} />` replaces the inline blocker
  `ConfirmDialog` that confirmations still carried (it had hard-coded English strings), plus
  confirmations' `<ConfirmDialog {...confirmDialogProps} />`. unsaved-guards had dropped the
  `ConfirmDialog` import, so it is re-added (integration-only breakage: `ConfirmDialog` not
  defined at runtime).
- `pages/AdminOfficeIntegrationPage.jsx`: imports union (`useUnsavedChanges`,
  `UnsavedChangesDialog`, `useSavedBaseline`, `ConfirmDialog`); JSX tail keeps both dialogs.
  `handleRegenerateAddinId` hunk: load-gating had `if (!ready) return;` before main's
  `window.confirm(...)`; confirmations replaced `window.confirm` with a ConfirmDialog that calls
  this handler. Result: `setConfirmingRegenerate(false); if (!ready) return;`.
- `docs/releases/next/fixes.md`, i18n: union.

## 6. visual-controls

visual-controls only changes classes (`formStyles` constants `INPUT_CLASS`, `CHECKBOX_CLASS`, …,
`border-admin-control-border`, `text-admin-accent`) and adds the `formStyles` import.

- `components/UserFormEditor.jsx` (vs server-guards), "Enabled" checkbox hunk: kept
  server-guards' logic (`checked={user.active !== false}`, `disabled={isSelf && user.active !== false}`,
  `aria-describedby` self hint, `onChange` sets only `active`, so a save no longer re-enables a
  deactivated account) with visual-controls' class: `` className={`${CHECKBOX_CLASS} disabled:opacity-50`} ``.
  Dropped visual-controls' side of the logic (`enabled && active`, onChange setting both), which
  was just main's old behaviour.
- `components/CookieSettingsConfig.jsx`, `components/ToolApprovalConfig.jsx` (vs load-gating):
  imports union; loading hunk: kept `<AdminLoadGate … loadingFallback={…}/>` and gave the
  fallback spinner visual-controls' class `text-admin-accent dark:text-admin-accent-fg-dark`.
- `components/TranslationOverridesEditor.jsx`, `components/tts/TtsVoicesPanel.jsx`,
  `pages/AdminLocalizationPage.jsx`: import-only hunks, union.
- `pages/AdminBackupPage.jsx` (vs confirmations): confirmations replaced the hidden file input +
  button with `<UploadConfigButton onChange={handleFileChosen} …/>` (the typed host-name import
  step). Kept that; visual-controls' only change there (a dark-mode spinner colour) is moot.
- `pages/AdminLoggingPage.jsx`, `AdminMcpGatewayPage.jsx`, `AdminTelemetryPage.jsx`,
  `AdminVoiceInputPage.jsx`, `AdminPageEditPage.jsx`, `AdminProviderCreatePage.jsx`,
  `AdminShortLinkEditPage.jsx`: the hunks are load-gating/unsaved-guards re-indenting whole JSX
  blocks (wrapping them in the gate) vs visual-controls changing `className`s inside them.
  Resolved by taking HEAD's file and replaying visual-controls' line edits (merge-base →
  visual-controls) onto it by content, re-indented (script: scratchpad `integ/replay.py`). All
  edits applied (numstat matches); the `formStyles` import in PageEdit/ShortLinkEdit was
  re-added by hand because its anchor line (`ConfirmDialog` import) was gone on HEAD.

## 7. docs-honesty

- `pages/AdminOverview.jsx` (vs load-gating): import hunk union (`useRetryCountdown` +
  `useSetupChecklist`). The rest auto-merged and fits: load-gating's `loadErrorBanner` (failed apps
  request = error with Retry) and docs-honesty's server-driven `useSetupChecklist` (shown while a
  required step is open, independent of `isFreshInstance`) are independent.
- `pages/AdminPageEditPage.jsx` (vs visual-controls): allowed-groups input: docs-honesty's
  `placeholder={t('admin.pages.fields.allowedGroupsPlaceholder', 'admins, users or *')}` +
  `aria-describedby="page-allowed-groups-help"` with visual-controls' `` className={`${INPUT_CLASS} mt-1 block`} ``.
- `docs/admin-ui.md` (vs load-gating), Overview checklist paragraph: took docs-honesty's
  rewritten "Getting started checklist" section and appended load-gating's sentence ("If the list
  of apps could not be loaded, the dashboard says so and offers **Retry** instead; it never takes a
  failed request for a fresh installation.").
- `shared/i18n/{en,de}.json`: textual union failed (both sides added an `admin.pages` object, and
  `de` had nested `step1..4` collisions), so merged semantically: ours + (theirs − merge-base),
  new keys inserted after their predecessor (scratchpad `integ/json3.py`). No value conflicts.
  Note: docs-honesty switches remaining German texts to formal "Sie"; that is intended and kept.

## 8. rate-limit

Only `docs/releases/next/features.md` (union).

## 9. contract-cu-in

- `components/integrations/IntegrationInstallForm.jsx`: import union (`DirtyReportContext,
  useDirtyReport` + `apiErrorMessage` + `mapProblemErrorsToFields`).
- `pages/AdminLoggingPage.jsx` (vs load-gating/unsaved-guards/visual-controls re-indent):
  contract-cu-in moved the inline `availableComponents` list to `utils/logComponents.js`
  (`LOG_COMPONENTS` with i18n `nameKey`/`descriptionKey`) and fixed the component-filter help
  text. Took HEAD and replayed contract-cu-in's 7 edits onto it (`integ/replay.py`; all applied).
- `pages/AdminShortLinkEditPage.jsx`: import hunk union (contract-cu-in's `getBasePath`,
  `shortLinkTargetPath` helpers, `parseParams`, `editableShortLink`), but **not** its
  `ConfirmDialog` import: contract-cu-in still used it for the unsaved-changes blocker, which
  unsaved-guards replaced with `<UnsavedChangesDialog>` (unused import otherwise). Two input
  hunks: contract-cu-in's `aria-describedby={paramsLeftOut ? 'shortlink-params-left-out' : undefined}`
  + visual-controls' `className={CHECKBOX_CLASS}` / `` `${INPUT_CLASS} mt-1 block font-mono` ``.
- fixes.md / i18n: union / semantic merge.

## 10. contract-ai-workflows

- `features/workflows/editor/WorkflowEditor.jsx` + `pages/WorkflowEditorPage.jsx` (vs
  unsaved-guards): contract-ai-workflows removed Publish (`onPublish`, `handlePublish`, the
  button; AX-B11); unsaved-guards added `onFlowChange` to both signatures and the JSX pass-through.
  Kept `onFlowChange` everywhere, dropped `onPublish` everywhere (JSDoc, both function
  signatures, `<WorkflowEditorInner onFlowChange>` and `<WorkflowEditor onFlowChange={handleFlowChange}>`).
- `pages/AdminAgentEditPage.jsx`:
  - Form/JSON toggle button (vs visual-controls): contract's `disabled={mode === 'json' && !jsonValid}`
    with visual-controls' dark-mode class, plus `disabled:opacity-50` (from contract's class).
  - Schedule section (vs visual-controls class change): removed, as contract-ai-workflows intends
    (agent schedules are not run, AX-B1).
  - HITL approver groups and service-account groups (vs visual-controls class change): took
    contract's `<GroupMultiSelect … commitOnBlur>` replacing the comma-split text inputs.
- `pages/AdminWorkflowsPage.jsx` (vs confirmations): imports union (`ConfirmDialog`,
  `useConfirmAction`, `deleteConfirmText` + `groupsGrantingWorkflow`); state union (`actionError`,
  `useConfirmAction` + `groups`).
- fixes.md, breaking-changes.md: union; i18n: semantic merge.

## 11. security-quick-fixes

- `server/utils/httpConfig.js` (vs config-writes): both moved `redactUrlSecrets` out of
  httpConfig. config-writes → `server/utils/urlSecrets.js` (imported by `redactedSecrets.js`),
  security → `server/utils/secretNames.js` (imported by `configOverrides.js`; its version also
  masks **every** `user:pass@` with `/g`, the security fix). Kept **one implementation, in
  `secretNames.js`** (dependency-free and has the fix). `urlSecrets.js` is now only
  `export { redactUrlSecrets } from './secretNames.js';`. In httpConfig: dropped the
  `import … from './urlSecrets.js'` line, kept `import { redactUrlSecrets } from './secretNames.js'`
  and the `export { redactUrlSecrets };` re-export; merged the two comments into one. Every
  import (httpConfig, urlSecrets, secretNames) still resolves.
- `components/SSLConfig.jsx`: imports union (`AdminLoadGate`, `useAdminConfigLoad`,
  `useDirtyReport` + `announceSslConfigSaved`); save hunk: both `setSavedConfig(config);` and
  `announceSslConfigSaved();`; whitelist JSX hunk: took security's version (whitelist shown
  whether or not invalid certs are ignored, so the `ignoreInvalidCertificates &&` wrapper is gone
  and the block dedented) and put visual-controls' input class
  (`border-admin-control-border …`) back on the domain input.
- `components/SsrfConfig.jsx`: imports union (+ `useEffect`); state union (`savedHosts` +
  `useDirtyReport` and `tlsTrustedHosts`). Load hunk: security added `fetchTlsWhitelist` +
  `SSL_CONFIG_SAVED_EVENT` listener inside the old `useEffect` fetch, which load-gating replaced.
  Kept load-gating's gate for the SSRF config and added a separate `useEffect` (deps `[]`) that
  loads `/admin/ssl/config` and subscribes to `SSL_CONFIG_SAVED_EVENT`. It is deliberately not a
  gate source: the TLS list is informational, so its failure must not hide the card.
- `pages/AdminOAuthClientEditPage.jsx`: import union (`UnsavedChangesDialog`,
  `SecretRevealDialog` + `oauthClientGrants` helpers).
- fixes/features/breaking-changes.md: union.

## 12. Integration-only fixes after all merges (commit "fix: integration-only breakage …")

Found by `npx jest --config tests/config/jest.config.js tests/unit/client` (7 suites / 9 tests
failed before; 469/469 suites, 6231 tests pass after). None of these fail on their own branch.

- `client/src/features/admin/components/AdminLoadError.jsx` (load-gating) vs visual-controls'
  class-hygiene ratchet (`borderlessBorderColor`): the colour strings sat in a ternary and the
  `border` width outside it. Moved `border` into each branch string. Visual result unchanged.
- `client/src/features/admin/components/StyleEditor.jsx`: confirmations' new "add variable"
  name/value inputs used `border-gray-300 dark:border-gray-600` → visual-controls' ratchet
  `lowContrastFieldBorder`. Switched both to `border-admin-control-border
  dark:border-admin-control-border-dark`.
- `client/src/features/admin/pages/AdminAuthPage.jsx`: load-gating's inline blocker
  `ConfirmDialog` used `admin.unsavedChanges.leave`, which is not in en/de (translation-keys
  test from docs-honesty). Replaced with unsaved-guards' shared `<UnsavedChangesDialog blocker>`
  (as every other admin editor now uses); dropped the `ConfirmDialog` import.
  Test `admin-auth-page-load-failure.test.jsx` (load-gating) updated: dialog text is now
  "Your changes will be lost."; the R1 helper `methodCheckbox` now uses
  `getByRole('checkbox', { name })` because visual-controls changed the auth-method row markup
  (`.flex.items-start` is gone).
- `tests/unit/client/admin-unsaved-guard-coverage.test.jsx` (unsaved-guards): removed
  `AdminAuthPage.jsx` from the shrink-only BASELINE (load-gating guards it now).
- `tests/unit/client/translation-keys-baseline.json` (docs-honesty): removed 48 keys (and the
  `AdminAuthPage.jsx` entry) that other branches added to en/de; the baseline is shrink-only and
  failed on "listed key no longer missing".
- `tests/unit/client/admin-overview-setup-checklist.test.jsx` (docs-honesty): AdminOverview now
  imports load-gating's `AdminLoadError` → `Icon` → `runtimeBasePath` (`import.meta`), which Jest
  on Node 22 cannot require. Added the same `Icon` mock `admin-overview-disk-space-row.test.jsx`
  uses.
- `tests/unit/client/admin-oauth-create-secret.test.jsx` (confirmations) vs security-quick-fixes:
  security made the create response the client itself (no `{ client }` envelope) and refuses a
  client-credentials client without any grant. Test now mocks `{ clientId, clientSecret }` and
  its ResourceSelector stand-in can grant `['*']`, which the test clicks before submitting.
- `tests/unit/client/admin-oauth-client-least-privilege.test.jsx` (security) vs confirmations:
  the secret is now shown in `SecretRevealDialog`'s read-only textbox, so
  `getByText('shown-once-secret')` → `getByDisplayValue('shown-once-secret')`.

## 13. Catch-up merges (branches moved during the integration)

Other sessions pushed to three branches while this integration ran (shared .git). Merged their
new heads on top, same order:

- server-guards 03645a061 → 134f449f2: clean.
- config-writes 53173d1a6 → edd40005b (incl. 31b67d585 "address review of config writes (R1-R10)
  and CI", which also fixes `server/tests/adminUiRoutesErrors.test.js`; at 53173d1a6 that test
  failed with 500 because `routes/admin/ui.js` already used `configStore.updateJson` but the test
  mock had only `writeJson`).
  Conflict `server/utils/urlSecrets.js`: config-writes now gives `redactUrlSecrets` a broader
  `SECRET_QUERY_PARAMS` list (Azure `code`/`sig`/`subscription-key`, AWS `X-Amz-*`, `auth`,
  refresh/id/session tokens). Kept ONE implementation in `server/utils/secretNames.js`, which now
  has config-writes' `SECRET_QUERY_PARAMS` **and** security's `/g` userinfo masking;
  `urlSecrets.js` stays a re-export. **Authors: when both PRs land, `secretNames.js` must get
  config-writes' parameter list.**
- confirmations 0099ad777 → da4788991: conflict `client/src/shared/components/ConfirmDialog.jsx`,
  JSDoc + props destructuring: kept both new props, server-guards' `hideConfirm = false` and
  confirmations' `zIndexClassName = 'z-50'`.
