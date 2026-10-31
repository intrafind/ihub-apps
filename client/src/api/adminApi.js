// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from './client.js';
import { CRAWL_REQUEST_TIMEOUT_MS } from './endpoints/projects.js';
import { buildApiUrl } from '../utils/runtimeBasePath';

const isPlainObjectForBody = value =>
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.toString.call(value) === '[object Object]';

// Extracts the server-provided error message from a failed admin API call,
// falling back to the generic axios message (e.g. network errors with no response).
export const getAdminApiErrorMessage = err =>
  err?.response?.data?.error ||
  err?.response?.data?.message ||
  err?.message ||
  'An unexpected error occurred';

// Utility function to make authenticated API calls to admin endpoints
export const makeAdminApiCall = async (url, options = {}) => {
  // Handle admin token for anonymous mode
  const adminToken = localStorage.getItem('adminToken');

  const { method = 'GET', headers = {}, ...axiosOptions } = options;

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

  try {
    const response = await apiClient(axiosConfig);
    return response;
  } catch (error) {
    const status = error.response?.status;

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
export const fetchAdminUsageData = async () => {
  const response = await makeAdminApiCall('/admin/usage');
  return response.data;
};

export const fetchAdminCacheStats = async () => {
  const response = await makeAdminApiCall('/admin/cache/stats');
  return response.data;
};

export const fetchAdminApps = async () => {
  const response = await makeAdminApiCall('/admin/apps');
  return response.data;
};

/**
 * Which integrations an app can require are on, e.g.
 * `{ ifinder: true, peopleDirectories: false }`.
 */
export const fetchAppIntegrationStatus = async () => {
  const response = await makeAdminApiCall('/admin/apps/integration-status');
  return response.data;
};

export const fetchAdminModels = async () => {
  try {
    const response = await makeAdminApiCall('/admin/models');
    const data = response.data;

    // Ensure we return an array
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminModels:', error);
    throw error;
  }
};

export const fetchAdminPrompts = async () => {
  try {
    const response = await makeAdminApiCall('/admin/prompts');
    const data = response.data;

    // Ensure we return an array
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminPrompts:', error);
    throw error;
  }
};

export const fetchAdminAppTemplates = async () => {
  const response = await makeAdminApiCall('/admin/apps/templates');
  return response.data;
};

export const fetchAppInheritance = async appId => {
  const response = await makeAdminApiCall(`/admin/apps/${appId}/inheritance`);
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
  return response.data;
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

export const toggleModels = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/admin/models/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
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

// UI Customization API functions
export const getUIConfig = async () => {
  const response = await makeAdminApiCall('/admin/ui/config');
  return response;
};

export const updateUIConfig = async config => {
  const response = await makeAdminApiCall('/admin/ui/config', {
    method: 'POST',
    body: { config }
  });
  return response;
};

export const backupUIConfig = async () => {
  const response = await makeAdminApiCall('/admin/ui/backup', {
    method: 'POST'
  });
  return response;
};

export const getUIAssets = async () => {
  const response = await makeAdminApiCall('/admin/ui/assets');
  return response;
};

export const uploadUIAsset = async formData => {
  const response = await makeAdminApiCall('/admin/ui/upload-asset', {
    method: 'POST',
    body: formData
  });
  return response;
};

export const deleteUIAsset = async assetId => {
  const response = await makeAdminApiCall(`/admin/ui/assets/${assetId}`, {
    method: 'DELETE'
  });
  return response;
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
  return Array.isArray(response.data) ? response.data : [];
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
 * who users may share their projects with, and the tier policy (whether the
 * users' iFinder smart collections are listed as projects).
 *
 * @returns {Promise<{sharing: {allowUsers: boolean, allowGroups: boolean,
 *   allowEveryone: boolean, allowCatalog: boolean}, tierPolicy: 'ihub'|'both'|'ifinder'}>}
 */
export const fetchProjectSettings = async () => {
  const response = await makeAdminApiCall(`${ADMIN_PROJECTS_PATH}/_settings`);
  return response.data;
};

/**
 * Change the sharing audiences and/or the tier policy; only the fields sent change.
 *
 * @param {{sharing?: Object, tierPolicy?: 'ihub'|'both'|'ifinder'}} settings
 * @returns {Promise<{sharing: Object, tierPolicy: string}>} The effective settings.
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
  return response.data?.project;
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
  return response.data?.project;
};

/**
 * Change some settings of an admin project.
 *
 * @param {string} projectId
 * @param {Object} changes - Any of `name`, `description`, `instructions`, `enabled`,
 *   `category`, `tags`.
 * @returns {Promise<Object>} The updated project.
 */
export const patchAdminProject = async (projectId, changes) => {
  const response = await makeAdminApiCall(adminProjectPath(projectId), {
    method: 'PATCH',
    body: changes
  });
  return response.data?.project;
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
  const response = await makeAdminApiCall(`${adminProjectPath(projectId)}/test`, {
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
  return response.data?.item;
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
  return response.data?.item;
};

/**
 * Rename an item or change whether it is pinned.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {{name?: string, pinned?: boolean}} changes
 * @returns {Promise<Object>} The updated item.
 */
export const updateAdminProjectItem = async (projectId, itemId, changes) => {
  const response = await makeAdminApiCall(adminProjectItemPath(projectId, itemId), {
    method: 'PATCH',
    body: changes
  });
  return response.data?.item;
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
  return response.data?.item;
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
  const response = await makeAdminApiCall(`${adminProjectItemPath(projectId, itemId)}/refresh`, {
    method: 'POST'
  });
  return response.data?.item;
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
  return Array.isArray(response.data?.pages) ? response.data.pages : [];
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
  return Array.isArray(response.data?.results) ? response.data.results : [];
};

/**
 * Check that a URL can be read before it is linked.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const checkProjectPickerUrl = async url => {
  const response = await makeAdminApiCall('/projects/pickers/url/check', {
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
  const response = await makeAdminApiCall('/projects/pickers/url/preview', {
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
  const response = await makeAdminApiCall('/projects/pickers/url/crawl', {
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
  const response = await makeAdminApiCall(`/admin/workflows/${id}/toggle`, { method: 'POST' });
  return response.data;
};

export const fetchAdminGroups = async () => {
  const response = await makeAdminApiCall('/admin/groups');
  return response.data;
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

// Tools API functions
export const fetchAdminTools = async () => {
  try {
    const response = await makeAdminApiCall('/admin/tools');
    const data = response.data;

    // Ensure we return an array
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminTools:', error);
    throw error;
  }
};

export const fetchAdminTool = async toolId => {
  const response = await makeAdminApiCall(`/admin/tools/${toolId}`);
  return response.data;
};

export const createTool = async toolData => {
  const response = await makeAdminApiCall('/admin/tools', {
    method: 'POST',
    body: toolData
  });
  return response.data;
};

export const updateTool = async (toolId, toolData) => {
  const response = await makeAdminApiCall(`/admin/tools/${toolId}`, {
    method: 'PUT',
    body: toolData
  });
  return response.data;
};

export const deleteTool = async toolId => {
  const response = await makeAdminApiCall(`/admin/tools/${toolId}`, {
    method: 'DELETE'
  });
  return response.data;
};

export const toggleTool = async toolId => {
  const response = await makeAdminApiCall(`/admin/tools/${toolId}/toggle`, {
    method: 'POST'
  });
  return response.data;
};

export const fetchToolScript = async toolId => {
  const response = await makeAdminApiCall(`/admin/tools/${toolId}/script`);
  return response.data;
};

export const updateToolScript = async (toolId, content) => {
  const response = await makeAdminApiCall(`/admin/tools/${toolId}/script`, {
    method: 'PUT',
    body: { content }
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
    const credentials = data?.credentials ?? data;
    return Array.isArray(credentials) ? credentials : [];
  } catch (error) {
    console.error('Error in listCredentials:', error);
    throw error;
  }
};

/**
 * Fetches a single credential profile by id (secrets redacted).
 *
 * @param {string} id - The credential profile id
 * @returns {Promise<Object>} The credential profile object
 */
export const getCredential = async id => {
  const response = await makeAdminApiCall(`/admin/credentials/${encodeURIComponent(id)}`);
  return response.data;
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

/**
 * Parses an OpenAPI specification from a URL, inline text, or uploaded content.
 * Returns the spec info, servers, and a flattened list of operations for the
 * OpenAPI tool editor.
 *
 * @param {string} source - OpenAPI source (URL or inline JSON/YAML text)
 * @returns {Promise<{info: Object, servers: Array, operations: Array}>}
 */
export const parseOpenApiSpec = async source => {
  const response = await makeAdminApiCall('/admin/tools/openapi/parse', {
    method: 'POST',
    body: { source }
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
 * @param {number} [params.offset] - Number of results to skip
 * @returns {Promise<Object>} Response containing executions array, total count, and stats
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
  const response = await makeAdminApiCall(`/workflows/executions/${id}/cancel`, { method: 'POST' });
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
  const response = await makeAdminApiCall(`/admin/skills/${encodeURIComponent(skillName)}/toggle`, {
    method: 'POST'
  });
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
  const response = await makeAdminApiCall('/admin/skills/import', {
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
  return response.data;
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
 * @param {number} [params.page] - Page number for pagination
 * @param {number} [params.limit] - Number of items per page
 * @returns {Promise<Object>} Paginated result with items, total, and totalPages
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
 * Fetches a Markdown companion file of an integration catalog item (a
 * release's notes) from its registry, without installing the item.
 *
 * @param {string} registryId - The registry ID the item belongs to
 * @param {string} name - The item name identifier
 * @param {string} path - The companion path as the catalog lists it
 * @returns {Promise<string>} The file's text
 */
export const fetchMarketplaceItemFile = async (registryId, name, path) => {
  const query = new URLSearchParams({ path });
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/integration/${name}/_file?${query}`,
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
 * @returns {Promise<Object>} Result of the update operation
 */
export const updateMarketplaceItem = async (registryId, type, name) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_update`,
    { method: 'POST' }
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

/**
 * Fetches marketplace items that have updates available for installed content.
 *
 * @returns {Promise<Array>} Array of items with available updates
 */
export const fetchMarketplaceUpdates = async () => {
  const response = await makeAdminApiCall('/admin/marketplace/updates');
  return response.data;
};

export const fetchAdminUsageTimeline = async (range = '30d', granularity) => {
  const params = new URLSearchParams({ range });
  if (granularity) params.set('granularity', granularity);
  const response = await makeAdminApiCall(`/admin/usage/timeline?${params}`);
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

export const triggerUsageRollup = async () => {
  const response = await makeAdminApiCall('/admin/usage/_rollup', { method: 'POST' });
  return response.data;
};

export const fetchAdminUsageUsers = async (range = '30d') => {
  const response = await makeAdminApiCall(`/admin/usage/users?range=${range}`);
  return response.data;
};

export const fetchAdminUsageApps = async (range = '30d') => {
  const response = await makeAdminApiCall(`/admin/usage/apps?range=${range}`);
  return response.data;
};

export const fetchAdminUsageModels = async (range = '30d') => {
  const response = await makeAdminApiCall(`/admin/usage/models?range=${range}`);
  return response.data;
};

export const fetchAdminUsageProviders = async (range = '30d') => {
  const response = await makeAdminApiCall(`/admin/usage/providers?range=${range}`);
  return response.data;
};

export const setAppFeedbackEnabled = async (appId, enabled) => {
  const response = await makeAdminApiCall(`/admin/apps/${appId}/features/feedback`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

export const fetchAdminFeedbackEntries = async (limit = 100, offset = 0) => {
  const response = await makeAdminApiCall(`/admin/usage/feedback?limit=${limit}&offset=${offset}`);
  return response.data;
};

// Create an adminApi object that contains all the functions for compatibility
export const adminApi = {
  // Existing functions
  makeAdminApiCall,
  fetchAdminUsageData,
  fetchAdminUsageTimeline,
  fetchAdminUsageMeta,
  updateAdminUsageTrackingMode,
  triggerUsageRollup,
  fetchAdminUsageUsers,
  fetchAdminUsageApps,
  fetchAdminUsageModels,
  fetchAdminUsageProviders,
  fetchAdminFeedbackEntries,
  setAppFeedbackEnabled,
  fetchAdminCacheStats,
  fetchAdminApps,
  fetchAdminModels,
  fetchAdminPrompts,
  fetchAdminAppTemplates,
  fetchAppInheritance,
  createPrompt,
  updatePrompt,
  translateText,
  generateAppUsageGuide,
  toggleApps,
  reorderApps,
  fetchAdminPages,
  fetchAdminPage,
  createPage,
  toggleModels,
  updatePage,
  togglePrompts,
  deletePage,
  getUIConfig,
  updateUIConfig,
  backupUIConfig,
  getUIAssets,
  uploadUIAsset,
  deleteUIAsset,

  // Projects functions
  fetchAdminProjects,
  fetchAdminProjectStats,
  fetchAdminProjectKinds,
  fetchAdminProjectConfig,
  fetchAdminProjectTokens,
  fetchAdminProjectDependencies,
  fetchAdminProject,
  createAdminProject,
  updateAdminProject,
  patchAdminProject,
  deleteAdminProject,
  toggleAdminProjects,
  mergeAdminProjects,
  transferAdminProjectItems,
  testAdminProject,
  estimateAdminProject,
  addAdminProjectItem,
  uploadAdminProjectItem,
  updateAdminProjectItem,
  updateAdminProjectItemText,
  deleteAdminProjectItem,
  refreshAdminProjectItem,
  fetchAdminProjectItemText,
  fetchProjectPickerPages,
  searchProjectPickerIFinder,
  fetchProjectPickerIFinderProfiles,
  checkProjectPickerUrl,
  previewProjectPickerUrl,
  crawlProjectPickerUrl,

  // Workflow functions
  fetchAdminWorkflows,
  fetchAdminWorkflow,
  createAdminWorkflow,
  updateAdminWorkflow,
  deleteAdminWorkflow,
  toggleAdminWorkflow,
  fetchAdminGroups,

  // Content access functions
  fetchContentAccess,
  updateContentAccess,

  // Workflow Execution functions
  fetchAdminExecutions,
  cancelAdminExecution,

  // Tools functions
  fetchAdminTools,
  fetchAdminTool,
  createTool,
  updateTool,
  deleteTool,
  toggleTool,
  fetchToolScript,
  updateToolScript,
  parseOpenApiSpec,

  // Credential store functions
  listCredentials,
  getCredential,
  createCredential,
  updateCredential,
  deleteCredential,

  // Skills functions
  fetchAdminSkills,
  fetchAdminSkillDetail,
  updateSkill,
  toggleSkill,
  deleteSkill,
  importSkill,
  exportSkill,

  // Marketplace functions
  fetchMarketplaceRegistries,
  createMarketplaceRegistry,
  updateMarketplaceRegistry,
  deleteMarketplaceRegistry,
  refreshMarketplaceRegistry,
  testMarketplaceRegistry,
  browseMarketplace,
  fetchMarketplaceItemDetail,
  installMarketplaceItem,
  updateMarketplaceItem,
  uninstallMarketplaceItem,
  detachMarketplaceItem,
  fetchMarketplaceInstallations,
  fetchMarketplaceUpdates
};
