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
 *   POST /api/mcp-apps/handshake        how the view announced itself (the
 *                                       legacy mcp-ui `appReady` instead of
 *                                       `ui/initialize`), logged for admins
 *
 * Authorization mirrors the chat itself: a view belongs to a tool call made by
 * an iHub app, so every request names that app and tool. The caller must be
 * able to open the app, the app must offer the tool, and the tool must render
 * an MCP App view: one it declares (`_meta.ui.resourceUri`) or, on a server
 * with MCP Apps enabled, one its result embeds (such a view has no
 * `resources/read` copy, so `GET /resource` answers 404 for it). A view may
 * then call tools of the same MCP server whose visibility includes `"app"` —
 * never tools of another server.
 *
 * A per-user OAuth server the caller has not connected answers **409**
 * `{ error: 'auth_required', code: 'MCP_AUTH_REQUIRED', connectUrl }` — never
 * 401, which the client reads as an expired iHub session and signs the user
 * out for. A sign-in that could not be renewed right now answers 503.
 *
 * @module routes/mcpAppRoutes
 */
import { z } from 'zod';
import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import {
  isAuthRequiredError,
  isTokenRefreshError,
  MCP_AUTH_REQUIRED
} from '../services/mcp/McpUserOAuthProvider.js';
import { isUserOAuthServer } from '../services/mcp/mcpOAuthService.js';
import { toolVisibleInSet } from '../services/mcp/permissions.js';
import {
  appsEnabledFor,
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

const handshakeBodySchema = z.object({
  ...toolRefShape,
  handshake: z.enum(['legacy'])
});

/** Status of "connect this MCP server first" — deliberately not 401 (see module comment). */
export const MCP_APP_AUTH_REQUIRED_STATUS = 409;

class McpAppAccessError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
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
 * @param {Object} [options]
 * @param {boolean} [options.declaredView=false] - Require a declared view
 *   (`_meta.ui.resourceUri`); otherwise any tool of a server with MCP Apps
 *   enabled qualifies, since its result may embed the view
 * @returns {Promise<{app: Object, conn: Object, tool: Object, user: Object, serverId: string, run: Function}>}
 *   `run(operation)` calls `operation(conn)` on the connection the caller
 *   uses — for a per-user OAuth server their own, with the token refreshed
 *   when needed. Use it for every request to the MCP server.
 * @throws {McpAppAccessError}
 */
export async function resolveMcpApp(req, appId, toolId, { declaredView = false } = {}) {
  // The routes validate both with zod already; checked again here because a
  // query parameter can also arrive as an array (`?toolId=a&toolId=b`), and
  // everything below treats them as strings.
  if (typeof appId !== 'string' || typeof toolId !== 'string') {
    throw new McpAppAccessError(400, 'Invalid app or tool id');
  }
  const user = resolveUser(req);
  if (!user) throw new McpAppAccessError(401, 'Authentication required');

  const platform = configCache.getPlatform() || {};
  const { data: apps = [] } = await configCache.getAppsForUser(user, platform);
  const app = findByIdCaseInsensitive(apps, appId);
  if (!app) throw new McpAppAccessError(403, 'App not available');

  const appTools = new Set(Array.isArray(app.tools) ? app.tools : []);
  let found = null;
  if (!toolVisibleInSet(toolId, appTools)) {
    // An app that uses an MCP server as a whole lists the server's id, and
    // only the tool's own `_mcp` marker says which server it belongs to. Look
    // the tool up only for such an app, so a request for a tool the app does
    // not offer never reaches an MCP server.
    const usesMcpServer = [...appTools].some(id => mcpClientManager.hasServer?.(id));
    found = usesMcpServer ? await mcpClientManager.findTool(toolId) : null;
    if (!toolVisibleInSet(toolId, appTools, found?.tool?._mcp?.serverId)) {
      throw new McpAppAccessError(403, 'Tool not available in this app');
    }
  } else {
    found = await mcpClientManager.findTool(toolId);
  }
  const rendersView = found?.tool._mcp?.ui?.resourceUri
    ? true
    : !declaredView && !!found?.tool._mcp && appsEnabledFor(found.conn.config);
  if (!rendersView) {
    throw new McpAppAccessError(404, 'MCP App not found');
  }
  const serverId = found.conn.config.id;
  // A per-user OAuth server is reached on the caller's own connection only;
  // a caller who has not connected it is told where to do so.
  if (!isUserOAuthServer(found.conn.config)) {
    const conn = found.conn;
    return { app, conn, tool: found.tool, user, serverId, run: operation => operation(conn) };
  }
  let conn;
  try {
    conn = await mcpClientManager.connectionForUser(serverId, user);
  } catch (error) {
    if (isAuthRequiredError(error)) throw authRequiredAccessError(serverId);
    throw error;
  }
  return {
    app,
    conn,
    tool: found.tool,
    user,
    serverId,
    run: operation => mcpClientManager.withUserConnection(serverId, user, operation)
  };
}

/** The "connect first" answer for a per-user server. */
function authRequiredAccessError(serverId) {
  return new McpAppAccessError(MCP_APP_AUTH_REQUIRED_STATUS, 'auth_required', {
    code: MCP_AUTH_REQUIRED,
    ...(serverId ? { connectUrl: mcpClientManager.connectUrlFor(serverId) } : {})
  });
}

function sendError(res, error, action) {
  if (isAuthRequiredError(error) && !(error instanceof McpAppAccessError)) {
    error = authRequiredAccessError(error.serverId);
  }
  if (error instanceof McpAppAccessError) {
    return res.status(error.status).json({ error: error.message, ...error.extra });
  }
  if (isTokenRefreshError(error)) {
    return res.status(503).json({ error: 'auth_refresh_failed', code: error.code });
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
        const { run, tool, serverId } = await resolveMcpApp(
          req,
          req.query.appId,
          req.query.toolId,
          { declaredView: true }
        );
        const { resource, appTool } = await run(async conn => ({
          resource: await conn.getUiResource(tool._mcp.ui.resourceUri),
          appTool: await conn.getAppTool(tool._mcp.originalName)
        }));
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
          serverId
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
        const { run, user, serverId } = await resolveMcpApp(req, appId, toolId);
        if (jsonByteLength(args) > MAX_ARGUMENT_BYTES) {
          return res.status(413).json({ error: 'Tool arguments too large' });
        }
        const outcome = await run(async conn => {
          // Visibility: only tools of this same server that list "app".
          const target = await conn.getAppTool(name);
          if (!target) return { forbidden: true };
          // The specification asks hosts to log view-initiated calls.
          logger.info('MCP App tool call', {
            component: COMPONENT,
            appId,
            viaToolId: toolId,
            serverId,
            tool: name,
            userId: user.id,
            argKeys: Object.keys(args).join(', ')
          });
          return { result: await conn.callToolRaw(name, args) };
        });
        if (outcome.forbidden) {
          return res.status(403).json({ error: `Tool ${name} is not callable from this app` });
        }
        return res.json(toViewToolResult(outcome.result));
      } catch (error) {
        return sendError(res, error, 'tool call');
      }
    }
  );

  // The handshake happens in the browser, so the host tells the server about
  // the one worth knowing: a view that never sent `ui/initialize` and was
  // initialized on mcp-ui's `appReady` instead. Logged, nothing else — it lets
  // admins see which servers depend on the compatibility path.
  app.post(
    buildServerPath('/api/mcp-apps/handshake'),
    authRequired,
    validate({ body: handshakeBodySchema }),
    async (req, res) => {
      const { appId, toolId, handshake } = req.body;
      try {
        const { tool, user, serverId } = await resolveMcpApp(req, appId, toolId);
        logger.info('MCP App view used the legacy mcp-ui handshake', {
          component: COMPONENT,
          handshake,
          appId,
          viaToolId: toolId,
          serverId,
          tool: tool._mcp.originalName,
          userId: user.id
        });
        return res.status(204).end();
      } catch (error) {
        return sendError(res, error, 'handshake report');
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
        const { run, user, serverId } = await resolveMcpApp(req, appId, toolId);
        logger.info('MCP App resource read', {
          component: COMPONENT,
          appId,
          viaToolId: toolId,
          serverId,
          uri: isUiResourceUri(uri) ? uri : uri.slice(0, 200),
          userId: user.id
        });
        const result = await run(conn => conn.readResource(uri));
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
