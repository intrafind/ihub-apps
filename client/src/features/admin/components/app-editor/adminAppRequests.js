// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The requests of the app editor against the admin API: the app as an admin
 * or a content admin stores it, who can use it, and what the form needs
 * beside the app.
 *
 * The editor's hooks and components make no request of their own. They get
 * these functions from the page, so the same editor can run against another
 * API by handing it another set.
 *
 * @module features/admin/components/app-editor/adminAppRequests
 */

import {
  fetchAdminModels,
  fetchContentAccess,
  makeAdminApiCall,
  toggleApp
} from '../../../../api/adminApi';
import { etagOf } from '../../../../api/adminConfigRevision';
import { fetchModels, fetchUIConfig } from '../../../../api';
import { fetchJsonSchema } from '../../../../utils/schemaService';
import { cleanAppForSave, padLoadedApp } from '../../../../../../shared/appDefaults.js';

const appUrl = appId => `/admin/apps/${encodeURIComponent(appId)}`;

/**
 * The stored app, padded with what the form expects to find.
 *
 * The server answers the read with the app's revision (`ETag`). A form that
 * passes its own revision holder gets it stored there, and {@link saveApp}
 * sends it back as `If-Match`: a save over a change someone else saved in
 * between is then refused (412 `PRECONDITION_FAILED`) instead of erasing it.
 * The holder belongs to the form that loaded the app, never to the tab (see
 * `api/adminConfigRevision.js`).
 *
 * @param {string} appId
 * @param {{current: string|null}} [revision] - The form's revision holder.
 * @returns {Promise<object>} Rejects with the request's error when the app cannot be read.
 */
export const loadApp = async (appId, revision) => {
  const response = await makeAdminApiCall(appUrl(appId));
  if (revision) revision.current = etagOf(response);
  return padLoadedApp(response.data);
};

/**
 * Stores the app as the form holds it, without the form's padding. The editor
 * only ever changes an existing app; creating one is the "New app" page.
 *
 * With a revision holder that holds a revision the save is conditional
 * (`If-Match`), and the holder then takes the revision of what was just
 * written, so the form's next save builds on it. When the answer carries no
 * `ETag`, the revision is read again: keeping the old one would refuse the
 * form's next save although nobody else saved.
 *
 * @param {object} app - The app as the form holds it.
 * @param {string} appId
 * @param {{current: string|null}} [revision] - The form's revision holder.
 * @returns {Promise<unknown>} Rejects when the server refuses the app; with 412
 *   `PRECONDITION_FAILED` when the app changed since the form loaded it.
 */
export const saveApp = async (app, appId, revision) => {
  const sent = revision?.current || null;
  const response = await makeAdminApiCall(appUrl(appId), {
    method: 'PUT',
    ...(sent ? { headers: { 'If-Match': sent } } : {}),
    body: cleanAppForSave(app)
  });
  await adoptRevision(response, appId, revision, sent);
  return response;
};

/**
 * After a write of the app file: the holder takes the revision the answer
 * carries. Without an `ETag` in the answer the revision is read again, since
 * the file changed and the old revision would refuse the form's next save.
 *
 * @param {object} response - The answer of the write.
 * @param {string} appId
 * @param {{current: string|null}} [revision] - The form's revision holder.
 * @param {string|null} sent - The revision the write was conditional on.
 */
async function adoptRevision(response, appId, revision, sent) {
  if (!revision) return;
  const written = etagOf(response);
  if (written) revision.current = written;
  else if (sent) revision.current = etagOf(await makeAdminApiCall(appUrl(appId)));
}

/**
 * Whether a failed save was refused because the app changed since the form
 * loaded it (412 of `PUT /api/admin/apps/{id}` with `If-Match`).
 *
 * @param {unknown} error - What the save rejected with.
 * @returns {boolean}
 */
export const isAppSaveConflict = error => error?.response?.status === 412;

/**
 * The content-access view of the app: `{ scope, groups, audience }`.
 *
 * @param {string} appId
 * @returns {Promise<object>}
 */
export const loadAccess = appId => fetchContentAccess('apps', appId);

/**
 * Publishes or unpublishes the app. Only the flag changes on the server, but
 * that rewrites the app file, so its revision changes too.
 *
 * With a revision holder the toggle is conditional (`If-Match`): it is
 * refused (412 `PRECONDITION_FAILED`) when someone else saved the app since
 * the form loaded it, like a save. Afterwards the holder takes the app's new
 * revision, so the form's next save, Apply or Undo is not refused although
 * nobody else saved.
 *
 * @param {string} appId
 * @param {boolean} published
 * @param {{current: string|null}} [revision] - The form's revision holder.
 * @returns {Promise<unknown>} Rejects when the server refuses the toggle.
 */
export const setPublished = async (appId, published, revision) => {
  const sent = revision?.current || null;
  const response = await toggleApp(appId, published, { ifMatch: sent });
  await adoptRevision(response, appId, revision, sent);
  return response.data;
};

/**
 * The chat models the app can be set to (AI-B9). An admin gets the admin model
 * list, disabled models included, so an app can name a model before that
 * model is switched on for everyone; the form marks each one's status. The
 * public list would hold only the models the admin may already use in a chat.
 *
 * A content admin may edit apps but not read the admin model list (403): they
 * get the models they may use themselves, as before.
 *
 * @returns {Promise<object[]>} Chat models (transcription and text-to-speech
 *   models never answer in an app).
 */
export async function fetchEditorModels() {
  let models;
  try {
    models = await fetchAdminModels();
  } catch (error) {
    if (error?.response?.status === 403) return fetchModels();
    throw error;
  }
  return models.filter(model => (model.modelType || 'chat') === 'chat');
}

/**
 * What `useEditorResources` loads: the models an app can be set to, the UI
 * configuration and the JSON schema of an app.
 */
export const EDITOR_RESOURCES = Object.freeze({
  fetchModels: () => fetchEditorModels(),
  fetchUiConfig: () => fetchUIConfig(),
  fetchSchema: () => fetchJsonSchema('app')
});
