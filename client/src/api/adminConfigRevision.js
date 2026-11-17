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
 * between reloading and keeping their edits. Keeping them re-reads the current
 * revision, so the next save deliberately replaces the newer version.
 *
 * Scoped writes (`PATCH`, which change only the fields they name) are not
 * guarded by default: a one-field toggle should not fail because another
 * section changed. A caller can still send its own `If-Match`. Their responses
 * do not advance the remembered revision either: a full-config form loaded
 * earlier in this tab has not seen the changes between its load and the
 * PATCH (another admin's included), so its next POST must still be checked
 * against the revision it loaded.
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

/**
 * The admin read that answers each guarded resource's current `ETag`; the
 * paths of {@link GUARDED_ENDPOINTS}, keyed the other way round.
 *
 * @param {string} resource - `'platform'` or `'ui'`
 * @returns {string|null} The URL to pass to `makeAdminApiCall`, or `null`
 */
export function revisionReadUrlOf(resource) {
  const entry = Object.entries(GUARDED_ENDPOINTS).find(([, name]) => name === resource);
  return entry ? entry[0] : null;
}

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

/** The methods whose response revision a full-config form may build on. */
const REVISION_METHODS = new Set(['GET', 'POST']);

/**
 * Remember the revision a response carries: full reads (`GET`) and full
 * writes (`POST`). A scoped `PATCH` response is ignored, because the page
 * that saves the whole file next did not load what that revision contains.
 *
 * @param {string} url
 * @param {{headers?: Object}} response - An axios response
 * @param {string} [method='GET'] - HTTP method of the request
 */
export function rememberRevision(url, response, method = 'GET') {
  const resource = guardedResourceOf(url);
  if (!resource || !REVISION_METHODS.has(String(method).toUpperCase())) return;
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
