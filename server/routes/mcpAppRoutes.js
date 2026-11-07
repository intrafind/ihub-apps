// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * `{ error: 'auth_required', code: 'INTEGRATION_AUTH_REQUIRED', integration, connectUrl }` — never
 * 401, which the client reads as an expired iHub session and signs the user
 * out for. A sign-in that could not be renewed right now answers 503.
 *
 * @module routes/mcpAppRoutes
 */
import { z } from 'zod';
import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import { INTEGRATION_AUTH_REQUIRED } from '../services/integrations/auth/integrationAuthRequired.js';
import { installedIntegrationById } from '../services/integrations/installedRefs.js';
import interactionService from '../services/loop/InteractionService.js';
import { authorizeInteraction as loadInteractionAccess } from '../services/loop/runAccess.js';
import {
  answerViewToolApproval,
  isViewToolApproval,
  requestViewToolCall
} from '../services/mcp/mcpViewToolApproval.js';
import { isAuthRequiredError, isTokenRefreshError } from '../services/mcp/McpUserOAuthProvider.js';
import { isUserOAuthServer } from '../services/mcp/mcpOAuthService.js';
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
import { ServiceError } from '../utils/ServiceError.js';

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
  arguments: z.record(z.string(), z.any()).optional(),
  /** The chat hosting the view, where a call that needs approval is asked for (#2945). */
  chatId: z.string().min(1).max(200).optional(),
  /** The host draws the approval card; without it a gated call is refused. */
  toolApprovalCapable: z.boolean().optional()
});

const approvalBodySchema = z.object({
  ...toolRefShape,
  interactionId: z.string().min(1).max(256),
  decision: z.enum(['approve', 'reject'])
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

/** The registry code of the statuses an access check refuses with. */
const ACCESS_CODE_BY_STATUS = {
  400: 'BAD_REQUEST',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND'
};

class McpAppAccessError extends ServiceError {
  /**
   * @param {number} status - 400, 401, 403 or 404
   * @param {string} message - What to tell the caller
   */
  constructor(status, message) {
    super(ACCESS_CODE_BY_STATUS[status] || 'FORBIDDEN', message, { status });
  }
}

/**
 * What a failed request to an MCP server stands for: a caller that has to connect
 * first (409), a refresh that failed for a transient reason (503), or the server
 * failing (502, with its message when it is safe to show). A ServiceError is already
 * an answer and passes through.
 *
 * @param {unknown} error
 * @returns {ServiceError}
 */
function toMcpAppError(error) {
  if (error instanceof ServiceError) return error;
  if (isAuthRequiredError(error)) return authRequiredAccessError(error.serverId);
  if (isTokenRefreshError(error)) {
    return new ServiceError('MCP_AUTH_REFRESH_FAILED', 'Refreshing the MCP sign-in failed', {
      cause: error
    });
  }
  return new ServiceError('UPSTREAM_ERROR', error?.message || 'MCP App request failed', {
    cause: error
  });
}

/**
 * Run an operation on an MCP connection; its failures are translated with
 * {@link toMcpAppError}.
 */
async function viaMcp(operation) {
  try {
    return await operation();
  } catch (error) {
    throw toMcpAppError(error);
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

  // The app offers an MCP server's tools only by binding its installation
  // (`app.integrations`). Look the tool up only for an app that binds one, so
  // a request for a tool the app does not offer never reaches an MCP server.
  const { boundInstanceIds, getIntegrationToolsForApp } =
    await import('../services/integrations/integrationTools.js');
  const usesMcpServer = boundInstanceIds(app).some(id => mcpClientManager.hasServer?.(id));
  const found = usesMcpServer ? await mcpClientManager.findTool(toolId) : null;
  const marker = found?.tool?._mcp
    ? {
        ...found.tool,
        _integration: {
          instanceId: found.tool._mcp.serverId,
          action: found.tool._mcp.originalName
        }
      }
    : null;
  if (!marker || getIntegrationToolsForApp(app, [marker], { user }).length === 0) {
    throw new McpAppAccessError(403, 'Tool not available in this app');
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
    return {
      app,
      conn,
      tool: found.tool,
      user,
      serverId,
      run: operation => viaMcp(() => operation(conn))
    };
  }
  const conn = await viaMcp(() => mcpClientManager.connectionForUser(serverId, user));
  return {
    app,
    conn,
    tool: found.tool,
    user,
    serverId,
    run: operation => viaMcp(() => mcpClientManager.withUserConnection(serverId, user, operation))
  };
}

/** The "connect first" answer for a per-user server. */
function authRequiredAccessError(serverId) {
  return new ServiceError(INTEGRATION_AUTH_REQUIRED, 'Connect this integration first', {
    status: MCP_APP_AUTH_REQUIRED_STATUS,
    ...(serverId
      ? {
          details: { integration: serverId, connectUrl: mcpClientManager.connectUrlFor(serverId) }
        }
      : {})
  });
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
      const { run, tool, serverId } = await resolveMcpApp(req, req.query.appId, req.query.toolId, {
        declaredView: true
      });
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
    }
  );

  app.post(
    buildServerPath('/api/mcp-apps/tools/call'),
    authRequired,
    validate({ body: toolCallBodySchema }),
    async (req, res) => {
      const { appId, toolId, name, chatId = null } = req.body;
      const args = req.body.arguments || {};
      const {
        app: appConfig,
        run,
        user,
        serverId,
        tool: viewTool
      } = await resolveMcpApp(req, appId, toolId);
      if (jsonByteLength(args) > MAX_ARGUMENT_BYTES) {
        throw new ServiceError('PAYLOAD_TOO_LARGE', 'Tool arguments too large');
      }
      const outcome = await run(async conn => {
        // Visibility: only tools of this same server that list "app".
        const target = await conn.getAppTool(name);
        if (!target) return { forbidden: true };
        // A tool that needs a person's approval (#2945) waits for it like a
        // model's call: the chat hosting the view shows the approval card,
        // and the server runs the stored call once it is approved. A host
        // that cannot show the card gets APPROVAL_REQUIRED_NO_USER.
        const gate = await requestViewToolCall({
          user,
          appId,
          app: appConfig,
          viewTool,
          serverId,
          name,
          args,
          target,
          chatId,
          canApprove: req.body.toolApprovalCapable === true,
          platform: configCache.getPlatform?.() || null,
          getInstallation: installedIntegrationById
        });
        if (gate.status !== 'run') return { gate };
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
        throw new ServiceError('FORBIDDEN', `Tool ${name} is not callable from this app`);
      }
      if (outcome.gate?.status === 'refused') {
        throw new ServiceError(outcome.gate.code, outcome.gate.message, { status: 403 });
      }
      if (outcome.gate?.status === 'awaiting') {
        // Nothing ran: the host shows the card and answers with
        // POST /api/mcp-apps/tools/call/approval, which runs the call.
        return res
          .status(202)
          .json({ awaitingApproval: true, interaction: outcome.gate.interaction });
      }
      return res.json(toViewToolResult(outcome.result));
    }
  );

  /**
   * The decision on an MCP App view's call that waits for approval (#2945):
   * `{ appId, toolId, interactionId, decision: 'approve' | 'reject' }`. On
   * approve the stored call runs and its result is the answer (the view's
   * `tools/call` result); reject and expiry answer with a structured tool
   * error (`USER_REJECTED`, `APPROVAL_EXPIRED`). Answered exactly once.
   */
  app.post(
    buildServerPath('/api/mcp-apps/tools/call/approval'),
    authRequired,
    validate({ body: approvalBodySchema }),
    async (req, res) => {
      const { appId, toolId, interactionId, decision } = req.body;
      const { run, user } = await resolveMcpApp(req, appId, toolId);
      const interaction = await interactionService.get(interactionId);
      if (interaction) {
        const view = interaction.source?.viewCall;
        if (
          !isViewToolApproval(interaction) ||
          view.appId !== appId ||
          view.viewToolId !== toolId
        ) {
          throw new ServiceError('NOT_FOUND', 'Approval not found');
        }
        if (!(await loadInteractionAccess(interaction, user))) {
          throw new ServiceError('FORBIDDEN', 'This approval belongs to another user');
        }
      }
      const answered = await answerViewToolApproval({
        interaction,
        decision,
        user,
        call: (callName, callArgs) =>
          run(async conn => {
            // Still a tool this view may call (the server may have changed).
            if (!(await conn.getAppTool(callName))) {
              throw new McpAppAccessError(403, `Tool ${callName} is not callable from this app`);
            }
            logger.info('MCP App tool call (approved)', {
              component: COMPONENT,
              appId,
              viaToolId: toolId,
              tool: callName,
              userId: user.id,
              interactionId
            });
            return conn.callToolRaw(callName, callArgs);
          })
      });
      return res.status(answered.status).json(answered.body);
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
    }
  );

  app.post(
    buildServerPath('/api/mcp-apps/resources/read'),
    authRequired,
    validate({ body: resourceReadBodySchema }),
    async (req, res) => {
      const { appId, toolId, uri } = req.body;
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
        throw new ServiceError('PAYLOAD_TOO_LARGE', 'Resource too large');
      }
      return res.json({ contents });
    }
  );
}
