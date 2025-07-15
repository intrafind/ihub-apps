// Utility function to make authenticated API calls to admin endpoints
export const makeAdminApiCall = async (url, options = {}) => {
  const token = localStorage.getItem('adminToken');

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401 || response.status === 403) {
    // Clear invalid token
    localStorage.removeItem('adminToken');

    // Redirect to admin home to trigger authentication
    if (window.location.pathname.startsWith('/admin')) {
      window.location.href = '/admin';
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
