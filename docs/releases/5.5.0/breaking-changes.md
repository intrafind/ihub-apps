# Breaking Changes — 5.5.0

## `config/tools.json` Is Removed

Tool configuration no longer supports the shared `contents/config/tools.json` array. Every tool
now lives in its own file under `contents/tools/`, and there is no fallback to the old file.

- A configuration migration runs automatically on upgrade: it splits any existing
  `contents/config/tools.json` into individual `contents/tools/<toolId>.json` files and deletes
  the old file. No manual action is required.
- `deepResearch`, `answerReducer`, `evaluator`, `queryRewriter`, and `researchPlanner` have been
  retired and are removed by the same migration, whether they were still in the legacy file or
  already split into their own file.
- Custom tools you added directly to `config/tools.json` are preserved — they're carried over into
  their own file with the same ID.

**Before upgrading:** No action needed; the migration handles the conversion automatically. If you
have external tooling that reads or writes `contents/config/tools.json` directly, update it to
manage individual files under `contents/tools/` instead.

## Electron Desktop App Target Removed

The `npm run electron:dev` and `npm run electron:build` scripts, the `electron/` source directory,
and the `electron`/`electron-builder` dev dependencies have been removed. This target never
produced a working packaged app — the desktop build had no valid entry point and could not reach
the local API server once packaged — so no functioning deployment is affected.

- Use the Progressive Web App (installable from the browser), the standalone binary, Docker, or
  npm for deployment instead.

**Before upgrading:** No action needed. If you had scripts or documentation referencing
`electron:dev`/`electron:build`, remove those references — the commands no longer exist.

## iFinder Source Configuration Schema Simplified

The `config` block of `ifinder` sources no longer accepts `baseUrl`, `apiKey`, `queryTemplate`,
or `filters`. These fields were never used when loading documents — the connection has always
come from the central iFinder integration — but they are now rejected on save instead of being
stored silently. Document selection moves to the new `documentId` / `query` fields, and sources
exposed as prompt context must set one of them.

- Migration V083 cleans stored sources automatically: it removes the dead connection fields,
  carries a non-empty `queryTemplate` over to `query`, and drops the auto-injected
  `searchProfile: "default"` so the platform-wide profile applies.

**Before upgrading:** No action needed for stored configurations; the migration converts them
automatically. If external tooling creates or updates iFinder sources through
`/api/admin/sources`, remove the `baseUrl`/`apiKey`/`queryTemplate`/`filters` fields from its
payloads and set `documentId` or `query` instead. Verify the central iFinder integration
(Admin → Providers → iFinder) is configured, since sources rely on it for connectivity.

## Filesystem Sources Must Live Under `contents/sources/`

Filesystem-source file operations (browse, read, write, delete, "Test connection") are now
hard-scoped to `contents/sources/`, closing a privilege-escalation gap where a restricted
**Content Admin** could reach any file under `contents/` — including `.encryption-key` and
`config/groups.json` — through the source file editor. A filesystem source's `config.path` must
now be `sources` or start with `sources/`, and no path segment may start with `.`.

- All bundled default sources already use the `sources/` prefix and are unaffected.
- A custom filesystem source you created with a `config.path` outside `sources/` (for example
  `data/file.txt`) will fail to load, and will be rejected if re-saved, after upgrading.

**Before upgrading:** If you have a custom filesystem source whose path is not under `sources/`,
move the target file into `contents/sources/` and update the source's `config.path` to match
(e.g. `sources/data/file.txt`) before or immediately after upgrading.
