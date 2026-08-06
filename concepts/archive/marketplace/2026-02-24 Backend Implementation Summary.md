# Marketplace Backend Implementation Summary

**Date:** 2026-02-24
**Branch:** marketplace
**Status:** Implemented, server starts cleanly

---

## What Was Built

This document describes the backend infrastructure for the iHub Marketplace feature. The marketplace enables admins to discover, install, update, and uninstall content (apps, models, prompts, skills, workflows) from remote registries without manual file management.

---

## Files Created or Modified

### New Files

| File | Purpose |
|---|---|
| `server/defaults/config/registries.json` | Default empty registries config (seed file) |
| `server/defaults/config/installations.json` | Default empty installations manifest (seed file) |
| `server/migrations/V005__add_marketplace.js` | Migration that creates the two config files on first run |
| `server/validators/catalogSchema.js` | Zod schema for catalog.json (items fetched from registries) |
| `server/validators/registryConfigSchema.js` | Zod schema for registry configuration objects |
| `server/services/marketplace/RegistryService.js` | Service: CRUD for registries, catalog fetching, item listing |
| `server/services/marketplace/ContentInstaller.js` | Service: Install/update/uninstall/detach content items |
| `server/routes/admin/marketplace.js` | Express routes for the admin marketplace API |

### Modified Files

| File | Change |
|---|---|
| `server/featureRegistry.js` | Added `marketplace` feature entry (preview, default: false) |
| `server/configCache.js` | Added `registries.json` and `installations.json` to criticalConfigs; added `getRegistries()`, `getInstallations()`, `refreshRegistriesCache()`, `refreshInstallationsCache()` methods |
| `server/routes/adminRoutes.js` | Added import and registration of marketplace routes |

---

## Architecture

```
Admin UI
   |
   | HTTP (adminAuth + requireFeature('marketplace'))
   v
server/routes/admin/marketplace.js        ← Express route handlers
   |
   +--- RegistryService.js                ← Registry CRUD + catalog fetch/cache
   |         |
   |         +--- requestThrottler.js     ← Throttled HTTP fetch
   |         +--- TokenStorageService.js  ← AES-256-GCM secret encryption
   |         +--- validators/catalogSchema.js
   |         +--- validators/registryConfigSchema.js
   |
   +--- ContentInstaller.js              ← Install/update/uninstall/detach
             |
             +--- RegistryService.js
             +--- configCache.js          ← Cache refresh after write
             +--- utils/atomicWrite.js    ← Atomic JSON file writes
```

---

## Key Design Decisions

### Lazy ConfigCache Import
Both `RegistryService` and `ContentInstaller` use dynamic `await import('../../configCache.js')` rather than a static top-level import. This breaks the circular dependency that would occur because `configCache.js` imports from `configLoader.js` and other modules that transitively depend on the config being ready at module load time.

### Contents Directory Resolution
The spec mentioned a `getContentsDir()` utility from `basePath.js`, but this function does not exist in the codebase. Instead, the implementation uses the same pattern as other existing services (`getRootDir()` from `pathUtils.js` + `config.CONTENTS_DIR` from `config.js`).

### Path Safety
For route handlers, `validateIdForPath(id, type, res)` from `pathSecurity.js` is used (it sends an HTTP 400 automatically). Inside services where there is no `res` object, `isValidId(name)` is used directly and an `Error` is thrown on failure.

### Secret Encryption
Registry auth credentials (bearer tokens, passwords, header values) are encrypted at rest using `TokenStorageService` with the same `encryptIfNeeded` / `decryptIfNeeded` guard pattern used for Jira and OIDC secrets. Auth is redacted to `***REDACTED***` before being sent to the client. REDACTED placeholders sent back by the client on update are restored from the existing encrypted values.

### Catalog Format Normalisation
The `mapClaudeCodeCatalog()` function in RegistryService detects Claude Code's `marketplace.json` format (which uses a `skills` array instead of `items`) and normalises it to the standard catalog format. This allows iHub to consume Claude Code skills registries without requiring the registry operator to change their format.

### Model API Key Stripping
When installing model configs, the `apiKey` field is stripped before writing to disk. This prevents API keys bundled in marketplace model configs from being stored in iHub's content directory, where they might be visible to other admins or included in backups.

---

## API Endpoints

All routes are prefixed with the configured `BASE_PATH` and require admin authentication plus the `marketplace` feature to be enabled.

### Registry Management
```
GET    /api/admin/marketplace/registries
POST   /api/admin/marketplace/registries
GET    /api/admin/marketplace/registries/:registryId
PUT    /api/admin/marketplace/registries/:registryId
DELETE /api/admin/marketplace/registries/:registryId
POST   /api/admin/marketplace/registries/:registryId/_refresh
POST   /api/admin/marketplace/registries/:registryId/_test
```

### Catalog Browsing
```
GET    /api/admin/marketplace                                              (filter/paginate all items)
GET    /api/admin/marketplace/registries/:registryId/items/:type/:name    (item detail + preview)
```

### Item Actions
```
POST   /api/admin/marketplace/registries/:registryId/items/:type/:name/_install
POST   /api/admin/marketplace/registries/:registryId/items/:type/:name/_update
POST   /api/admin/marketplace/registries/:registryId/items/:type/:name/_uninstall
POST   /api/admin/marketplace/registries/:registryId/items/:type/:name/_detach
```

### Installation Tracking
```
GET    /api/admin/marketplace/installations
GET    /api/admin/marketplace/updates
```

---

## Enabling the Feature

The `marketplace` feature is disabled by default (preview category). To enable it:

```json
// contents/config/features.json
{
  "marketplace": true
}
```

Or toggle it through the admin UI under Settings > Features.

---

## Next Steps for a Junior Developer

1. **Frontend**: Create `client/src/features/marketplace/` with:
   - `MarketplacePage.jsx` — main browse view
   - `RegistryManagementPage.jsx` — admin CRUD for registries
   - `InstallationsPage.jsx` — installed items with update/uninstall actions

2. **Auto-refresh**: The `autoRefresh` and `refreshIntervalHours` fields in the registry config are stored but not yet acted upon. A background job (using `setInterval` or a cron) could call `registryService.refreshRegistry()` on a schedule.

3. **Update Notifications**: The `GET /api/admin/marketplace/updates` endpoint checks versions but does not push notifications. The frontend could poll this endpoint and show a badge on the marketplace menu item.

4. **Skill Package Format**: Currently skill installation expects either a `files` map or a plain SKILL.md string. A more robust format (zip archives, multi-file packages) could be added to `ContentInstaller._writeContent()`.

5. **Testing**: Add unit tests for:
   - `validateCatalog()` with valid and invalid catalog structures
   - `validateRegistryConfig()` with each auth type
   - `RegistryService.mapClaudeCodeCatalog()` for format normalisation
   - `ContentInstaller.install()` with mocked registry service
