# Offline Office.js and Error Handling

**Date:** 2026-07-06  
**Issue:** [#1670](https://github.com/intrafind/ihub-apps/issues/1670)  
**Status:** Implemented

---

## Problem

Some enterprise customers block outbound access to `appsforoffice.microsoft.com` and `microsoft.com`. This caused the Outlook add-in to silently fail — users saw a blank or broken page with no guidance. Two distinct problems were identified:

### Case 1 — Uncaught JavaScript Errors

If Office.js could not load (CDN blocked), or any other JS error occurred, the add-in showed nothing useful. Errors were invisible to both users and admins.

### Case 2 — Office.js Not Available Offline

There was no mechanism to serve Office.js from the iHub Apps server itself, so environments with blocked internet access could not use the add-in at all.

---

## Solution

### Case 1 — Global JS Error Handling (`client/office/taskpane.html`)

A global error-handler IIFE is injected as the **first `<script>` in `<head>`** before office.js loads. It:

- Catches synchronous JS errors via `window.onerror`
- Catches async promise rejections via `window.addEventListener('unhandledrejection', ...)`
- Handles the specific case where the office.js CDN `<script>` tag fires `onerror` (CDN blocked)
- Shows a visible `#office-error-page` div with a human-readable title, message, and collapsible technical detail panel
- Queues errors that fire before `<body>` is parsed (DOM-ready queue pattern)

For `commands.html` (background command surface), errors are logged to `console.error` only — no UI is shown since commands have no visible surface.

For `callback.html` (OAuth callback), load errors update the `#status` text element.

### Case 2 — Offline Office.js

#### Install & Build

`@microsoft/office-js` is installed as a **devDependency** in `client/package.json`. A custom Vite plugin (`copyOfficeJsPlugin` in `client/vite.config.js`) runs after the production bundle is built and copies the entire `@microsoft/office-js/dist` directory to `dist/office/office-js/`.

This means the full ~86 MB office.js distribution (including locale sub-files that office.js lazy-loads at runtime) is bundled in production builds.

#### Server-Side URL Injection

`server/routes/office.js` no longer uses `res.sendFile()` for the main HTML files. Instead, a `renderOfficeHtml(filePath, config)` helper reads the HTML with `fs.readFileSync`, then:

- If `config.officeIntegration.useLocalOfficejs === true`: replaces the CDN URL with the relative path `./office-js/office.js`
- Otherwise: serves the file unchanged (CDN URL)

A new static route `/office/office-js` serves the local distribution files:

- **Dev**: from `client/node_modules/@microsoft/office-js/dist`
- **Prod**: from `public/office/office-js`

#### Configuration

A new boolean flag `useLocalOfficejs` (default `false`) was added to `officeIntegration` in:

- `server/defaults/config/platform.json` (fresh installs)
- `server/migrations/V066__office_use_local_officejs.js` (existing installs)

#### Admin API

`server/routes/admin/officeIntegration.js` was updated to:

- Include `useLocalOfficejs` in the GET `/api/admin/office-integration/status` response
- Accept, validate, and persist `useLocalOfficejs` in the PUT `/api/admin/office-integration/config` endpoint

#### Admin UI

`client/src/features/admin/pages/AdminOfficeIntegrationPage.jsx` was updated with a new "Offline Mode" section that shows:

- A toggle switch for `useLocalOfficejs`
- A yellow warning banner explaining the ~86 MB size impact and that Microsoft AppSource publishing is not compatible with this mode

---

## Important Constraints

| Constraint | Detail |
|---|---|
| HTTPS required | Even for local/offline deployments, Office client refuses to load add-in scripts served over plain HTTP. |
| AppSource incompatible | Microsoft rejects add-ins during certification if they don't load Office.js from the official CDN. For internal enterprise sideloading only. |
| Lazy-loaded sub-files | office.js dynamically loads platform-specific files (e.g. `outlook-win32-16.01.js`). The entire `dist/` folder must be present. |
| Relative URL | The injected URL is `./office-js/office.js` (relative) not `/office/office-js/office.js` (absolute) to support subpath deployments. |
| Strict boolean check | Server uses `=== true` (strict equality) to avoid truthy-string issues from legacy config values. |

---

## Files Changed

| File | Change |
|---|---|
| `client/office/taskpane.html` | Global error handler + error page UI |
| `client/office/commands.html` | Console error handlers |
| `client/public/office/callback.html` | Status text error handler |
| `client/vite.config.js` | `copyOfficeJsPlugin` |
| `client/package.json` | `@microsoft/office-js` devDependency |
| `server/routes/office.js` | `renderOfficeHtml()` helper + local static route |
| `server/routes/admin/officeIntegration.js` | `useLocalOfficejs` in GET + PUT |
| `server/defaults/config/platform.json` | `useLocalOfficejs: false` default |
| `server/migrations/V066__office_use_local_officejs.js` | Migration for existing installs |
| `client/src/features/admin/pages/AdminOfficeIntegrationPage.jsx` | Offline Mode toggle + warning |
| `shared/i18n/en.json` | `offlineTitle`, `offlineDesc`, `offlineLabel`, `offlineWarning` |
| `shared/i18n/de.json` | Same keys in German |
