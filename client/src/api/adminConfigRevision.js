// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optimistic locking for the admin pages that save the platform and UI
 * configuration, implemented once for all of them inside `makeAdminApiCall`.
 *
 * The server answers `GET /api/admin/configs/platform` and
 * `GET /api/admin/ui/config` with an `ETag` (the revision of the stored file),
 * and every successful write with the new one. This module remembers the last
 * revision this browser tab read or wrote for each file, and sends it as
 * `If-Match` on the next `POST` of that file. When someone else saved in
 * between (another admin, another tab, a script), the server refuses with
 * `412 PRECONDITION_FAILED` and writes nothing; this module then raises the
 * {@link CONFIG_CONFLICT_EVENT} window event, which `AdminConfigConflictNotice`
 * turns into one dialog: the page keeps the admin's edits, and they choose
 * whether to reload.
 *
 * Scoped writes (`PATCH`, which change only the fields they name) are not
 * guarded by default: a one-field toggle should not fail because another
 * section changed. A caller can still send its own `If-Match`.
 *
 * @module api/adminConfigRevision
 */

/** The window event raised when a save was refused because the file changed. */
export const CONFIG_CONFLICT_EVENT = 'adminConfigConflict';

/** The admin endpoints whose writes are guarded, by the resource they save. */
const GUARDED_ENDPOINTS = Object.freeze({
  '/admin/configs/platform': 'platform',
  '/admin/ui/config': 'ui'
});

/** Last known revision per resource, as the quoted ETag the server sent. */
const revisions = new Map();

/**
 * The guarded resource an admin API URL addresses, if any.
 *
 * @param {string} url - As passed to `makeAdminApiCall` (`/admin/...`, query allowed)
 * @returns {string|null} `'platform'`, `'ui'` or `null`
 */
export function guardedResourceOf(url) {
  if (typeof url !== 'string') return null;
  const path = (url.startsWith('/') ? url : `/${url}`).split(/[?#]/)[0].replace(/\/+$/, '');
  return GUARDED_ENDPOINTS[path] ?? null;
}

/** @param {Object|undefined} headers */
function hasHeader(headers, name) {
  return Object.keys(headers || {}).some(key => key.toLowerCase() === name.toLowerCase());
}

/**
 * The request headers with `If-Match` added where this module guards the write.
 *
 * @param {string} url
 * @param {string} method - HTTP method
 * @param {Object} headers - The request headers (not modified)
 * @returns {Object} Headers to send
 */
export function withIfMatch(url, method, headers) {
  const resource = guardedResourceOf(url);
  if (!resource || String(method).toUpperCase() !== 'POST') return headers;
  if (hasHeader(headers, 'If-Match')) return headers;
  const etag = revisions.get(resource);
  return etag ? { ...headers, 'If-Match': etag } : headers;
}

/**
 * Remember the revision a response carries (reads and successful writes).
 *
 * @param {string} url
 * @param {{headers?: Object}} response - An axios response
 */
export function rememberRevision(url, response) {
  const resource = guardedResourceOf(url);
  if (!resource) return;
  const headers = response?.headers || {};
  const etag = typeof headers.get === 'function' ? headers.get('etag') : headers.etag;
  if (typeof etag === 'string' && etag) revisions.set(resource, etag);
}

/**
 * Whether a failed admin call was refused because the configuration changed
 * since it was read.
 *
 * @param {unknown} error - An axios error
 * @returns {boolean}
 */
export function isConfigConflict(error) {
  return error?.response?.status === 412 && error?.response?.data?.code === 'PRECONDITION_FAILED';
}

/**
 * Raise the conflict notice for a refused save of a guarded resource.
 *
 * @param {string} url
 * @param {unknown} error - The axios error
 * @returns {boolean} Whether the notice was raised
 */
export function reportConfigConflict(url, error) {
  const resource = guardedResourceOf(url);
  if (!resource || !isConfigConflict(error)) return false;
  window.dispatchEvent(new CustomEvent(CONFIG_CONFLICT_EVENT, { detail: { resource } }));
  return true;
}

/** Forget every remembered revision (tests, sign-out). */
export function resetConfigRevisions() {
  revisions.clear();
}
