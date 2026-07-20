import { apiClient } from './client.js';
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
      // Let axios/browser set the multipart boundary for FormData bodies
      Object.keys(axiosConfig.headers).forEach(headerKey => {
        if (headerKey.toLowerCase() === 'content-type') {
          delete axiosConfig.headers[headerKey];
        }
      });
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

export const toggleApps = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/admin/apps/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
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

// Sources API functions
export const fetchAdminSources = async () => {
  try {
    const response = await makeAdminApiCall('/admin/sources');
    const data = response.data;

    // Ensure we return an array
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminSources:', error);
    throw error;
  }
};

export const fetchAdminSource = async sourceId => {
  const response = await makeAdminApiCall(`/admin/sources/${sourceId}`);
  return response.data;
};

export const createSource = async sourceData => {
  const response = await makeAdminApiCall('/admin/sources', {
    method: 'POST',
    body: sourceData
  });
  return response.data;
};

export const updateSource = async (sourceId, sourceData) => {
  const response = await makeAdminApiCall(`/admin/sources/${sourceId}`, {
    method: 'PUT',
    body: sourceData
  });
  return response.data;
};

export const deleteSource = async sourceId => {
  const response = await makeAdminApiCall(`/admin/sources/${sourceId}`, {
    method: 'DELETE'
  });
  return response.data;
};

export const testSource = async (sourceId, testData) => {
  const response = await makeAdminApiCall(`/admin/sources/${sourceId}/test`, {
    method: 'POST',
    body: testData
  });
  return response.data;
};

export const toggleSources = async (ids, enabled) => {
  const response = await makeAdminApiCall('/admin/sources/_toggle', {
    method: 'POST',
    body: { ids: Array.isArray(ids) ? ids : [ids], enabled }
  });
  return response.data;
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
 * @returns {Promise<Object>} Result of the install operation
 */
export const installMarketplaceItem = async (registryId, type, name) => {
  const response = await makeAdminApiCall(
    `/admin/marketplace/registries/${registryId}/items/${type}/${name}/_install`,
    { method: 'POST' }
  );
  return response.data;
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
  fetchAdminFeedbackEntries,
  fetchAdminCacheStats,
  fetchAdminApps,
  fetchAdminModels,
  fetchAdminPrompts,
  fetchAdminAppTemplates,
  fetchAppInheritance,
  createPrompt,
  updatePrompt,
  translateText,
  toggleApps,
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

  // Sources functions - both name variants for compatibility
  fetchAdminSources,
  getSources: fetchAdminSources, // Alias for SourcePicker compatibility
  fetchAdminSource,
  getSource: fetchAdminSource, // Alias
  createSource,
  updateSource,
  deleteSource,
  testSource,
  toggleSources,

  // Workflow functions
  fetchAdminWorkflows,
  fetchAdminWorkflow,
  createAdminWorkflow,
  updateAdminWorkflow,
  deleteAdminWorkflow,
  toggleAdminWorkflow,
  fetchAdminGroups,

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
