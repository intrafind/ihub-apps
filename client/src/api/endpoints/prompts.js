import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import cache, { CACHE_KEYS, DEFAULT_CACHE_TTL } from '../../utils/cache';

/**
 * The prompt library — one `/api/prompts` for global prompts (admin-curated
 * configuration) and user prompts (written and shared by users). Every entry
 * of the list carries its `scope` (`global`, `mine`, `shared`) and the
 * `permissions` the server computed for the caller; the UI only uses those to
 * show or hide actions.
 *
 * The list is cached with its ETag. Every write below drops that cache, so
 * the next read is fresh — a prompt someone just shared or revoked shows up
 * (or goes) on the next open of the library or the `/` search.
 */

/** Drop the cached prompt list. */
export const invalidatePromptsCache = () => {
  cache.delete(CACHE_KEYS.PROMPTS);
};

const write = async call => {
  try {
    return await handleApiResponse(call, null, null, false);
  } finally {
    invalidatePromptsCache();
  }
};

/**
 * The prompt library as the caller may see it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.skipCache=false] - Bypass the cached list.
 * @returns {Promise<Object[]>}
 */
export const fetchPrompts = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.PROMPTS;

  return handleApiResponse(
    () => {
      const headers = {};

      // Add ETag header if we have cached data
      if (cacheKey) {
        const cachedData = cache.get(cacheKey);
        if (cachedData && cachedData.etag) {
          headers['If-None-Match'] = cachedData.etag;
        }
      }

      return apiClient.get('/prompts', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM,
    true,
    true // Enable ETag handling
  );
};

/**
 * One prompt, global or user, with its permissions (and, for those who may
 * change it, its share list).
 *
 * @param {string} promptId - Prompt id.
 * @returns {Promise<Object>}
 */
export const fetchPrompt = async promptId =>
  handleApiResponse(
    () => apiClient.get(`/prompts/${encodeURIComponent(promptId)}`),
    null,
    null,
    false
  );

/**
 * Create a prompt owned by the caller — private until shared.
 *
 * @param {Object} data - `{ name, description?, prompt, icon?, category?, appId?, variables? }`
 * @returns {Promise<Object>} The created prompt.
 */
export const createUserPrompt = async data => write(() => apiClient.post('/prompts', data));

/**
 * Save a user prompt as a new revision. `expectedRevision` makes the save
 * fail with 409 when someone else saved in between.
 *
 * @param {string} promptId - Prompt id.
 * @param {Object} data - Content plus optional `expectedRevision`.
 * @returns {Promise<Object>}
 */
export const updateUserPrompt = async (promptId, data) =>
  write(() => apiClient.put(`/prompts/${encodeURIComponent(promptId)}`, data));

/** Delete a user prompt (owner or admin). */
export const deleteUserPrompt = async promptId =>
  write(() => apiClient.delete(`/prompts/${encodeURIComponent(promptId)}`));

/**
 * Copy a global or shared prompt into the caller's own prompts.
 *
 * @param {string} promptId - Prompt id.
 * @param {Object} [body] - `{ name?, language? }`
 * @returns {Promise<Object>} The copy.
 */
export const duplicatePrompt = async (promptId, body = {}) =>
  write(() => apiClient.post(`/prompts/${encodeURIComponent(promptId)}/duplicate`, body));

/**
 * Replace who a user prompt is shared with.
 *
 * @param {string} promptId - Prompt id.
 * @param {Array<{type: 'user'|'group'|'everyone', id?: string, permission: 'use'|'edit'}>} shares
 * @returns {Promise<Object>} The prompt with its new share list.
 */
export const updatePromptShares = async (promptId, shares) =>
  write(() => apiClient.put(`/prompts/${encodeURIComponent(promptId)}/shares`, { shares }));

/** Hand a user prompt to another user. */
export const transferPrompt = async (promptId, ownerId) =>
  write(() => apiClient.put(`/prompts/${encodeURIComponent(promptId)}/owner`, { ownerId }));

/**
 * Saved revisions of a user prompt, newest first.
 *
 * @param {string} promptId - Prompt id.
 * @returns {Promise<{revision: number, versions: Object[]}>}
 */
export const fetchPromptVersions = async promptId =>
  handleApiResponse(
    () => apiClient.get(`/prompts/${encodeURIComponent(promptId)}/versions`),
    null,
    null,
    false
  );

/** Restore an old revision — saved as a new one. */
export const restorePromptVersion = async (promptId, revision) =>
  write(() =>
    apiClient.post(
      `/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(revision)}/restore`
    )
  );

/**
 * Users and groups the caller may share with, and which audiences are open.
 *
 * @param {string} query - Search text.
 * @returns {Promise<{allowed: Object, users: Object[], groups: Object[]}>}
 */
export const fetchPromptShareTargets = async query =>
  handleApiResponse(
    () => apiClient.get('/prompts/share-targets', { params: { q: query || '' } }),
    null,
    null,
    false
  );

/**
 * The values the global prompt variables take for the caller, and the names
 * that fill themselves in.
 *
 * @param {string} [language] - UI language, for date formatting.
 * @returns {Promise<{autoNames: string[], values: Object}>}
 */
export const fetchPromptVariables = async language =>
  handleApiResponse(
    () => apiClient.get('/prompts/variables', { params: language ? { lang: language } : {} }),
    null,
    null,
    false
  );

/** The caller's favorites and recents, as stored on the server. */
export const fetchPromptPreferences = async () =>
  handleApiResponse(() => apiClient.get('/prompts/preferences'), null, null, false);

/**
 * Replace the caller's favorites; `recents` are merged in (the one-time
 * carry-over from the browser).
 */
export const savePromptPreferences = async body =>
  handleApiResponse(() => apiClient.put('/prompts/preferences', body), null, null, false);

/** Record one use of a prompt, for "recent". */
export const recordPromptUsageOnServer = async promptId =>
  handleApiResponse(
    () => apiClient.post(`/prompts/${encodeURIComponent(promptId)}/usage`),
    null,
    null,
    false
  );

export const generateMagicPrompt = async (input, options = {}) => {
  return handleApiResponse(
    () => apiClient.post('/magic-prompt', { input, ...options }),
    null,
    null,
    false
  );
};
