import { createOAuthClient, loadOAuthClients } from '../utils/oauthClientManager.js';
import { validateRegistrationRequest } from '../utils/dcrValidation.js';
import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * MCP-aware clients (Claude, Claude Desktop, Cursor, VS Code, …) discover the
 * registration_endpoint from /.well-known/oauth-authorization-server and
 * self-register before running the authorization_code + PKCE flow. Without
 * this endpoint every user would have to manually create an OAuth client in
 * the admin UI and paste its id/secret into their MCP client.
 *
 * Registration is unauthenticated by design (that is how the MCP client
 * ecosystem uses DCR), so the policy is intentionally narrow — see
 * dcrValidation.js — and the endpoint is:
 *   - opt-in via platform.oauth.dcr.enabled (default false),
 *   - rate-limited by the shared /api/oauth limiter,
 *   - capped at platform.oauth.dcr.maxClients auto-registered clients.
 *
 * Registered clients always require user consent (consentRequired: true) and
 * are never trusted, so a user must still sign in and approve the requested
 * mcp:* scopes before any token is issued.
 */
export default function registerOAuthRegisterRoutes(app) {
  /**
   * @swagger
   * /api/oauth/register:
   *   post:
   *     summary: OAuth 2.0 Dynamic Client Registration endpoint (RFC 7591)
   *     description: |
   *       Registers a new OAuth client for the authorization_code + PKCE flow.
   *       Only available when platform.oauth.dcr.enabled is true.
   *     tags:
   *       - OAuth
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - redirect_uris
   *             properties:
   *               redirect_uris:
   *                 type: array
   *                 items:
   *                   type: string
   *               client_name:
   *                 type: string
   *               grant_types:
   *                 type: array
   *                 items:
   *                   type: string
   *               response_types:
   *                 type: array
   *                 items:
   *                   type: string
   *               token_endpoint_auth_method:
   *                 type: string
   *                 enum: [none, client_secret_post, client_secret_basic]
   *               scope:
   *                 type: string
   *     responses:
   *       201:
   *         description: Client registered
   *       400:
   *         description: Invalid client metadata
   *       404:
   *         description: Dynamic client registration is not enabled
   */
  app.post(buildServerPath('/api/oauth/register'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};
      const dcrConfig = oauthConfig.dcr || {};

      // Hard-404 while disabled, matching the MCP gateway posture — probing
      // must not reveal whether the feature exists.
      if (!oauthConfig.enabled?.authz || dcrConfig.enabled !== true) {
        return res.status(404).json({
          error: 'not_found',
          error_description: 'Dynamic client registration is not enabled'
        });
      }

      const validation = validateRegistrationRequest(req.body, {
        allowedScopes: dcrConfig.allowedScopes
      });
      if (!validation.ok) {
        return res
          .status(400)
          .json({ error: validation.error, error_description: validation.errorDescription });
      }

      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';

      // Cap the number of auto-registered clients so an unauthenticated
      // caller cannot grow the client store unboundedly.
      const maxClients = Number.isInteger(dcrConfig.maxClients) ? dcrConfig.maxClients : 100;
      const clientsConfig = loadOAuthClients(clientsFilePath);
      if (clientsConfig?.metadata?.error) {
        return res.status(503).json({
          error: 'service_unavailable',
          error_description: 'OAuth client store unavailable'
        });
      }
      const dcrClientCount = Object.values(clientsConfig.clients || {}).filter(
        c => c?.metadata?.dcr === true
      ).length;
      if (dcrClientCount >= maxClients) {
        logger.warn('[OAuth DCR] Registration rejected — client limit reached', {
          component: 'OAuthRegister',
          dcrClientCount,
          maxClients
        });
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description:
            'Dynamic client registration limit reached — ask an administrator to remove unused clients'
        });
      }

      const meta = validation.clientMetadata;
      const isPublic = meta.tokenEndpointAuthMethod === 'none';

      const created = await createOAuthClient(
        {
          name: meta.name,
          description: 'Dynamically registered client (RFC 7591)',
          clientType: isPublic ? 'public' : 'confidential',
          grantTypes: meta.grantTypes,
          redirectUris: meta.redirectUris,
          scopes: meta.scopes,
          consentRequired: true,
          trusted: false,
          tokenExpirationMinutes: oauthConfig.defaultTokenExpirationMinutes || 60,
          metadata: {
            dcr: true,
            tokenEndpointAuthMethod: meta.tokenEndpointAuthMethod,
            ...(meta.softwareId ? { softwareId: meta.softwareId } : {}),
            ...(meta.softwareVersion ? { softwareVersion: meta.softwareVersion } : {})
          }
        },
        clientsFilePath,
        'dcr'
      );

      logger.info('[OAuth DCR] Client registered', {
        component: 'OAuthRegister',
        clientId: created.clientId,
        clientName: meta.name,
        clientType: isPublic ? 'public' : 'confidential',
        scopes: meta.scopes,
        ip: req.ip
      });

      // RFC 7591 §3.2.1 response. The plaintext secret is only returned for
      // confidential clients and only in this one response.
      const response = {
        client_id: created.clientId,
        client_id_issued_at: Math.floor(Date.parse(created.createdAt) / 1000),
        client_name: meta.name,
        redirect_uris: meta.redirectUris,
        grant_types: meta.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: meta.tokenEndpointAuthMethod,
        scope: meta.scopes.join(' ')
      };
      if (!isPublic) {
        response.client_secret = created.clientSecret;
        response.client_secret_expires_at = 0;
      }

      res.status(201).json(response);
    } catch (error) {
      logger.error('[OAuth DCR] Registration endpoint error', {
        component: 'OAuthRegister',
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({
        error: 'server_error',
        error_description: 'An internal error occurred'
      });
    }
  });
}
