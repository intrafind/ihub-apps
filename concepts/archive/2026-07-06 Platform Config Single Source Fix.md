# Platform Config Single Source Fix

**Date:** 2026-07-06  
**Issue:** #1771 (tracks #1677)  
**Severity:** Medium  
**Category:** Architecture

## Problem

`server.js` loaded `platform.json` raw (no env-var resolution, no `IHUB_PLATFORM__*`
overrides) and passed that snapshot to `setupMiddleware`, which froze it into:

- `app.set('platform', platformConfig)` — read by `authRequired` and all route files
- the `enhanceUserWithPermissions` closure in `setup.js`
- body-size limit, rate limiters, session stores, and the NTLM SPA-bypass check

Meanwhile `configCache` served a **resolved, override-applied, periodically refreshed**
copy used elsewhere (e.g. CORS was already reading live config).

### Consequences

1. **`IHUB_PLATFORM__*` overrides silently ignored** by boot-wired code — auth mode,
   rate limits, `requestBodyLimitMB`, etc. were taken from the raw JSON even when env
   vars overrode them.

2. **Inconsistent auth window after admin saves** — after an admin saved platform
   config via the UI, `configCache` flipped immediately while `authRequired` and
   `enhanceUserWithPermissions` kept the old values until restart.

## Fix

### `server/server.js`

Replaced `setupMiddleware(app, platformConfig)` with
`setupMiddleware(app, configCache.getPlatform() || platformConfig)`.

`configCache.initialize()` is already called before `setupMiddleware`, so the resolved
config (with all `IHUB_PLATFORM__*` overrides applied) is available. The raw value is
kept as a fallback in case configCache failed to initialise.

### `server/middleware/authRequired.js`

Imported `configCache` and changed the per-request read from the stale
`req.app.get('platform')` to `configCache.getPlatform()`. This is the primary
security fix — it ensures the anonymous-access gate reacts immediately to admin
config changes without a restart.

### `server/middleware/setup.js`

- Updated the `enhanceUserWithPermissions` middleware closure to call
  `configCache.getPlatform()` per-request instead of using the boot-time captured
  `platformConfig`.
- Added a documentation comment identifying the truly **restart-only** settings:
  body-size limit, rate limiters, session stores, and the NTLM SPA-bypass. These
  are wired into Express middleware objects that cannot be hot-swapped at runtime.

### `server/utils/authorization.js`

Added `configCache` import and updated `createAuthorizationMiddleware` to use
`configCache.getPlatform()` per-request.

### Route files

Replaced `req.app.get('platform') || {}` with `configCache.getPlatform() || {}` in:

- `server/routes/skillRoutes.js` (4 occurrences)
- `server/routes/generalRoutes.js`
- `server/routes/modelRoutes.js`
- `server/routes/chat/dataRoutes.js`
- `server/routes/toolRoutes.js`

All these files already imported `configCache`, so this was a one-line change per
occurrence.

## Settings That Remain Restart-Only

The following middleware objects are constructed once at boot from the boot-time
config snapshot and **cannot** be refreshed without a restart:

| Setting | Where wired |
|---|---|
| `requestBodyLimitMB` | `express.json({ limit })` + `checkContentLength(limit)` |
| `rateLimit.*` | `createRateLimiters(platformConfig)` |
| OIDC / integration sessions | `setupSessionMiddleware(app, platformConfig)` |
| NTLM SPA-bypass | `createAuthChain(…, platformConfig)` |

All other platform config values (auth mode, anonymous access, group permissions,
feature flags, …) are now read live from `configCache` on every request.

## Files Changed

- `server/server.js`
- `server/middleware/authRequired.js`
- `server/middleware/setup.js`
- `server/utils/authorization.js`
- `server/routes/skillRoutes.js`
- `server/routes/generalRoutes.js`
- `server/routes/modelRoutes.js`
- `server/routes/chat/dataRoutes.js`
- `server/routes/toolRoutes.js`
