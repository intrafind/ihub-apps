import { apiClient, streamingApiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

// Apps
export const fetchApps = async (options = {}) => {
  const { language = null } = options;

  return handleApiResponse(
    () => apiClient.get('/apps', { params: { language } }),
    null, // no client-side caching for apps list
    null
  );
};

export const fetchAppDetails = async (appId, options = {}) => {
  const { language = null } = options;

  return handleApiResponse(
    () => apiClient.get(`/apps/${appId}`, { params: { language } }),
    null, // no client-side caching for app details
    null
  );
};

export const sendAppChatMessage = async (appId, chatId, messages, options = {}) => {
  if (!appId || !chatId || !messages) {
    throw new Error('Missing required parameters');
  }

  return handleApiResponse(
    () =>
      streamingApiClient.post(`/apps/${appId}/chat/${chatId}`, {
        messages,
        ...options
      }),
    null, // No caching for chat messages
    null,
    false // Don't deduplicate chat requests
  );
};

export const stopAppChatStream = async (appId, chatId) => {
  return handleApiResponse(
    () => apiClient.post(`/apps/${appId}/chat/${chatId}/stop`),
    null, // No caching
    null,
    false // Don't deduplicate
  );
};

export const checkAppChatStatus = async (appId, chatId) => {
  return handleApiResponse(
    () => apiClient.get(`/apps/${appId}/chat/${chatId}/status`),
    null, // Don't cache status checks
    null,
    false // Don't deduplicate status checks
  );
};

export const exportChatToPDF = async (appId, chatId, exportData) => {
  if (!appId || !chatId || !exportData) {
    throw new Error('Missing required parameters');
  }

  const response = await apiClient.post(`/apps/${appId}/chat/${chatId}/export/pdf`, exportData, {
    responseType: 'blob' // Important for binary PDF data
  });

  // Create download link from blob response
  const blob = new Blob([response.data], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  // Extract filename from Content-Disposition header if available
  const contentDisposition = response.headers['content-disposition'];
  let filename = 'chat-export.pdf';
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch) {
      filename = filenameMatch[1].replace(/['"]/g, '');
    }
  }

  // Trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  return { success: true, filename };
};
