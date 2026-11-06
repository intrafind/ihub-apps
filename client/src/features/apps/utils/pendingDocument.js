// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "pending document" contract: a link such as
 * `/apps?documentId=<id>&integration=ifinder[&searchProfile=<id>][&prefill=…]` opens the app
 * picker with a document waiting to be attached; the app the user picks gets the same
 * parameters and the chat attaches the document and strips them.
 *
 * `integration` is the id of an installed integration that hands documents over by reference
 * (the `files` capability, `GET /api/integrations/:integration/files/*`). Kept in one place so the picker,
 * the start page and the chat agree on the parameter names and limits (the limits mirror
 * `server/routes/integrations/files.js`).
 *
 * @module features/apps/utils/pendingDocument
 */
import { contentTypeFromExtension } from '../../nextcloud-embed/utilities/nextcloudFileMeta';

export const DOCUMENT_ID_PARAM = 'documentId';
export const DOCUMENT_INTEGRATION_PARAM = 'integration';
export const DOCUMENT_SCOPE_PARAM = 'searchProfile';
export const DOCUMENT_PREFILL_PARAM = 'prefill';

/**
 * Parameters that make up a pending document. Deliberately not `send`, `model` or `var_*`:
 * forwarding `send=true` would auto-send in whichever app the user happens to click.
 */
export const PENDING_DOCUMENT_PARAMS = Object.freeze([
  DOCUMENT_ID_PARAM,
  DOCUMENT_INTEGRATION_PARAM,
  DOCUMENT_SCOPE_PARAM,
  DOCUMENT_PREFILL_PARAM
]);

const INTEGRATION_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_ID_CHARS = 1024;
const MAX_SCOPE_CHARS = 256;
const MAX_PREFILL_CHARS = 2000;

/** True for an installation id the integration routes would accept. */
export const isValidIntegrationId = integration =>
  typeof integration === 'string' && INTEGRATION_PATTERN.test(integration);

/**
 * The pending document a URL carries, or `null` when it carries none or an unusable one.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{documentId: string, integration: string, searchProfile: string, prefill: string}|null}
 */
export function readPendingDocument(searchParams) {
  if (!searchParams) return null;
  const documentId = searchParams.get(DOCUMENT_ID_PARAM);
  const integration = searchParams.get(DOCUMENT_INTEGRATION_PARAM);
  if (!documentId || documentId.length > MAX_ID_CHARS) return null;
  if (!isValidIntegrationId(integration)) return null;

  const searchProfile = searchParams.get(DOCUMENT_SCOPE_PARAM) || '';
  return {
    documentId,
    integration,
    searchProfile: searchProfile.length <= MAX_SCOPE_CHARS ? searchProfile : '',
    prefill: (searchParams.get(DOCUMENT_PREFILL_PARAM) || '').slice(0, MAX_PREFILL_CHARS)
  };
}

/**
 * The query string that hands a pending document to the next page (no leading `?`).
 *
 * @param {{documentId: string, integration: string, searchProfile?: string, prefill?: string}} doc
 * @returns {string}
 */
export function pendingDocumentQuery(doc) {
  if (!doc) return '';
  const params = new URLSearchParams();
  params.set(DOCUMENT_ID_PARAM, doc.documentId);
  params.set(DOCUMENT_INTEGRATION_PARAM, doc.integration);
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
 * The ref the integration's routes take (`{ id, scope? }`).
 *
 * @param {{documentId: string, searchProfile?: string}} doc
 * @returns {{id: string, scope?: string}}
 */
export function documentRefOf(doc) {
  return doc.searchProfile
    ? { id: doc.documentId, scope: doc.searchProfile }
    : { id: doc.documentId };
}

/**
 * Whether an app binds an integration: a key of `app.integrations` that is the installation's id,
 * its definition's id (every installation of the definition) or `type:<type>` (every
 * installation of the type). `info` is the probe's answer (`GET /api/integrations/:id/files`).
 *
 * @param {Object} app - an entry of `GET /api/apps`
 * @param {{id: string, definition?: string, type?: string|null}} info
 * @returns {boolean}
 */
export function appBindsIntegration(app, info) {
  const bindings = app?.integrations;
  if (!info?.id || !bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    return false;
  }
  return [info.id, info.definition, info.type ? `type:${info.type}` : null].some(
    key => typeof key === 'string' && Object.hasOwn(bindings, key)
  );
}

/**
 * What kind of attachment a document becomes: `image` (resized for a vision model), `audio`, or
 * `document` (text extraction, original kept) — the same split `processCloudFile` makes.
 *
 * @param {{mediaType?: string, filename?: string, contentType?: string}} details
 * @returns {'image'|'audio'|'document'}
 */
export function documentKindOf({ mediaType, filename, contentType } = {}) {
  const fromName = filename ? contentTypeFromExtension(filename) : 'application/octet-stream';
  const type = [fromName, contentType, mediaType].find(
    candidate => typeof candidate === 'string' && /^(image|audio)\//.test(candidate)
  );
  if (type?.startsWith('image/') && /^image\/(jpe?g|png|gif|webp)$/.test(type)) return 'image';
  if (type?.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Whether the picker offers an app for a pending document: a chat app that **binds the
 * integration** the document comes from. The binding is what lets an app receive the integration's
 * documents (as it lets an app attach files from a storage provider, whatever its local upload
 * settings say); an app that never opted into the integration never receives its documents.
 *
 * @param {Object} app - an entry of `GET /api/apps`
 * @param {{id: string, definition?: string, type?: string|null}} info - the probe's answer
 * @returns {boolean}
 */
export function appCanTakeDocument(app, info) {
  if (!app || (app.type || 'chat') !== 'chat') return false;
  return appBindsIntegration(app, info);
}

/**
 * Whether a chat can take the pending document now: this route's own app is loaded (the route
 * resolves an app id case-insensitively, so `/apps/Summarizer` loads the app `summarizer`), its
 * settings are initialized for it rather than for the previous app, the models have loaded and one
 * is selected (the model decides what an image or audio needs).
 *
 * @param {Object} state
 * @param {Object|null} state.app - the loaded app
 * @param {string} [state.appId] - the route's app id
 * @param {boolean} state.modelsLoading
 * @param {string|null} state.settingsInitializedFor - the app id `useAppSettings` initialized
 * @param {Object|null} state.model - the selected model object
 * @returns {boolean}
 */
export function isChatReadyForDocument({
  app,
  appId,
  modelsLoading,
  settingsInitializedFor,
  model
}) {
  return Boolean(
    app &&
    appId &&
    String(app.id).toLowerCase() === String(appId).toLowerCase() &&
    !modelsLoading &&
    settingsInitializedFor === app.id &&
    model
  );
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
