// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Per-user OAuth for outbound MCP servers (`auth.type: "oauthUser"`).
 *
 *   GET  /api/mcp/oauth/client-metadata/:serverId  iHub's Client ID Metadata Document
 *                                                  for one server (unauthenticated)
 *   GET  /api/mcp/oauth/authorize                  start a sign-in (302 to the AS);
 *                                                  `scope=` asks for more (step-up)
 *   GET  /api/mcp/oauth/callback/:serverId         alias of /api/integrations/oauth/callback
 *   GET  /api/mcp/oauth/connections                the caller's per-user servers
 *   POST /api/mcp/oauth/disconnect                 revoke + delete the caller's tokens
 *
 * Each server keeps its own callback URL and CIMD (they are registered at the
 * authorization servers), and the callback refuses a flow started for another
 * server, so a code delivered to one server's callback can never complete
 * another server's sign-in.
 *
 * The flow runs through the connection service
 * (`services/integrations/auth/IntegrationConnectionService.js`) and the
 * shared OAuth client with the MCP discovery strategy; these handlers
 * validate input and translate failures into stable `mcp_error` codes on the
 * return URL (text from the authorization server is never echoed). The
 * `state` names a server-side, single-use flow, so start and callback may
 * land on different cluster workers.
 *
 * @module routes/mcpOAuth
 */
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import { isServerVisibleToUser, isUserOAuthServer } from '../services/mcp/mcpOAuthService.js';
import { userTokenStatus } from '../services/mcp/mcpUserTokens.js';
import {
  buildMcpClientMetadata,
  mcpConnectPath,
  resolveMcpPublicBaseInfo,
  MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CLIENT_METADATA_PATH
} from '../services/mcp/mcpOAuthPublicUrl.js';
import { isAdminUser, isAnonymousUser } from '../services/loop/runIdentity.js';
import { authOptional, authRequired } from '../middleware/authRequired.js';
import { isValidReturnUrl } from '../utils/oauthReturnUrl.js';
import { buildServerPath } from '../utils/basePath.js';
import { sendAuthRequired } from '../utils/responseHelpers.js';
import { zSafeId } from '../validators/common.js';
import {
  OAUTH_FLOW_ERROR_CODES,
  OAuthFlowError,
  parseScope
} from '../services/integrations/auth/OAuthUserClient.js';
import {
  getIntegrationConnectionService,
  resultParams,
  returnPathWith
} from '../services/integrations/auth/IntegrationConnectionService.js';
import { integrationOAuthCallbackHandler } from './integrations/oauthCallback.js';
import logger from '../utils/logger.js';

const COMPONENT = 'McpOAuth';

/** Where the browser lands when no (valid) return URL was given. */
const DEFAULT_RETURN_PATH = '/settings/integrations';

/** CIMD documents are capped at 8 KB by iHub's own validator (and the draft). */
const MAX_CLIENT_METADATA_BYTES = 8 * 1024;

const serverIdSchema = zSafeId.min(1).max(64);

const disconnectBodySchema = z.object({ serverId: serverIdSchema });

// Starting a sign-in reaches out to the MCP server and its authorization
// server; bound it per IP like the other OAuth start routes.
const authorizeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

/** The default return path, with the deployment's base path. */
function defaultReturnUrl() {
  return buildServerPath(DEFAULT_RETURN_PATH);
}

/** Scopes a step-up may ask for: a bounded list of plain scope tokens. */
const STEP_UP_SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/;

/**
 * Redirect to the return URL (as a same-origin path) with an `mcp_error`.
 * @param {import('express').Response} res
 * @param {string} returnUrl
 * @param {string} code - One of OAUTH_FLOW_ERROR_CODES
 * @param {string} [serverId]
 */
function redirectWithError(res, returnUrl, code, serverId) {
  return res.redirect(
    returnPathWith(
      returnUrl,
      resultParams({ stack: 'mcp', installationId: serverId }, { ok: false, code })
    )
  );
}

/**
 * The enabled `oauthUser` server config with this id, or null.
 * @param {string} serverId
 * @returns {Object|null}
 */
function userOAuthServer(serverId) {
  const conn = mcpClientManager.getConnection(serverId);
  if (!conn || conn.config.enabled === false || !isUserOAuthServer(conn.config)) return null;
  return conn.config;
}

/** The server's known tool definitions (for the visibility check). */
function catalogToolsOf(serverId) {
  return mcpClientManager.toolsOfServer(serverId);
}

/**
 * Register the MCP OAuth routes.
 * @param {import('express').Express} app
 */
export default function registerMcpOAuthRoutes(app) {
  // iHub's Client ID Metadata Document for one server. Authorization servers
  // that support CIMD fetch it with no credentials and no redirects;
  // `client_id` must be this exact URL. Only a configured Public URL makes the
  // document cacheable: one derived from the request depends on its Host.
  app.get(buildServerPath(`${MCP_OAUTH_CLIENT_METADATA_PATH}/:serverId`), (req, res) => {
    const parsedId = serverIdSchema.safeParse(req.params.serverId);
    const serverConfig = parsedId.success ? userOAuthServer(parsedId.data) : null;
    if (!serverConfig) return res.status(404).json({ error: 'Not found' });
    const { publicBase, configured } = resolveMcpPublicBaseInfo(req);
    if (!publicBase) return res.status(503).json({ error: 'Public URL unknown' });
    const document = buildMcpClientMetadata({ publicBase, serverId: serverConfig.id });
    const body = JSON.stringify(document);
    if (Buffer.byteLength(body, 'utf8') > MAX_CLIENT_METADATA_BYTES) {
      logger.error('MCP client metadata document exceeds 8 KB', { component: COMPONENT });
      return res.status(500).json({ error: 'Client metadata document too large' });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (configured) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(body);
  });

  app.get(
    buildServerPath(MCP_OAUTH_AUTHORIZE_PATH),
    authRequired,
    authorizeLimiter,
    async (req, res) => {
      const returnUrl = isValidReturnUrl(req.query.returnUrl, req)
        ? String(req.query.returnUrl)
        : defaultReturnUrl();
      if (isAnonymousUser(req.user)) return sendAuthRequired(res);

      const parsedId = serverIdSchema.safeParse(req.query.serverId);
      if (!parsedId.success) {
        return redirectWithError(res, returnUrl, OAUTH_FLOW_ERROR_CODES.INTEGRATION_NOT_FOUND);
      }
      const serverId = parsedId.data;
      const serverConfig = userOAuthServer(serverId);
      // An unknown server and one the user may not use look the same.
      if (
        !serverConfig ||
        !(await isServerVisibleToUser(req.user, serverConfig, await catalogToolsOf(serverId)))
      ) {
        return redirectWithError(
          res,
          returnUrl,
          OAUTH_FLOW_ERROR_CODES.INTEGRATION_NOT_FOUND,
          serverId
        );
      }

      const { publicBase, configured } = resolveMcpPublicBaseInfo(req);
      if (!publicBase) {
        return redirectWithError(res, returnUrl, OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED, serverId);
      }
      const requested = parseScope(typeof req.query.scope === 'string' ? req.query.scope : '');
      const scopes = requested.filter(scope => STEP_UP_SCOPE.test(scope)).slice(0, 50);
      try {
        const { authorizationUrl } = await getIntegrationConnectionService().beginConnect({
          installationId: serverId,
          user: req.user,
          req,
          returnUrl,
          ...(scopes.length ? { scopes } : {}),
          publicBase,
          // Only a configured Public URL or an admin's own sign-in may replace
          // a registration made for another base — never one request's Host.
          trustedBase: configured || isAdminUser(req.user)
        });
        return res.redirect(302, authorizationUrl.href);
      } catch (error) {
        const code =
          error instanceof OAuthFlowError ? error.code : OAUTH_FLOW_ERROR_CODES.OAUTH_FAILED;
        logger.warn('MCP OAuth sign-in could not start', {
          component: COMPONENT,
          serverId,
          userId: req.user.id,
          code,
          error: error.message
        });
        return redirectWithError(res, returnUrl, code, serverId);
      }
    }
  );

  // The per-server callback registered at the authorization servers: an alias
  // of the one integration callback, bound to this server's flows.
  app.get(
    buildServerPath(`${MCP_OAUTH_CALLBACK_PATH}/:serverId`),
    authOptional,
    integrationOAuthCallbackHandler(req => ({
      stack: 'mcp',
      installationId: String(req.params.serverId || '').slice(0, 64)
    }))
  );

  app.get(buildServerPath('/api/mcp/oauth/connections'), authRequired, async (req, res) => {
    if (isAnonymousUser(req.user)) return sendAuthRequired(res);
    try {
      const out = [];
      for (const conn of mcpClientManager.connections.values()) {
        const cfg = conn.config;
        if (cfg.enabled === false || !isUserOAuthServer(cfg)) continue;
        if (!(await isServerVisibleToUser(req.user, cfg, await catalogToolsOf(cfg.id)))) continue;
        const status = await userTokenStatus(String(req.user.id), cfg);
        out.push({
          serverId: cfg.id,
          name: cfg.name,
          ...(cfg.description ? { description: cfg.description } : {}),
          connected: status.connected && !status.expired,
          expiresAt: status.expiresAt,
          scope: status.scope,
          connectUrl: mcpConnectPath(cfg.id)
        });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ servers: out });
    } catch (error) {
      logger.error('Listing MCP OAuth connections failed', {
        component: COMPONENT,
        error: error.message
      });
      return res.status(500).json({ error: 'Failed to list MCP connections' });
    }
  });

  app.post(buildServerPath('/api/mcp/oauth/disconnect'), authRequired, async (req, res) => {
    if (isAnonymousUser(req.user)) return sendAuthRequired(res);
    const parsed = disconnectBodySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid serverId' });
    const { serverId } = parsed.data;
    const conn = mcpClientManager.getConnection(serverId);
    if (!conn || !isUserOAuthServer(conn.config)) {
      return res.status(404).json({ error: 'MCP server not found' });
    }
    try {
      const result = await getIntegrationConnectionService().disconnect({
        installationId: serverId,
        userId: String(req.user.id),
        req
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logger.error('MCP OAuth disconnect failed', {
        component: COMPONENT,
        serverId,
        userId: req.user.id,
        error: error.message
      });
      return res.status(500).json({ error: 'Failed to disconnect' });
    }
  });
}
