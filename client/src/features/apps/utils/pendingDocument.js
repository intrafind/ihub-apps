// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "pending document" contract: a link such as
 * `/apps?documentId=<id>&source=ifinder[&searchProfile=<id>][&prefill=…]` opens the
 * app picker with a document waiting to be attached; the app the user picks gets the same
 * parameters and `AppChat` attaches the document and strips them.
 *
 * Kept in one place so the picker, the start page and `AppChat` agree on the parameter names
 * and limits (the limits mirror `server/routes/sources.js`).
 *
 * @module features/apps/utils/pendingDocument
 */

export const DOCUMENT_ID_PARAM = 'documentId';
export const DOCUMENT_SOURCE_PARAM = 'source';
export const DOCUMENT_SCOPE_PARAM = 'searchProfile';
export const DOCUMENT_PREFILL_PARAM = 'prefill';

/**
 * Parameters that make up a pending document. Deliberately not `send`, `model` or `var_*`:
 * forwarding `send=true` would auto-send in whichever app the user happens to click.
 */
export const PENDING_DOCUMENT_PARAMS = Object.freeze([
  DOCUMENT_ID_PARAM,
  DOCUMENT_SOURCE_PARAM,
  DOCUMENT_SCOPE_PARAM,
  DOCUMENT_PREFILL_PARAM
]);

const SOURCE_PATTERN = /^[\w.-]{1,100}$/;
const MAX_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;
const MAX_PREFILL_CHARS = 2000;

/** True for a source provider id the sources route would accept. */
export const isValidDocumentSource = source =>
  typeof source === 'string' && SOURCE_PATTERN.test(source);

/**
 * The pending document a URL carries, or `null` when it carries none or an unusable one.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{documentId: string, source: string, searchProfile: string, prefill: string}|null}
 */
export function readPendingDocument(searchParams) {
  if (!searchParams) return null;
  const documentId = searchParams.get(DOCUMENT_ID_PARAM);
  const source = searchParams.get(DOCUMENT_SOURCE_PARAM);
  if (!documentId || documentId.length > MAX_ID_CHARS) return null;
  if (!isValidDocumentSource(source)) return null;

  const searchProfile = searchParams.get(DOCUMENT_SCOPE_PARAM) || '';
  return {
    documentId,
    source,
    searchProfile: searchProfile.length <= MAX_SCOPE_CHARS ? searchProfile : '',
    prefill: (searchParams.get(DOCUMENT_PREFILL_PARAM) || '').slice(0, MAX_PREFILL_CHARS)
  };
}

/**
 * The query string that hands a pending document to the next page (no leading `?`).
 *
 * @param {{documentId: string, source: string, searchProfile?: string, prefill?: string}} doc
 * @returns {string}
 */
export function pendingDocumentQuery(doc) {
  if (!doc) return '';
  const params = new URLSearchParams();
  params.set(DOCUMENT_ID_PARAM, doc.documentId);
  params.set(DOCUMENT_SOURCE_PARAM, doc.source);
  if (doc.searchProfile) params.set(DOCUMENT_SCOPE_PARAM, doc.searchProfile);
  if (doc.prefill) params.set(DOCUMENT_PREFILL_PARAM, doc.prefill);
  return params.toString();
}

/**
 * The URL's parameters without the pending document's, everything else kept.
 *
 * @param {URLSearchParams} searchParams
 * @returns {URLSearchParams}
 */
export function withoutPendingDocument(searchParams) {
  const next = new URLSearchParams(searchParams);
  PENDING_DOCUMENT_PARAMS.forEach(key => next.delete(key));
  return next;
}

/**
 * True when the app can take a document as input: a chat app whose file upload is on.
 *
 * @param {Object} app - an entry of `GET /api/apps`
 * @returns {boolean}
 */
export function appAcceptsDocuments(app) {
  if (!app) return false;
  if ((app.type || 'chat') !== 'chat') return false;
  return app.upload?.enabled !== false && app.upload?.fileUpload?.enabled === true;
}

/**
 * The text for a document that could not be attached, by the HTTP status of the failure.
 *
 * @param {number|undefined} status
 * @returns {'noAccess'|'notFound'|'failed'}
 */
export function documentFailureKind(status) {
  if (status === 401 || status === 403) return 'noAccess';
  if (status === 404) return 'notFound';
  return 'failed';
}
