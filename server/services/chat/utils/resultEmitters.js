/**
 * Result Emitters
 *
 * Shared utility functions for emitting streaming result metadata
 * (images, thinking content, grounding metadata) to the client via actionTracker.
 *
 * Previously these lived on StreamingHandler and were awkwardly accessed from
 * ToolExecutor via `this.streamingHandler.processImages(result, chatId)`.
 *
 * @module services/chat/utils/resultEmitters
 */

import { actionTracker } from '../../../actionTracker.js';

/**
 * Emit images from a streaming result to the client.
 * @param {Object} result - Generic streaming result with optional images array
 * @param {string} chatId - Chat/session identifier
 */
export function emitImages(result, chatId) {
  if (result && result.images && result.images.length > 0) {
    for (const image of result.images) {
      actionTracker.trackImage(chatId, {
        mimeType: image.mimeType,
        data: image.data,
        thoughtSignature: image.thoughtSignature
      });
    }
  }
}

/**
 * Emit thinking content from a streaming result to the client.
 * @param {Object} result - Generic streaming result with optional thinking array
 * @param {string} chatId - Chat/session identifier
 */
export function emitThinking(result, chatId) {
  if (result && result.thinking && result.thinking.length > 0) {
    for (const thought of result.thinking) {
      actionTracker.trackThinking(chatId, { content: thought });
    }
  }
}

/**
 * Emit grounding metadata from a streaming result to the client.
 * @param {Object} result - Generic streaming result with optional groundingMetadata
 * @param {string} chatId - Chat/session identifier
 */
export function emitGroundingMetadata(result, chatId) {
  if (result && result.groundingMetadata) {
    actionTracker.trackAction(chatId, {
      event: 'grounding',
      metadata: result.groundingMetadata
    });
  }
}
