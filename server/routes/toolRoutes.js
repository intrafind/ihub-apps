import { runTool } from '../toolLoader.js';
import { logInteraction } from '../utils.js';
import { authRequired } from '../middleware/authRequired.js';
import validate from '../validators/validate.js';
import { runToolSchema } from '../validators/index.js';
import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { requireFeature } from '../featureRegistry.js';
import { sendInternalError } from '../utils/responseHelpers.js';
import { stripReservedToolContext, withTrustedToolContext } from '../utils/toolCallContext.js';

export default function registerToolRoutes(app) {
  app.get(
    buildServerPath('/api/tools'),
    requireFeature('tools'),
    authRequired,
    async (req, res) => {
      try {
        const platformConfig = configCache.getPlatform() || {};
        const authConfig = platformConfig.auth || {};

        // Force permission enhancement if not already done
        if (req.user && !req.user.permissions) {
          req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
        }

        // Create anonymous user if none exists and anonymous access is allowed
        if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
          req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
        }

        // Get user language from query parameters or platform default
        const defaultLang = platformConfig?.defaultLanguage || 'en';
        const userLanguage = req.query.language || req.query.lang || defaultLang;

        // The chat's tools menu passes the app it runs in, so that app's tools
        // are listed even when no group grants them directly.
        const appId = typeof req.query.appId === 'string' ? req.query.appId : undefined;

        // Use centralized method to get filtered tools with user-specific ETag
        const { data: tools, etag: userSpecificEtag } = await configCache.getToolsForUser(
          req.user,
          platformConfig,
          userLanguage,
          { appId }
        );

        res.setHeader('ETag', userSpecificEtag);
        res.json(tools);
      } catch (error) {
        return sendInternalError(res, error, 'fetch tools');
      }
    }
  );

  app.all(
    buildServerPath('/api/tools/:toolId'),
    requireFeature('tools'),
    authRequired,
    validate(runToolSchema),
    async (req, res) => {
      const { toolId } = req.params;

      // Validate toolId to prevent injection via dynamic import
      if (!validateIdForPath(toolId, 'tool', res)) return;

      // The caller's arguments never carry iHub's context: `user` (whose
      // identity and, for per-user OAuth MCP servers, whose stored token the
      // call uses), `chatId`, `appConfig`, … are stripped and set here, so the
      // authenticated user always wins over anything in the body or query.
      const chatId =
        typeof req.headers['x-chat-id'] === 'string' ? req.headers['x-chat-id'] : undefined;
      const args = stripReservedToolContext(req.method === 'GET' ? req.query : req.body);
      const params = withTrustedToolContext(args, { chatId, user: req.user });
      try {
        const result = await runTool(toolId, params);
        await logInteraction('tool_usage', {
          toolId,
          toolInput: args,
          toolOutput: result,
          sessionId: req.headers['x-chat-id'] || 'direct',
          userSessionId: req.headers['x-session-id'] || 'unknown',
          user: req.user
        });
        res.json(result);
      } catch (error) {
        return sendInternalError(res, error, `execute tool ${toolId}`);
      }
    }
  );
}
