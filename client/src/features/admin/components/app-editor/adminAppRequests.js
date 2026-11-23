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
  toggleApps
} from '../../../../api/adminApi';
import { fetchModels, fetchUIConfig } from '../../../../api';
import { fetchJsonSchema } from '../../../../utils/schemaService';
import { cleanAppForSave, padLoadedApp } from '../../../../../../shared/appDefaults.js';

const appUrl = appId => `/admin/apps/${encodeURIComponent(appId)}`;

/**
 * The stored app, padded with what the form expects to find.
 *
 * @param {string} appId
 * @returns {Promise<object>} Rejects with the request's error when the app cannot be read.
 */
export const loadApp = async appId => padLoadedApp((await makeAdminApiCall(appUrl(appId))).data);

/**
 * Stores the app as the form holds it, without the form's padding. The editor
 * only ever changes an existing app; creating one is the "New app" page.
 *
 * @param {object} app - The app as the form holds it.
 * @param {string} appId
 * @returns {Promise<unknown>} Rejects when the server refuses the app.
 */
export const saveApp = (app, appId) =>
  makeAdminApiCall(appUrl(appId), { method: 'PUT', body: cleanAppForSave(app) });

/**
 * The content-access view of the app: `{ scope, groups, audience }`.
 *
 * @param {string} appId
 * @returns {Promise<object>}
 */
export const loadAccess = appId => fetchContentAccess('apps', appId);

/**
 * Publishes or unpublishes the app. Only the flag changes on the server.
 *
 * @param {string} appId
 * @param {boolean} published
 * @returns {Promise<unknown>}
 */
export const setPublished = (appId, published) => toggleApps([appId], published);

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
