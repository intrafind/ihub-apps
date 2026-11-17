// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optimistic locking for the admin pages that save the platform and UI
 * configuration, implemented once for all of them inside `makeAdminApiCall`.
 *
 * The server answers `GET /api/admin/configs/platform` and
 * `GET /api/admin/ui/config` with an `ETag` (the revision of the stored file),
 * and every successful write with the new one.
 *
 * The revision belongs to the form that loaded it, never to the browser tab:
 * a page creates a revision holder ({@link createConfigRevision}, or a React
 * `useRef(null)`) and passes it as the `revision` option of the `GET` that
 * fills its form and of the `POST` that saves it. `makeAdminApiCall` stores the
 * `ETag` of that `GET` (and of each successful `POST`) in the holder and sends
 * it as `If-Match` on the `POST`. A read of the same file by another page or
 * card in the same tab cannot change what this form sends: had it done so, a
 * form loaded at revision R1 could save its R1-based edits with the R2 a later
 * read brought in, and erase the change between R1 and R2.
 *
 * When someone else saved in between (another admin, another tab, a script),
 * the server refuses with `412 PRECONDITION_FAILED` and writes nothing; this
 * module then raises the {@link CONFIG_CONFLICT_EVENT} window event with the
 * form's holder, which `AdminConfigConflictNotice` turns into one dialog: the
 * page keeps the admin's edits, and they choose between reloading and keeping
 * their edits. Keeping them re-reads the current revision into that form's
 * holder only, so that form's next save deliberately replaces the newer
 * version.
 *
 * Calls without a holder send no `If-Match` and behave as before. Scoped
 * writes (`PATCH`, which change only the fields they name) are not guarded:
 * a one-field toggle should not fail because another section changed. A
 * caller can still send its own `If-Match` header.
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

/**
 * The guarded resource an admin API URL addresses, if any.
 *
 * @param {string} url - As passed to `makeAdminApiCall` (`/admin/...`, query allowed)
 * @returns {string|null} `'platform'`, `'ui'` or `null`
 */
export function guardedResourceOf(url) {
  if (typeof url !== 'string') return null;
  const path = withoutTrailingSlashes((url.startsWith('/') ? url : `/${url}`).split(/[?#]/)[0]);
  return GUARDED_ENDPOINTS[path] ?? null;
}

/**
 * `path` without the slashes it ends with. A loop rather than `/\/+$/`, which
 * takes quadratic time on a long run of slashes that does not end the string.
 *
 * @param {string} path
 * @returns {string}
 */
function withoutTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** @param {Object|undefined} headers */
function hasHeader(headers, name) {
  return Object.keys(headers || {}).some(key => key.toLowerCase() === name.toLowerCase());
}

/**
 * A revision holder for one form: pass it as the `revision` option of the
 * `makeAdminApiCall` that loads the form and of the one that saves it. A React
 * component can use `useRef(null)` instead, which has the same shape.
 *
 * @returns {{current: string|null}} The holder, empty until the first read
 */
export function createConfigRevision() {
  return { current: null };
}

/**
 * The request headers with `If-Match` added where this module guards the write:
 * a `POST` of a guarded resource whose form holds a revision.
 *
 * @param {string} url
 * @param {string} method - HTTP method
 * @param {Object} headers - The request headers (not modified)
 * @param {{current: string|null}} [revision] - The saving form's revision holder
 * @returns {Object} Headers to send
 */
export function withIfMatch(url, method, headers, revision) {
  if (!guardedResourceOf(url) || String(method).toUpperCase() !== 'POST') return headers;
  if (hasHeader(headers, 'If-Match')) return headers;
  const etag = revision?.current;
  return etag ? { ...headers, 'If-Match': etag } : headers;
}

/** The methods whose response revision a full-config form may build on. */
const REVISION_METHODS = new Set(['GET', 'POST']);

/**
 * Store the revision a response carries in the form's holder: its own full
 * read (`GET`) and its own full write (`POST`). A scoped `PATCH` response is
 * ignored, because the form that saves the whole file next did not load what
 * that revision contains.
 *
 * @param {string} url
 * @param {{headers?: Object}} response - An axios response
 * @param {string} method - HTTP method of the request
 * @param {{current: string|null}} [revision] - The form's revision holder
 */
export function captureRevision(url, response, method, revision) {
  if (!revision || !guardedResourceOf(url)) return;
  if (!REVISION_METHODS.has(String(method).toUpperCase())) return;
  const headers = response?.headers || {};
  const etag = typeof headers.get === 'function' ? headers.get('etag') : headers.etag;
  if (typeof etag === 'string' && etag) revision.current = etag;
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
 * Raise the conflict notice for a refused save of a guarded resource. The
 * event carries the saving form's holder, so "Keep my changes" re-reads the
 * revision for that form only.
 *
 * @param {string} url
 * @param {unknown} error - The axios error
 * @param {{current: string|null}} [revision] - The saving form's revision holder
 * @returns {boolean} Whether the notice was raised
 */
export function reportConfigConflict(url, error, revision) {
  const resource = guardedResourceOf(url);
  if (!resource || !isConfigConflict(error)) return false;
  window.dispatchEvent(
    new CustomEvent(CONFIG_CONFLICT_EVENT, { detail: { resource, revision: revision ?? null } })
  );
  return true;
}
