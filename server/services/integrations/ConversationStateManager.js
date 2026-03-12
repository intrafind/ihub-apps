/**
 * ConversationStateManager
 * In-memory state manager mapping chatId -> conversation state.
 * Tracks conversation IDs, parent message IDs for threading, and metadata.
 * Uses TTL-based cleanup to prevent memory leaks.
 */
import logger from '../../utils/logger.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

class ConversationStateManager {
  constructor() {
    this.states = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow Node to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Get conversation state for a chat
   * @param {string} chatId
   * @returns {Object|null} Conversation state or null
   */
  getState(chatId) {
    const entry = this.states.get(chatId);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.createdAt > DEFAULT_TTL_MS) {
      this.states.delete(chatId);
      return null;
    }

    return entry;
  }

  /**
   * Set conversation state for a chat
   * @param {string} chatId
   * @param {Object} state - { conversationId, lastParentId, title, baseUrl, profileId }
   */
  setState(chatId, state) {
    this.states.set(chatId, {
      ...state,
      createdAt: state.createdAt || Date.now(),
      updatedAt: Date.now()
    });
  }

  /**
   * Delete state for a chat
   * @param {string} chatId
   */
  deleteState(chatId) {
    this.states.delete(chatId);
  }

  /**
   * Update the parent ID after receiving a response_message_id event
   * @param {string} chatId
   * @param {string} messageId - The response message ID to use as parent for next message
   */
  updateParentId(chatId, messageId) {
    const entry = this.states.get(chatId);
    if (entry) {
      entry.lastParentId = messageId;
      entry.updatedAt = Date.now();
    } else {
      logger.warn('No state found for chatId when updating parentId', {
        component: 'ConversationStateManager',
        chatId
      });
    }
  }

  /**
   * Set the conversation ID (e.g. when client provides an existing conversation to resume)
   * @param {string} chatId
   * @param {string} conversationId
   */
  setConversationId(chatId, conversationId) {
    const entry = this.states.get(chatId);
    if (entry) {
      entry.conversationId = conversationId;
      entry.updatedAt = Date.now();
    } else {
      // Create minimal state if none exists
      this.setState(chatId, { conversationId });
    }
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [chatId, entry] of this.states) {
      if (now - entry.createdAt > DEFAULT_TTL_MS) {
        this.states.delete(chatId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info('Cleaned up expired entries', {
        component: 'ConversationStateManager',
        count: cleaned
      });
    }
  }

  /**
   * Get current state count (for monitoring)
   */
  get size() {
    return this.states.size;
  }
}

export default new ConversationStateManager();
