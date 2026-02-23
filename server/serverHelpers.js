import PromptService from './services/PromptService.js';
import { clients, activeRequests } from './sse.js';
import ErrorHandler from './utils/ErrorHandler.js';
import ApiKeyVerifier from './utils/ApiKeyVerifier.js';
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

export async function verifyApiKey(model, res, clientRes = null, language) {
  const result = await apiKeyVerifier.verifyApiKey(model, res, clientRes, language);
  return result.success ? result.apiKey : false;
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
  setInterval(() => {
    const now = new Date();
    for (const [chatId, client] of clients.entries()) {
      if (now - client.lastActivity > 5 * 60 * 1000) {
        if (activeRequests.has(chatId)) {
          try {
            const controller = activeRequests.get(chatId);
            controller.abort();
            activeRequests.delete(chatId);
          } catch (e) {
            logger.error(`Error aborting request for chat ID: ${chatId}`, {
              component: 'SSE',
              error: e
            });
          }
        }
        client.response.end();
        clients.delete(chatId);
        logger.info(`Removed inactive client: ${chatId}`, { component: 'SSE' });
      }
    }
  }, 60 * 1000);
}
