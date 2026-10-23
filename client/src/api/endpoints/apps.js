// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

/**
 * Stop the turn running on a chat. This is the unconditional abort — it ends a
 * stored turn too — so only a person's Stop reaches it; see `useEventSource`.
 *
 * @param {string} appId
 * @param {string} chatId
 * @param {Object} [options]
 * @param {string} [options.source] - The control that asked (`stop-button`, `compare`, …),
 *   recorded with who stopped the turn
 */
export const stopAppChatStream = async (appId, chatId, { source } = {}) => {
  return handleApiResponse(
    () => apiClient.post(`/apps/${appId}/chat/${chatId}/stop`, source ? { source } : undefined),
    null, // No caching
    null,
    false // Don't deduplicate
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
