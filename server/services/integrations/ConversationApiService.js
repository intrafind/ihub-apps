/**
 * ConversationApiService
 * HTTP client for the iFinder Conversation API endpoints.
 * Supports multi-turn conversations, message sending, feedback, and profile listing.
 *
 * Base path: /public-api/rag/api/v0
 */
import { throttledFetch } from '../../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import logger from '../../utils/logger.js';

const BASE_PATH = '/public-api/rag/api/v0';

class ConversationApiService {
  /**
   * Build full URL for a conversation API endpoint
   */
  buildUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/, '')}${BASE_PATH}${path}`;
  }

  /**
   * Build standard request headers with JWT auth
   */
  buildHeaders(user, options = {}) {
    const authHeader = getIFinderAuthorizationHeader(user, { scope: options.scope });
    return {
      'Content-Type': 'application/json',
      Accept: options.accept || 'application/json',
      Authorization: authHeader,
      ...options.extraHeaders
    };
  }

  /**
   * Create a new conversation
   * @param {Object} params
   * @param {Object} params.user - Authenticated user
   * @param {string} params.baseUrl - iFinder base URL
   * @param {string} [params.searchProfile] - iFinder search profile name (e.g. "searchprofile-standard")
   * @param {Object} [params.labels] - Labels/tags for the conversation
   * @param {Object} [params.retrievalScope] - Document scope restrictions (merged into retrieval_scope)
   * @param {boolean} [params.ephemeral] - Whether the conversation is ephemeral
   * @returns {Promise<Object>} Created conversation object
   */
  async createConversation({ user, baseUrl, searchProfile, labels, retrievalScope, ephemeral }) {
    const url = this.buildUrl(baseUrl, '/conversations');
    const headers = this.buildHeaders(user);

    const conversation = {};
    if (labels) conversation.labels = labels;
    if (ephemeral !== undefined) conversation.ephemeral = ephemeral;

    // Build retrieval_scope: always include search profile, merge with document scope
    const retrieval_scope = {};
    if (searchProfile) retrieval_scope.ifinder_search_profile = searchProfile;
    if (retrievalScope) Object.assign(retrieval_scope, retrievalScope);

    const body = { conversation };
    if (Object.keys(retrieval_scope).length > 0) body.retrieval_scope = retrieval_scope;

    logger.info(
      `ConversationApiService: Creating conversation at ${url} — body: ${JSON.stringify(body)}`
    );

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create conversation (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Send a message to a conversation (returns raw Response for streaming)
   * @param {string} conversationId - Conversation ID
   * @param {Object} params
   * @param {string} params.content - Message content
   * @param {string} [params.parentId] - Parent message ID for threading
   * @param {string} [params.profileId] - Profile to use for this message
   * @param {Array} [params.tools] - Tools available for this message
   * @param {Object} params.user - Authenticated user
   * @param {string} params.baseUrl - iFinder base URL
   * @returns {Promise<Response>} Raw fetch Response for streaming
   */
  async sendMessage(conversationId, { content, parentId, profileId, tools, user, baseUrl }) {
    const url = this.buildUrl(baseUrl, `/conversations/${conversationId}/messages`);
    const headers = this.buildHeaders(user, { accept: 'text/event-stream' });

    const message = { content };
    if (profileId) message.profile_id = profileId;
    if (tools && tools.length > 0) message.tools = tools;

    const body = { message };
    if (parentId) body.parent_id = parentId;

    logger.info('ConversationApiService: Sending message', {
      conversationId,
      hasParentId: !!parentId,
      contentLength: content?.length
    });

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send message (${response.status}): ${errorText}`);
    }

    // Return raw response for streaming
    return response;
  }

  /**
   * Get conversation details
   */
  async getConversation(conversationId, { user, baseUrl }) {
    const url = this.buildUrl(baseUrl, `/conversations/${conversationId}`);
    const headers = this.buildHeaders(user);

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get conversation (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get messages for a conversation (paginated)
   * @param {string} conversationId
   * @param {Object} params
   * @param {number} [params.size=50] - Page size
   * @param {string} [params.nextCursor] - Cursor for pagination
   * @returns {Promise<Object>} { messages: [], nextCursor?: string }
   */
  async getMessages(conversationId, { user, baseUrl, size = 50, nextCursor }) {
    let path = `/conversations/${conversationId}/messages?size=${size}`;
    if (nextCursor) path += `&next_cursor=${encodeURIComponent(nextCursor)}`;

    const url = this.buildUrl(baseUrl, path);
    const headers = this.buildHeaders(user);

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get messages (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Delete a conversation
   */
  async deleteConversation(conversationId, { user, baseUrl }) {
    const url = this.buildUrl(baseUrl, `/conversations/${conversationId}`);
    const headers = this.buildHeaders(user);

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'DELETE',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete conversation (${response.status}): ${errorText}`);
    }

    return response.status === 204 ? null : response.json();
  }

  /**
   * Delete a specific message from a conversation
   */
  async deleteMessage(conversationId, messageId, { user, baseUrl }) {
    const url = this.buildUrl(baseUrl, `/conversations/${conversationId}/messages/${messageId}`);
    const headers = this.buildHeaders(user);

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'DELETE',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete message (${response.status}): ${errorText}`);
    }

    return response.status === 204 ? null : response.json();
  }

  /**
   * Send feedback for a message
   * @param {string} conversationId
   * @param {string} messageId
   * @param {Object} params
   * @param {string} params.rating - 'positive' or 'negative'
   * @param {string} [params.comment] - Optional feedback comment
   */
  async sendFeedback(conversationId, messageId, { user, baseUrl, rating, comment }) {
    const url = this.buildUrl(
      baseUrl,
      `/conversations/${conversationId}/messages/${messageId}/feedback`
    );
    const headers = this.buildHeaders(user);

    const body = { rating };
    if (comment) body.comment = comment;

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send feedback (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Delete feedback for a message
   */
  async deleteFeedback(conversationId, messageId, { user, baseUrl }) {
    const url = this.buildUrl(
      baseUrl,
      `/conversations/${conversationId}/messages/${messageId}/feedback`
    );
    const headers = this.buildHeaders(user);

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'DELETE',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete feedback (${response.status}): ${errorText}`);
    }

    return response.status === 204 ? null : response.json();
  }

  /**
   * List available profiles
   */
  async listProfiles({ user, baseUrl }) {
    const url = this.buildUrl(baseUrl, '/profiles');
    const headers = this.buildHeaders(user);

    const response = await throttledFetch('iAssistantConversation', url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list profiles (${response.status}): ${errorText}`);
    }

    return response.json();
  }
}

export default new ConversationApiService();
