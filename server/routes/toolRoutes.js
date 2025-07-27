import { loadTools, runTool } from '../toolLoader.js';
import { logInteraction } from '../utils.js';
import { authRequired, authOptional } from '../middleware/authRequired.js';
import validate from '../validators/validate.js';
import { runToolSchema } from '../validators/index.js';
import configCache from '../configCache.js';
import {
  filterResourcesByPermissions,
  isAnonymousAccessAllowed,
  enhanceUserWithPermissions
} from '../utils/authorization.js';
import crypto from 'crypto';

export default function registerToolRoutes(app) {
  app.get('/api/tools', authOptional, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      // Check if anonymous access is allowed
      if (!isAnonymousAccessAllowed(platformConfig) && (!req.user || req.user.id === 'anonymous')) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
          message: 'You must be logged in to access this resource'
        });
      }

      // Get tools with ETag from cache
      const { data: configuredTools, etag: toolsEtag } = configCache.getTools();

      // Get user language from query parameters or platform default
      const defaultLang = platformConfig?.defaultLanguage || 'en';
      const userLanguage = req.query.language || req.query.lang || defaultLang;

      // Load all tools (including MCP discovered ones) with localization
      let tools = await loadTools(userLanguage);

      // Force permission enhancement if not already done
      if (req.user && !req.user.permissions) {
        const authConfig = platformConfig.auth || {};
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Create anonymous user if none exists and anonymous access is allowed
      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        const authConfig = platformConfig.auth || {};
        req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
      }

      // Apply group-based filtering if user has permissions
      if (req.user && req.user.permissions && req.user.permissions.tools) {
        const allowedTools = req.user.permissions.tools;
        tools = filterResourcesByPermissions(tools, allowedTools, 'tools');
      } else if (isAnonymousAccessAllowed(platformConfig)) {
        // For anonymous users, filter to only anonymous-allowed tools
        const allowedTools = new Set(); // No default tools for anonymous
        tools = filterResourcesByPermissions(tools, allowedTools, 'tools');
      }

      // Generate user-specific ETag to prevent cache poisoning between users with different permissions
      let userSpecificEtag = toolsEtag || 'no-etag';

      // Create ETag based on the actual filtered tools content
      // This ensures users with the same permissions share cache, but different permissions get different ETags
      const originalToolsCount = (await loadTools(userLanguage)).length || 0;
      if (tools.length < originalToolsCount) {
        // Tools were filtered - create content-based ETag from filtered tool IDs
        const toolIds = tools.map(tool => tool.id).sort();
        const contentHash = crypto
          .createHash('md5')
          .update(JSON.stringify(toolIds))
          .digest('hex')
          .substring(0, 8);

        userSpecificEtag = `${toolsEtag}-${contentHash}`;
      }
      // If tools.length === originalToolsCount, user sees all tools, use original ETag

      res.setHeader('ETag', userSpecificEtag);
      res.json(tools);
    } catch (error) {
      console.error('Error fetching tools:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.all('/api/tools/:toolId', authRequired, validate(runToolSchema), async (req, res) => {
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
        userSessionId: req.headers['x-session-id'] || 'unknown'
      });
      res.json(result);
    } catch (error) {
      console.error(`Tool ${toolId} error:`, error);
      res.status(500).json({ error: 'Tool execution failed' });
    }
  });
}
