/**
 * Request Lifecycle Manager
 *
 * Manages the lifecycle of an LLM streaming request:
 * - AbortController for cancellation
 * - Timeout management
 * - activeRequests map registration/cleanup
 *
 * Consolidates previously duplicated logic from:
 * - StreamingHandler.executeStreamingResponse
 * - ToolExecutor.processChatWithTools
 * - ToolExecutor.continueWithToolExecution
 *
 * @module services/chat/utils/requestLifecycle
 */

import { activeRequests } from '../../../sse.js';

/**
 * Manages the lifecycle of an active LLM request.
 */
class RequestLifecycle {
  /**
   * @param {string} chatId - Chat/session identifier
   * @param {Object} options - Lifecycle options
   * @param {number} options.timeout - Timeout in milliseconds
   * @param {Function} options.onTimeout - Called when the timeout fires
   */
  constructor(chatId, { timeout, onTimeout }) {
    this.chatId = chatId;
    this.controller = new AbortController();
    this.timeoutId = null;
    this.timeout = timeout;
    this.onTimeout = onTimeout;

    // Abort any existing request for this chat
    if (activeRequests.has(chatId)) {
      const existingController = activeRequests.get(chatId);
      existingController.abort();
    }
    activeRequests.set(chatId, this.controller);

    // Set up the timeout
    this._setupTimeout();
  }

  /** @returns {AbortSignal} The abort signal for use with fetch */
  get signal() {
    return this.controller.signal;
  }

  /** Reset the timeout (e.g., after a successful response) */
  resetTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this._setupTimeout();
  }

  /** Clear the timeout without resetting */
  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /** Clean up the lifecycle (clear timeout, remove from activeRequests) */
  cleanup() {
    this.clearTimeout();
    if (activeRequests.get(this.chatId) === this.controller) {
      activeRequests.delete(this.chatId);
    }
  }

  /** @private Set up the timeout handler */
  _setupTimeout() {
    this.timeoutId = setTimeout(async () => {
      if (activeRequests.has(this.chatId)) {
        this.controller.abort();
        if (this.onTimeout) {
          await this.onTimeout();
        }
        if (activeRequests.get(this.chatId) === this.controller) {
          activeRequests.delete(this.chatId);
        }
      }
    }, this.timeout);
  }
}

export default RequestLifecycle;
