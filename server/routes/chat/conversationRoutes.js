// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Conversation API routes for iAssistant Conversation provider.
 * Provides endpoints for loading conversation history and managing messages.
 */
import { authRequired } from '../../middleware/authRequired.js';
import configCache from '../../configCache.js';
import conversationApiService from '../../services/integrations/ConversationApiService.js';
import conversationStateManager from '../../services/integrations/ConversationStateManager.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import iAssistantProfileResolver from '../../services/integrations/iAssistantProfileResolver.js';
import { withConversationSources } from '../../services/sources/producers/ifinder.js';
import logger from '../../utils/logger.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError, sendNotFound, sendBadRequest } from '../../utils/responseHelpers.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { authorizeChat } from '../../services/chat/chatAccess.js';
import { scopeToConversationConfig } from '../../services/integrations/scopes/iAssistantScopes.js';

/** The `config` block of an app's preferred model, or an empty object. */
function preferredModelConfig(app) {
  const modelId = app?.preferredModel;
  if (!modelId) return {};
  const { data: models = [] } = configCache.getModels() || {};
  return findByIdCaseInsensitive(models, modelId)?.config || {};
}

/**
 * Resolve the iAssistant base URL for an app's conversation API calls.
 * Checks app config -> model config -> service defaults.
 */
function resolveBaseUrl(app) {
  return (
    app?.iassistant?.baseUrl ||
    preferredModelConfig(app).baseUrl ||
    iAssistantService.getConfig().baseUrl
  );
}

/**
 * The search profile an app's conversations search, resolved the way the
 * adapter does when it creates one: the iFinder iAssistant the chat's scope or
 * the app names, none when the chat or the app searches all of the user's
 * profiles, or the configured one (app → model → service defaults) unless the
 * user does not have it.
 * Never throws — without a profile the history is returned as iFinder sent it.
 *
 * @param {Object} app
 * @param {Object} params
 * @param {Object} params.user
 * @param {string} params.baseUrl
 * @param {string|null} [params.scopeId] - the chat's iAssistant scope (#3050)
 */
async function resolveConversationSearchProfile(app, { user, baseUrl, scopeId = null }) {
  try {
    const appConfig = app?.iassistant || {};
    const modelConfig = preferredModelConfig(app);
    const serviceConfig = iAssistantService.getConfig();
    const scoped = scopeToConversationConfig(scopeId);
    const { searchProfile } = await iAssistantProfileResolver.resolveScope({
      assistantId: scoped ? scoped.assistantId : appConfig.assistantId || modelConfig.assistantId,
      allSearchProfiles: scoped
        ? scoped.allSearchProfiles
        : (appConfig.allSearchProfiles ?? modelConfig.allSearchProfiles ?? false),
      configuredSearchProfile:
        appConfig.searchProfile || modelConfig.searchProfile || serviceConfig.defaultSearchProfile,
      user,
      baseUrl
    });
    return searchProfile;
  } catch (error) {
    logger.debug('Could not resolve the conversation search profile', {
      component: 'ConversationRoutes',
      error: error?.message
    });
    return undefined;
  }
}

/**
 * The search profile a resumed conversation searched.
 *
 * The adapter pins it on the chat's conversation state when it creates the
 * conversation, and every later turn builds its document links with it, so a
 * search profile an admin changed since does not move an existing
 * conversation's documents into another corpus. That pinned profile is used
 * when the client names the chat it is resuming and that chat's state — read
 * as the requesting user — is this conversation. Otherwise (another tab, whose
 * chat id is not the one the conversation was started under, or state that
 * has expired) the profile is resolved as for a new conversation.
 *
 * @param {Object} app - The app's configuration
 * @param {Object} params
 * @param {string} [params.chatId] - The chat the client is resuming
 * @param {string} params.conversationId - The conversation whose history is read
 * @param {Object} params.user - The requesting user
 * @param {string} params.baseUrl - iFinder base URL
 * @returns {Promise<string|undefined>}
 */
export async function conversationSearchProfile(app, { chatId, conversationId, user, baseUrl }) {
  if (isValidId(chatId)) {
    const state = await conversationStateManager.loadState(chatId, { ownerId: user?.id ?? null });
    if (state?.conversationId === conversationId) {
      // A conversation that searches all of the user's profiles has none.
      if (state.searchScope === 'all') return undefined;
      if (typeof state.searchProfile === 'string' && state.searchProfile) {
        return state.searchProfile;
      }
    }
  }
  return resolveConversationSearchProfile(app, {
    user,
    baseUrl,
    scopeId: await storedChatScope(chatId, user)
  });
}

/**
 * The iAssistant scope stored with a chat the user may read, or null.
 * @param {string} chatId
 * @param {Object} user
 * @returns {Promise<string|null>}
 */
async function storedChatScope(chatId, user) {
  if (!isValidId(chatId)) return null;
  try {
    const access = await authorizeChat(chatId, user, { intent: 'read' });
    const scopeId = access.ok ? access.chat?.settings?.integrationScopes?.iassistant : null;
    return typeof scopeId === 'string' && scopeId ? scopeId : null;
  } catch {
    return null;
  }
}

export default function registerConversationRoutes(app) {
  /**
   * @swagger
   * /apps/{appId}/conversations/{conversationId}/messages:
   *   get:
   *     summary: Get conversation message history
   *     description: |
   *       Loads paginated message history for a conversation from the iAssistant
   *       Conversation API. Returns messages in reverse-chronological order.
   *     tags:
   *       - Conversations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *         description: The conversation ID
   *       - in: query
   *         name: size
   *         schema:
   *           type: integer
   *           default: 50
   *         description: Maximum number of messages to return
   *       - in: query
   *         name: next_cursor
   *         schema:
   *           type: string
   *         description: Pagination cursor from a previous response
   *       - in: query
   *         name: chat_id
   *         schema:
   *           type: string
   *         description: |
   *           The chat being resumed. When its conversation state is this
   *           conversation, the documents' access links use the search profile
   *           the conversation was created with.
   *     responses:
   *       200:
   *         description: Message history retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 messages:
   *                   type: array
   *                   items:
   *                     type: object
   *                 next_cursor:
   *                   type: string
   *                   description: Cursor for fetching the next page
   *       400:
   *         description: No base URL configured for conversation API
   *       401:
   *         description: Authentication required
   *       404:
   *         description: App not found
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('apps/:appId/conversations/:conversationId/messages'),
    authRequired,
    async (req, res) => {
      try {
        const { appId, conversationId } = req.params;
        const { size = 50, next_cursor: nextCursor, chat_id: chatId } = req.query;
        const user = req.user;

        // Load app config to get baseUrl
        const { data: apps = [] } = configCache.getApps() || {};
        const appConfig = findByIdCaseInsensitive(apps, appId);
        if (!appConfig) {
          return sendNotFound(res, 'App');
        }

        const baseUrl = resolveBaseUrl(appConfig);
        if (!baseUrl) {
          return sendBadRequest(res, 'No base URL configured for conversation API');
        }

        const result = await conversationApiService.getMessages(conversationId, {
          user,
          baseUrl,
          size: Number.parseInt(size, 10),
          nextCursor
        });

        // The documents of a reopened conversation become sources, with the
        // search profile the live stream gives them, so the sources panel can
        // preview, download and attach them again.
        const searchProfile = await conversationSearchProfile(appConfig, {
          chatId,
          conversationId,
          user,
          baseUrl
        });
        res.json(withConversationSources(result, searchProfile));
      } catch (error) {
        return sendInternalError(res, error, 'fetch conversation messages');
      }
    }
  );

  /**
   * @swagger
   * /apps/{appId}/conversations/{conversationId}/messages/{messageId}:
   *   delete:
   *     summary: Delete a conversation message
   *     description: Deletes a specific message from a conversation (e.g. for cancellation).
   *     tags:
   *       - Conversations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *         description: The conversation ID
   *       - in: path
   *         name: messageId
   *         required: true
   *         schema:
   *           type: string
   *         description: The message ID to delete
   *     responses:
   *       204:
   *         description: Message deleted successfully
   *       400:
   *         description: No base URL configured for conversation API
   *       401:
   *         description: Authentication required
   *       404:
   *         description: App not found
   *       500:
   *         description: Internal server error
   */
  app.delete(
    buildServerPath('apps/:appId/conversations/:conversationId/messages/:messageId'),
    authRequired,
    async (req, res) => {
      try {
        const { appId, conversationId, messageId } = req.params;
        const user = req.user;

        const { data: apps = [] } = configCache.getApps() || {};
        const appConfig = findByIdCaseInsensitive(apps, appId);
        if (!appConfig) {
          return sendNotFound(res, 'App');
        }

        const baseUrl = resolveBaseUrl(appConfig);
        if (!baseUrl) {
          return sendBadRequest(res, 'No base URL configured for conversation API');
        }

        await conversationApiService.deleteMessage(conversationId, messageId, {
          user,
          baseUrl
        });

        res.status(204).send();
      } catch (error) {
        return sendInternalError(res, error, 'delete conversation message');
      }
    }
  );

  /**
   * @swagger
   * /apps/{appId}/conversations/{conversationId}:
   *   delete:
   *     summary: Delete a conversation
   *     description: Deletes an entire conversation and all its messages.
   *     tags:
   *       - Conversations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *         description: The app ID
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *         description: The conversation ID to delete
   *     responses:
   *       204:
   *         description: Conversation deleted successfully
   *       400:
   *         description: No base URL configured for conversation API
   *       401:
   *         description: Authentication required
   *       404:
   *         description: App not found
   *       500:
   *         description: Internal server error
   */
  app.delete(
    buildServerPath('apps/:appId/conversations/:conversationId'),
    authRequired,
    async (req, res) => {
      try {
        const { appId, conversationId } = req.params;
        const user = req.user;

        const { data: apps = [] } = configCache.getApps() || {};
        const appConfig = findByIdCaseInsensitive(apps, appId);
        if (!appConfig) {
          return sendNotFound(res, 'App');
        }

        const baseUrl = resolveBaseUrl(appConfig);
        if (!baseUrl) {
          return sendBadRequest(res, 'No base URL configured for conversation API');
        }

        await conversationApiService.deleteConversation(conversationId, {
          user,
          baseUrl
        });

        res.status(204).send();
      } catch (error) {
        return sendInternalError(res, error, 'delete conversation');
      }
    }
  );
}
