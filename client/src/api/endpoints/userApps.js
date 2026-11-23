// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * The personal apps API (`/api/apps`, the routes of a user's own apps).
 *
 * A personal app is created, shared and handed over by users. Every app comes
 * back with the `permissions` the server computed for the caller; the UI uses
 * them to show or hide actions, every check runs on the server.
 *
 * The client calls these routes only while the feature `userApps` is on.
 * Nothing here is cached. A failed call rejects with the error of
 * `enhanceApiError`: `status`, `code` (a registry code such as
 * `QUOTA_USER_APPS`), and the server's body on
 * `error.originalError.response.data` (`detail`, `details`).
 *
 * **Optimistic locking.** An app carries its `revision`. Every write that
 * takes `revision` sends it as `If-Match: "<revision>"`, the value of the
 * `ETag` the server sent with that state; a newer stored state answers 409
 * `ETAG_MISMATCH`.
 */

const APPS_PATH = '/apps';

/** Path of one app, with the ID encoded for the URL. */
const appPath = appId => `${APPS_PATH}/${encodeURIComponent(appId)}`;

/** One uncached call through the shared error handling. */
const call = request => handleApiResponse(request, null, null, false);

/**
 * The `If-Match` header for a revision, or no header without one.
 *
 * @param {number|null|undefined} revision
 * @returns {{headers: {'If-Match': string}}|undefined}
 *
 * @example
 * ifMatch(7); // → { headers: { 'If-Match': '"7"' } }
 */
export const ifMatch = revision =>
  Number.isInteger(revision) && revision > 0
    ? { headers: { 'If-Match': `"${revision}"` } }
    : undefined;

/**
 * What personal apps offer the caller: whether the feature is on, whether
 * they may create, share and publish, the limit, and the capabilities an app
 * of theirs may ask for.
 *
 * @param {{language?: string}} [options]
 * @returns {Promise<{enabled: boolean, canCreate: boolean, canShare: boolean,
 *   canPublish: boolean, maxApps: number, used: number, generator: boolean,
 *   capabilities: Object}>} The `userApps` block of the answer.
 */
export const fetchUserAppsConfig = async ({ language } = {}) => {
  const data = await call(() =>
    apiClient.get(`${APPS_PATH}/_config`, language ? { params: { language } } : undefined)
  );
  return data?.userApps || { enabled: false, canCreate: false, canShare: false };
};

/**
 * The personal apps of the caller.
 *
 * @param {{scope?: 'mine'|'shared'|'personal'}} [options] - `mine`: owned, plus
 *   the apps offered to the caller (`permissions.canAcceptOffer`). `shared`:
 *   shared with the caller. `personal`: both.
 * @returns {Promise<Array<Object>>} The full app where the caller may use it,
 *   the reduced body (no instructions, no capabilities) otherwise.
 */
export const fetchUserApps = async ({ scope = 'personal' } = {}) => {
  const data = await call(() => apiClient.get(APPS_PATH, { params: { scope } }));
  return Array.isArray(data?.items) ? data.items : [];
};

/**
 * One personal app as the caller may read it.
 *
 * @param {string} appId
 * @returns {Promise<Object>}
 */
export const fetchUserApp = appId => call(() => apiClient.get(appPath(appId)));

/**
 * The templates a personal app can start from.
 *
 * @returns {Promise<Array<Object>>}
 */
export const fetchUserAppTemplates = async () => {
  const data = await call(() => apiClient.get(`${APPS_PATH}/_templates`));
  return Array.isArray(data?.items) ? data.items : [];
};

/** How long a draft request may take: the server gives the model 80 seconds. */
const USER_APP_DRAFT_TIMEOUT_MS = 90000;

/**
 * Draft an app from a description. Request and response are those of the
 * admin draft route. Aborting the signal cancels the request, and the server
 * then stops the model call.
 *
 * @param {{description: string, language?: string, signal?: AbortSignal}} request
 * @returns {Promise<Object>}
 */
export const generateUserApp = ({ description, language, signal } = {}) =>
  call(() =>
    apiClient.post(
      `${APPS_PATH}/_generate`,
      { description, ...(language ? { language } : {}) },
      { timeout: USER_APP_DRAFT_TIMEOUT_MS, signal }
    )
  );

/**
 * Ask an AI model for one change to a personal app, or one question about it
 * (`POST /api/apps/_revise`). Request and response are those of the admin
 * route (`POST /api/admin/apps/_revise`); nothing is stored. Aborting the
 * signal cancels the request, and the server then stops the model call.
 *
 * @param {Object} request
 * @param {Object} request.draft - The app's content as the editor holds it.
 * @param {Array<{role: 'author'|'builder', kind?: string, text: string}>} request.conversation
 * @param {string} [request.language] - The content language of the app.
 * @param {string[]} [request.fields] - Restrict the change to these content keys.
 * @param {boolean} [request.allowQuestions] - `false`: the answer is never a question.
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<Object>} `{ reply, text, question, patch, changed, suggestions, warnings, model }`
 */
export const reviseUserApp = ({
  draft,
  conversation,
  language,
  fields,
  allowQuestions,
  signal
} = {}) =>
  call(() =>
    apiClient.post(
      `${APPS_PATH}/_revise`,
      {
        draft,
        conversation,
        ...(language ? { language } : {}),
        ...(Array.isArray(fields) && fields.length > 0 ? { fields } : {}),
        ...(typeof allowQuestions === 'boolean' ? { allowQuestions } : {})
      },
      { timeout: USER_APP_DRAFT_TIMEOUT_MS, signal }
    )
  );

/**
 * The people and groups an app can be shared with or handed over to.
 *
 * @param {{q?: string, purpose?: 'share'|'offer'}} [options] - `offer` answers
 *   users only, for the hand-over dialog.
 * @returns {Promise<{allowed: {user: boolean, group: boolean, everyone: boolean}|null,
 *   users: Array<Object>, groups: Array<Object>, everyone: boolean}>} `allowed`: which
 *   kinds of target the installation lets the caller pick; null when the server
 *   did not say.
 */
export const fetchUserAppShareTargets = async ({ q = '', purpose } = {}) => {
  const data = await call(() =>
    apiClient.get(`${APPS_PATH}/_share-targets`, {
      params: { q, ...(purpose ? { purpose } : {}) }
    })
  );
  const allowed = data?.allowed;
  return {
    allowed:
      allowed && typeof allowed === 'object'
        ? {
            user: allowed.user === true,
            group: allowed.group === true,
            everyone: allowed.everyone === true
          }
        : null,
    users: Array.isArray(data?.users) ? data.users : [],
    groups: Array.isArray(data?.groups) ? data.groups : [],
    everyone: data?.everyone === true
  };
};

/**
 * Create a personal app owned by the caller.
 *
 * @param {Object} body - `{ language, origin, ...content }`, the content keys
 *   of `pickUserAppContent` (shared/userAppContent.js).
 * @returns {Promise<Object>} The created app.
 */
export const createUserApp = body => call(() => apiClient.post(APPS_PATH, body));

/**
 * Change the content of an app (owner and "Can edit"). A JSON Merge Patch
 * over the content keys.
 *
 * @param {string} appId
 * @param {Object} changes
 * @param {{revision?: number}} [options] - The revision the change was made on.
 * @returns {Promise<Object>} The updated app.
 */
export const updateUserApp = (appId, changes, { revision } = {}) =>
  call(() => apiClient.patch(appPath(appId), changes, ifMatch(revision)));

/**
 * Delete an app (owner).
 *
 * @param {string} appId
 * @returns {Promise<void>}
 */
export const deleteUserApp = async appId => {
  await call(() => apiClient.delete(appPath(appId)));
};

/**
 * Copy an app into one the caller owns, without members.
 *
 * @param {string} appId
 * @returns {Promise<Object>} The new app.
 */
export const duplicateUserApp = appId => call(() => apiClient.post(`${appPath(appId)}/_duplicate`));

/**
 * Replace the member list of an app.
 *
 * @param {string} appId
 * @param {Array<{type: 'user'|'group'|'everyone', id?: string, role: 'user'|'editor'}>} members
 * @param {{revision?: number}} [options]
 * @returns {Promise<Object>} The updated app.
 */
export const setUserAppMembers = (appId, members, { revision } = {}) =>
  call(() => apiClient.put(`${appPath(appId)}/members`, { members }, ifMatch(revision)));

/**
 * Remove the caller's own share of an app.
 *
 * @param {string} appId
 * @returns {Promise<void>}
 */
export const leaveUserApp = async appId => {
  await call(() => apiClient.post(`${appPath(appId)}/_leave`));
};

/**
 * Offer an app to another user. Nothing changes until they accept.
 *
 * @param {string} appId
 * @param {string} ownerId - The user asked to take the app over.
 * @param {{revision?: number}} [options]
 * @returns {Promise<Object>} The app, with `pendingOwner`.
 */
export const offerUserApp = (appId, ownerId, { revision } = {}) =>
  call(() => apiClient.put(`${appPath(appId)}/owner-offer`, { ownerId }, ifMatch(revision)));

/**
 * Withdraw an offer (owner, full admin) or decline it (receiver).
 *
 * @param {string} appId
 * @returns {Promise<void>}
 */
export const clearUserAppOffer = async appId => {
  await call(() => apiClient.delete(`${appPath(appId)}/owner-offer`));
};

/**
 * Take over an app that was offered to the caller. The server requires the
 * revision the caller read: a newer state answers 409 `ETAG_MISMATCH`.
 *
 * @param {string} appId
 * @param {{revision: number}} options
 * @returns {Promise<Object>} The app, owned by the caller.
 */
export const acceptUserAppOffer = (appId, { revision }) =>
  call(() => apiClient.post(`${appPath(appId)}/owner-offer/_accept`, undefined, ifMatch(revision)));

/**
 * Publish an app as a company app (owner). The server requires the revision
 * the caller read. Not available until the installation offers publishing
 * (`canPublish` of {@link fetchUserAppsConfig}).
 *
 * @param {string} appId
 * @param {{revision: number}} options
 * @returns {Promise<Object>} The app, now `promoted`, with `publishedAs`; for
 *   an owner who can use the company app at once the retired body
 *   (`state: 'retired'`), as `GET` then answers it.
 */
export const publishUserApp = (appId, { revision }) =>
  call(() => apiClient.post(`${appPath(appId)}/_publish`, undefined, ifMatch(revision)));
