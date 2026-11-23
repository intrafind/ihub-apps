// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from './client.js';
import { CRAWL_REQUEST_TIMEOUT_MS } from './endpoints/projects.js';
import { buildApiUrl } from '../utils/runtimeBasePath';
import { captureRevision, reportConfigConflict, withIfMatch } from './adminConfigRevision.js';

const isPlainObjectForBody = value =>
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.toString.call(value) === '[object Object]';

// Extracts the server-provided error message from a failed admin API call,
// falling back to the generic axios message (e.g. network errors with no response).
export const getAdminApiErrorMessage = err =>
  err?.response?.data?.detail || err?.message || 'An unexpected error occurred';

/**
 * Make an authenticated call to an admin endpoint.
 *
 * @param {string} url - Admin API path (`/admin/...`)
 * @param {Object} [options] - `method`, `headers`, `body` and other axios options
 * @param {{current: string|null}} [options.revision] - The revision holder of the
 *   form this call loads or saves (platform or UI config only; see
 *   `api/adminConfigRevision.js`). A `GET` or `POST` stores the response `ETag`
 *   in it; a `POST` sends the held revision as `If-Match`.
 * @returns {Promise<Object>} The axios response
 */
export const makeAdminApiCall = async (url, options = {}) => {
  // Handle admin token for anonymous mode
  const adminToken = localStorage.getItem('adminToken');

  const { method = 'GET', headers = {}, revision, ...axiosOptions } = options;

  // Create axios config from supported options
  const axiosConfig = {
    url: url.startsWith('/') ? url : `/${url}`,
    method,
    ...axiosOptions,
    headers: { ...headers }
  };

  const hasBody = Object.hasOwn(options, 'body');
  const body = options.body;
  const isFormData = body instanceof FormData;

  if (Object.hasOwn(options, 'data')) {
    throw new Error(
      'Breaking change: makeAdminApiCall no longer supports the "data" option. Use "body" instead, for example { body: { key: value } } or { body: formData }.'
    );
  }

  // Handle request body
  if (hasBody) {
    if (!isFormData && !isPlainObjectForBody(body)) {
      const bodyType = body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body;
      throw new Error(
        `makeAdminApiCall expects "body" to be a plain object (or FormData). Received ${bodyType}.`
      );
    }

    axiosConfig.data = body;
    if (isFormData) {
      // Let axios/browser set the multipart boundary for FormData bodies.
      //
      // Deleting the key from this per-request object is NOT enough: the shared
      // axios instance declares `Content-Type: application/json` as an *instance
      // default* (see api/client.js), and that default still applies to a request
      // whose own headers simply omit the key. Axios' default transformRequest
      // then sees a JSON content type on a FormData payload and serialises the
      // form to JSON (`{"backup":{}}`), so the file never leaves the browser and
      // the server reports a missing upload. Setting the header to `undefined`
      // overrides the instance default and tells axios to omit it entirely.
      Object.keys(axiosConfig.headers).forEach(headerKey => {
        if (headerKey.toLowerCase() === 'content-type') {
          delete axiosConfig.headers[headerKey];
        }
      });
      axiosConfig.headers['Content-Type'] = undefined;
    } else {
      axiosConfig.headers = {
        'Content-Type': 'application/json',
        ...axiosConfig.headers
      };
    }
  }

  // Add authentication headers
  const authToken = localStorage.getItem('authToken');

  if (authToken) {
    // In OIDC/Local/Proxy modes, use the regular auth token
    axiosConfig.headers.Authorization = `Bearer ${authToken}`;
  } else if (adminToken) {
    // In anonymous mode, use admin token if available
    axiosConfig.headers.Authorization = `Bearer ${adminToken}`;
  }

  // Platform and UI config saves carry the revision their own form loaded, so a
  // save over someone else's newer change is refused (412) instead of erasing it.
  axiosConfig.headers = withIfMatch(axiosConfig.url, method, axiosConfig.headers, revision);

  try {
    const response = await apiClient(axiosConfig);
    captureRevision(axiosConfig.url, response, method, revision);
    return response;
  } catch (error) {
    const status = error.response?.status;
    reportConfigConflict(axiosConfig.url, error, revision);

    // Handle admin-specific auth failures
    if (status === 401 || status === 403) {
      // Clear the anonymous-mode admin token if present; it is no longer valid.
      if (adminToken) {
        localStorage.removeItem('adminToken');
      }

      if (status === 401) {
        // Session expired or token invalid. Trigger the global re-authentication
        // flow instead of hard-redirecting away from the admin area. The
        // `authTokenExpired` handler stores the current URL and shows the auth
        // gate overlay, returning the user to exactly where they were after they
        // log back in — so an admin re-prompted mid-session lands back on the
        // admin page, not the app home.
        //
        // Dispatching is idempotent: handleTokenExpired guards against re-entry
        // and the auth gate won't re-show while it is already visible.
        window.dispatchEvent(new CustomEvent('authTokenExpired'));
      }
      // 403 (authenticated but not permitted for THIS endpoint) is intentionally
      // NOT handled with a redirect. Entry to the admin area is already gated by
      // AdminLayout via /admin/auth/status; individual endpoints are permission-
      // scoped (e.g. content admins may call /admin/apps but not /admin/usage).
      // A hard `window.location` redirect here caused an infinite reload loop for
      // content admins: the Overview page fires full-admin-only calls that 403,
      // the redirect reloaded /admin, which re-fired them, and so on (issue #1923).
      // Let the 403 propagate so the calling component can handle it locally.
    }
    throw error;
  }
};

// Specific admin API functions
export const fetchAdminApps = async () => {
  const response = await makeAdminApiCall('/admin/apps');
  return response.data?.items ?? [];
};

/**
 * Which integrations an app can require are on, e.g.
 * `{ ifinder: true, 'com.intrafind/ldap-directory': false }`.
 */
export const fetchAppIntegrationStatus = async () => {
  const response = await makeAdminApiCall('/admin/apps/integration-status');
  return response.data;
};

export const fetchAdminModels = async () => {
  try {
    const response = await makeAdminApiCall('/admin/models');
    const items = response.data?.items;

    // Ensure we return an array
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error('Error in fetchAdminModels:', error);
    throw error;
  }
};

export const fetchAdminPrompts = async () => {
  try {
    const response = await makeAdminApiCall('/admin/prompts');
    const items = response.data?.items;

    // Ensure we return an array
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error('Error in fetchAdminPrompts:', error);
    throw error;
  }
};

export const fetchAdminAppTemplates = async () => {
  const response = await makeAdminApiCall('/admin/apps/templates');
  return response.data?.items ?? [];
};

/**
 * One app's configuration as it is stored (`GET /api/admin/apps/{id}`).
 *
 * @param {string} appId
 * @returns {Promise<Object>}
 */
export const fetchAdminApp = async appId => {
  const response = await makeAdminApiCall(`/admin/apps/${encodeURIComponent(appId)}`);
  return response.data;
};

/**
 * The templates the "New app" page offers (`GET /api/admin/app-templates`):
 * `{ id, name, description, icon, color, category, hasInputFields, app }`.
 * Not to be confused with {@link fetchAdminAppTemplates}, which lists the
 * existing apps a new app can be copied from.
 *
 * @returns {Promise<Object[]>}
 */
export const fetchAppStartTemplates = async () => {
  const response = await makeAdminApiCall('/admin/app-templates');
  return response.data?.items ?? [];
};

/**
 * How long the browser waits for an app draft. Above the server's own limit
 * for the model call (80 seconds), and well above the 30 seconds of other
 * admin calls.
 */
export const APP_DRAFT_TIMEOUT_MS = 90000;

/**
 * Have an AI model prepare an app draft from a description
 * (`POST /api/admin/apps/_generate`). Nothing is stored.
 *
 * @param {Object} request
 * @param {string} request.description - What the app should do, 1 to 2,000 characters.
 * @param {string} [request.language] - The language of the draft's texts; the
 *   platform's default language when absent.
 * @param {AbortSignal} [request.signal] - Aborting it cancels the request; the
 *   server then stops the model call.
 * @returns {Promise<{ app: Object, suggestions: Object, warnings: Object[], model: Object }>}
 */
export const generateAppDraft = async ({ description, language, signal }) => {
  const response = await makeAdminApiCall('/admin/apps/_generate', {
    method: 'POST',
    body: { description, ...(language ? { language } : {}) },
    timeout: APP_DRAFT_TIMEOUT_MS,
    signal
  });
  return response.data;
};

/**
 * Ask an AI model for one change to an app, or one question about it
 * (`POST /api/admin/apps/_revise`). Nothing is stored: the editor applies
 * the answer's `patch` itself and saves through its normal save.
 *
 * @param {Object} request
 * @param {Object} request.draft - The app's content as the editor holds it.
 * @param {Array<{role: 'author'|'builder', kind?: string, text: string}>} request.conversation -
 *   1 to 12 entries; the last one is the author's.
 * @param {string} [request.language] - The content language of the app.
 * @param {string[]} [request.fields] - Restrict the change to these content keys.
 * @param {boolean} [request.allowQuestions] - `false`: the answer is never a question.
 * @param {AbortSignal} [request.signal] - Aborting it cancels the request; the
 *   server then stops the model call.
 * @returns {Promise<{ reply: 'question'|'change'|'message', text: string, question: Object|null,
 *   patch: Object, changed: string[], suggestions: Object, warnings: Object[], model: Object }>}
 */
export const reviseAdminApp = async ({
  draft,
  conversation,
  language,
  fields,
  allowQuestions,
  signal
}) => {
  const response = await makeAdminApiCall('/admin/apps/_revise', {
    method: 'POST',
    body: reviseBody({ draft, conversation, language, fields, allowQuestions }),
    timeout: APP_DRAFT_TIMEOUT_MS,
    signal
  });
  return response.data;
};

/**
 * The body of a `_revise` request: the members that are set, nothing else.
 * (`endpoints/userApps.js` builds the same body for the personal route; it
 * must not import this module, which a person without admin rights never loads.)
 *
 * @param {Object} request
 * @returns {Object}
 */
function reviseBody({ draft, conversation, language, fields, allowQuestions }) {
  return {
    draft,
    conversation,
    ...(language ? { language } : {}),
    ...(Array.isArray(fields) && fields.length > 0 ? { fields } : {}),
    ...(typeof allowQuestions === 'boolean' ? { allowQuestions } : {})
  };
}

/**
 * Create an app (`POST /api/admin/apps`).
 *
 * @param {Object} app - The app configuration; stored as sent.
 * @param {{ origin?: string }} [options] - How the app was started, one of
 *   `APP_CREATE_ORIGINS` (`shared/appGenerator.js`). It goes into the audit
 *   entry and changes nothing about the app.
 * @returns {Promise<Object>} The created app.
 */
export const createAdminApp = async (app, { origin } = {}) => {
  const response = await makeAdminApiCall('/admin/apps', {
    method: 'POST',
    body: app,
    ...(origin ? { params: { origin } } : {})
  });
  return response.data;
};

export const createPrompt = async promptData => {
  const response = await makeAdminApiCall('/admin/prompts', {
    method: 'POST',
    body: promptData
  });
  return response.data;
};

export const updatePrompt = async (promptId, promptData) => {
  const response = await makeAdminApiCall(`/admin/prompts/${promptId}`, {
    method: 'PUT',
    body: promptData
  });
  return response.data;
};

export const translateText = async ({ text, from, to }) => {
  const response = await makeAdminApiCall('/admin/translate', {
    method: 'POST',
    body: { text, from, to }
  });
  return response.data;
};

/**
 * Have the default model write a usage guide for an app (issue #2838).
 * Nothing is stored.
 * @param {Object} app - App configuration, possibly unsaved
 * @param {string} language - Language code of the guide
 * @returns {Promise<{content: string}>}
 */
export const generateAppUsageGuide = async (app, language) => {
  const response = await makeAdminApiCall('/admin/apps/_usage-guide', {
    method: 'POST',
    body: { app, language }
  });
  return response.data;
};

export const toggleApps = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/admin/apps/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

/**
 * Save the display order of apps: the first id becomes `order: 1`, the second
 * `order: 2`, and so on. Apps left out of `ids` keep the order they have.
 */
export const reorderApps = async ids => {
  const response = await makeAdminApiCall('/admin/apps/_reorder', {
    method: 'POST',
    body: { ids }
  });
  return response.data;
};

export const fetchAdminPages = async () => {
  const response = await makeAdminApiCall('/admin/pages');
  return response.data?.items ?? [];
};

export const fetchAdminPage = async pageId => {
  const response = await makeAdminApiCall(`/admin/pages/${pageId}`);
  return response.data;
};

export const createPage = async pageData => {
  const response = await makeAdminApiCall('/admin/pages', {
    method: 'POST',
    body: pageData
  });
  return response.data;
};

/**
 * The model the server made the platform default on its own while handling a
 * request (create, update, `_toggle`, delete of a model), read from the
 * `Default-Model-Assigned` response header. The admin is told, because every
 * app that names no model now answers with it.
 *
 * @param {{headers?: Object}|undefined} response - An axios response.
 * @returns {string|null} The model id, or null when the default did not move on its own.
 */
export const assignedDefaultModelId = response => {
  const headers = response?.headers;
  const value =
    typeof headers?.get === 'function'
      ? headers.get('default-model-assigned')
      : headers?.['default-model-assigned'];
  if (!value) return null;
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
};

/**
 * Enables or disables models.
 *
 * @param {string|string[]} ids - Model ids, or `'*'` for all.
 * @param {boolean} enabled
 * @returns {Promise<{enabled: boolean, ids: string[], assignedDefaultModelId: string|null}>}
 *   The server's answer plus the model it made the default on its own, if any.
 */
export const toggleModels = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/admin/models/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
  return { ...response.data, assignedDefaultModelId: assignedDefaultModelId(response) };
};

/**
 * Makes an enabled chat model the platform default.
 *
 * @param {string} modelId
 * @returns {Promise<Object>} The model as stored now.
 */
export const makeDefaultModel = async modelId => {
  const response = await makeAdminApiCall(
    `/admin/models/${encodeURIComponent(modelId)}/_make-default`,
    { method: 'POST' }
  );
  return response.data;
};

/**
 * What names a model: `{ apps, workflows, groups, isDefault, nextDefaultModelId? }`.
 *
 * @param {string} modelId
 * @returns {Promise<Object>}
 */
export const fetchModelDependants = async modelId => {
  const response = await makeAdminApiCall(
    `/admin/models/${encodeURIComponent(modelId)}/_dependants`
  );
  return response.data;
};

/**
 * What names an app: `{ prompts, apps, workflows, groups }`.
 *
 * @param {string} appId
 * @returns {Promise<Object>}
 */
export const fetchAppDependants = async appId => {
  const response = await makeAdminApiCall(`/admin/apps/${encodeURIComponent(appId)}/_dependants`);
  return response.data;
};

export const updatePage = async (pageId, pageData) => {
  const response = await makeAdminApiCall(`/admin/pages/${pageId}`, {
    method: 'PUT',
    body: pageData
  });
  return response.data;
};

export const togglePrompts = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/admin/prompts/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

export const deletePage = async pageId => {
  const response = await makeAdminApiCall(`/admin/pages/${pageId}`, {
    method: 'DELETE'
  });
  return response.data;
};
// Projects API functions (#1036). Admin projects replace the admin sources:
// knowledge an admin links to apps, workflow nodes and agent profiles.

const ADMIN_PROJECTS_PATH = '/admin/projects';

/** Path of one admin project, with the id encoded for the URL. */
const adminProjectPath = projectId => `${ADMIN_PROJECTS_PATH}/${encodeURIComponent(projectId)}`;

/** Path of one item of an admin project. */
const adminProjectItemPath = (projectId, itemId) =>
  `${adminProjectPath(projectId)}/items/${encodeURIComponent(itemId)}`;

/**
 * Every admin project, disabled ones included.
 *
 * @returns {Promise<Array<Object>>} Admin projects (`GET /api/admin/projects`).
 */
export const fetchAdminProjects = async () => {
  const response = await makeAdminApiCall(ADMIN_PROJECTS_PATH);
  return Array.isArray(response.data?.items) ? response.data.items : [];
};

/**
 * Counts of admin and user projects for the list page header.
 *
 * @returns {Promise<{admin: {total: number, enabled: number, disabled: number, byKind: Object},
 *   user: {total: number, items: number, bytes: number, owners: number}, limits: Object}>}
 */
export const fetchAdminProjectStats = async () => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_stats`);
  return response.data;
};

/**
 * The project settings an admin edits on the projects page (full admins only):
 * who users may share their projects with, the tier policy (whether the
 * users' iFinder smart collections are listed as projects), the default app
 * and the limits of the local tier, with the most items a project may hold
 * (`maxFilesCeiling`).
 *
 * @returns {Promise<{sharing: {allowUsers: boolean, allowGroups: boolean,
 *   allowEveryone: boolean, allowCatalog: boolean}, tierPolicy: 'ihub'|'both'|'ifinder',
 *   defaultAppId: string, limits: {maxFiles: number, maxFileBytes: number,
 *   maxProjectBytes: number, maxProjectsPerUser: number}, maxFilesCeiling: number}>}
 */
export const fetchProjectSettings = async () => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_settings`);
  return response.data;
};

/**
 * Change the sharing audiences, the tier policy, the default app and/or the
 * limits; only the fields sent change.
 *
 * @param {{sharing?: Object, tierPolicy?: 'ihub'|'both'|'ifinder', defaultAppId?: string,
 *   limits?: Object}} settings
 * @returns {Promise<Object>} The effective settings, as {@link fetchProjectSettings} reads them.
 */
export const saveProjectSettings = async settings => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_settings`, {
    method: 'PUT',
    body: settings
  });
  return response.data;
};

/**
 * The item kinds the server knows, with whether each is enabled here.
 *
 * @returns {Promise<Array<{id: string, name: Object, icon: string|null, picker: Object,
 *   storage: 'text'|'link', credentials: string, enabled: boolean}>>}
 */
export const fetchAdminProjectKinds = async () => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_kinds`);
  return Array.isArray(response.data) ? response.data : [];
};

/**
 * Upload, malware scan and quota settings the item dialog needs.
 *
 * @returns {Promise<{upload: {available: boolean, accept: string[], mimeTypes: string[],
 *   summary: string}, scan: {provider: string}, limits: Object}>}
 */
export const fetchAdminProjectConfig = async () => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_config`);
  return response.data;
};

/**
 * Estimated size of every admin project, for the project picker.
 *
 * @returns {Promise<{loadAllBudgetTokens?: number, toolResultBudgetTokens?: number,
 *   projects: Object<string, {tokens: number, items: number, bytes: number}>}>}
 */
export const fetchAdminProjectTokens = async () => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_tokens`);
  return response.data || { projects: {} };
};

/**
 * The apps, workflows and agents that link a project. A linked project
 * cannot be deleted.
 *
 * @param {string} projectId
 * @returns {Promise<Array<{type: 'app'|'workflow'|'agent', id: string, name: string}>>}
 */
export const fetchAdminProjectDependencies = async projectId => {
  const response = await makeAdminApiCall(
    `${ADMIN_PROJECTS_PATH}/_dependencies/${encodeURIComponent(projectId)}`
  );
  return Array.isArray(response.data?.dependencies) ? response.data.dependencies : [];
};

/**
 * One admin project with its items.
 *
 * @param {string} projectId
 * @returns {Promise<Object>} The project.
 */
export const fetchAdminProject = async projectId => {
  const response = await makeAdminApiCall(adminProjectPath(projectId));
  return response.data;
};

/**
 * Create an admin project. A duplicate id answers `409 PROJECT_EXISTS`.
 *
 * @param {Object} project - `{ id, name, description?, instructions?, enabled?, category?, tags? }`
 * @returns {Promise<Object>} The created project.
 */
export const createAdminProject = async project => {
  const response = await makeAdminApiCall(ADMIN_PROJECTS_PATH, {
    method: 'POST',
    body: project
  });
  return response.data;
};

/**
 * Replace an admin project's settings (everything but its items).
 *
 * @param {string} projectId
 * @param {Object} project - The whole project document without `items`.
 * @returns {Promise<Object>} The updated project.
 */
export const updateAdminProject = async (projectId, project) => {
  const response = await makeAdminApiCall(adminProjectPath(projectId), {
    method: 'PUT',
    body: project
  });
  return response.data;
};

/**
 * Change some fields of an admin project (`PATCH`), such as its refresh TTL.
 *
 * @param {string} projectId
 * @param {{refreshTtl?: number|'never'|null}} changes
 * @returns {Promise<Object>} The updated project.
 */
export const patchAdminProject = async (projectId, changes) => {
  const response = await makeAdminApiCall(adminProjectPath(projectId), {
    method: 'PATCH',
    body: changes
  });
  return response.data;
};

/**
 * Delete a project. A linked admin project answers `400 PROJECT_IN_USE` with
 * `details.dependencies`.
 *
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export const deleteAdminProject = async projectId => {
  await makeAdminApiCall(adminProjectPath(projectId), { method: 'DELETE' });
};

/**
 * Enable or disable several admin projects at once.
 *
 * @param {string|string[]} ids
 * @param {boolean} enabled
 * @returns {Promise<{message: string, changed: number}>}
 */
export const toggleAdminProjects = async (ids, enabled) => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_toggle`, {
    method: 'POST',
    body: { ids: Array.isArray(ids) ? ids : [ids], enabled }
  });
  return response.data;
};

/**
 * Merge admin projects into one: every item of the sources moves into the
 * target, apps, workflows and agents that linked a source link the target, and
 * with `deleteSources` the emptied sources are deleted. A source whose items
 * did not all move is kept, with its links.
 *
 * @param {{sourceIds: string[], targetId: string, deleteSources?: boolean}} merge
 * @returns {Promise<{target: Object, sources: Array<{id: string, moved: number,
 *   failed: Array<{itemId: string, name?: string, code: string, message: string}>,
 *   relinked: Array<{type: string, id: string, name: string}>, merged: boolean,
 *   deleted: boolean, error?: string}>}>}
 */
export const mergeAdminProjects = async ({ sourceIds, targetId, deleteSources = false }) => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_merge`, {
    method: 'POST',
    body: { sourceIds, targetId, deleteSources }
  });
  return response.data;
};

/**
 * Copy or move items of a project into another admin project. Items that
 * cannot go (still being processed, over the target's quota) come back in
 * `failed`; the others went.
 *
 * @param {string} projectId - The project the items are in.
 * @param {{itemIds: string[], targetProjectId: string, mode?: 'copy'|'move'}} transfer
 * @returns {Promise<{transferred: Array<{itemId: string, newItemId: string, name: string}>,
 *   failed: Array<{itemId: string, name?: string, code: string, message: string}>,
 *   source: Object, target: Object}>}
 */
export const transferAdminProjectItems = async (
  projectId,
  { itemIds, targetProjectId, mode = 'move' }
) => {
  const response = await makeAdminApiCall(
    `${ADMIN_PROJECTS_PATH}/${mode === 'copy' ? '_copy' : '_move'}`,
    { method: 'POST', body: { sourceId: projectId, targetId: targetProjectId, itemIds } }
  );
  return response.data;
};

/**
 * Read every item of a project the way a chat would.
 *
 * @param {string} projectId
 * @returns {Promise<{success: boolean, duration: number, items: Array<Object>}>}
 */
export const testAdminProject = async projectId => {
  const response = await makeAdminApiCall(`${adminProjectPath(projectId)}/_test`, {
    method: 'POST'
  });
  return response.data;
};

/**
 * Load every item of a project, count its tokens and get a recommendation
 * (prompt or search) per item and for the project.
 *
 * @param {string} projectId
 * @returns {Promise<Object>} See `services/projects/projectEstimate.js`.
 */
export const estimateAdminProject = async projectId => {
  const response = await makeAdminApiCall(`${adminProjectPath(projectId)}/estimate`, {
    method: 'POST'
  });
  return response.data;
};

/**
 * Add an item described as JSON (every kind but a file upload).
 *
 * @param {string} projectId
 * @param {{kind: string, ref: Object, name?: string, pinned?: boolean, text?: string}} item
 * @returns {Promise<Object>} The new item (`ready` for link kinds, `pending` for text kinds).
 */
export const addAdminProjectItem = async (projectId, item) => {
  const response = await makeAdminApiCall(`${adminProjectPath(projectId)}/items`, {
    method: 'POST',
    body: item
  });
  return response.data;
};

/**
 * Upload a file as a new item (multipart, field `file`).
 *
 * @param {string} projectId
 * @param {{file: File|Blob, name?: string, pinned?: boolean}} upload
 * @returns {Promise<Object>} The new item, `pending` until its text is extracted.
 */
export const uploadAdminProjectItem = async (projectId, { file, name, pinned = false }) => {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  formData.append('pinned', pinned ? 'true' : 'false');
  const response = await makeAdminApiCall(`${adminProjectPath(projectId)}/items`, {
    method: 'POST',
    body: formData
  });
  return response.data;
};

/**
 * Rename an item, change whether it is pinned, or change what a link item
 * (URL, page, iFinder document or search) points at.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {{name?: string, pinned?: boolean, ref?: Object, refreshTtl?: number|'never'|null}} changes
 * @returns {Promise<Object>} The updated item.
 */
export const updateAdminProjectItem = async (projectId, itemId, changes) => {
  const response = await makeAdminApiCall(adminProjectItemPath(projectId, itemId), {
    method: 'PATCH',
    body: changes
  });
  return response.data;
};

/**
 * Replace the text of a written, uploaded or imported document of an admin project.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {string} text
 * @returns {Promise<Object>} The updated item.
 */
export const updateAdminProjectItemText = async (projectId, itemId, text) => {
  const response = await makeAdminApiCall(`${adminProjectItemPath(projectId, itemId)}/text`, {
    method: 'PUT',
    body: { text }
  });
  return response.data;
};

/**
 * Remove an item from a project.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @returns {Promise<void>}
 */
export const deleteAdminProjectItem = async (projectId, itemId) => {
  await makeAdminApiCall(adminProjectItemPath(projectId, itemId), { method: 'DELETE' });
};

/**
 * Read an item's content again (a stale item) or retry a failed extraction.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @returns {Promise<Object>} The item.
 */
export const refreshAdminProjectItem = async (projectId, itemId) => {
  const response = await makeAdminApiCall(`${adminProjectItemPath(projectId, itemId)}/_refresh`, {
    method: 'POST'
  });
  return response.data;
};

/**
 * The plain text of an item, cut at `maxChars`.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {{maxChars?: number}} [options]
 * @returns {Promise<{text: string, chars: number|null, truncated: boolean}>}
 */
export const fetchAdminProjectItemText = async (projectId, itemId, { maxChars = 20000 } = {}) => {
  const query = new URLSearchParams({ maxChars: String(maxChars) });
  const response = await makeAdminApiCall(
    `${adminProjectItemPath(projectId, itemId)}/text?${query}`,
    { responseType: 'text' }
  );
  const headers = response.headers || {};
  const chars = Number.parseInt(headers['x-item-chars'], 10);
  return {
    text: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
    chars: Number.isFinite(chars) ? chars : null,
    truncated: headers['x-item-truncated'] === 'true'
  };
};

// Pickers of the project item dialog. They belong to the user projects API
// (`/api/projects/pickers`), which every signed-in user may call.

/**
 * iHub pages an item can link.
 *
 * @returns {Promise<Array<{id: string, title: string|Object, languages: string[]}>>}
 */
export const fetchProjectPickerPages = async () => {
  const response = await makeAdminApiCall('/projects/pickers/pages');
  return Array.isArray(response.data?.items) ? response.data.items : [];
};

/**
 * Search iFinder for documents to link.
 *
 * @param {string} query
 * @param {{profile?: string, limit?: number}} [options]
 * @returns {Promise<Array<{documentId: string, title: string, mimeType?: string, url?: string}>>}
 */
/**
 * The iFinder search profiles the admin may search in for the item picker.
 *
 * @returns {Promise<{profiles: Array<{id: string, name: string, isDefault: boolean}>,
 *   defaultProfile: string|null, fixed: boolean}>}
 */
export const fetchProjectPickerIFinderProfiles = async () => {
  const response = await makeAdminApiCall('/projects/pickers/ifinder/profiles');
  const data = response.data || {};
  return {
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
    defaultProfile: data.defaultProfile || null,
    fixed: data.fixed === true
  };
};

export const searchProjectPickerIFinder = async (query, { profile, limit } = {}) => {
  const params = new URLSearchParams({ q: query });
  if (profile) params.set('profile', profile);
  if (limit) params.set('limit', String(limit));
  const response = await makeAdminApiCall(`/projects/pickers/ifinder/search?${params}`);
  return Array.isArray(response.data?.items) ? response.data.items : [];
};

/**
 * Check that a URL can be read before it is linked.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const checkProjectPickerUrl = async url => {
  const response = await makeAdminApiCall('/projects/pickers/url/_check', {
    method: 'POST',
    body: { url }
  });
  return response.data || { ok: false };
};

/**
 * The text a URL item would give the model, read before the item is added.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, title?: string, finalUrl?: string, text?: string,
 *   chars?: number, truncated?: boolean, error?: string}>}
 */
export const previewProjectPickerUrl = async url => {
  const response = await makeAdminApiCall('/projects/pickers/url/_preview', {
    method: 'POST',
    body: { url }
  });
  return response.data || { ok: false };
};

/**
 * The pages of a website below a start URL, found by following its links.
 *
 * @param {string} url
 * @param {{maxPages?: number, maxDepth?: number, samePath?: boolean}} [options]
 * @returns {Promise<{ok: boolean, pages?: Array<Object>, truncated?: boolean, error?: string}>}
 */
export const crawlProjectPickerUrl = async (url, options = {}) => {
  const response = await makeAdminApiCall('/projects/pickers/url/_crawl', {
    method: 'POST',
    body: { url, ...options },
    // Past the server's crawl deadline; see `CRAWL_REQUEST_TIMEOUT_MS`.
    timeout: CRAWL_REQUEST_TIMEOUT_MS
  });
  return response.data || { ok: false };
};

// Workflow API functions
export const fetchAdminWorkflows = async () => {
  try {
    const response = await makeAdminApiCall('/admin/workflows');
    const data = response.data;
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminWorkflows:', error);
    throw error;
  }
};

export const fetchAdminWorkflow = async id => {
  const response = await makeAdminApiCall(`/workflows/${id}`);
  return response.data;
};

export const createAdminWorkflow = async data => {
  const response = await makeAdminApiCall('/workflows', { method: 'POST', body: data });
  return response.data;
};

export const updateAdminWorkflow = async (id, data) => {
  const response = await makeAdminApiCall(`/workflows/${id}`, { method: 'PUT', body: data });
  return response.data;
};

export const deleteAdminWorkflow = async id => {
  const response = await makeAdminApiCall(`/workflows/${id}`, { method: 'DELETE' });
  return response.data;
};

export const toggleAdminWorkflow = async id => {
  const response = await makeAdminApiCall(`/admin/workflows/${id}/_toggle`, { method: 'POST' });
  return response.data;
};

export const fetchAdminGroups = async () => {
  const response = await makeAdminApiCall('/admin/groups');
  return response.data;
};

/**
 * `platform.json` as the admin reads it (secrets redacted): the inbound
 * channels' switches, the OIDC providers, the OAuth issuer, …
 * @returns {Promise<Object>}
 */
export const fetchAdminPlatformConfig = async () => {
  const response = await makeAdminApiCall('/admin/configs/platform');
  return response.data ?? null;
};

// Content access: which groups may use one app / prompt / skill / tool /
// workflow. Content admins get only the groups they belong to (and the groups
// inheriting from those); full admins get every group.
export const fetchContentAccess = async (type, id) => {
  const response = await makeAdminApiCall(
    `/admin/content-access/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  );
  return response.data;
};

export const updateContentAccess = async (type, id, { grant = [], revoke = [] } = {}) => {
  const response = await makeAdminApiCall(
    `/admin/content-access/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: { grant, revoke }
    }
  );
  return response.data;
};

// Item access (full admins): who can use an app, model, prompt, … and why,
// the access check, and replacing wildcards so that one item is no longer
// granted to everyone. See server/routes/admin/itemAccess.js.

const itemAccessUrl = (type, id) =>
  `/admin/access/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;

/**
 * Every group with the routes by which its members get the item.
 *
 * @param {'apps'|'models'|'prompts'|'skills'|'workflows'} type
 * @param {string} id
 * @returns {Promise<{type: string, id: string, groups: object[], audience: object,
 *   wildcardGroups: string[], restrictable: boolean}>}
 */
export const fetchItemAccess = async (type, id) => {
  const response = await makeAdminApiCall(itemAccessUrl(type, id));
  return response.data;
};

/**
 * Whether a group or a user can use an app or a model, with the reasons.
 *
 * @param {'apps'|'models'} type
 * @param {string} id
 * @param {{groupId?: string, userId?: string}} subject - Exactly one of the two
 * @returns {Promise<{subject: object, verdict: 'available'|'unavailable', reasons: object[]}>}
 */
export const fetchAccessVerdict = async (type, id, { groupId, userId } = {}) => {
  const query = new URLSearchParams(groupId ? { groupId } : { userId: userId || '' });
  const response = await makeAdminApiCall(`${itemAccessUrl(type, id)}/verdict?${query}`);
  return response.data;
};

/**
 * What restricting the item would change, without writing.
 *
 * @param {'apps'|'models'|'prompts'} type
 * @param {string} id
 * @param {{groupIds?: string[], grantGroupIds?: string[]}} [body]
 * @returns {Promise<object>} The restriction plan
 */
export const previewAccessRestriction = async (type, id, body = {}) => {
  const response = await makeAdminApiCall(`${itemAccessUrl(type, id)}/_preview-restrict`, {
    method: 'POST',
    body
  });
  return response.data;
};

/**
 * Replaces `*` in the chosen groups with an explicit list without the item,
 * then grants it to `grantGroupIds`.
 *
 * @param {'apps'|'models'|'prompts'} type
 * @param {string} id
 * @param {{groupIds?: string[], grantGroupIds?: string[]}} body
 * @returns {Promise<object>} The access view after the change, with `changed`
 */
export const restrictItemAccess = async (type, id, body) => {
  const response = await makeAdminApiCall(`${itemAccessUrl(type, id)}/_restrict`, {
    method: 'POST',
    body
  });
  return response.data;
};

// Credential store API functions

/**
 * Fetches all credential profiles from the central credential store.
 * Secret fields are redacted to '***REDACTED***' by the server.
 *
 * @returns {Promise<Array>} Array of credential profile objects (with id)
 */
export const listCredentials = async () => {
  try {
    const response = await makeAdminApiCall('/admin/credentials');
    const data = response.data;
    const credentials = data?.items;
    return Array.isArray(credentials) ? credentials : [];
  } catch (error) {
    console.error('Error in listCredentials:', error);
    throw error;
  }
};

/**
 * Creates a new credential profile.
 *
 * @param {Object} data - Credential profile data (id, type, and type-specific fields)
 * @returns {Promise<Object>} The created credential profile (secrets redacted)
 */
export const createCredential = async data => {
  const response = await makeAdminApiCall('/admin/credentials', {
    method: 'POST',
    body: data
  });
  return response.data;
};

/**
 * Updates an existing credential profile. Secret fields left as '***REDACTED***'
 * preserve the stored value on the server.
 *
 * @param {string} id - The credential profile id
 * @param {Object} data - Updated credential profile data
 * @returns {Promise<Object>} The updated credential profile (secrets redacted)
 */
export const updateCredential = async (id, data) => {
  const response = await makeAdminApiCall(`/admin/credentials/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: data
  });
  return response.data;
};

/**
 * Deletes a credential profile by id.
 *
 * @param {string} id - The credential profile id
 * @returns {Promise<void>}
 */
export const deleteCredential = async id => {
  const response = await makeAdminApiCall(`/admin/credentials/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  return response.data;
};

// Workflow Execution Admin API functions

/**
 * Fetches workflow executions for admin view with optional filtering.
 * Supports status filter, search, and pagination.
 *
 * @param {Object} [params] - Query parameters for filtering
 * @param {string} [params.status] - Filter by status ('all', 'running', 'paused', 'completed', 'failed', 'cancelled')
 * @param {string} [params.search] - Search by user ID or workflow name
 * @param {number} [params.limit] - Maximum number of results
 * @param {string} [params.cursor] - The `nextCursor` of the previous page
 * @returns {Promise<{items: Object[], nextCursor: string|null, total: number, stats: Object}>}
 */
export const fetchAdminExecutions = async (params, { signal } = {}) => {
  const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
  const response = await makeAdminApiCall(`/admin/workflows/executions${queryString}`, { signal });
  return response.data;
};

/**
 * Cancels a running or paused workflow execution.
 *
 * @param {string} id - The execution ID to cancel
 * @returns {Promise<Object>} Response with success status and new execution state
 */
export const cancelAdminExecution = async id => {
  const response = await makeAdminApiCall(`/workflows/executions/${id}/_cancel`, {
    method: 'POST'
  });
  return response.data;
};

// Skills API functions

/**
 * Fetches all installed skills for the admin panel.
 *
 * @returns {Promise<Array>} Array of skill objects
 */
export const fetchAdminSkills = async () => {
  try {
    const response = await makeAdminApiCall('/admin/skills');
    const data = response.data;
    // Server returns { skills: [...], settings: {...} }
    const skills = data?.skills ?? data;
    return Array.isArray(skills) ? skills : [];
  } catch (error) {
    console.error('Error in fetchAdminSkills:', error);
    throw error;
  }
};

/**
 * Fetches detailed information for a single skill by name.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @returns {Promise<Object>} The skill detail object
 */
export const fetchAdminSkillDetail = async skillName => {
  const response = await makeAdminApiCall(`/admin/skills/${encodeURIComponent(skillName)}`);
  return response.data;
};

/**
 * Updates an existing skill's configuration overrides.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @param {Object} data - The updated skill data
 * @returns {Promise<Object>} The updated skill object
 */
export const updateSkill = async (skillName, data) => {
  const response = await makeAdminApiCall(`/admin/skills/${encodeURIComponent(skillName)}`, {
    method: 'PUT',
    body: data
  });
  return response.data;
};

/**
 * Toggles the enabled/disabled state of a skill.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @returns {Promise<Object>} The toggled skill object with updated enabled state
 */
export const toggleSkill = async skillName => {
  const response = await makeAdminApiCall(
    `/admin/skills/${encodeURIComponent(skillName)}/_toggle`,
    {
      method: 'POST'
    }
  );
  return response.data;
};

/**
 * Deletes a skill by name.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @returns {Promise<Object>} Confirmation of deletion
 */
export const deleteSkill = async skillName => {
  const response = await makeAdminApiCall(`/admin/skills/${encodeURIComponent(skillName)}`, {
    method: 'DELETE'
  });
  return response.data;
};

/**
 * Imports a skill from an uploaded .zip archive via FormData.
 *
 * @param {FormData} formData - Form data containing the skill .zip file
 * @returns {Promise<Object>} The imported skill object
 */
export const importSkill = async formData => {
  const response = await makeAdminApiCall('/admin/skills/_import', {
    method: 'POST',
    body: formData
  });
  return response.data;
};

/**
 * Triggers a browser download of a skill package by opening the export
 * endpoint in a new tab.
 *
 * @param {string} skillName - The unique name identifier of the skill
 */
export const exportSkill = skillName => {
  window.open(buildApiUrl(`admin/skills/${encodeURIComponent(skillName)}/export`), '_blank');
};

// Marketplace - Registry management

/**
 * Fetches all marketplace registries configured by the admin.
 *
 * @returns {Promise<Array>} Array of registry objects
 */
export const fetchMarketplaceRegistries = async () => {
  const response = await makeAdminApiCall('/admin/marketplace/registries');
  return response.data?.items ?? [];
};

/**
 * Creates a new marketplace registry.
 *
 * @param {Object} data - Registry configuration data
 * @returns {Promise<Object>} The created registry object
 */
export const createMarketplaceRegistry = async data => {
  const response = await makeAdminApiCall('/admin/marketplace/registries', {
    method: 'POST',
    body: data
  });
  return response.data;
};

/**
 * Updates an existing marketplace registry by ID.
 *
 * @param {string} id - The registry ID
 * @param {Object} data - Updated registry configuration data
 * @returns {Promise<Object>} The updated registry object
 */
export const updateMarketplaceRegistry = async (id, data) => {
  const response = await makeAdminApiCall(`/admin/marketplace/registries/${id}`, {
    method: 'PUT',
    body: data
  });
  return response.data;
};

/**
 * Deletes a marketplace registry and removes its cached catalog data.
 *
 * @param {string} id - The registry ID to delete
 * @returns {Promise<Object>} Confirmation of deletion
 */
export const deleteMarketplaceRegistry = async id => {
  const response = await makeAdminApiCall(`/admin/marketplace/registries/${id}`, {
    method: 'DELETE'
  });
  return response.data;
};

/**
 * Triggers a manual refresh of a marketplace registry's catalog.
 *
 * @param {string} id - The registry ID to refresh
 * @returns {Promise<Object>} Result of the refresh operation
 */
export const refreshMarketplaceRegistry = async id => {
  const response = await makeAdminApiCall(`/admin/marketplace/registries/${id}/_refresh`, {
    method: 'POST'
  });
  return response.data;
};

/**
 * Tests connectivity to a registry URL before saving.
 *
 * @param {Object} data - Connection data including source URL and auth config
 * @returns {Promise<Object>} Test result with success flag and message
 */
export const testMarketplaceRegistry = async data => {
  const response = await makeAdminApiCall('/admin/marketplace/registries/_test', {
    method: 'POST',
    body: data
  });
  return response.data;
};

// Marketplace - Browse

/**
 * Browses all marketplace items across configured registries with optional filtering.
 *
 * @param {Object} [params] - Filter and pagination parameters
 * @param {string} [params.type] - Filter by item type (app, model, prompt, skill, workflow)
 * @param {string} [params.search] - Search query string
 * @param {string} [params.registry] - Filter by registry ID
 * @param {string} [params.status] - Filter by installation status (available, installed)
 * @param {string} [params.cursor] - The `nextCursor` of the previous page
 * @param {number} [params.limit] - Number of items per page (default 24, at most 1000)
 * @returns {Promise<{items: Object[], nextCursor: string|null, total: number}>}
 */
export const browseMarketplace = async (params = {}) => {
  const query = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).filter(([, v]) => v != null && v !== '' && v !== 'all')
    )
  ).toString();
  const response = await makeAdminApiCall(`/admin/marketplace${query ? `?${query}` : ''}`);
  return response.data;
};

/**
 * Fetches detailed information for a single marketplace item.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {string} type - The item type (app, model, prompt, skill, workflow)
 * @param {string} name - The item name identifier
 * @returns {Promise<Object>} Detailed item object including contentPreview
 */
export const fetchMarketplaceItemDetail = async (registryId, type, name) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}`
  );
  return response.data;
};

// Marketplace - Item actions

/**
 * Installs a marketplace item into the local iHub instance.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {string} type - The item type (app, model, prompt, skill, workflow)
 * @param {string} name - The item name identifier
 * @param {Object} [options]
 * @param {boolean} [options.replaceLocal=false] - Confirms replacing an item with the same
 *   id that already exists on this instance (installationStatus 'local')
 * @returns {Promise<Object>} Result of the install operation
 */
export const installMarketplaceItem = async (registryId, type, name, { replaceLocal } = {}) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_install`,
    { method: 'POST', ...(replaceLocal ? { body: { replaceLocal: true } } : {}) }
  );
  return response.data;
};

/**
 * Fetches one text file of a catalog item from its registry, without
 * installing the item: a Markdown companion of an integration (a release's
 * notes) or any file of a skill's folder, `SKILL.md` included.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {'integration'|'skill'} type - The item type
 * @param {string} name - The item name identifier
 * @param {string} path - The file path as the catalog lists it
 * @returns {Promise<string>} The file's text
 */
export const fetchMarketplaceItemFile = async (registryId, type, name, path) => {
  const query = new URLSearchParams({ path });
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_file?${query}`,
    { responseType: 'text' }
  );
  return typeof response.data === 'string' ? response.data : String(response.data ?? '');
};

/**
 * Updates an already-installed marketplace item to the latest version.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {string} type - The item type (app, model, prompt, skill, workflow)
 * @param {string} name - The item name identifier
 * @param {Object} [options]
 * @param {string} [options.version] - A version the item lists; without it the server
 *   takes the version the registry offers (its channel and the item's pin applied)
 * @returns {Promise<Object>} Result of the update operation
 */
export const updateMarketplaceItem = async (registryId, type, name, { version } = {}) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_update`,
    { method: 'POST', ...(version ? { body: { version } } : {}) }
  );
  return response.data;
};

/**
 * Uninstalls a marketplace item, removing its files from the local instance.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {string} type - The item type (app, model, prompt, skill, workflow)
 * @param {string} name - The item name identifier
 * @returns {Promise<Object>} Result of the uninstall operation
 */
export const uninstallMarketplaceItem = async (registryId, type, name) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_uninstall`,
    { method: 'POST' }
  );
  return response.data;
};

/**
 * Detaches an item from marketplace tracking without deleting its files.
 * Use this when you want to keep the item but stop tracking updates from the registry.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {string} type - The item type (app, model, prompt, skill, workflow)
 * @param {string} name - The item name identifier
 * @returns {Promise<Object>} Result of the detach operation
 */
export const detachMarketplaceItem = async (registryId, type, name) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_detach`,
    { method: 'POST' }
  );
  return response.data;
};

// Marketplace - Tracking

/**
 * Fetches a list of all currently installed marketplace items.
 *
 * @returns {Promise<Array>} Array of installation tracking records
 */
export const fetchMarketplaceInstallations = async () => {
  const response = await makeAdminApiCall('/admin/marketplace/installations');
  return response.data;
};

export const fetchAdminUsageMeta = async () => {
  const response = await makeAdminApiCall('/admin/usage/meta');
  return response.data;
};

export const updateAdminUsageTrackingMode = async mode => {
  const response = await makeAdminApiCall('/admin/usage/meta', {
    method: 'PUT',
    body: { trackingMode: mode }
  });
  return response.data;
};

/**
 * One user's token usage against their effective limits (model, group and
 * personal), with where each limit comes from and their file storage.
 *
 * @param {string} userKey - The user id (as stored in usage tracking)
 * @returns {Promise<Object>} `{ buckets, models, files, personalLimits, ... }`
 */
export const fetchAdminUsageLimitUser = async userKey => {
  const response = await makeAdminApiCall(
    `/admin/usage/limits/users/${encodeURIComponent(userKey)}`
  );
  return response.data;
};

/**
 * Reset a user's token counts for the current window(s).
 *
 * @param {string} userKey - The user id
 * @param {{modelId?: string, window?: 'day'|'week'|'month'}} [body] - Narrow the
 *   reset to one model and/or window; empty resets everything
 * @returns {Promise<Object>} The user's usage after the reset
 */
export const resetAdminUsageLimitUser = async (userKey, body = {}) => {
  const response = await makeAdminApiCall(
    `/admin/usage/limits/users/${encodeURIComponent(userKey)}/_reset`,
    {
      method: 'POST',
      body
    }
  );
  return response.data;
};

export const setAppFeedbackEnabled = async (appId, enabled) => {
  const response = await makeAdminApiCall(`/admin/apps/${appId}/features/feedback`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

/**
 * One page of feedback entries, newest first.
 * @param {number} [limit]
 * @param {string|null} [cursor] - The `nextCursor` of the previous page
 * @returns {Promise<{items: Object[], nextCursor: string|null, total: number}>}
 */
export const fetchAdminFeedbackEntries = async (limit = 100, cursor = null) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const response = await makeAdminApiCall(`/admin/usage/feedback?${params}`);
  return response.data;
};

// --- Personal apps (feature `userApps`) ---------------------------------------
// The routes of `server/routes/admin/userApps.js`. Full admins only; they work
// with the feature off.

const ADMIN_USER_APPS_PATH = '/admin/user-apps';

const adminUserAppPath = appId => `${ADMIN_USER_APPS_PATH}/${encodeURIComponent(appId)}`;

/**
 * Every personal app the filters match. The list answers one page at a time
 * and a page can hold fewer items than its limit, so this follows `nextCursor`
 * until it is null.
 *
 * @param {Object} [filters] - `q`, `ownerId`, `state` (`active` or `promoted`),
 *   and the flags `waiting`, `everyone`, `ownerActive`, `ownerStale`, `clash`
 *   as booleans. An empty or missing value is not sent.
 * @returns {Promise<Array<Object>>} The items of `GET /api/admin/user-apps`.
 *
 * @example
 * await fetchAdminUserApps({ ownerId: 'anna' });
 * await fetchAdminUserApps({ waiting: true });
 */
export const fetchAdminUserApps = async (filters = {}) => {
  const items = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ limit: '200' });
    for (const [name, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(name, String(value));
    }
    if (cursor) params.set('cursor', cursor);
    const response = await makeAdminApiCall(`${ADMIN_USER_APPS_PATH}?${params}`);
    if (Array.isArray(response.data?.items)) items.push(...response.data.items);
    cursor = response.data?.nextCursor || null;
  } while (cursor);
  return items;
};

/**
 * The admin view of one personal app: the list item plus `content`, `members`,
 * `language`, `origin` and `revision`. A read by an admin who is neither owner
 * nor member is written to the audit log.
 *
 * @param {string} appId
 * @returns {Promise<Object>}
 */
export const fetchAdminUserApp = async appId => {
  const response = await makeAdminApiCall(adminUserAppPath(appId));
  return response.data;
};

/**
 * The stored content states of a personal app, newest first.
 *
 * @param {string} appId
 * @returns {Promise<Array<{revision: number, contentHash: string, content: Object,
 *   savedAt: string|null, savedBy: {id: string, name: string}|null}>>}
 */
export const fetchAdminUserAppRevisions = async appId => {
  const response = await makeAdminApiCall(`${adminUserAppPath(appId)}/revisions`);
  return Array.isArray(response.data?.items) ? response.data.items : [];
};

/**
 * Switch a personal app off. Nobody but a full admin can use it then; owner
 * and members see the reason.
 *
 * @param {string} appId
 * @param {string} [reason] - At most 500 characters.
 * @returns {Promise<Object>} The admin view, with `disabled`.
 */
export const disableAdminUserApp = async (appId, reason = '') => {
  const text = String(reason).trim();
  const response = await makeAdminApiCall(`${adminUserAppPath(appId)}/_disable`, {
    method: 'POST',
    body: text ? { reason: text } : {}
  });
  return response.data;
};

/**
 * Switch a personal app on again.
 *
 * @param {string} appId
 * @returns {Promise<Object>} The admin view.
 */
export const enableAdminUserApp = async appId => {
  const response = await makeAdminApiCall(`${adminUserAppPath(appId)}/_enable`, {
    method: 'POST'
  });
  return response.data;
};

/**
 * Delete a personal app with its shares.
 *
 * @param {string} appId
 * @returns {Promise<void>}
 */
export const deleteAdminUserApp = async appId => {
  await makeAdminApiCall(adminUserAppPath(appId), { method: 'DELETE' });
};

/**
 * Give a promoted personal app back to its owner. Answers 409 `CONFLICT` with
 * `details.reason: 'published'` while the company app is visible.
 *
 * @param {string} appId
 * @returns {Promise<Object>} The admin view.
 */
export const releaseAdminUserApp = async appId => {
  const response = await makeAdminApiCall(`${adminUserAppPath(appId)}/_release`, {
    method: 'POST'
  });
  return response.data;
};

/**
 * The people a personal app can be offered to. The route is the user route
 * `GET /api/apps/_share-targets` with `purpose=offer`: a full admin may offer
 * any app, and the answer holds users only.
 *
 * @param {string} [q] - Search text.
 * @returns {Promise<Array<{id: string, name: string, email: string|null}>>}
 */
export const fetchUserAppOfferTargets = async (q = '') => {
  const params = new URLSearchParams({ purpose: 'offer', q });
  const response = await makeAdminApiCall(`/apps/_share-targets?${params}`);
  return Array.isArray(response.data?.users) ? response.data.users : [];
};

/**
 * Offer a personal app to a new owner (`PUT /api/apps/{appId}/owner-offer`).
 * Nothing changes until that person accepts.
 *
 * @param {string} appId
 * @param {string} ownerId - The user asked to take the app over.
 * @param {number} [revision] - The revision the admin read; a newer stored
 *   state answers 409 `ETAG_MISMATCH`.
 * @returns {Promise<Object>} The app, with `pendingOwner`.
 */
export const offerAdminUserApp = async (appId, ownerId, revision) => {
  const response = await makeAdminApiCall(`/apps/${encodeURIComponent(appId)}/owner-offer`, {
    method: 'PUT',
    body: { ownerId },
    ...(Number.isInteger(revision) && revision > 0
      ? { headers: { 'If-Match': `"${revision}"` } }
      : {})
  });
  return response.data;
};

/**
 * Withdraw the open offer of a personal app
 * (`DELETE /api/apps/{appId}/owner-offer`).
 *
 * @param {string} appId
 * @returns {Promise<void>}
 */
export const withdrawAdminUserAppOffer = async appId => {
  await makeAdminApiCall(`/apps/${encodeURIComponent(appId)}/owner-offer`, { method: 'DELETE' });
};

/**
 * The settings of personal apps (`platform.userApps`).
 *
 * @returns {Promise<{limits: {maxAppsPerUser: number, maxOpenOffersPerUser: number,
 *   ownerSnapshotMaxAgeDays: number}, sharing: {allowUsers: boolean, allowGroups: boolean,
 *   allowEveryone: boolean, allowPublish: boolean}, capabilities: {modelChoice: boolean,
 *   upload: boolean, webSearch: boolean, skills: boolean,
 *   integrations: Array<{id: string, actions: string[]}>},
 *   publishing: {adminEnables: 'withTools'|'always'}, blockedOwners: string[]}>}
 */
export const fetchUserAppSettings = async () => {
  const response = await makeAdminApiCall(`${ADMIN_USER_APPS_PATH}/_settings`);
  return response.data;
};

/**
 * Change the settings of personal apps. Only the keys sent change; the lists
 * `capabilities.integrations` and `blockedOwners` are replaced as a whole. A
 * change applies at once.
 *
 * @param {Object} settings - A partial block of {@link fetchUserAppSettings}.
 * @returns {Promise<Object>} The settings after the change.
 */
export const saveUserAppSettings = async settings => {
  const response = await makeAdminApiCall(`${ADMIN_USER_APPS_PATH}/_settings`, {
    method: 'PUT',
    body: settings
  });
  return response.data;
};
