/**
 * Selection bridge between the Nextcloud-side app shell and the embedded
 * iHub iframe.
 *
 * The Nextcloud shell can hand a selection to the iframe two ways:
 *
 *   1. **URL hash** at navigation time — e.g.
 *        `/nextcloud/full-embed.html#providerId=cloud-main&paths=%5B%22%2FReports%2Fq1.pdf%22%5D`
 *      This is the simple path: a hard `window.location.assign` to the
 *      iframe URL carries the selection in the hash. No postMessage
 *      handshake required for the first selection.
 *
 *   2. **`postMessage`** at runtime — for ongoing selection updates when
 *      the iframe is already mounted (user opens Nextcloud Files in a
 *      side-by-side pane and changes selection). Payload shape:
 *        `{ kind: 'ihub.nextcloud.selection', providerId: string, paths: string[] }`
 *      Origin is checked against `allowedHostOrigins` from the runtime
 *      config (`/api/integrations/nextcloud-embed/config`).
 *
 * The bridge is intentionally a thin event source. It does not fetch
 * anything; `useNextcloudEmbedAttachments` consumes the latest selection
 * and calls the existing `/api/integrations/nextcloud/download` endpoint
 * for each path.
 *
 * @typedef {Object} NextcloudSelection
 * @property {string} providerId  Nextcloud cloud-storage provider id (matches
 *                                the existing cloudStorage providers admin UI).
 * @property {string[]} paths     File paths inside the user's Nextcloud root.
 */

const SELECTION_MESSAGE_KIND = 'ihub.nextcloud.selection';
const MAX_PATHS = 50;

let currentSelection = null;
let allowedHostOrigins = [];
const listeners = new Set();
let messageListener = null;
let hashListener = null;

function sanitizePaths(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > MAX_PATHS) return null;
  const out = [];
  for (const path of value) {
    if (typeof path !== 'string') return null;
    if (path.length === 0 || path.length > 4096) return null;
    if (path.includes('\0')) return null;
    // No `..` segments — defense in depth even though the server enforces
    // this on `/download` (the server is the authority on path safety; this
    // check only filters obvious garbage before the UI shows it). Variants
    // like url-encoded `%2e%2e` arrive here as opaque string segments and
    // are forwarded to the server, which decodes and rejects them.
    const segments = path.split('/');
    if (segments.some(seg => seg === '..')) return null;
    out.push(path);
  }
  return out;
}

function sanitizeSelectionPayload(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.providerId !== 'string' || value.providerId.length === 0) return null;
  if (value.providerId.length > 200) return null;
  const paths = sanitizePaths(value.paths);
  if (!paths) return null;
  return { providerId: value.providerId, paths };
}

function notifyListeners() {
  for (const cb of listeners) {
    try {
      cb(currentSelection);
    } catch {
      /* swallow listener errors so one bad consumer doesn't break the rest */
    }
  }
}

function setSelection(next) {
  // Replace, don't merge — Nextcloud is the source of truth for the
  // current selection. An empty paths array means "no selection".
  currentSelection = next;
  notifyListeners();
}

function parseHashSelection() {
  // window.location.hash always starts with `#` (or is empty); strip it
  // and parse as URLSearchParams so we get robust percent-decoding.
  const raw = (window.location.hash || '').replace(/^#/, '');
  if (!raw) return null;
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const providerId = params.get('providerId');
  const pathsJson = params.get('paths');
  if (!providerId || !pathsJson) return null;
  let paths;
  try {
    paths = JSON.parse(pathsJson);
  } catch {
    return null;
  }
  return sanitizeSelectionPayload({ providerId, paths });
}

function originIsAllowed(origin) {
  if (typeof origin !== 'string') return false;
  // The embed is loaded inside an iframe from a Nextcloud origin, so the
  // parent's origin must match one of the admin-configured entries.
  return allowedHostOrigins.includes(origin);
}

/**
 * Initialise the bridge. Idempotent — calling twice replaces the previous
 * allowlist but keeps the existing selection. Call once after fetching the
 * runtime config from `/api/integrations/nextcloud-embed/config`.
 *
 * @param {{ allowedHostOrigins?: string[] }} options
 */
export function initNextcloudSelectionBridge(options = {}) {
  allowedHostOrigins = Array.isArray(options.allowedHostOrigins)
    ? options.allowedHostOrigins.slice()
    : [];

  // Seed from the URL hash. The Nextcloud-side app navigates to the embed
  // URL with the selection encoded in the hash, so this lights up before
  // any postMessage arrives.
  const hashSelection = parseHashSelection();
  if (hashSelection) {
    setSelection(hashSelection);
  }

  if (!messageListener) {
    messageListener = event => {
      if (!originIsAllowed(event.origin)) return;
      const payload = event.data;
      if (!payload || payload.kind !== SELECTION_MESSAGE_KIND) return;
      const next = sanitizeSelectionPayload(payload);
      if (!next) return;
      setSelection(next);
    };
    window.addEventListener('message', messageListener);
  }

  if (!hashListener) {
    hashListener = () => {
      const next = parseHashSelection();
      if (next) setSelection(next);
    };
    window.addEventListener('hashchange', hashListener);
  }
}

/**
 * Tear down listeners. Mainly useful in tests; production code can leave
 * the bridge running for the lifetime of the embed.
 */
export function destroyNextcloudSelectionBridge() {
  if (messageListener) {
    window.removeEventListener('message', messageListener);
    messageListener = null;
  }
  if (hashListener) {
    window.removeEventListener('hashchange', hashListener);
    hashListener = null;
  }
  listeners.clear();
  currentSelection = null;
  allowedHostOrigins = [];
}

/**
 * @returns {NextcloudSelection|null}
 */
export function getCurrentSelection() {
  return currentSelection;
}

/**
 * Subscribe to selection changes. Returns an unsubscribe function.
 * @param {(selection: NextcloudSelection|null) => void} cb
 */
export function onSelectionChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Exported for tests.
export const __internal = {
  sanitizeSelectionPayload,
  parseHashSelection,
  SELECTION_MESSAGE_KIND
};
