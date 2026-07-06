# 2026-07-06 Admin CONTENTS_DIR Path Alignment

## Context

Admin write endpoints resolved content paths in multiple inconsistent ways (`join(rootDir, 'contents', ...)`, `process.env.CONTENTS_DIR || 'contents'`, and `__dirname`-relative paths in backup routes). Deployments using custom `CONTENTS_DIR` could report successful admin updates while persisting files into the wrong directory.

## Decision

Introduce a shared helper:

- `server/utils/contentsPath.js` → `getContentsPath(...segments)`

This helper resolves all admin file-system paths via `getRootDir()` + `config.CONTENTS_DIR`.

## Implementation Notes

Updated admin route modules to use `getContentsPath`:

- `server/routes/admin/apps.js`
- `server/routes/admin/models.js`
- `server/routes/admin/prompts.js`
- `server/routes/admin/groups.js`
- `server/routes/admin/configs.js`
- `server/routes/admin/tools.js`
- `server/routes/admin/backup.js`
- `server/routes/admin/auth.js`
- `server/routes/admin/ui.js`
- `server/routes/admin/sources.js`

Backup import/export now uses the configured contents directory name consistently instead of a hardcoded `contents/` segment.

## Validation

- Added `server/tests/contentsPath.test.js` to verify canonical path construction and `CONTENTS_DIR` override behavior in a fresh process.
- Verified server startup with default configuration and with a custom `CONTENTS_DIR`.
