/**
 * iHub Apps browser extension — service worker (Manifest V3).
 *
 * Most of the extension's behaviour now lives in the React side-panel app
 * built by Vite from `client/extension/sidepanel-entry.jsx`. The side panel
 * makes its own `fetch` calls (OAuth token exchange, /api/apps,
 * /api/apps/{id}/chat/{cid}) directly to the iHub server, with tokens
 * stored in `chrome.storage.{session,local}` from the React tree.
 *
 * The service worker therefore has only one job: arrange for clicking the
 * toolbar action to open the side panel. Everything else (auth, chat,
 * page extraction) runs in the side panel context where the React app
 * already has the relevant Chrome extension permissions.
 */

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.warn('sidePanel.setPanelBehavior failed', err));
}
