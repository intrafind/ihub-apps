// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient, streamingApiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { shortenedTimeout } from '../utils/devTimeout';

/**
 * The request settings of the chat POST: nothing of its own, except in a
 * development build, where a test may shorten its timeout by setting
 * `window.__ihubStreamTimeoutMs` before the message is sent. The POST is
 * answered when the turn ends, and its timeout is five minutes; the end-to-end
 * proof that a turn outlasts it (`tests/e2e-agents/long-turn.spec.js`) cannot
 * wait that long.
 *
 * A production build never reads the window property: Vite replaces
 * `import.meta.env.DEV` with `false` there, and the bundler drops what follows
 * the `return`. In a development build the value can only shorten the timeout
 * (`shortenedTimeout`), never lengthen or remove it, and a POST that times out
 * early stops nothing: the client asks whether the turn is running and keeps
 * listening (`sendPendingMessage`).
 *
 * @returns {{timeout: number}|undefined}
 */
const chatPostConfig = () => {
  if (!import.meta.env.DEV) return undefined;
  const timeout = shortenedTimeout(
    window.__ihubStreamTimeoutMs,
    streamingApiClient.defaults.timeout
  );
  return timeout === undefined ? undefined : { timeout };
};

// Apps
export const fetchApps = async (options = {}) => {
  const { language = null } = options;

  const data = await handleApiResponse(
    () => apiClient.get('/apps', { params: { language } }),
    null, // no client-side caching for apps list
    null
  );
  return data?.items ?? [];
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
      streamingApiClient.post(
        `/apps/${appId}/chat/${chatId}`,
        {
          messages,
          ...options
        },
        chatPostConfig()
      ),
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
 * Whether the server is working on a chat: `{ active, processing }`.
 *
 * @param {string} appId
 * @param {string} chatId
 * @param {Object} [options]
 * @param {number} [options.timeout] - How long to wait for the answer, in
 *   milliseconds, instead of the API client's own limit of 30 seconds. A check
 *   that passes it fails like any request that timed out (`isTimeout`).
 * @returns {Promise<Object>}
 */
export const checkAppChatStatus = async (appId, chatId, { timeout } = {}) => {
  return handleApiResponse(
    () =>
      apiClient.get(
        `/apps/${appId}/chat/${chatId}/status`,
        Number.isFinite(timeout) && timeout > 0 ? { timeout } : undefined
      ),
    null, // Don't cache status checks
    null,
    false // Don't deduplicate status checks
  );
};
