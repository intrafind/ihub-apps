/**
 * Per-user OAuth for outbound MCP servers (`auth.type: "oauthUser"`).
 *
 *   GET  /api/mcp/oauth/client-metadata.json  iHub's Client ID Metadata Document
 *                                             (unauthenticated, cacheable)
 *   GET  /api/mcp/oauth/authorize             start a sign-in (302 to the AS)
 *   GET  /api/mcp/oauth/callback              finish it (302 back to returnUrl)
 *   GET  /api/mcp/oauth/connections           the caller's per-user servers
 *   POST /api/mcp/oauth/disconnect            revoke + delete the caller's tokens
 *
 * The flow logic lives in `services/mcp/mcpOAuthService.js`; these handlers
 * validate input, bind the flow to the signed-in user and translate failures
 * into stable `mcp_error` codes on the return URL (text from the authorization
 * server is never echoed). No session is used: the `state` is a signed
 * ticket, so start and callback may land on different cluster workers.
 *
 * @module routes/mcpOAuth
 */
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthFlowError,
  completeUserAuthorization,
  isServerVisibleToUser,
  isUserOAuthServer,
  revokeUserConnection,
  startUserAuthorization
} from '../services/mcp/mcpOAuthService.js';
import { verifyMcpOAuthTicket } from '../services/mcp/mcpOAuthTicket.js';
import { userTokenStatus } from '../services/mcp/mcpUserTokens.js';
import {
  buildMcpClientMetadata,
  mcpConnectPath,
  resolveMcpPublicBase,
  MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CLIENT_METADATA_PATH
} from '../services/mcp/mcpOAuthPublicUrl.js';
import { isAnonymousUser } from '../services/loop/runIdentity.js';
import { authRequired } from '../middleware/authRequired.js';
import { isValidReturnUrl } from '../utils/oauthReturnUrl.js';
import { buildServerPath } from '../utils/basePath.js';
import { sendAuthRequired } from '../utils/responseHelpers.js';
import { zSafeId } from '../validators/common.js';
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

/**
 * `returnUrl` with query parameters added. Works for relative and absolute
 * URLs and keeps any existing query and fragment.
 *
 * @param {string} returnUrl - Already validated
 * @param {Object<string, string>} params
 * @returns {string}
 */
export function withQuery(returnUrl, params) {
  const hashIndex = returnUrl.indexOf('#');
  const base = hashIndex >= 0 ? returnUrl.slice(0, hashIndex) : returnUrl;
  const hash = hashIndex >= 0 ? returnUrl.slice(hashIndex) : '';
  const query = new URLSearchParams(params).toString();
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${query}${hash}`;
}

function redirectWithError(res, returnUrl, code, serverId) {
  return res.redirect(
    withQuery(returnUrl, { mcp_error: code, ...(serverId ? { mcp_server: serverId } : {}) })
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
  // iHub's Client ID Metadata Document. Authorization servers that support
  // CIMD fetch it with no credentials and no redirects; `client_id` must be
  // this exact URL.
  app.get(buildServerPath(MCP_OAUTH_CLIENT_METADATA_PATH), (req, res) => {
    const publicBase = resolveMcpPublicBase(req);
    if (!publicBase) return res.status(503).json({ error: 'Public URL unknown' });
    const document = buildMcpClientMetadata({ publicBase });
    const body = JSON.stringify(document);
    if (Buffer.byteLength(body, 'utf8') > MAX_CLIENT_METADATA_BYTES) {
      logger.error('MCP client metadata document exceeds 8 KB', { component: COMPONENT });
      return res.status(500).json({ error: 'Client metadata document too large' });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
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
        return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.SERVER_NOT_FOUND);
      }
      const serverId = parsedId.data;
      const serverConfig = userOAuthServer(serverId);
      // An unknown server and one the user may not use look the same.
      if (
        !serverConfig ||
        !(await isServerVisibleToUser(req.user, serverConfig, await catalogToolsOf(serverId)))
      ) {
        return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.SERVER_NOT_FOUND, serverId);
      }

      const publicBase = resolveMcpPublicBase(req);
      if (!publicBase) {
        return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.DISCOVERY_FAILED, serverId);
      }
      try {
        const { authorizationUrl } = await startUserAuthorization({
          serverConfig,
          user: req.user,
          publicBase,
          returnUrl,
          security: mcpClientManager.security
        });
        return res.redirect(302, authorizationUrl.href);
      } catch (error) {
        const code =
          error instanceof McpOAuthFlowError ? error.code : MCP_OAUTH_ERROR_CODES.OAUTH_FAILED;
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

  app.get(buildServerPath(MCP_OAUTH_CALLBACK_PATH), authRequired, async (req, res) => {
    if (isAnonymousUser(req.user)) return sendAuthRequired(res);

    const verified = verifyMcpOAuthTicket(
      typeof req.query.state === 'string' ? req.query.state : ''
    );
    if (!verified.ok) {
      const code =
        verified.reason === 'expired'
          ? MCP_OAUTH_ERROR_CODES.STATE_EXPIRED
          : MCP_OAUTH_ERROR_CODES.INVALID_STATE;
      return redirectWithError(res, defaultReturnUrl(), code);
    }
    const { ticket } = verified;
    const { serverId, returnUrl } = ticket;

    // The ticket is bound to the user who started the flow. Completing it in
    // another user's session would attach the attacker's upstream account to
    // the victim (or the reverse), so it is refused.
    if (String(req.user.id) !== ticket.userId) {
      logger.warn('MCP OAuth callback for a different user refused', {
        component: COMPONENT,
        serverId,
        userId: req.user.id
      });
      return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.USER_MISMATCH, serverId);
    }
    if (req.query.error) {
      logger.info('MCP OAuth sign-in declined or failed at the authorization server', {
        component: COMPONENT,
        serverId,
        userId: ticket.userId
      });
      return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.OAUTH_FAILED, serverId);
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.MISSING_CODE, serverId);
    }
    const serverConfig = userOAuthServer(serverId);
    if (!serverConfig) {
      return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.SERVER_NOT_FOUND, serverId);
    }

    try {
      await completeUserAuthorization({
        serverConfig,
        ticket,
        code,
        security: mcpClientManager.security
      });
    } catch (error) {
      logger.warn('MCP OAuth code exchange failed', {
        component: COMPONENT,
        serverId,
        userId: ticket.userId,
        error: error.message
      });
      return redirectWithError(res, returnUrl, MCP_OAUTH_ERROR_CODES.EXCHANGE_FAILED, serverId);
    }

    // The next call reconnects with the new token; listing the tools now
    // fills the server's shared catalog (best effort, not awaited).
    await mcpClientManager.evictUserConnection(serverId, ticket.userId);
    mcpClientManager.refreshCatalogForUser(serverId, req.user).catch(() => {});
    logger.info('MCP server connected for user', {
      component: COMPONENT,
      serverId,
      userId: ticket.userId
    });
    return res.redirect(withQuery(returnUrl, { mcp_connected: serverId }));
  });

  app.get(buildServerPath('/api/mcp/oauth/connections'), authRequired, async (req, res) => {
    if (isAnonymousUser(req.user)) return sendAuthRequired(res);
    try {
      const out = [];
      for (const conn of mcpClientManager.connections.values()) {
        const cfg = conn.config;
        if (cfg.enabled === false || !isUserOAuthServer(cfg)) continue;
        if (!(await isServerVisibleToUser(req.user, cfg, await catalogToolsOf(cfg.id)))) continue;
        const status = await userTokenStatus(String(req.user.id), cfg.id);
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
      const userId = String(req.user.id);
      const result = await revokeUserConnection({
        serverConfig: conn.config,
        userId,
        security: mcpClientManager.security
      });
      await mcpClientManager.evictUserConnection(serverId, userId);
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
