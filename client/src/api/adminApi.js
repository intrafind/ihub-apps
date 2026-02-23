import { apiClient } from './client.js';
import { buildPath } from '../utils/runtimeBasePath';

// Utility function to make authenticated API calls to admin endpoints
export const makeAdminApiCall = async (url, options = {}) => {
  // Handle admin token for anonymous mode
  const adminToken = localStorage.getItem('adminToken');

  // Create axios config from options
  const axiosConfig = {
    url: url.startsWith('/') ? url : `/${url}`,
    method: options.method || 'GET',
    ...options
  };

  // Initialize headers
  axiosConfig.headers = axiosConfig.headers || {};

  // Track if this is a FormData request
  const isFormData = options.body instanceof FormData;

  // Handle request body
  if (options.body) {
    if (isFormData) {
      axiosConfig.data = options.body;
      // For FormData, start with empty headers (no Content-Type)
      // Let the browser set the correct multipart/form-data header with boundary
      axiosConfig.headers = {
        ...options.headers
      };
    } else if (typeof options.body === 'string') {
      axiosConfig.data = JSON.parse(options.body);
      axiosConfig.headers = {
        'Content-Type': 'application/json',
        ...axiosConfig.headers,
        ...options.headers
      };
    } else {
      axiosConfig.data = options.body;
      axiosConfig.headers = {
        'Content-Type': 'application/json',
        ...axiosConfig.headers,
        ...options.headers
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
    // For FormData requests, use fetch directly to avoid axios default headers
    if (isFormData) {
      const API_URL = import.meta.env.VITE_API_URL || '/api';
      const fullUrl = `${API_URL}${axiosConfig.url}`;

      // Add session ID manually since we're not using axios interceptors
      const { getSessionId } = await import('../utils/sessionManager');
      const sessionId = getSessionId();

      const fetchHeaders = {
        ...axiosConfig.headers,
        'X-Session-ID': sessionId
        // Deliberately NOT setting Content-Type - let browser handle it for FormData
      };

      const fetchResponse = await fetch(fullUrl, {
        method: axiosConfig.method,
        headers: fetchHeaders,
        body: axiosConfig.data,
        credentials: 'include'
      });

      if (!fetchResponse.ok) {
        const error = new Error(`HTTP ${fetchResponse.status}`);
        error.response = {
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          data: await fetchResponse.json().catch(() => ({}))
        };
        throw error;
      }

      return {
        data: await fetchResponse.json(),
        status: fetchResponse.status,
        headers: Object.fromEntries(fetchResponse.headers.entries())
      };
    } else {
      const response = await apiClient(axiosConfig);
      return response;
    }
  } catch (error) {
    // Handle admin-specific auth failures
    if (error.response?.status === 401 || error.response?.status === 403) {
      // Clear invalid admin tokens
      if (adminToken) {
        localStorage.removeItem('adminToken');
      }

      // For auth failures, redirect appropriately based on the auth mode
      if (window.location.pathname.startsWith('/admin')) {
        const authToken = localStorage.getItem('authToken');
        // If we have a regular auth token, this suggests a permission issue
        if (authToken) {
          // User is authenticated but doesn't have admin permissions
          window.location.href = buildPath('/admin'); // Will show appropriate error message
        } else {
          // User is not authenticated, redirect to login
          window.location.href = buildPath('/');
        }
      }
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
export const fetchAdminExecutions = async params => {
  const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
  const response = await makeAdminApiCall(`/admin/workflows/executions${queryString}`);
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
  const baseURL = import.meta.env.VITE_API_URL || '/api';
  window.open(`${baseURL}/admin/skills/${encodeURIComponent(skillName)}/export`, '_blank');
};

// Create an adminApi object that contains all the functions for compatibility
export const adminApi = {
  // Existing functions
  makeAdminApiCall,
  fetchAdminUsageData,
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

  // Skills functions
  fetchAdminSkills,
  fetchAdminSkillDetail,
  updateSkill,
  toggleSkill,
  deleteSkill,
  importSkill,
  exportSkill
};
