# Preview Features Implementation

**Date**: 2026-02-19  
**Status**: Implemented  
**Related Issue**: Preview Features

## Summary

Implemented preview features functionality to mark certain features as "Preview" in the UI. Features marked as preview are displayed in their own category at the top of the Features admin page with a blue badge.

## Changes Made

### 1. Feature Registry Updates (`server/featureRegistry.js`)

#### Renamed Feature
- **Old**: `experimentalWorkflows`
- **New**: `workflows`
- **Breaking Change**: No backward compatibility provided as requested

#### New Preview Category
Added new "Preview" category with order 1 (displayed first):
```javascript
preview: { name: { en: 'Preview', de: 'Vorschau' }, order: 1 }
```

#### Preview Features
Two features are now marked as preview:

1. **Workflows** (formerly experimentalWorkflows)
   - ID: `workflows`
   - Category: `preview`
   - Preview: `true`
   - Default: `false`
   
2. **Integrations**
   - ID: `integrations`
   - Category: `preview`
   - Preview: `true`
   - Default: `true`

### 2. UI Updates

#### AdminFeaturesPage.jsx
- Changed from `experimental` flag to `preview` flag
- Updated badge styling:
  - **Old**: `bg-amber-100 text-amber-800` (amber/yellow)
  - **New**: `bg-blue-100 text-blue-800` (blue)
- Badge text: Shows "Preview" / "Vorschau" based on language

#### Visual Example
```
┌─────────────────────────────────────────────────────────┐
│ Preview                                                  │
├─────────────────────────────────────────────────────────┤
│ Workflows  [Preview]                              [ON]   │
│ Agentic workflow automation for multi-step AI tasks     │
├─────────────────────────────────────────────────────────┤
│ Integrations  [Preview]                           [ON]   │
│ External service integrations (Jira, Cloud Storage)     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ AI Capabilities                                          │
├─────────────────────────────────────────────────────────┤
│ Tool Calling                                      [ON]   │
│ Allow AI models to call external tools and functions    │
├─────────────────────────────────────────────────────────┤
│ Sources                                           [ON]   │
│ Add custom knowledge sources directly to prompts        │
└─────────────────────────────────────────────────────────┘
```

### 3. Code References Updated

All references to `experimentalWorkflows` changed to `workflows`:

1. **server/routes/workflow/workflowRoutes.js**
   - `requireFeature('experimentalWorkflows')` → `requireFeature('workflows')`

2. **client/src/features/admin/components/AdminNavigation.jsx**
   - `isEnabled('experimentalWorkflows', false)` → `isEnabled('workflows', false)`

3. **client/src/shared/components/Layout.jsx**
   - Feature route mapping updated

4. **server/defaults/config/features.json**
   - Default config uses new `workflows` key

### 4. Translations Added

#### English (en.json)
```json
"admin": {
  "features": {
    "title": "Features",
    "description": "Enable or disable platform features",
    "preview": "Preview",
    "loadError": "Failed to load features",
    "saveError": "Failed to save features",
    "saved": "Features updated successfully"
  }
}
```

#### German (de.json)
```json
"admin": {
  "features": {
    "title": "Funktionen",
    "description": "Plattform-Funktionen aktivieren oder deaktivieren",
    "preview": "Vorschau",
    "loadError": "Fehler beim Laden der Funktionen",
    "saveError": "Fehler beim Speichern der Funktionen",
    "saved": "Funktionen erfolgreich aktualisiert"
  }
}
```

### 5. Documentation Updates

#### FEATURE_FLAGS_README.md
- Updated available features list
- Marked preview features with **[Preview]** tag
- Updated date to 2026-02-19
- Changed examples from `experimentalWorkflows` to `workflows`

#### Concept Documents
- Updated `2026-02-17 Feature Flag Utility Encapsulation.md`
- Updated `concepts/admin-workflow-management/2026-02-16 Admin Workflow Management Pages.md`

## Testing

### Server Startup
✅ Server starts successfully with no errors
✅ All modules load correctly
✅ Feature registry resolves correctly

### API Endpoint
The `/api/admin/features` endpoint now returns:
```json
{
  "features": [
    {
      "id": "workflows",
      "name": { "en": "Workflows", "de": "Workflows" },
      "category": "preview",
      "preview": true,
      "enabled": false
    },
    {
      "id": "integrations",
      "name": { "en": "Integrations", "de": "Integrationen" },
      "category": "preview",
      "preview": true,
      "enabled": true
    },
    // ... other features
  ],
  "categories": {
    "preview": { "name": { "en": "Preview", "de": "Vorschau" }, "order": 1 },
    "ai": { "name": { "en": "AI Capabilities", "de": "KI-Funktionen" }, "order": 2 },
    // ... other categories
  }
}
```

## Key Features

1. **Clear Visual Indication**: Preview features have a blue badge making them easily distinguishable
2. **Dedicated Category**: Preview features are grouped together at the top of the features list
3. **Internationalized**: All UI text supports English and German
4. **Breaking Change**: Renamed `experimentalWorkflows` to `workflows` without backward compatibility as requested

## Migration Notes

### For Users
If you had `experimentalWorkflows` enabled in your `contents/config/features.json`, you need to update it to use `workflows`:

**Before:**
```json
{
  "experimentalWorkflows": true
}
```

**After:**
```json
{
  "workflows": true
}
```

### For Developers
Update any code that checks for `experimentalWorkflows`:
- Use `isEnabled('workflows', false)` instead
- Update any documentation or configuration examples

## Files Modified

- `server/featureRegistry.js`
- `server/defaults/config/features.json`
- `server/routes/workflow/workflowRoutes.js`
- `client/src/features/admin/pages/AdminFeaturesPage.jsx`
- `client/src/features/admin/components/AdminNavigation.jsx`
- `client/src/shared/components/Layout.jsx`
- `shared/i18n/en.json`
- `shared/i18n/de.json`
- `shared/FEATURE_FLAGS_README.md`
- `concepts/2026-02-17 Feature Flag Utility Encapsulation.md`
- `concepts/admin-workflow-management/2026-02-16 Admin Workflow Management Pages.md`
