# Marketplace Frontend Implementation

**Date:** 2026-02-24
**Branch:** marketplace (worktree)
**Status:** Complete - awaiting server-side backend implementation

---

## Overview

This document describes the frontend UI implementation for the iHub Marketplace feature. The marketplace allows admins to discover and install content (apps, models, prompts, skills, workflows) from remote registries directly from the admin panel.

---

## Files Created or Modified

### New Files

| File | Purpose |
|------|---------|
| `client/src/features/admin/pages/AdminMarketplacePage.jsx` | Main browse page with filtering, search, type tabs, and item grid |
| `client/src/features/admin/pages/AdminMarketplaceRegistriesPage.jsx` | Registry management page (CRUD + enable/disable + refresh) |
| `client/src/features/admin/components/marketplace/RegistryFormDialog.jsx` | Modal dialog for creating/editing a registry |
| `client/src/features/admin/components/marketplace/MarketplaceItemCard.jsx` | Card component for individual items in the browse grid |
| `client/src/features/admin/components/marketplace/MarketplaceTypeTabs.jsx` | Horizontal tab bar for filtering by item type |
| `client/src/features/admin/components/marketplace/MarketplaceItemDetail.jsx` | Slide-in detail panel with install/update/uninstall/detach actions |

### Modified Files

| File | Change |
|------|--------|
| `client/src/api/adminApi.js` | Added 14 marketplace API functions + registered them in the export object |
| `client/src/App.jsx` | Added lazy imports and routes for both marketplace pages (gated by `marketplace` feature flag) |
| `client/src/features/admin/components/AdminNavigation.jsx` | Added Marketplace nav item to the `content` group (gated by `marketplace` feature flag) |
| `client/src/features/admin/pages/AdminHome.jsx` | Added Marketplace section card (gated by `marketplace` feature flag) |
| `shared/i18n/en.json` | Added full `admin.marketplace` and `admin.nav.marketplace` translation keys |
| `shared/i18n/de.json` | Added full German translations for all marketplace keys |

---

## Architecture Decisions

### Feature Flag Gating

All marketplace UI is hidden behind `featureFlags.isEnabled('marketplace', false)`. The default is `false`, meaning the feature must be explicitly enabled in `contents/config/features.json`. This prevents the feature from appearing to users before the backend is ready.

### Route Structure

```
/admin/marketplace              -> AdminMarketplacePage (browse + install)
/admin/marketplace/registries   -> AdminMarketplaceRegistriesPage (manage registries)
```

Note: These routes do NOT use `showAdminPage()` (which reads `platformConfig.admin.pages`). They use `featureFlags.isEnabled('marketplace', false)` instead. This matches the pattern used by `workflows` and `skills` routes.

### API Endpoint Patterns

All API calls go through `makeAdminApiCall()` with paths starting with `/admin/marketplace/`. The expected server endpoints are:

```
GET    /api/admin/marketplace                                              - Browse items
GET    /api/admin/marketplace/registries                                   - List registries
POST   /api/admin/marketplace/registries                                   - Create registry
PUT    /api/admin/marketplace/registries/:id                               - Update registry
DELETE /api/admin/marketplace/registries/:id                               - Delete registry
POST   /api/admin/marketplace/registries/:id/_refresh                      - Refresh catalog
POST   /api/admin/marketplace/registries/_test                             - Test connection
GET    /api/admin/marketplace/registries/:id/items/:type/:name             - Item detail
POST   /api/admin/marketplace/registries/:id/items/:type/:name/_install    - Install item
POST   /api/admin/marketplace/registries/:id/items/:type/:name/_update     - Update item
POST   /api/admin/marketplace/registries/:id/items/:type/:name/_uninstall  - Uninstall item
POST   /api/admin/marketplace/registries/:id/items/:type/:name/_detach     - Detach item
GET    /api/admin/marketplace/installations                                 - List installations
GET    /api/admin/marketplace/updates                                       - List available updates
```

### Expected API Response Shapes

#### Browse response (`GET /api/admin/marketplace`)
```json
{
  "items": [
    {
      "registryId": "my-registry",
      "registryName": "My Registry",
      "type": "app",
      "name": "my-app",
      "displayName": { "en": "My App", "de": "Meine App" },
      "description": { "en": "Description", "de": "Beschreibung" },
      "version": "1.0.0",
      "tags": ["productivity"],
      "author": "Author Name",
      "category": "productivity",
      "installationStatus": "installed"
    }
  ],
  "total": 42,
  "totalPages": 2
}
```

Supported query params: `type`, `search`, `registry`, `status`, `page`, `limit`

#### Registry object
```json
{
  "id": "my-registry",
  "name": "My Registry",
  "description": "Optional description",
  "source": "https://example.com/catalog.json",
  "auth": { "type": "none" },
  "enabled": true,
  "autoRefresh": false,
  "refreshIntervalHours": 24,
  "itemCount": 42,
  "lastSynced": "2026-02-24T12:00:00Z"
}
```

#### Item detail (adds to browse item shape)
```json
{
  "contentPreview": { ... },
  "license": "MIT",
  "installation": {
    "installedAt": "2026-02-24T12:00:00Z",
    "version": "1.0.0"
  }
}
```

---

## How to Enable the Feature

1. Open `contents/config/features.json`
2. Add `"marketplace": true` to the features object
3. The nav item, home card, and routes will appear automatically

---

## How to Continue This Work (for junior developers)

### To add a new filter to the browse page
1. Open `AdminMarketplacePage.jsx`
2. Add state with `useState`
3. Pass the filter to `browseMarketplace()` inside `loadItems`
4. Add the filter control to the "Filter bar" section of the JSX

### To add a new action to items (e.g. clone)
1. Add the API function to `adminApi.js` following the `installMarketplaceItem` pattern
2. Add the action handler in `MarketplaceItemDetail.jsx` inside `handleAction`
3. Add a button in the "Action buttons bar" section of the detail panel JSX
4. Add i18n keys in both `en.json` and `de.json`

### To add a new tab or metadata field
1. Add the type to `TYPES` array in `MarketplaceTypeTabs.jsx`
2. Add color to `TYPE_COLORS` in both `MarketplaceItemCard.jsx` and `MarketplaceItemDetail.jsx`
3. Add i18n keys for the type and its plural form in the `admin.marketplace.types` section

---

## Known Limitations

- The `knownRoutes` array in `client/src/utils/runtimeBasePath.js` does NOT need updating because `/admin/marketplace` is a child of `/admin`, which is already in the known routes list.
- Type counts are fetched with `limit: 1000` as an approximation. If catalogs grow very large, this should be replaced with a dedicated `GET /api/admin/marketplace/counts` endpoint.
- The confirm dialog for destructive actions (uninstall/detach) is inline within the detail panel, not a separate modal, to keep the UX lightweight.
