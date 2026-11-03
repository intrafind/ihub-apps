// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one OAuth callback of every integration that signs users in:
 *
 *   GET /api/integrations/oauth/callback
 *
 * and its **aliases** — the callback URLs admins registered in vendor OAuth
 * apps before there was one, which keep working unchanged:
 *
 *   GET /api/integrations/jira/callback                       (Jira)
 *   GET /api/integrations/<office365|googledrive|nextcloud>/<installationId>/callback
 *   GET /api/mcp/oauth/callback/<serverId>                    (per-user MCP)
 *
 * Every path runs the same handler (`IntegrationConnectionService.completeConnect`):
 * the `state` names a server-side flow that is bound to the signed-in user
 * and the installation, carries the PKCE verifier and the validated return
 * URL, and can be used once. An alias that names an installation (or a
 * stack) additionally refuses a flow started for another one. The browser is
 * always sent to a same-origin path with stable result codes only.
 *
 * @module routes/integrations/oauthCallback
 */
import { authOptional } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import { buildApiPath, buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { getIntegrationConnectionService } from '../../services/integrations/auth/IntegrationConnectionService.js';

/** The canonical callback path below the API base. */
export const INTEGRATION_OAUTH_CALLBACK_PATH = '/integrations/oauth/callback';

/**
 * The callback handler. `aliasOf(req)` says what the path the request came
 * in on names (nothing for the canonical path).
 *
 * @param {(req: import('express').Request) => {installationId?: string, stack?: string, resultKey?: string}} [aliasOf]
 * @returns {import('express').RequestHandler}
 */
export function integrationOAuthCallbackHandler(aliasOf = () => ({})) {
  return async (req, res) => {
    try {
      const alias = aliasOf(req) || {};
      const outcome = await getIntegrationConnectionService().completeConnect({ req, alias });
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, outcome.redirectTo);
    } catch (error) {
      logger.error('Integration OAuth callback failed', {
        component: 'IntegrationOAuthCallback',
        error: error.message
      });
      return res.redirect(
        302,
        buildServerPath('/settings/integrations?integration_error=callback_failed')
      );
    }
  };
}

/**
 * Register the canonical callback. The aliases are registered by the routers
 * that own their paths (the integration route factory and `routes/mcpOAuth.js`).
 *
 * @param {import('express').Express} app
 */
export default function registerIntegrationOAuthCallback(app) {
  app.get(
    buildApiPath(INTEGRATION_OAUTH_CALLBACK_PATH),
    requireFeature('integrations'),
    authOptional,
    integrationOAuthCallbackHandler()
  );
}
