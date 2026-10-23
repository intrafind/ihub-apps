// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * The user projects API (`/api/projects`, #1036 spec 1 §5.1).
 *
 * A project is one container with documents (items), instructions and chats.
 * User projects are created and shared by users; admin projects linked to the
 * caller's apps are listed too, read-only. Every project comes back with the
 * `permissions` the server computed for the caller; the UI only uses those
 * to show or hide actions, every check runs on the server.
 *
 * Nothing here is cached: a project changes while its items are extracted,
 * and a stale member list would offer actions the caller no longer has.
 * Errors keep the server's answer on `error.originalError.response.data`
 * (`{ error, details: { code, … } }`); `features/projects/utils/projectErrors`
 * turns them into messages.
 */

const PROJECTS_PATH = '/projects';

/** Path of one project, with the id encoded for the URL. */
const projectPath = projectId => `${PROJECTS_PATH}/${encodeURIComponent(projectId)}`;

/** Path of one item of a project. */
const itemPath = (projectId, itemId) =>
  `${projectPath(projectId)}/items/${encodeURIComponent(itemId)}`;

/** One uncached call through the shared error handling. */
const call = request => handleApiResponse(request, null, null, false);

/**
 * What projects this installation offers the caller: flags, limits, sharing
 * audiences, the enabled item kinds with their picker descriptors, and the
 * upload settings.
 *
 * @returns {Promise<{enabled: boolean, userProjects: {enabled: boolean, canCreate: boolean,
 *   canShare: boolean, maxProjects: number, used: number}, limits: Object, sharing: Object,
 *   kinds: Array<Object>, upload: {available: boolean, accept: string[], mimeTypes: string[],
 *   summary: string}}>}
 */
export const fetchProjectsConfig = () => call(() => apiClient.get(`${PROJECTS_PATH}/_config`));

/**
 * The projects the caller may use: owned, shared with them, and admin
 * projects reached through their apps.
 *
 * @param {{scope?: 'all'|'mine'|'shared'|'admin'}} [options]
 * @returns {Promise<Array<Object>>} Project summaries (no items), newest activity first.
 */
export const fetchProjects = async ({ scope = 'all' } = {}) => {
  const data = await call(() => apiClient.get(PROJECTS_PATH, { params: { scope } }));
  return Array.isArray(data?.items) ? data.items : [];
};

/**
 * Create a user project owned by the caller.
 *
 * @param {{name: string, description?: string, instructions?: string}} project
 * @returns {Promise<Object>} The created project.
 */
export const createProject = project => call(() => apiClient.post(PROJECTS_PATH, project));

/**
 * One project with its items and the caller's permissions.
 *
 * @param {string} projectId
 * @returns {Promise<Object>}
 */
export const fetchProject = projectId => call(() => apiClient.get(projectPath(projectId)));

/**
 * Change a project's name, description or instructions (owner and editors).
 *
 * @param {string} projectId
 * @param {{name?: string, description?: string, instructions?: string}} changes
 * @returns {Promise<Object>} The updated project.
 */
export const updateProject = (projectId, changes) =>
  call(() => apiClient.patch(projectPath(projectId), changes));

/**
 * Delete a project (owner only). Its chats survive, outside the project.
 *
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export const deleteProject = async projectId => {
  await call(() => apiClient.delete(projectPath(projectId)));
};

/**
 * Add an item described as JSON (every kind but a file upload).
 *
 * @param {string} projectId
 * @param {{kind: string, ref: Object, name?: string, pinned?: boolean, text?: string}} item
 * @returns {Promise<Object>} The new item (`ready` for link kinds, `pending` for text kinds).
 */
export const addProjectItem = async (projectId, item) => {
  const data = await call(() => apiClient.post(`${projectPath(projectId)}/items`, item));
  return data?.item;
};

/**
 * Upload a file as a new item (multipart, field `file`).
 *
 * @param {string} projectId
 * @param {{file: File|Blob, name?: string, pinned?: boolean}} upload
 * @returns {Promise<Object>} The new item, `pending` until its text is extracted.
 */
export const uploadProjectItem = async (projectId, { file, name, pinned = false }) => {
  const formData = new FormData();
  formData.append('file', file);
  if (name) formData.append('name', name);
  formData.append('pinned', pinned ? 'true' : 'false');
  const data = await call(() =>
    apiClient.post(`${projectPath(projectId)}/items`, formData, {
      // Let the browser set the multipart boundary (the instance default is JSON).
      headers: { 'Content-Type': undefined }
    })
  );
  return data?.item;
};

/**
 * Rename an item or change whether it is pinned.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {{name?: string, pinned?: boolean}} changes
 * @returns {Promise<Object>} The updated item.
 */
export const updateProjectItem = (projectId, itemId, changes) =>
  call(() => apiClient.patch(itemPath(projectId, itemId), changes));

/**
 * Replace the text of a written, uploaded or imported document. The text is
 * stored like written text; the item comes back `ready` and `written`.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {string} text
 * @returns {Promise<Object>} The updated item.
 */
export const updateProjectItemText = async (projectId, itemId, text) => {
  const data = await call(() => apiClient.put(`${itemPath(projectId, itemId)}/text`, { text }));
  return data?.item;
};

/**
 * Remove an item and its text.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @returns {Promise<void>}
 */
export const deleteProjectItem = async (projectId, itemId) => {
  await call(() => apiClient.delete(itemPath(projectId, itemId)));
};

/**
 * Read a picked document again with the caller's credentials, or retry a
 * failed extraction.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @returns {Promise<Object>} The item.
 */
export const refreshProjectItem = async (projectId, itemId) => {
  const data = await call(() => apiClient.post(`${itemPath(projectId, itemId)}/refresh`));
  return data?.item;
};

/**
 * Load every document of a project, count its tokens and get a
 * recommendation (prompt or search) per document and for the project.
 *
 * @param {string} projectId
 * @returns {Promise<Object>} See `services/projects/projectEstimate.js`.
 */
export const estimateProjectTokens = async projectId =>
  call(() => apiClient.post(`${projectPath(projectId)}/estimate`));

/**
 * The plain text of an item, cut at `maxChars`.
 *
 * @param {string} projectId
 * @param {string} itemId
 * @param {{maxChars?: number}} [options]
 * @returns {Promise<{text: string, chars: number|null, truncated: boolean}>}
 */
export const fetchProjectItemText = async (projectId, itemId, { maxChars = 20000 } = {}) => {
  const response = await apiClient.get(`${itemPath(projectId, itemId)}/text`, {
    params: { maxChars },
    responseType: 'text'
  });
  const headers = response.headers || {};
  const chars = Number.parseInt(headers['x-item-chars'], 10);
  return {
    text: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
    chars: Number.isFinite(chars) ? chars : null,
    truncated: headers['x-item-truncated'] === 'true'
  };
};

/**
 * Replace who a project is shared with (the complete list).
 *
 * @param {string} projectId
 * @param {Array<{type: 'user'|'group'|'everyone', id?: string, role: 'user'|'editor'}>} members
 * @returns {Promise<Object>} The project with its new member list.
 */
export const updateProjectMembers = (projectId, members) =>
  call(() => apiClient.put(`${projectPath(projectId)}/members`, { members }));

/**
 * Users and groups a project can be shared with, and which audiences are open.
 *
 * @param {string} [query] - Search text (users need at least two characters).
 * @returns {Promise<{allowed: {user: boolean, group: boolean, everyone: boolean},
 *   users: Array<{id: string, name: string, email: string|null}>,
 *   groups: Array<{id: string, name: string, description: string}>}>}
 */
export const fetchProjectShareTargets = (query = '') =>
  call(() => apiClient.get(`${PROJECTS_PATH}/share-targets`, { params: { q: query } }));

/**
 * Hand a project to another user (owner only).
 *
 * @param {string} projectId
 * @param {string} ownerId
 * @returns {Promise<Object>} The project, or `{ id, transferred: true }` when
 *   the caller can no longer see it.
 */
export const transferProject = (projectId, ownerId) =>
  call(() => apiClient.post(`${projectPath(projectId)}/transfer`, { ownerId }));

/**
 * The projects published to the catalog, for everyone signed in to browse.
 *
 * @param {string} [query] - Matches name, description and owner.
 * @returns {Promise<{enabled: boolean, items: Array<Object>}>} Each item with
 *   `subscribed` (the caller added it to their list).
 */
export const fetchProjectCatalog = (query = '') =>
  call(() => apiClient.get(`${PROJECTS_PATH}/_catalog`, { params: { q: query } }));

/**
 * Publish a project to the catalog, or take it out (owners and editors).
 *
 * @param {string} projectId
 * @param {boolean} published
 * @returns {Promise<Object>} The project.
 */
export const publishProject = (projectId, published) =>
  call(() => apiClient.put(`${projectPath(projectId)}/catalog`, { published }));

/**
 * Add a project from the catalog to the caller's list.
 *
 * @param {string} projectId
 * @returns {Promise<Object>} The project, with `subscribed: true`.
 */
export const addCatalogProject = projectId =>
  call(() => apiClient.post(`${projectPath(projectId)}/subscription`));

/**
 * Remove a project taken from the catalog from the caller's list.
 *
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export const removeCatalogProject = projectId =>
  call(() => apiClient.delete(`${projectPath(projectId)}/subscription`));

/**
 * One page of the chats inside a project, newest first.
 *
 * @param {string} projectId
 * @param {{filter?: 'all'|'mine'|'others', limit?: number, cursor?: string|null}} [options] -
 *   `cursor` is the `nextCursor` of the previous page, or the offset a page starts at.
 * @returns {Promise<{items: Array<{id: string, title: string, appId: string|null,
 *   lastMessageAt: string, messageCount: number, status: string,
 *   owner: {name: string, mine: boolean}}>, nextCursor: string|null, total: number}>}
 */
export const fetchProjectChats = async (projectId, { filter = 'all', limit, cursor } = {}) => {
  const data = await call(() =>
    apiClient.get(`${projectPath(projectId)}/chats`, {
      params: {
        filter,
        ...(limit ? { limit } : {}),
        ...(cursor ? { cursor } : {})
      }
    })
  );
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    items,
    nextCursor: data?.nextCursor ?? null,
    total: Number.isFinite(data?.total) ? data.total : items.length
  };
};

// --- pickers of the "Add item" dialog ---------------------------------------------

/**
 * iHub pages an item can link.
 *
 * @returns {Promise<Array<{id: string, title: string|Object, languages: string[]}>>}
 */
export const fetchPickerPages = async () => {
  const data = await call(() => apiClient.get(`${PROJECTS_PATH}/pickers/pages`));
  return Array.isArray(data?.pages) ? data.pages : [];
};

/**
 * Search iFinder for documents to link, with the caller's own rights.
 *
 * @param {string} query
 * @param {{profile?: string, limit?: number}} [options]
 * @returns {Promise<Array<{documentId: string, title: string, mimeType?: string, url?: string}>>}
 */
export const searchPickerIFinder = async (query, { profile, limit } = {}) => {
  const params = { q: query, ...(profile ? { profile } : {}), ...(limit ? { limit } : {}) };
  const data = await call(() =>
    apiClient.get(`${PROJECTS_PATH}/pickers/ifinder/search`, { params })
  );
  return Array.isArray(data?.results) ? data.results : [];
};

/**
 * Check that a URL can be read before it is linked.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const checkPickerUrl = async url => {
  const data = await call(() => apiClient.post(`${PROJECTS_PATH}/pickers/url/check`, { url }));
  return data || { ok: false };
};

/**
 * The text a URL item would give the model, read before the item is added.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, title?: string, finalUrl?: string, text?: string,
 *   chars?: number, truncated?: boolean, error?: string}>}
 */
export const previewPickerUrl = async url => {
  const data = await call(() => apiClient.post(`${PROJECTS_PATH}/pickers/url/preview`, { url }));
  return data || { ok: false };
};

/**
 * How long the client waits for a site crawl: past the server's 25-second
 * crawl deadline (which answers with the pages found so far), with room for
 * the last pages it parses.
 */
export const CRAWL_REQUEST_TIMEOUT_MS = 45_000;

/**
 * The pages of a website below a start URL, found by following its links.
 *
 * @param {string} url
 * @param {{maxPages?: number, maxDepth?: number, samePath?: boolean}} [options]
 * @returns {Promise<{ok: boolean, pages?: Array<{url: string, title: string, depth: number,
 *   type: 'page'|'document'}>, truncated?: boolean, error?: string}>}
 */
export const crawlPickerUrl = async (url, options = {}) => {
  const data = await call(() =>
    apiClient.post(
      `${PROJECTS_PATH}/pickers/url/crawl`,
      { url, ...options },
      { timeout: CRAWL_REQUEST_TIMEOUT_MS }
    )
  );
  return data || { ok: false };
};

/**
 * The cloud storage providers a cloud item can be picked from.
 *
 * @returns {Promise<Array<{id: string, type: string, displayName: string}>>}
 */
export const fetchPickerCloudProviders = async () => {
  const data = await call(() => apiClient.get(`${PROJECTS_PATH}/pickers/cloud`));
  return Array.isArray(data?.providers) ? data.providers : [];
};
