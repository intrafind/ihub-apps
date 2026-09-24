/**
 * Test mode of the admin app editor (issue #2510).
 *
 * The editor's test panel loads the real app page (`/apps/:appId`) in an
 * iframe with `?ihubPreview=1`, so the admin chats with exactly what end users
 * get. Inside that iframe the page renders without iHub's header, footer and
 * sidebar (see `integrationSettings.js`).
 *
 * The flag only exists on the iframe's first URL: in-app navigation (a new
 * chat, a chat id in the path) drops the query string. It is therefore read
 * once when this module loads and kept for the lifetime of the page. It is
 * never persisted, because the iframe shares localStorage and sessionStorage
 * with the admin's own tab. It is also ignored outside an iframe, so a pasted
 * preview link opens the app normally.
 */
export const APP_PREVIEW_PARAM = 'ihubPreview';

function detectAppPreviewMode() {
  if (typeof window === 'undefined') return false;
  let framed;
  try {
    framed = window.self !== window.top;
  } catch {
    // Reading window.top across origins throws, which also means we're framed.
    framed = true;
  }
  if (!framed) return false;
  return new URLSearchParams(window.location.search).get(APP_PREVIEW_PARAM) === '1';
}

let detected = detectAppPreviewMode();

/** Whether this page is the app editor's test panel. */
export function isAppPreviewMode() {
  return detected;
}

/** Test hook: detect again from the current location. */
export function resetAppPreviewModeDetection() {
  detected = detectAppPreviewMode();
}

/**
 * Router path of an app's chat page, relative to the base path.
 * Pass the result through `buildPath` for an `href` or iframe `src`.
 *
 * @param {string} appId - The app identifier
 * @param {{ preview?: boolean }} [options] - `preview: true` adds the test-panel flag
 * @returns {string} e.g. `/apps/my-app` or `/apps/my-app?ihubPreview=1`
 */
export function appChatPath(appId, { preview = false } = {}) {
  const path = `/apps/${encodeURIComponent(appId)}`;
  return preview ? `${path}?${APP_PREVIEW_PARAM}=1` : path;
}
