/**
 * MCP Apps host routes (extension `io.modelcontextprotocol/ui`).
 *
 * When a chat app calls an MCP tool that declares a `ui://` view, the client
 * renders that view in a sandboxed iframe. The view talks JSON-RPC to the
 * client (the "host"), and these routes are how the host reaches the MCP
 * server on the view's behalf:
 *
 *   GET  /api/mcp-apps/sandbox          the sandbox proxy page (no auth; static,
 *                                       CSP header built from `?csp=`)
 *   GET  /api/mcp-apps/resource         the view's HTML + CSP/permission metadata
 *   POST /api/mcp-apps/tools/call       a `tools/call` from the view
 *   POST /api/mcp-apps/resources/read   a `resources/read` from the view
 *
 * Authorization mirrors the chat itself: a view belongs to a tool call made by
 * an iHub app, so every request names that app and tool. The caller must be
 * able to open the app, the app must offer the tool, and the tool must render
 * an MCP App view. A view may then call tools of the same MCP server whose
 * visibility includes `"app"` — never tools of another server.
 *
 * @module routes/mcpAppRoutes
 */
import { z } from 'zod';
import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import { toolVisibleInSet } from '../services/mcp/permissions.js';
import {
  buildAllowAttribute,
  buildSandboxCsp,
  isUiResourceUri,
  jsonByteLength,
  MAX_UI_RESOURCE_BYTES,
  normalizeCsp,
  toViewToolResult
} from '../services/mcp/mcpApps.js';
import { SANDBOX_PAGE_HTML } from '../services/mcp/mcpAppSandboxPage.js';
import { authRequired } from '../middleware/authRequired.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import { zSafeId } from '../validators/common.js';
import validate from '../validators/validate.js';
import logger from '../utils/logger.js';

const COMPONENT = 'McpApps';

/** Largest `?csp=` value accepted for the sandbox page. */
const MAX_CSP_PARAM_CHARS = 8192;

/** Largest tool-argument object a view may send. */
const MAX_ARGUMENT_BYTES = 1024 * 1024;

const toolRefShape = {
  appId: zSafeId.min(1).max(128),
  toolId: zSafeId.min(1).max(200)
};

const resourceQuerySchema = z.object(toolRefShape);

const toolCallBodySchema = z.object({
  ...toolRefShape,
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.any()).optional()
});

const resourceReadBodySchema = z.object({
  ...toolRefShape,
  uri: z.string().min(1).max(2048)
});

class McpAppAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The acting user with permissions resolved (anonymous when allowed).
 * @param {import('express').Request} req
 * @returns {Object|null}
 */
function resolveUser(req) {
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platform);
  }
  if (!req.user && isAnonymousAccessAllowed(platform)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platform);
  }
  return req.user || null;
}

/**
 * Resolve and authorize the MCP App a request is made for.
 *
 * @param {import('express').Request} req
 * @param {string} appId - iHub app the chat belongs to
 * @param {string} toolId - iHub id of the tool whose call rendered the view
 * @returns {Promise<{app: Object, conn: Object, tool: Object, user: Object}>}
 * @throws {McpAppAccessError}
 */
export async function resolveMcpApp(req, appId, toolId) {
  const user = resolveUser(req);
  if (!user) throw new McpAppAccessError(401, 'Authentication required');

  const platform = configCache.getPlatform() || {};
  const { data: apps = [] } = await configCache.getAppsForUser(user, platform);
  const app = findByIdCaseInsensitive(apps, appId);
  if (!app) throw new McpAppAccessError(403, 'App not available');

  const appTools = new Set(Array.isArray(app.tools) ? app.tools : []);
  if (!toolVisibleInSet(toolId, appTools)) {
    throw new McpAppAccessError(403, 'Tool not available in this app');
  }

  const found = await mcpClientManager.findTool(toolId);
  if (!found || !found.tool._mcp?.ui?.resourceUri) {
    throw new McpAppAccessError(404, 'MCP App not found');
  }
  return { app, conn: found.conn, tool: found.tool, user };
}

function sendError(res, error, action) {
  if (error instanceof McpAppAccessError) {
    return res.status(error.status).json({ error: error.message });
  }
  logger.warn(`MCP App ${action} failed`, { component: COMPONENT, error: error.message });
  return res.status(502).json({ error: error.message || `MCP App ${action} failed` });
}

/**
 * Parse the sandbox page's `?csp=` parameter (JSON of declared domains).
 * Anything unparsable yields the restrictive default policy.
 */
function parseCspParam(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CSP_PARAM_CHARS) return {};
  try {
    return normalizeCsp(JSON.parse(raw));
  } catch {
    return {};
  }
}

export default function registerMcpAppRoutes(app) {
  // The sandbox proxy page. Static and unauthenticated: it holds no data, it
  // only relays messages between iHub and the view it is handed. The CSP
  // header — which the view inherits — is what enforces the view's declared
  // domains, so it is built here from sanitized values, not left to the view.
  app.get(buildServerPath('/api/mcp-apps/sandbox'), (req, res) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', buildSandboxCsp(parseCspParam(req.query.csp)));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(SANDBOX_PAGE_HTML);
  });

  app.get(
    buildServerPath('/api/mcp-apps/resource'),
    authRequired,
    validate({ query: resourceQuerySchema }),
    async (req, res) => {
      try {
        const { conn, tool } = await resolveMcpApp(req, req.query.appId, req.query.toolId);
        const resource = await conn.getUiResource(tool._mcp.ui.resourceUri);
        const appTool = await conn.getAppTool(tool._mcp.originalName);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          uri: resource.uri,
          html: resource.html,
          csp: resource.csp,
          permissions: resource.permissions,
          allow: buildAllowAttribute(resource.permissions),
          prefersBorder: resource.prefersBorder,
          // `hostContext.toolInfo.tool` for the view.
          tool: {
            name: tool._mcp.originalName,
            description: tool.description || '',
            inputSchema: tool.parameters || { type: 'object', properties: {} },
            ...(appTool?.title ? { title: appTool.title } : {})
          },
          serverId: conn.config.id
        });
      } catch (error) {
        return sendError(res, error, 'resource fetch');
      }
    }
  );

  app.post(
    buildServerPath('/api/mcp-apps/tools/call'),
    authRequired,
    validate({ body: toolCallBodySchema }),
    async (req, res) => {
      const { appId, toolId, name } = req.body;
      const args = req.body.arguments || {};
      try {
        const { conn, user } = await resolveMcpApp(req, appId, toolId);
        if (jsonByteLength(args) > MAX_ARGUMENT_BYTES) {
          return res.status(413).json({ error: 'Tool arguments too large' });
        }
        // Visibility: only tools of this same server that list "app".
        const target = await conn.getAppTool(name);
        if (!target) {
          return res.status(403).json({ error: `Tool ${name} is not callable from this app` });
        }
        // The specification asks hosts to log view-initiated calls.
        logger.info('MCP App tool call', {
          component: COMPONENT,
          appId,
          viaToolId: toolId,
          serverId: conn.config.id,
          tool: name,
          userId: user.id,
          argKeys: Object.keys(args).join(', ')
        });
        const result = await conn.callToolRaw(name, args);
        return res.json(toViewToolResult(result));
      } catch (error) {
        return sendError(res, error, 'tool call');
      }
    }
  );

  app.post(
    buildServerPath('/api/mcp-apps/resources/read'),
    authRequired,
    validate({ body: resourceReadBodySchema }),
    async (req, res) => {
      const { appId, toolId, uri } = req.body;
      try {
        const { conn, user } = await resolveMcpApp(req, appId, toolId);
        logger.info('MCP App resource read', {
          component: COMPONENT,
          appId,
          viaToolId: toolId,
          serverId: conn.config.id,
          uri: isUiResourceUri(uri) ? uri : uri.slice(0, 200),
          userId: user.id
        });
        const result = await conn.readResource(uri);
        const contents = Array.isArray(result?.contents) ? result.contents : [];
        if (jsonByteLength(contents) > MAX_UI_RESOURCE_BYTES) {
          return res.status(413).json({ error: 'Resource too large' });
        }
        return res.json({ contents });
      } catch (error) {
        return sendError(res, error, 'resource read');
      }
    }
  );
}
