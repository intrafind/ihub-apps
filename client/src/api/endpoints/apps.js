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

/**
 * Get conversation messages from iAssistant Conversation API
 * @param {string} appId - App ID
 * @param {string} conversationId - Conversation ID
 * @param {Object} [options] - Pagination options
 * @param {number} [options.size] - Page size
 * @param {string} [options.nextCursor] - Cursor for pagination
 */
export const getConversationMessages = async (appId, conversationId, options = {}) => {
  const params = {};
  if (options.size) params.size = options.size;
  if (options.nextCursor) params.next_cursor = options.nextCursor;

  return handleApiResponse(
    () =>
      apiClient.get(`/apps/${appId}/conversations/${conversationId}/messages`, {
        params
      }),
    null,
    null,
    false
  );
};

/**
 * Delete a conversation
 */
export const deleteConversation = async (appId, conversationId) => {
  return handleApiResponse(
    () => apiClient.delete(`/apps/${appId}/conversations/${conversationId}`),
    null,
    null,
    false
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
