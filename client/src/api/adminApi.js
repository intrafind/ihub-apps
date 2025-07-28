import { apiClient } from './client.js';

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

  // Handle request body
  if (options.body) {
    if (options.body instanceof FormData) {
      axiosConfig.data = options.body;
      // Don't set Content-Type for FormData, let axios handle it
      axiosConfig.headers = {
        ...axiosConfig.headers,
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

  // Add admin token if available (for anonymous mode)
  if (adminToken && !localStorage.getItem('authToken')) {
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'Authorization': `Bearer ${adminToken}`
    };
  }

  try {
    const response = await apiClient(axiosConfig);
    return response;
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
          window.location.href = '/admin'; // Will show appropriate error message
        } else {
          // User is not authenticated, redirect to login
          window.location.href = '/';
        }
      }
    }
    throw error;
  }
};

// Specific admin API functions
export const fetchAdminUsageData = async () => {
  const response = await makeAdminApiCall('/api/admin/usage');
  return response.data;
};

export const fetchAdminCacheStats = async () => {
  const response = await makeAdminApiCall('/api/admin/cache/stats');
  return response.data;
};

export const fetchAdminApps = async () => {
  const response = await makeAdminApiCall('/api/admin/apps');
  return response.data;
};

export const fetchAdminModels = async () => {
  try {
    const response = await makeAdminApiCall('/api/admin/models');
    const data = response.data;

    // Debug logging
    console.log('Admin models API response:', data);
    console.log('Is array:', Array.isArray(data));

    // Ensure we return an array
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminModels:', error);
    throw error;
  }
};

export const fetchAdminPrompts = async () => {
  try {
    const response = await makeAdminApiCall('/api/admin/prompts');
    const data = response.data;

    // Debug logging
    console.log('Admin prompts API response:', data);
    console.log('Is array:', Array.isArray(data));

    // Ensure we return an array
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error in fetchAdminPrompts:', error);
    throw error;
  }
};

export const fetchAdminAppTemplates = async () => {
  const response = await makeAdminApiCall('/api/admin/apps/templates');
  return response.data;
};

export const fetchAppInheritance = async appId => {
  const response = await makeAdminApiCall(`/api/admin/apps/${appId}/inheritance`);
  return response.data;
};

export const createPrompt = async promptData => {
  const response = await makeAdminApiCall('/api/admin/prompts', {
    method: 'POST',
    body: promptData
  });
  return response.data;
};

export const updatePrompt = async (promptId, promptData) => {
  const response = await makeAdminApiCall(`/api/admin/prompts/${promptId}`, {
    method: 'PUT',
    body: promptData
  });
  return response.data;
};

export const translateText = async ({ text, from, to }) => {
  const response = await makeAdminApiCall('/api/admin/translate', {
    method: 'POST',
    body: { text, from, to }
  });
  return response.data;
};

export const toggleApps = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/api/admin/apps/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

export const fetchAdminPages = async () => {
  const response = await makeAdminApiCall('/api/admin/pages');
  return response.data;
};

export const fetchAdminPage = async pageId => {
  const response = await makeAdminApiCall(`/api/admin/pages/${pageId}`);
  return response.data;
};

export const createPage = async pageData => {
  const response = await makeAdminApiCall('/api/admin/pages', {
    method: 'POST',
    body: pageData
  });
  return response.data;
};

export const toggleModels = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/api/admin/models/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

export const updatePage = async (pageId, pageData) => {
  const response = await makeAdminApiCall(`/api/admin/pages/${pageId}`, {
    method: 'PUT',
    body: pageData
  });
  return response.data;
};

export const togglePrompts = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/api/admin/prompts/${idParam}/_toggle`, {
    method: 'POST',
    body: { enabled }
  });
  return response.data;
};

export const deletePage = async pageId => {
  const response = await makeAdminApiCall(`/api/admin/pages/${pageId}`, {
    method: 'DELETE'
  });
  return response.data;
};

// UI Customization API functions
export const getUIConfig = async () => {
  const response = await makeAdminApiCall('/api/admin/ui/config');
  return response;
};

export const updateUIConfig = async config => {
  const response = await makeAdminApiCall('/api/admin/ui/config', {
    method: 'POST',
    body: { config }
  });
  return response;
};

export const backupUIConfig = async () => {
  const response = await makeAdminApiCall('/api/admin/ui/backup', {
    method: 'POST'
  });
  return response;
};

export const getUIAssets = async () => {
  const response = await makeAdminApiCall('/api/admin/ui/assets');
  return response;
};

export const uploadUIAsset = async formData => {
  const response = await makeAdminApiCall('/api/admin/ui/upload-asset', {
    method: 'POST',
    body: formData
  });
  return response;
};

export const deleteUIAsset = async assetId => {
  const response = await makeAdminApiCall(`/api/admin/ui/assets/${assetId}`, {
    method: 'DELETE'
  });
  return response;
};
