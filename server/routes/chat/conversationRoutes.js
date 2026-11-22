// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Conversation API routes for iAssistant Conversation provider.
 * Provides the endpoint that deletes a conversation.
 */
import { authRequired } from '../../middleware/authRequired.js';
import configCache from '../../configCache.js';
import conversationApiService from '../../services/integrations/ConversationApiService.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { canUserAccessResource } from '../../utils/authorization.js';
import { isUnresolvedUserAppId, resolveAppForChat } from '../../services/userApps/resolveApp.js';

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

export default function registerConversationRoutes(app) {
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
      const { appId, conversationId } = req.params;
      const user = req.user;

      const found = await resolveAppForChat(appId, user, { req });
      const appConfig = found?.app || null;
      // This route has never checked the group permission of a published app,
      // and still does not. An app that is not published exists only for a
      // content admin whose groups grant it, as in the chat: for anyone else
      // the answer is the one an unknown id gets.
      const hidden =
        !found?.userApp &&
        appConfig?.enabled === false &&
        !canUserAccessResource(user, 'apps', appConfig.id);
      // A personal app the caller can no longer use (deleted, unshared,
      // switched off): the conversation is still the caller's own, and
      // deleting it stays possible. Nothing of the app is read for it; the
      // address comes from the installation's own settings.
      const ownConversationOnly = isUnresolvedUserAppId(appId, found);
      if ((!appConfig && !ownConversationOnly) || hidden) {
        throw new ServiceError('NOT_FOUND', 'App not found');
      }

      const baseUrl = resolveBaseUrl(appConfig);
      if (!baseUrl) {
        throw new ServiceError('BAD_REQUEST', 'No base URL configured for conversation API');
      }

      await conversationApiService.deleteConversation(conversationId, {
        user,
        baseUrl
      });

      res.status(204).send();
    }
  );
}
