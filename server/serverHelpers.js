import PromptService from './services/PromptService.js';
import { clients, activeRequests, isChatDurable } from './sse.js';
import ErrorHandler from './utils/ErrorHandler.js';
import ApiKeyVerifier from './utils/ApiKeyVerifier.js';
import { startInactiveClientSweep } from './utils/sseChannel.js';
import { resetStream } from './services/loop/RunStream.js';
import logger from './utils/logger.js';

const errorHandler = new ErrorHandler();

export async function getLocalizedError(errorKey, params = {}, language) {
  return await errorHandler.getLocalizedError(errorKey, params, language);
}

// Create singleton instance for backward compatibility
const apiKeyVerifier = new ApiKeyVerifier();

export function validateApiKeys() {
  return apiKeyVerifier.validateApiKeys();
}

// Export the class for direct use
export { ApiKeyVerifier };

export async function processMessageTemplates(
  messages,
  app,
  style = null,
  outputFormat = null,
  language,
  outputSchema = null,
  user = null,
  chatId = null,
  modelName = null,
  requestedSkill = null
) {
  return PromptService.processMessageTemplates(
    messages,
    app,
    style,
    outputFormat,
    language,
    outputSchema,
    user,
    chatId,
    modelName,
    requestedSkill
  );
}

export function cleanupInactiveClients() {
  startInactiveClientSweep(clients, {
    component: 'SSE',
    onEvict: chatId => {
      // A durable turn survives its client: the heartbeat that keeps an entry
      // "active" dies with the socket, so without this guard the sweep would
      // abort every persisted run about five minutes after the browser closed —
      // exactly the case durability exists for. Its seq counter and run binding
      // stay too, so the run keeps producing frames under the same run id and a
      // reconnect resumes the stream instead of restarting it.
      if (isChatDurable(chatId)) {
        logger.info('Inactive SSE client evicted; durable chat turn keeps running', {
          component: 'SSE',
          chatId
        });
        return;
      }
      // The stream is gone for good: drop its seq counter and run binding.
      resetStream(chatId);
      if (!activeRequests.has(chatId)) return;
      try {
        const controller = activeRequests.get(chatId);
        controller.abort();
        activeRequests.delete(chatId);
      } catch (error) {
        logger.error('Error aborting request for chat', {
          component: 'SSE',
          chatId,
          error: error?.message || String(error)
        });
      }
    }
  });
}
