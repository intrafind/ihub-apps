# Cloud Storage Browser Shell Extraction

**Date:** 2026-05-11
**Status:** Proposed
**Related PR:** [#1416 — Nextcloud cloud-storage provider](https://github.com/intrafind/ihub-apps/pull/1416)
**Owner:** TBD

## Problem Statement

The three cloud-storage providers (Office 365, Google Drive, Nextcloud) ship a file-picker UI that follows the same flow — auth → source list → drive list → folder/file list with search, sort, and multi-select — yet each provider lives in a near-fully-duplicated file pair:

| Provider | Browser component | Browser hook |
|---|---|---|
| Office 365 | `client/src/features/upload/components/Office365FileBrowser.jsx` (~600 lines) | `client/src/features/upload/hooks/useOffice365Browser.js` (~370 lines) |
| Google Drive | `client/src/features/upload/components/GoogleDriveFileBrowser.jsx` (~600 lines) | `client/src/features/upload/hooks/useGoogleDriveBrowser.js` (~370 lines) |
| Nextcloud | `client/src/features/upload/components/NextcloudFileBrowser.jsx` (~570 lines) | `client/src/features/upload/hooks/useNextcloudBrowser.js` (~310 lines) |

Estimated **~85% identical JSX** across the three browsers and **~80% identical state-management logic** across the three hooks. Adding Nextcloud already revealed the drift problem: the "Sorted by" debug indicator stayed in Office 365 / Google Drive when it was correctly removed from Nextcloud after a Copilot review, and the missing keyboard-row click target identified by the reviewer agent exists in all three.

### Concrete duplication identified during PR #1416

From the comprehensive code review on PR #1416:

- Sort + filter pipeline in the `processedItems` `useMemo` block — identical except for the data source.
- `getFileIcon(item)` MIME → icon mapping — three identical copies.
- `canSelectFile(item)` / `getFileTooltip(item)` size + supported-MIME logic — identical.
- The "not connected → source list → drive list → file list" four-view conditional render — identical scaffolding with provider-specific copy.
- The debounced search effect — identical (and has the same stale-closure subtlety in all three).
- Selection map, deselect-all, download-and-process orchestration — identical logic, different download endpoint.

### Pain caused by the current shape

1. **Drift risk**: every bugfix or UX change has to be applied three times manually. Two examples from this PR alone:
   - The unparseable-date crash fix in `_parsePropfindResponse` would have lived in a shared parser if we had one.
   - The a11y improvements (aria-live on the copy button, file-row keyboard targets) skipped Office 365 / Google Drive purely because the diff was already large.
2. **Onboarding cost**: a contributor adding a fourth provider (e.g. Dropbox) is forced to read and clone ~1000 lines before writing a single line of Dropbox-specific code.
3. **Review surface**: PR #1416 added ~880 lines of largely-duplicated code that reviewers had to read carefully despite ~80% being identical to existing files.

## Goals

1. Eliminate the duplication between the three browsers and hooks **without** sacrificing readability per-provider.
2. Make the provider-specific divergence explicit and tiny: things like the WebDAV-vs-Graph API navigation model and the "connect" copy string should be the only Nextcloud-specific code paths.
3. Keep the contract with `CloudStoragePicker` unchanged — adding a new provider is a one-import-plus-one-conditional change in the picker, not a refactor of the picker itself.
4. Land in a single PR small enough to review, ideally one-provider-migration-per-commit so the merge can be bisected.

## Non-Goals

- Changing the user-visible UX of any of the three browsers.
- Touching the server-side OAuth / API code (each provider keeps its own service + route layer; only the React surface changes).
- Fixing the per-user-per-service token scoping limitation — see the parity doc.

## Constraints

- **Two navigation models**: Office 365 and Google Drive identify folders/files by opaque IDs (`folderId`, `fileId`). Nextcloud is path-based (`folderPath`, `filePath`). The shell needs both shapes.
- **Different "drive" semantics**: Office 365 has multiple drives per source (OneDrive, several SharePoint sites, several Teams), Google Drive has multiple drives per source (My Drive, Shared Drives, Shared with Me items), Nextcloud has exactly one synthetic drive per user. The shell must handle multi-drive *and* single-drive providers.
- **Different fallback strings**: each provider has its own connect prompt copy (`cloudStorage.connectPrompt`, `cloudStorage.googleDrive.connectPrompt`, `cloudStorage.nextcloud.connectPrompt`). The shell must accept i18n key overrides.
- **Existing translations must keep working**: the existing `cloudStorage.*` keys are heavily used; we cannot break them.
- **Existing `provider` prop shape** is set by `CloudStorageConfig` and serialized in `platform.json`. Shell input has to accept those existing objects unchanged.

## Proposed Architecture

A two-layer split: a **generic hook factory** for state management and a **single shell component** for rendering. Each provider keeps a thin adapter file.

### Layer 1: Hook factory — `useCloudStorageBrowser`

```js
// client/src/features/upload/hooks/useCloudStorageBrowser.js
export function useCloudStorageBrowser({
  basePath,                  // e.g. '/integrations/nextcloud'
  navigationModel,           // 'id' | 'path'
  buildFolderQuery,          // (currentPath/Id) => Express query object
  buildDownloadQuery,        // (item, currentPath/Id) => Express query object
  buildBreadcrumbFromItem,   // (folderItem, prevBreadcrumb) => { id, name, path? }
  buildBreadcrumbTarget      // (breadcrumb) => identifier passed to listItems
}) {
  // Returns the same surface the existing three hooks export:
  // { authStatus, sources, currentSource, drives, items, currentDrive,
  //   breadcrumbs, selectedFiles, loading, downloading, error,
  //   searchQuery, sortBy, sortDirection,
  //   checkAuthStatus, loadSources, loadDrivesForSource,
  //   goBackToSources, selectDrive, navigateToFolder,
  //   navigateToBreadcrumb, toggleFileSelection, deselectAllFiles,
  //   downloadAndProcessFiles, searchItems, setSortBy, setSortDirection }
}
```

Provider hooks shrink to:

```js
// useNextcloudBrowser.js (~30 lines, was 310)
export const useNextcloudBrowser = () =>
  useCloudStorageBrowser({
    basePath: '/integrations/nextcloud',
    navigationModel: 'path',
    buildFolderQuery: (path) => ({ folderPath: path || undefined }),
    buildDownloadQuery: (item) => ({ filePath: item.path }),
    buildBreadcrumbFromItem: (folder) => ({
      id: folder.id, name: folder.name, path: folder.path
    }),
    buildBreadcrumbTarget: (crumb) => crumb.path || ''
  });

// useOffice365Browser.js (~40 lines, was 370)
export const useOffice365Browser = () =>
  useCloudStorageBrowser({
    basePath: '/integrations/office365',
    navigationModel: 'id',
    buildFolderQuery: (folderId, driveId) => ({ driveId, folderId }),
    buildDownloadQuery: (item, _, currentDrive) => ({
      fileId: item.id, driveId: currentDrive.id
    }),
    buildBreadcrumbFromItem: (folder) => ({
      id: folder.id, name: folder.name, type: 'folder'
    }),
    buildBreadcrumbTarget: (crumb) => crumb.type === 'drive' ? null : crumb.id
  });
```

The factory holds the four-way useState bag, the `selectedFiles` Map, the debounced search, the download progress reporter, and the `loadItems` / `navigateToFolder` / `navigateToBreadcrumb` / `searchItems` callbacks. Provider-specific differences thread through the four small builder functions.

### Layer 2: Shell component — `CloudFileBrowserShell`

```jsx
// client/src/features/upload/components/CloudFileBrowserShell.jsx
function CloudFileBrowserShell({
  provider,                  // the full provider object from platform.json
  useBrowserHook,            // the provider-specific hook (one of the three above)
  i18nKeys,                  // { notConnected, connectPrompt, connect }
  uploadConfig,
  onFilesProcessed,
  onClose
}) {
  // All four views (not-connected, sources, drives, files) live here.
  // Drive selection auto-skips when `drives.length === 1` so single-drive
  // providers (Nextcloud today) jump straight into files.
}
```

Each provider's component file collapses to:

```jsx
// NextcloudFileBrowser.jsx (~15 lines, was 570)
const NextcloudFileBrowser = (props) => (
  <CloudFileBrowserShell
    {...props}
    useBrowserHook={useNextcloudBrowser}
    i18nKeys={{
      notConnected: ['cloudStorage.nextcloud.notConnected', 'Nextcloud Not Connected'],
      connectPrompt: ['cloudStorage.nextcloud.connectPrompt',
        'Connect your Nextcloud account to browse and attach files from your Nextcloud instance.'],
      connect: ['cloudStorage.nextcloud.connect', 'Connect to Nextcloud']
    }}
  />
);
```

`CloudStoragePicker.jsx` is unchanged: it still imports the three named components and dispatches on `provider.type`.

### What stays per-provider

- Server-side `*Service.js` + `routes/integrations/*.js` — unchanged. The shell only knows about the basePath the hook calls.
- `i18nKeys` — three short keys per provider, defaulted to a sensible fallback.
- Drive-list semantics — handled by the factory's `loadDrivesForSource` plumbing (single-drive providers just have one entry).

## File-Level Changes

### New files

- `client/src/features/upload/hooks/useCloudStorageBrowser.js` (~350 lines, factored out)
- `client/src/features/upload/components/CloudFileBrowserShell.jsx` (~500 lines, factored out)

### Drastically slimmed files

- `client/src/features/upload/hooks/useOffice365Browser.js`: 370 → ~40 lines
- `client/src/features/upload/hooks/useGoogleDriveBrowser.js`: 370 → ~40 lines
- `client/src/features/upload/hooks/useNextcloudBrowser.js`: 310 → ~30 lines
- `client/src/features/upload/components/Office365FileBrowser.jsx`: 600 → ~20 lines
- `client/src/features/upload/components/GoogleDriveFileBrowser.jsx`: 600 → ~20 lines
- `client/src/features/upload/components/NextcloudFileBrowser.jsx`: 570 → ~20 lines

### Untouched

- `CloudStoragePicker.jsx`
- All `server/services/integrations/*.js`, `server/routes/integrations/*.js`
- `cloudStorageSchema.js`, `CloudStorageConfig.jsx`, `platform.json`
- Translation files (existing keys re-used; no breaking key removals)

**Net delta**: roughly **−1700 lines** of duplicate code traded for **+850 lines** of factored code → ~850-line net reduction, plus all future provider bugs/features land in one place.

## Migration Plan

Per the CLAUDE.md guidance against premature abstraction and half-finished implementations, the work is structured so each commit ships a fully working tree:

1. **Commit 1** — Add `useCloudStorageBrowser` + `CloudFileBrowserShell` alongside existing files. Wire **only Nextcloud** to use them. Office 365 / Google Drive untouched. Manual QA on Nextcloud picker.
2. **Commit 2** — Migrate Google Drive. Drop the now-orphaned `GoogleDriveFileBrowser` body, keep the file as a thin shim. Manual QA on Google Drive picker.
3. **Commit 3** — Migrate Office 365 the same way. Manual QA on Office 365 picker.
4. **Commit 4** — Remove the orphaned old hook+component code paths. Make sure no stale imports remain.

Each commit is independently revertable. Single PR or a small chain depending on review preference.

## Test Plan

### Automated

- A new `client/src/features/upload/__tests__/useCloudStorageBrowser.test.js` exercising:
  - Auth-status check → connected vs not-connected vs error transitions
  - Source / drive / items pagination handling
  - Path-based vs ID-based folder navigation (one test per `navigationModel` value)
  - Breadcrumb truncation on navigate-back
  - Selection set + deselect-all
  - Search debounce timing
- `CloudFileBrowserShell` snapshot tests across the four views (not-connected / sources / drives / files), driven by a fake `useBrowserHook`.
- Existing `nextcloud-service.test.js` and `office365-callback-url-autodetect.test.js` continue to pass unchanged (server side untouched).

### Manual / smoke

Per provider, after each migration commit:

- [ ] Connect → grant consent → return to picker shows "connected" without reload.
- [ ] Source list renders correct entries (3 for Office 365, 3 for Google Drive, 1 for Nextcloud).
- [ ] Drive selection step auto-skips when `drives.length === 1` (Nextcloud).
- [ ] Folder navigation: drill 3+ levels deep, verify breadcrumbs and back-to-drives.
- [ ] Search: type, debounce fires once, results filter the current folder.
- [ ] Sort by name / size / date in both directions.
- [ ] Multi-select 3 files → "Attach" → all three reach the chat with correct names and MIME types.
- [ ] Disconnect → reconnect cycle clears stored tokens correctly.
- [ ] Localized German UI shows the right strings (no fallback English leaks).

## Open Questions

1. Should `CloudFileBrowserShell` accept an optional `renderRowActions` slot for future per-provider row-level actions (e.g. Nextcloud share-link copy)? Default to "no slot" — add only if a concrete use case appears.
2. Should the shell's table use a virtualization library when the folder has many items, or stay with the current simple flex list? Current Nextcloud limit is implicit (10 MiB PROPFIND ≈ a few thousand entries). Defer until a user reports a performance issue.
3. Do we adopt a small TypeScript declaration file for the factory's options bag, even though the repo is JS? Probably not in this refactor; the JSDoc on the factory will be enough.

## Out of Scope (separate follow-ups)

- Per-provider token scoping (so a user can stay connected to two Office 365 tenants simultaneously) — see the security-parity concept.
- Switching from regex-based PROPFIND parsing to a streaming XML parser — only relevant if a user reports a parse bug.
- Adding a fourth provider (Dropbox, Box, S3) — easier *after* this refactor lands.

## Estimated Effort

- ~1.5 days for the factor-out + Nextcloud migration (commit 1)
- ~0.5 day each for Office 365 and Google Drive migration (commits 2 + 3)
- ~0.5 day for cleanup + tests (commit 4)
- Total: ~3 engineering days
