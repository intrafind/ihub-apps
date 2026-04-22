# Export Feature Flag Implementation

**Date:** 2026-04-22
**Author:** Claude Code Agent
**Issue:** #1137

## Problem Statement

Currently, there is no way to fully disable the export function for a given app in iHub. The export buttons and functionality are visible if there are messages and export settings, but they are not gated by an explicit feature flag. While there is a `pdfExport` feature flag for PDF export, there is no general app-level or platform-level feature toggle for export in general, which may be important for customers with compliance or data governance requirements.

## Solution

Implemented a general `export` feature flag at the platform level that acts as a master switch for all export functionality, working alongside the existing `pdfExport` flag to provide granular control.

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

Updated the following components to check the export feature flag:

1. **`client/src/features/chat/components/ChatHeader.jsx`**
   - Added `useFeatureFlags` hook
   - Check `exportEnabled` before rendering export button
   - Only render `ExportDialog` if export is enabled

2. **`client/src/features/chat/components/ChatActionsMenu.jsx`**
   - Added `useFeatureFlags` hook
   - Check `exportEnabled` before showing export menu item
   - Only render `ExportDialog` if export is enabled

3. **`client/src/features/chat/components/ExportConversationMenu.jsx`**
   - Check both `export` and `pdfExport` flags
   - `pdfExportEnabled = exportEnabled && featureFlags.isEnabled('pdfExport', true)`
   - Return `null` early if export is disabled

4. **`client/src/features/canvas/components/ExportMenu.jsx`**
   - Added `useFeatureFlags` hook
   - Check `exportEnabled` flag
   - Return `null` early if export is disabled

5. **`client/src/features/canvas/components/QuillToolbar.jsx`**
   - Added `useFeatureFlags` hook
   - Check `exportEnabled` before rendering export button
   - Wrap export button in conditional rendering

### Feature Flag Hierarchy

```
export (master switch, default: true)
  ├── JSON export
  ├── JSONL export
  ├── Markdown export
  ├── HTML export
  └── pdfExport (specific flag, default: true)
       └── PDF export with templates and watermarks
```

### Configuration Options

Platform administrators can now configure three scenarios:

1. **Disable all exports:**
   ```json
   {
     "features": {
       "export": false
     }
   }
   ```

2. **Allow all exports except PDF:**
   ```json
   {
     "features": {
       "export": true,
       "pdfExport": false
     }
   }
   ```

3. **Allow all exports including PDF (default):**
   ```json
   {
     "features": {
       "export": true,
       "pdfExport": true
     }
   }
   ```

## Documentation Updates

- Updated `docs/platform.md` with export feature flag documentation
- Updated `shared/FEATURE_FLAGS_README.md` with export flag information
- Clarified relationship between `export` and `pdfExport` flags

## Testing

- Server startup tested successfully
- Linting and formatting checks passed
- All export UI components now respect the feature flag

## Backward Compatibility

Both `export` and `pdfExport` flags default to `true`, ensuring full backward compatibility with existing installations. No migration is required since the feature registry provides the default values automatically.

## Security & Governance Benefits

Organizations can now:
- Meet stricter governance requirements by disabling export
- Control data exfiltration by preventing conversation exports
- Comply with data residency and privacy regulations
- Provide granular control over PDF vs. other export formats

## Code Locations

- Feature flag definition: `server/featureRegistry.js:106-115`
- Chat header export button: `client/src/features/chat/components/ChatHeader.jsx:45,160-169,226-235`
- Chat actions menu: `client/src/features/chat/components/ChatActionsMenu.jsx:35,128-141,146-155`
- Export menu: `client/src/features/chat/components/ExportConversationMenu.jsx:16-18,79-81`
- Canvas export menu: `client/src/features/canvas/components/ExportMenu.jsx:12,57-59`
- Canvas toolbar: `client/src/features/canvas/components/QuillToolbar.jsx:25,348-363`

## Future Enhancements

Potential future improvements:
- App-level export override (allow specific apps to disable export even if platform enables it)
- Per-format granular control (enable/disable JSON, Markdown, HTML separately)
- Role-based export permissions (only admins can export)
- Export audit logging for compliance tracking

## Related Issues

- Issue #1137: Add feature flag to enable/disable export functionality per app
- Related to existing `pdfExport` feature flag functionality
