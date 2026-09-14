import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * Durable chats (`/api/chats/*`) — list, open, rename and erase the chats the
 * server stored for the caller. The transcripts themselves are written off the
 * chat request path; nothing here creates or appends to a chat.
 *
 * Every call passes `cacheKey = null, ttl = null`: a chat list changes on every
 * turn, and a stale list would show a chat the user just deleted or hide the one
 * they just started. Like every endpoint module these resolve with the response
 * body (`handleApiResponse` unwraps the HTTP response), and none of them add
 * auth headers — the request interceptor in `api/client.js` does that.
 *
 * The routes answer `503 CHAT_PERSISTENCE_UNAVAILABLE` when the feature is off
 * or the storage provider did not come up, so callers should gate on
 * `platformConfig.chats.persistence` rather than probing.
 */

/**
 * One page of the caller's chats, newest activity first.
 *
 * The chat documents come back exactly as stored — no `appName`, `appColor`,
 * `appIcon` or recency group. Those are joined on the client from the apps list
 * it already holds (`useApps`) and computed from `lastMessageAt`
 * (`utils/chatGroups`).
 *
 * @param {Object} [options]
 * @param {number} [options.limit] - Page size; the server defaults to 30 and caps at 100.
 * @param {string|null} [options.cursor] - `nextCursor` from a previous page.
 * @returns {Promise<{ items: Object[], nextCursor: string|null }>} the response body, where each
 *   item is `{ id, ownerId, appId, modelId, title, titleSetByUser, createdAt, lastMessageAt,
 *   messageCount, activeRunId, hasUnseenActivity, status, runIds }`
 */
export const fetchChats = async (options = {}) => {
  const { limit, cursor } = options;

  return handleApiResponse(
    () => apiClient.get('/chats', { params: { limit, cursor } }),
    null, // never cached — a chat list must not be served stale
    null
  );
};

/**
 * One chat with its stored transcript. Opening a chat is what "seen" means, so
 * this also clears the chat's `hasUnseenActivity` flag server-side.
 *
 * @param {string} chatId - Chat id.
 * @returns {Promise<{ chat: Object, messages: Object[], version: number }>} the response body,
 *   where each message is `{ id, role, content, ts, runId, clientMessageId?, usage?, error?,
 *   finishReason?, attachments? }`
 */
export const fetchChat = async chatId => {
  if (!chatId) {
    throw new Error('Missing required parameters');
  }

  return handleApiResponse(
    () => apiClient.get(`/chats/${encodeURIComponent(chatId)}`),
    null, // never cached — the transcript grows while the chat is open
    null
  );
};

/**
 * Rename a chat. The server caps the title and marks it as user-set so no later
 * turn derives a title over it; an empty title clears that mark instead.
 *
 * @param {string} chatId - Chat id.
 * @param {string} title - New title.
 * @returns {Promise<{ chat: Object }>} the response body
 */
export const renameChat = async (chatId, title) => {
  if (!chatId) {
    throw new Error('Missing required parameters');
  }

  return handleApiResponse(
    () => apiClient.patch(`/chats/${encodeURIComponent(chatId)}`, { title: title ?? '' }),
    null,
    null
  );
};

/**
 * Erase a chat, its transcript and the runs it produced. Reports success even
 * when a concurrent delete won the race — the postcondition holds either way.
 *
 * @param {string} chatId - Chat id.
 * @returns {Promise<{ deleted: boolean }>} the response body
 */
export const deleteChat = async chatId => {
  if (!chatId) {
    throw new Error('Missing required parameters');
  }

  return handleApiResponse(
    () => apiClient.delete(`/chats/${encodeURIComponent(chatId)}`),
    null,
    null
  );
};
