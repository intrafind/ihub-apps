# Export Feature Flag Implementation

**Date:** 2026-04-22
**Author:** Claude Code Agent
**Issue:** #1137
**PR Comment:** @manzke feedback on app-level control

## Problem Statement

The user (@manzke) requested that the export feature must be configurable at the **app level** via the apps admin UI. The initial implementation only had platform-level control, which didn't meet the requirement for per-app export configuration.

Additionally, the `pdfExport` feature flag was deemed unnecessary complexity - export should be a simple on/off toggle.

## User Requirements

From @manzke's PR comment:

> "it must be possible to dis-/enable export in an app. means I can configure in the apps admin via the ui, if export is allowed or not. if global feature is disabled, it doesn't work. if global export is on (default), it can be disabled via the apps admin. please remove the feature flag for pdf export for now. it is a on or off if export is allowed."

Key requirements:
1. Export must be configurable at the **app level** (via apps admin UI)
2. Global feature flag acts as master switch (if disabled globally, no app can export)
3. If global is enabled (default), individual apps can disable export
4. Remove `pdfExport` feature flag - make export a simple on/off toggle

## Solution

Implemented a hierarchical export feature flag system that checks **both** platform and app levels using the `isBothEnabled` pattern from the FeatureFlags utility.

## Implementation Details

### Feature Flag Registration

Added new `export` feature flag to `server/featureRegistry.js`:

```javascript
{
  id: 'export',
  name: { en: 'Export', de: 'Export' },
  description: {
    en: 'Enable exporting chat conversations and canvas content in various formats (JSON, JSONL, Markdown, HTML, PDF)',
    de: 'Exportieren von Chat-Unterhaltungen und Canvas-Inhalten in verschiedenen Formaten (JSON, JSONL, Markdown, HTML, PDF) aktivieren'
  },
  category: 'content',
  default: true
}
```

### Client Component Updates

Updated the following components to check the export feature flag **at both platform and app levels**:

1. **`client/src/features/chat/components/ChatHeader.jsx`**
   - Added `app` prop to function signature
   - Changed from `featureFlags.isEnabled('export', true)` to `featureFlags.isBothEnabled(app, 'export', true)`
   - Only render export button and `ExportDialog` if export is enabled at both levels

2. **`client/src/features/apps/components/SharedAppHeader.jsx`**
   - Added `app={app}` prop when calling `ChatHeader` component
   - Enables `ChatHeader` to check app-level export flag

3. **`client/src/features/chat/components/ChatActionsMenu.jsx`**
   - Added `app` prop to function signature
   - Changed to `featureFlags.isBothEnabled(app, 'export', true)`
   - Only show export menu item if enabled at both levels

4. **`client/src/features/chat/components/ExportConversationMenu.jsx`**
   - Added `app` prop to function signature
   - Removed `pdfExport` feature flag logic
   - Changed to `featureFlags.isBothEnabled(app, 'export', true)`
   - PDF export now always available when export is enabled (no separate flag)

5. **`client/src/features/chat/components/ExportDialog.jsx`**
   - Removed `pdfExport` feature flag check
   - PDF format now always included in export formats when export is enabled

6. **`client/src/features/canvas/components/ExportMenu.jsx`**
   - Added `app` prop to function signature
   - Changed to `featureFlags.isBothEnabled(app, 'export', true)`

7. **`client/src/features/canvas/components/QuillToolbar.jsx`**
   - Changed from `featureFlags.isEnabled('export', true)` to `featureFlags.isBothEnabled(app, 'export', true)`
   - Added `app={app}` prop when calling `ExportMenu` component

### Feature Flag Hierarchy

```
Platform Level (contents/config/features.json)
  └── export: true/false (global master switch)

App Level (contents/apps/{app-id}.json)
  └── features.export: true/false (per-app override)

UI Check: Both must be true for export to work
```

### Configuration Options

Platform administrators can now configure export at multiple levels:

1. **Disable all exports globally:**
   ```json
   // contents/config/features.json
   {
     "export": false
   }
   ```
   Result: No app can export, regardless of app-level settings

2. **Enable globally, disable for specific app:**
   ```json
   // contents/config/features.json
   {
     "export": true
   }

   // contents/apps/secure-chat.json
   {
     "id": "secure-chat",
     "features": {
       "export": false
     }
   }
   ```
   Result: All apps can export except "secure-chat"

3. **Enable for all apps (default):**
   ```json
   // contents/config/features.json
   {
     "export": true
   }
   ```
   Result: All apps can export unless explicitly disabled at app level

4. **App inherits platform setting (default behavior):**
   - If app doesn't specify `features.export`, it inherits from platform level
   - Platform `true` + App unspecified = export enabled
   - Platform `false` + App unspecified = export disabled

## Documentation Updates

- Updated `shared/FEATURE_FLAGS_README.md` with export feature flag documentation
- Added export feature usage examples showing platform and app-level control
- Removed all references to `pdfExport` flag
- Clarified that export includes all formats (PDF, JSON, JSONL, Markdown, HTML, Office formats)

## Testing

- Server startup tested successfully
- All export UI components now respect both platform and app-level export flags
- PDF export integrated into main export flag (no separate toggle needed)

## Backward Compatibility

The `export` flag defaults to `true` at both platform and app levels, ensuring full backward compatibility with existing installations. No migration is required since:
- Feature registry provides platform-level default (true)
- Apps without explicit `features.export` setting inherit platform default
- Existing apps continue to work without configuration changes

## Security & Governance Benefits

Organizations can now:
- Meet stricter governance requirements by disabling export globally or per-app
- Control data exfiltration by preventing conversation exports
- Comply with data residency and privacy regulations
- Configure export permissions at granular app level via admin UI
- Disable export for sensitive/confidential apps while allowing it for others

## Code Locations

- Feature flag definition: `server/featureRegistry.js:107-115`
- Chat header export: `client/src/features/chat/components/ChatHeader.jsx:15,46,160-169,226-235`
- Shared header: `client/src/features/apps/components/SharedAppHeader.jsx:113`
- Chat actions menu: `client/src/features/chat/components/ChatActionsMenu.jsx:10,36,128-141,146-155,206`
- Export menu: `client/src/features/chat/components/ExportConversationMenu.jsx:10,23,79-81`
- Export dialog: `client/src/features/chat/components/ExportDialog.jsx:116-124,259-263`
- Canvas export menu: `client/src/features/canvas/components/ExportMenu.jsx:6,12,57-59`
- Canvas toolbar: `client/src/features/canvas/components/QuillToolbar.jsx:14,25,363-367`

## Future Enhancements

Potential future improvements:
- Per-format granular control (enable/disable JSON, Markdown, HTML separately)
- Role-based export permissions (only admins can export)
- Export audit logging for compliance tracking
- Export watermarking for traceability
- Time-based export restrictions

## Related Issues

- Issue #1137: Add feature flag to enable/disable export functionality per app
- Related to existing `pdfExport` feature flag functionality
