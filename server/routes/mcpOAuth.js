// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP routes that are registered at authorization servers, for outbound
 * MCP servers with per-user sign-in (`auth.type: "oauthUser"`):
 *
 *   GET  /api/mcp/oauth/client-metadata/:serverId  iHub's Client ID Metadata Document
 *                                                  for one server (unauthenticated)
 *   GET  /api/mcp/oauth/callback/:serverId         alias of /api/integrations/oauth/callback
 *
 * Each server keeps its own callback URL and CIMD (they are registered at the
 * authorization servers), and the callback refuses a flow started for another
 * server, so a code delivered to one server's callback can never complete
 * another server's sign-in.
 *
 * Starting a sign-in, listing connections and disconnecting are the one
 * connect flow of every integration (`routes/integrations/userIntegrations.js`:
 * `GET /api/integrations`, `POST /api/integrations/:id/connect|reconnect|disconnect`).
 *
 * @module routes/mcpOAuth
 */
import mcpClientManager from '../services/mcp/McpClientManager.js';
import { isUserOAuthServer } from '../services/mcp/mcpOAuthService.js';
import {
  buildMcpClientMetadata,
  resolveMcpPublicBaseInfo,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CLIENT_METADATA_PATH
} from '../services/mcp/mcpOAuthPublicUrl.js';
import { authOptional } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { zSafeId } from '../validators/common.js';
import { integrationOAuthCallbackHandler } from './integrations/oauthCallback.js';
import logger from '../utils/logger.js';

const COMPONENT = 'McpOAuth';

/** CIMD documents are capped at 8 KB by iHub's own validator (and the draft). */
const MAX_CLIENT_METADATA_BYTES = 8 * 1024;

const serverIdSchema = zSafeId.min(1).max(64);

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
}
