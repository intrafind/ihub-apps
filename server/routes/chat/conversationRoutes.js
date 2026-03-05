/**
 * Conversation API routes for iAssistant Conversation provider.
 * Provides endpoints for loading conversation history and managing messages.
 */
import { authRequired } from '../../middleware/authRequired.js';
import configCache from '../../configCache.js';
import conversationApiService from '../../services/integrations/ConversationApiService.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';

/**
 * Resolve the iAssistant base URL for an app's conversation API calls.
 * Checks app config -> model config -> service defaults.
 */
function resolveBaseUrl(app) {
  // Check app-level iassistant config
  if (app?.iassistant?.baseUrl) return app.iassistant.baseUrl;

  // Check the app's preferred model config
  const modelId = app?.preferredModel;
  if (modelId) {
    const { data: models = [] } = configCache.getModels() || {};
    const model = models.find(m => m.id === modelId);
    if (model?.config?.baseUrl) return model.config.baseUrl;
  }

  // Fall back to service defaults
  return iAssistantService.getConfig().baseUrl;
}

export default function registerConversationRoutes(app) {
  /**
   * GET /api/apps/:appId/conversations/:conversationId/messages
   * Load message history for a conversation (paginated)
   */
  app.get(
    buildServerPath('apps/:appId/conversations/:conversationId/messages'),
    authRequired,
    async (req, res) => {
      try {
        const { appId, conversationId } = req.params;
        const { size = 50, next_cursor: nextCursor } = req.query;
        const user = req.user;

        // Load app config to get baseUrl
        const { data: apps = [] } = configCache.getApps() || {};
        const appConfig = apps.find(a => a.id === appId);
        if (!appConfig) {
          return res.status(404).json({ error: 'App not found' });
        }

        const baseUrl = resolveBaseUrl(appConfig);
        if (!baseUrl) {
          return res.status(400).json({ error: 'No base URL configured for conversation API' });
        }

        const result = await conversationApiService.getMessages(conversationId, {
          user,
          baseUrl,
          size: parseInt(size, 10),
          nextCursor
        });

        res.json(result);
      } catch (error) {
        logger.error('Conversation messages route error:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  /**
   * DELETE /api/apps/:appId/conversations/:conversationId/messages/:messageId
   * Delete a message (e.g. for cancellation)
   */
  app.delete(
    buildServerPath('apps/:appId/conversations/:conversationId/messages/:messageId'),
    authRequired,
    async (req, res) => {
      try {
        const { appId, conversationId, messageId } = req.params;
        const user = req.user;

        const { data: apps = [] } = configCache.getApps() || {};
        const appConfig = apps.find(a => a.id === appId);
        if (!appConfig) {
          return res.status(404).json({ error: 'App not found' });
        }

        const baseUrl = resolveBaseUrl(appConfig);
        if (!baseUrl) {
          return res.status(400).json({ error: 'No base URL configured for conversation API' });
        }

        await conversationApiService.deleteMessage(conversationId, messageId, {
          user,
          baseUrl
        });

        res.status(204).send();
      } catch (error) {
        logger.error('Conversation delete message route error:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  /**
   * DELETE /api/apps/:appId/conversations/:conversationId
   * Delete an entire conversation
   */
  app.delete(
    buildServerPath('apps/:appId/conversations/:conversationId'),
    authRequired,
    async (req, res) => {
      try {
        const { appId, conversationId } = req.params;
        const user = req.user;

        const { data: apps = [] } = configCache.getApps() || {};
        const appConfig = apps.find(a => a.id === appId);
        if (!appConfig) {
          return res.status(404).json({ error: 'App not found' });
        }

        const baseUrl = resolveBaseUrl(appConfig);
        if (!baseUrl) {
          return res.status(400).json({ error: 'No base URL configured for conversation API' });
        }

        await conversationApiService.deleteConversation(conversationId, {
          user,
          baseUrl
        });

        res.status(204).send();
      } catch (error) {
        logger.error('Conversation delete route error:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );
}
