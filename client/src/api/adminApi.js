// Utility function to make authenticated API calls to admin endpoints
export const makeAdminApiCall = async (url, options = {}) => {
  // In local/OIDC/proxy modes, use the regular authToken
  // In anonymous mode, use the adminToken (admin secret)
  const authToken = localStorage.getItem('authToken');
  const adminToken = localStorage.getItem('adminToken');

  // Prefer authToken (regular authentication) over adminToken (admin secret)
  const token = authToken || adminToken;

  const headers = {
    ...options.headers
  };

  // Only set Content-Type if not uploading files (FormData)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401 || response.status === 403) {
    // Clear invalid tokens
    if (adminToken) {
      localStorage.removeItem('adminToken');
    }

    // For auth failures, redirect appropriately based on the auth mode
    if (window.location.pathname.startsWith('/admin')) {
      // If we have a regular auth token, this suggests a permission issue
      if (authToken) {
        // User is authenticated but doesn't have admin permissions
        window.location.href = '/admin'; // Will show appropriate error message
      } else {
        // User is not authenticated, redirect to login
        window.location.href = '/';
      }
    }

    throw new Error('Authentication required');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
  }

  return response;
};

// Specific admin API functions
export const fetchAdminUsageData = async () => {
  const response = await makeAdminApiCall('/api/admin/usage');
  return response.json();
};

export const fetchAdminCacheStats = async () => {
  const response = await makeAdminApiCall('/api/admin/cache/stats');
  return response.json();
};

export const fetchAdminApps = async () => {
  const response = await makeAdminApiCall('/api/admin/apps');
  return response.json();
};

export const fetchAdminModels = async () => {
  try {
    const response = await makeAdminApiCall('/api/admin/models');
    const data = await response.json();

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
    const data = await response.json();

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
  return response.json();
};

export const fetchAppInheritance = async appId => {
  const response = await makeAdminApiCall(`/api/admin/apps/${appId}/inheritance`);
  return response.json();
};

export const createPrompt = async promptData => {
  const response = await makeAdminApiCall('/api/admin/prompts', {
    method: 'POST',
    body: JSON.stringify(promptData)
  });
  return response.json();
};

export const updatePrompt = async (promptId, promptData) => {
  const response = await makeAdminApiCall(`/api/admin/prompts/${promptId}`, {
    method: 'PUT',
    body: JSON.stringify(promptData)
  });
  return response.json();
};

export const translateText = async ({ text, from, to }) => {
  const response = await makeAdminApiCall('/api/admin/translate', {
    method: 'POST',
    body: JSON.stringify({ text, from, to })
  });
  return response.json();
};

export const toggleApps = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/api/admin/apps/${idParam}/_toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled })
  });
  return response.json();
};

export const fetchAdminPages = async () => {
  const response = await makeAdminApiCall('/api/admin/pages');
  return response.json();
};

export const fetchAdminPage = async pageId => {
  const response = await makeAdminApiCall(`/api/admin/pages/${pageId}`);
  return response.json();
};

export const createPage = async pageData => {
  const response = await makeAdminApiCall('/api/admin/pages', {
    method: 'POST',
    body: JSON.stringify(pageData)
  });
  return response.json();
};

export const toggleModels = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/api/admin/models/${idParam}/_toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled })
  });
  return response.json();
};

export const updatePage = async (pageId, pageData) => {
  const response = await makeAdminApiCall(`/api/admin/pages/${pageId}`, {
    method: 'PUT',
    body: JSON.stringify(pageData)
  });
  return response.json();
};

export const togglePrompts = async (ids, enabled) => {
  const idParam = Array.isArray(ids) ? ids.join(',') : ids;
  const response = await makeAdminApiCall(`/api/admin/prompts/${idParam}/_toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled })
  });
  return response.json();
};

export const deletePage = async pageId => {
  const response = await makeAdminApiCall(`/api/admin/pages/${pageId}`, {
    method: 'DELETE'
  });
  return response.json();
};

// UI Customization API functions
export const getUIConfig = async () => {
  const response = await makeAdminApiCall('/api/admin/ui/config');
  return response;
};

export const updateUIConfig = async config => {
  const response = await makeAdminApiCall('/api/admin/ui/config', {
    method: 'POST',
    body: JSON.stringify({ config }),
    headers: {
      'Content-Type': 'application/json'
    }
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
