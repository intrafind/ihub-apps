# Named confirmations, no native dialogs — implementation notes

Date: 2026-11-16. Branch `claude/admin-now-confirmations` (epic #3739, "Now" row 5).
Findings: PL-B1, PL-B2 (callout only), PL-B7, PL-B8, OB-B7, OB-B8, AI-B2, AI-B12, AX-B14,
IN-B3 (client part), IN-B12 (Modal part), ID-B15, CU-B24, UX-N2, UX-N3.

This note tells the next person where things are and which rules to keep.

## Building blocks

| Piece | File | What it does |
| --- | --- | --- |
| Overlay stack | `client/src/shared/hooks/useOverlayStack.js` | One window `keydown` listener; Escape goes to the topmost open overlay only (UX-N2). `Modal`, `ConfirmDialog` and `SecretRevealDialog` register with an Escape handler; `Drawer` registers without one and checks `isTop()`. |
| `ConfirmDialog` v2 | `client/src/shared/components/ConfirmDialog.jsx` | Additive props: `consequences`, `irreversible`, `typedConfirmation { token, label }`, `busy`, `error`, `blocked { reason }`, `busyLabel`. Ids from `useId` (UX-N3). Mounted only while open, so typed text never carries over. Uses Heroicons directly (not `Icon`), so every Modal does not pull in `runtimeBasePath`. |
| `Modal` `isDirty` | `client/src/shared/components/Modal.jsx` | `isDirty` + `dirtyTitle`: Escape and `requestClose` (render-prop child `({ requestClose }) => …`) ask "Discard changes?"; backdrop click does nothing while dirty. Unchanged when not dirty. |
| `SecretRevealDialog` | `client/src/shared/components/SecretRevealDialog.jsx` | Read-only monospace field, Copy, "only time shown", Done; warns once when closed without copying. The secret lives only in the caller's state and is dropped on `onDone`. |
| `useConfirmAction` | `client/src/features/admin/hooks/useConfirmAction.js` | `requestConfirm({ title, message, …, action })` + `<ConfirmDialog {...dialogProps} />`. Runs the async action with `busy`; on error keeps the dialog open with the message (`apiErrorMessage`, or `errorMessage(err)`). |
| Text helpers | `client/src/features/admin/utils/confirmText.js` | `deleteConfirmText({ typeKey, name, t })` → `Delete {type} "{name}"?` + "Delete" button; `namedList(names, t)` → five names + "and N more". |
| Bulk toggle text | `client/src/features/admin/utils/bulkToggleConfirm.js` | Count + names for Enable/Disable All; `blocked` when nothing would change. |
| Credential usage | `client/src/features/admin/utils/credentialUsage.js` | Installations whose `auth.credentialRef` or any stored value equals the credential id (IN-B3, client only; the server still does not refuse). |
| Shipped registries | `client/src/features/admin/utils/shippedRegistries.js` | Ids from `server/defaults/config/registries.json`; a test keeps them in sync. Shipped → type-to-confirm with the registry id. |
| Status line | `client/src/features/admin/components/AdminStatusNotice.jsx` | Polite success message instead of `alert()`. |

## Rules (keep them)

- Title names type + item; confirm button is a verb; Cancel has initial focus (or the typed field).
- Type-to-confirm only for whole-system replacement or no-restore deletes. Tokens are ids or the
  host name, never translated words. Exact match after trim, case-sensitive; paste allowed.
- No `window.alert/confirm/prompt` in `client/src/features/admin` and `client/src/shared`:
  ESLint `no-alert: error` (eslint.config.js) and the ratchet
  `tests/unit/client/admin-no-native-dialogs.test.jsx` (count must stay 0).
- Copy that states a consequence must match the server: Disable All on Models clears `default`
  on every model (`server/routes/admin/models.js`, `_toggle`), and `ensureStoredDefault` later
  promotes the first enabled chat model. Force refresh takes effect when iHub is next loaded
  (`client/src/utils/forceRefresh.js` runs at startup). Backup keeps 3 pre-import copies
  (`IMPORT_BACKUPS_TO_KEEP` in `server/routes/admin/backup.js`).

## Flows changed

Backup import (choose → tier-3 dialog → `POST /admin/backup/_import`), Enable/Disable All on
Apps/Models/Prompts, deletes on Apps/Models/Prompts/Providers/Skills/Workflows/Registries/Assets/
Credentials/TTS voices/scheduled tasks, Force client refresh, tracking mode, audit cleanup,
OAuth secret rotation, add-in ID regeneration, integration connections (disconnect/reset),
DualModeEditor mode switch/reset, MemoryEditor clear, StyleEditor "Add variable" (inline form),
page ID and redirect URI validation (inline errors).

## Not done here (follow-ups)

- `client/src/features/workflows/editor/panels/NodeConfigPanel.jsx` still calls `window.confirm`
  (outside the scanned folders).
- Server: `Cache-Control: no-store` on backup export / secret responses and the debug-level
  "Adding to archive" log (security spec S4/S5) were out of this PR's brief.
- `RegistryFormDialog` has its own overlay (not `Modal`), so it has no dirty guard yet.
- Server-side "used by" (409 `RESOURCE_IN_USE`) for credentials, models and apps.

## Tests

`tests/unit/client/confirm-dialog.test.jsx`, `secret-reveal-dialog.test.jsx`,
`admin-oauth-rotate-secret.test.jsx`, `admin-backup-import-confirm.test.jsx`,
`admin-bulk-toggle-confirm.test.jsx`, `admin-confirmations.test.jsx`,
`integration-install-dialog-dirty.test.jsx`, `admin-no-native-dialogs.test.jsx`;
e2e `tests/e2e/admin-confirmations.spec.js` (intercepts every write; never runs a real restore).
