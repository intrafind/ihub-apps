import { loadTools, runTool } from '../toolLoader.js';
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
import { getVisibleToolIds } from '../services/mcp/permissions.js';
import { isToolSelected } from '../utils/toolSelection.js';

/**
 * The caller with permissions resolved: an anonymous caller (when anonymous
 * access is allowed) gets the anonymous permissions.
 *
 * @param {import('express').Request} req
 * @param {Object} platformConfig
 * @returns {Object|null}
 */
function resolveCaller(req, platformConfig) {
  const authConfig = platformConfig.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
  }
  if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
  }
  return req.user || null;
}

/**
 * Whether the caller may run a tool directly. The rule is the MCP gateway's
 * (`services/mcp/permissions.js`): a tool the caller's groups grant
 * (`permissions.tools`, `*` for all) or an app they can open lists, read the
 * way an app's `tools` are read — exact id, base id of a function-style tool,
 * MCP server id, A2A agent reference (see `isToolSelected`). An admin, who
 * can grant themselves any tool, runs every tool (testing a tool this way is
 * how tool authors check it).
 *
 * @param {Object} user
 * @param {Object} platformConfig
 * @param {string} toolId
 * @returns {Promise<boolean>}
 */
async function mayRunTool(user, platformConfig, toolId) {
  if (user.permissions?.adminAccess === true) return true;
  const visible = await getVisibleToolIds(user, platformConfig);
  if (visible.has('*')) return true;
  const tools = await loadTools(platformConfig.defaultLanguage || 'en');
  // The loaded definition carries the MCP server / A2A agent it belongs to;
  // a tool that is not in the list (workflow_, source_, …) is judged by id.
  const tool = (tools || []).find(t => t.id === toolId) || { id: toolId };
  return isToolSelected(tool, visible);
}

export default function registerToolRoutes(app) {
  app.get(
    buildServerPath('/api/tools'),
    requireFeature('tools'),
    authRequired,
    async (req, res) => {
      try {
        const platformConfig = configCache.getPlatform() || {};
        resolveCaller(req, platformConfig);

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

      // Only a tool the caller's groups or apps grant runs; the answer is the
      // same for a tool that does not exist, so it does not disclose which do.
      const platformConfig = configCache.getPlatform() || {};
      const caller = resolveCaller(req, platformConfig);
      try {
        if (!caller || !(await mayRunTool(caller, platformConfig, toolId))) {
          return res.status(403).json({ error: 'Tool not available' });
        }
      } catch (error) {
        return sendInternalError(res, error, `authorize tool ${toolId}`);
      }

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
