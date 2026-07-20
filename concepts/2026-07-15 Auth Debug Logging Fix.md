# Authentication Debug Logging Fix

**Date:** 2026-07-15
**Issue:** [#2068](https://github.com/intrafind/ihub-apps/issues/2068) — Debug Logging for Authentication broken

## Problem

Admins could not reliably enable authentication debug logging to diagnose OIDC
redirect issues, token exchange, and group mapping. The controls were spread
across multiple admin pages, and the main toggle silently did nothing.

## Root cause

1. **Config key mismatch (the "broken").** The admin UI and shipped examples
   wrote a **top-level `authDebug`** block, but the server only ever read
   **`auth.debug`** (`authDebugService`, `platformConfigSchema`). Worse, the
   `POST /api/admin/configs/platform` merge only whitelists specific top-level
   keys and `authDebug` was not among them, so the value was never even
   persisted by that route.
2. **Two gates in two places.** Even with `auth.debug.enabled = true`, most
   OIDC events were logged at Winston level `debug`, which the default
   `logging.level: info` suppresses. Admins had to *also* lower the global log
   level in a different UI section.
3. **Dead flags.** `includeRawData` was never consulted (the raw access token
   log fired unconditionally), and `consoleLogging` was not in the schema and
   read nowhere.
4. **Component filter could hide auth logs.** `logging.components` filtering,
   when enabled without the auth components in the list, silently dropped auth
   logs. `components` was also missing from the logging schema.
5. **Fragmentation.** Auth-debug controls appeared on both the Logging page and
   the Authentication page, `ntlmAuth.debug` was a third standalone switch, and
   the UI wrongly claimed a restart was required.

## Fix

- **Standardize on `auth.debug`** (the key the code/schema already use). The UI
  now reads/writes `auth.debug`; the platform-save merge persists it because the
  whole `auth` object is whitelisted.
- **Single toggle is sufficient.** `authDebugService.log()` now emits
  informational traces at `info` (errors/warnings keep their severity), so they
  appear at the default log level with no second switch. Applies immediately —
  the platform-config cache is refreshed on save.
- **`includeRawData` now works.** Raw access-token and full user-info logs are
  gated behind it (default off), and `sanitizeData` only bypasses masking when
  it is explicitly on. The core logger still redacts known-sensitive keys as a
  defense-in-depth safety net.
- **`consoleLogging` removed** from the UI, examples, and defaults (Winston owns
  the console transport).
- **Component filter never hides auth logs** while `auth.debug.enabled` is true;
  `components` added to the logging schema.
- **NTLM unified.** `ntlmAuth.debug` still works, and NTLM tracing now also
  responds to the central `auth.debug` toggle (`providers.ntlm`).
- **UI consolidated** onto the Logging page; the Authentication page now points
  there. The misleading "requires restart" note is corrected.
- **Migration `V079`** moves any existing top-level `authDebug` → `auth.debug`
  and drops the dead `consoleLogging` flag, preserving admin settings.

## Security posture (defaults)

- `maskTokens: true`, `redactPasswords: true`, `includeRawData: false`.
- Enabling `includeRawData` is a deliberate, documented risk and should be
  turned off again after debugging.

## Files touched

- `server/utils/authDebugService.js` — emit level, `includeRawData`, `isRawDataEnabled`
- `server/utils/logger.js` — auth components bypass component filter when debug on
- `server/middleware/oidcAuth.js` — gate raw token / user-info logs
- `server/middleware/ntlmAuth.js` — honor central `auth.debug` toggle
- `server/validators/platformConfigSchema.js` — add `logging.components`
- `server/migrations/V079__migrate_auth_debug_key.js` — key migration
- `server/defaults/config/platform.json`, `examples/config/platform.json`
- `client/.../AdminLoggingPage.jsx`, `PlatformFormEditor.jsx`, `AdminAuthPage.jsx`
- `docs/platform.md`
