import { runTool } from '../toolLoader.js';
import { logInteraction } from '../utils.js';
import { authRequired } from '../middleware/authRequired.js';
import validate from '../validators/validate.js';
import { runToolSchema } from '../validators/index.js';
import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import rateLimit from 'express-rate-limit';
export default function registerToolRoutes(app, basePath = '') {
  // Rate limiter: max 100 requests per 15 minutes per IP
  const toolRouteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the RateLimit-* headers
    legacyHeaders: false // Disable the X-RateLimit-* headers
  });

  app.get(buildServerPath('/api/tools', basePath), authRequired, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
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

      // Use centralized method to get filtered tools with user-specific ETag
      const { data: tools, etag: userSpecificEtag } = await configCache.getToolsForUser(
        req.user,
        platformConfig,
        userLanguage
      );

      res.setHeader('ETag', userSpecificEtag);
      res.json(tools);
    } catch (error) {
      console.error('Error fetching tools:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.all(
    toolRouteLimiter,
    buildServerPath('/api/tools/:toolId', basePath),
    authRequired,
    validate(runToolSchema),
    async (req, res) => {
      const { toolId } = req.params;
      const params = req.method === 'GET' ? req.query : req.body;
      if (req.headers['x-chat-id']) {
        params.chatId = req.headers['x-chat-id'];
      }
      try {
        const result = await runTool(toolId, params);
        await logInteraction('tool_usage', {
          toolId,
          toolInput: params,
          toolOutput: result,
          sessionId: req.headers['x-chat-id'] || 'direct',
          userSessionId: req.headers['x-session-id'] || 'unknown',
          user: req.user
        });
        res.json(result);
      } catch (error) {
        console.error(`Tool ${toolId} error:`, error);
        res.status(500).json({ error: 'Tool execution failed' });
      }
    }
  );
}
