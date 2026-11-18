# Config writes: no redacted or whole-file overwrites, optional If-Match, scoped PATCH (PL-B4, CU-B3, OB-B10)

Implementation notes for the "Now" PR of epic #3739 that stops admin saves from erasing what the
admin read redacted or did not show, adds optimistic locking (decision 6: optional `If-Match`,
412 `PRECONDITION_FAILED`) and a scoped `PATCH /api/admin/configs/platform`. Stacked on the
lockout guards PR (see `2026-11-17 lockout and last-admin guards.md`). Read this before adding a
secret to `platform.json`, a new writer of it, or a page that saves it.

## Layout

| File | Role |
| --- | --- |
| `server/utils/redactedSecrets.js` | `SECRET_MARKER`, `PLATFORM_SECRET_PATHS`, `redactForRead`, `restoreRedacted(next, stored, paths, {mode})`, `assertNoMarkers`, `isRedactedValue`. Pure. |
| `server/utils/urlSecrets.js` | `redactUrlSecrets` (moved out of `httpConfig.js`, which re-exports it), so the redaction module does not load the HTTP stack. |
| `server/utils/configRevision.js` | `revisionOf(stored)`, `setRevisionHeaders(res, rev)`, `parseIfMatch`, `assertIfMatch(req, stored, resource)`. |
| `server/routes/admin/configs.js` | `applyPlatformChange(req, body, {mode})`: the ONE writer of POST (`replace`) and PATCH (`merge`). Also `PATCHABLE_PLATFORM_SECTIONS`, `assertPatchShape`, `mergePatch`, `validatePlatformSections`, `mergePlatformSections`. |
| `server/routes/admin/changes.js` | Platform snapshot GET redacted; rollback `restoreRedacted(..., {mode: 'rollback'})` + `assertNoMarkers`. |
| `server/routes/admin/ui.js` | GET `ETag`; POST through `configStore.updateJson` with `assertIfMatch`, keeps stored `pages`. |
| `server/routes/admin/logging.js` | PUT now writes a snapshot and an audit entry (OB-B6 subset). |
| `client/src/api/adminConfigRevision.js` | Remembers the last `ETag` per guarded file, adds `If-Match` to POSTs, raises `adminConfigConflict` on 412. Wired into `makeAdminApiCall`. |
| `client/src/features/admin/components/AdminConfigConflictNotice.jsx` | The one conflict dialog, rendered by `AdminLayout`. |

## Rules

- **Secret paths** (`PLATFORM_SECRET_PATHS`): `auth.jwtSecret`, `localAuth.jwtSecret`,
  `speech.azure.subscriptionKey` (kind `secret`, read as `***REDACTED***`, `${ENV}` kept) and
  `proxyAuth.jwtProviders[].jwkUrl` (kind `url`, read with `redactUrlSecrets`). `[]` arrays are
  matched by `name`, then `id`, never by index.
- **Save restore**, only where the enclosing object is in the body: omitted → stored, marker or
  masked URL → stored, `null` → removed, anything else → new value. Encryption of the speech key is
  done by `updatePlatform` (`encryptPlatformSecrets`), not by the route.
- **Rollback restore**: secrets always come from the current file (absent there → removed); URLs
  roll back unless masked. Default "keep current" from security.md question 4.
- **`assertNoMarkers`** runs on each submitted top-level section after the restore (not on the
  whole file, so a legacy marker in an untouched section does not block unrelated saves). It
  matches whole strings only: `***REDACTED***`, `[redacted]`, `[REDACTED]`, `//REDACTED@`,
  `?x=REDACTED`. Free text containing "[redacted]" passes.
- **Revision**: SHA-256 base64url over canonical JSON (sorted keys) of the parsed STORED body.
  Missing file = `{}`. Strong comparison; `W/` tags never match; `*` requires a non-empty file.
  Compared inside `updatePlatform` / `updateJson`, i.e. under the file lock.
- **PATCH**: allowlist = exactly the sections the POST writes. Dedicated sections (`ssl`, `ssrf`,
  `cors`, `rateLimit`, `proxy`, `logging`) and unknown keys → 400 `VALIDATION_FAILED`,
  `errors[].pointer`. `null` on a top-level section → 400 (except `toolApproval`); `null` on an
  object enclosing a secret → 400; `null` on a secret leaf is kept as `null` through the merge so
  the restore clears it. `provenance` is passed through unmerged (its own merge has the `null` =
  default rule). The PATCH answers with the redacted resource (no `reconfiguration` envelope).
- **UI POST**: `pages` always comes from the stored file (the pages routes own it).
- **Client**: If-Match is sent automatically on POST only (PATCH is scoped and not guarded unless
  the caller sets the header). The ETag is the last one this tab saw for the file (read or write).

## Known limits / follow-ups

- `GET /api/admin/ui/config` still returns the cache body (env-resolved); the `ETag` is of the
  stored file. A lagging cache could pair a fresh `ETag` with a stale body.
- The pages routes (`routes/admin/pages.js`) still read-modify-write `ui.json` without the
  update lock; the disclaimer PUT writes from the cache. Not changed here.
- Snapshot files still hold the JWT secrets in plain text on disk (only the read is redacted).
  security.md S2.4 suggests encrypting them; that needs `encryptPlatformSecrets` to cover JWT
  secrets and a decrypt on rollback.
- `If-Match` required (428) is a later decision (D6).
- Pages that re-read platform.json right before saving get the fresh `ETag` from that re-read, so
  they are protected only for that short window; pages that load once (Authentication, UI
  Customization) are protected for the whole edit.

## Tests

`server/tests/admin-config-roundtrip.test.js`, `admin-config-if-match.test.js`,
`admin-config-patch.test.js`, `redactedSecrets.test.js`;
`tests/unit/client/admin-save-conflict.test.jsx`, `admin-logging-privacy-save.test.jsx`,
`eu-ai-act-provenance-settings.test.jsx` (updated for PATCH).
