import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * Chat sharing (`/api/chats/:chatId/shares`, `/api/shares/*`,
 * `/api/users/lookup`) — read-only links onto durable chats.
 *
 * Nothing here is cached: a share can be revoked at any moment and the view
 * counts move on every open. The viewer calls add no auth headers of their
 * own — the request interceptor in `api/client.js` attaches the caller's
 * credentials when there are any, and a `public` share simply does not need
 * them.
 *
 * Callers gate on `platformConfig.chats.sharing.enabled` rather than probing:
 * the owner routes answer `503 CHAT_SHARING_UNAVAILABLE` when sharing is off,
 * and the viewer routes answer 404.
 */

/**
 * Create a share of a chat.
 *
 * @param {string} chatId - Chat to share.
 * @param {Object} body
 * @param {'users'|'authenticated'|'public'} body.mode - Who may open the link.
 * @param {string[]} [body.recipients] - User ids, for `users` mode.
 * @param {string|null} [body.expiresAt] - ISO instant, or null for none.
 * @param {number|null} [body.maxViews] - Positive integer, or null for unlimited.
 * @param {boolean} [body.showOwnerName] - Whether a public viewer sees the owner's name.
 * @returns {Promise<{ share: Object }>} the response body, where `share` is the
 *   owner's view: `{ id, chatId, mode, recipients, recipientDetails, title,
 *   createdAt, expiresAt, maxViews, viewCount, lastViewedAt, recipientViews,
 *   revokedAt, state, … }`
 */
export const createChatShare = async (chatId, body) => {
  if (!chatId || !body?.mode) {
    throw new Error('Missing required parameters');
  }
  return handleApiResponse(
    () => apiClient.post(`/chats/${encodeURIComponent(chatId)}/shares`, body),
    null,
    null
  );
};

/**
 * The shares of one chat, newest first — active and dead alike.
 *
 * @param {string} chatId - Chat id.
 * @returns {Promise<{ items: Object[] }>} the response body
 */
export const fetchChatShares = async chatId => {
  if (!chatId) {
    throw new Error('Missing required parameters');
  }
  return handleApiResponse(
    () => apiClient.get(`/chats/${encodeURIComponent(chatId)}/shares`),
    null,
    null
  );
};

/**
 * Revoke a share. The link stops opening immediately; the record stays in
 * the owner's list marked revoked.
 *
 * @param {string} shareId - Share id.
 * @returns {Promise<{ share: Object }>} the response body
 */
export const revokeChatShare = async shareId => {
  if (!shareId) {
    throw new Error('Missing required parameters');
  }
  return handleApiResponse(
    () => apiClient.delete(`/shares/${encodeURIComponent(shareId)}`),
    null,
    null
  );
};

/**
 * The `users`-mode shares addressed to the caller that still open.
 *
 * @returns {Promise<{ items: Object[] }>} the response body, where each item is
 *   `{ id, mode, title, appId, app, createdAt, expiresAt, sharedBy, messageCount,
 *   viewed, lastViewedAt }`
 */
export const fetchSharesWithMe = async () => {
  return handleApiResponse(() => apiClient.get('/shares/with-me'), null, null);
};

/**
 * Open a share: its frozen transcript and what the page shows about it.
 *
 * Rejects with `status` 401 when the link needs a sign-in the caller does not
 * have, and 404 when it is unknown, revoked, expired or used up.
 *
 * @param {string} shareId - Share id from the URL.
 * @returns {Promise<{ share: Object, messages: Object[], version: number }>} the response body
 */
export const fetchSharedChat = async shareId => {
  if (!shareId) {
    throw new Error('Missing required parameters');
  }
  return handleApiResponse(
    () => apiClient.get(`/shares/${encodeURIComponent(shareId)}`),
    null,
    null
  );
};

/**
 * Descriptors of the artifacts a share's messages reference.
 *
 * @param {string} shareId - Share id.
 * @returns {Promise<{ items: Object[] }>} the response body
 */
export const fetchSharedChatArtifacts = async shareId => {
  if (!shareId) {
    throw new Error('Missing required parameters');
  }
  return handleApiResponse(
    () => apiClient.get(`/shares/${encodeURIComponent(shareId)}/artifacts`),
    null,
    null
  );
};

/**
 * The bytes of one artifact, through the share, as a blob. Same shape as
 * `fetchChatArtifact` so the chat bubble can use either.
 *
 * @param {string} shareId - Share id.
 * @param {string} artifactId - Artifact id from a message descriptor.
 * @returns {Promise<Blob>} the artifact bytes
 */
export const fetchSharedArtifact = async (shareId, artifactId) => {
  if (!shareId || !artifactId) {
    throw new Error('Missing required parameters');
  }
  const response = await apiClient.get(
    `/shares/${encodeURIComponent(shareId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { responseType: 'blob' }
  );
  return response.data;
};

/**
 * Users matching a name or e-mail fragment, for the recipient picker. At
 * most ten, never the caller, nothing under two characters.
 *
 * @param {string} q - Query.
 * @returns {Promise<{ items: Array<{ id: string, name: string, email: string|null }> }>}
 */
export const lookupUsers = async q => {
  const query = typeof q === 'string' ? q.trim() : '';
  if (query.length < 2) return { items: [] };
  return handleApiResponse(
    () => apiClient.get('/users/lookup', { params: { q: query } }),
    null,
    null
  );
};
