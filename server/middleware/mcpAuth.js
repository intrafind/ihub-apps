import { verifyOAuthToken } from '../utils/oauthTokenService.js';
import { loadOAuthClients, findClientById } from '../utils/oauthClientManager.js';
import { isPersonalKeysEnabled } from '../utils/personalApiKeyManager.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import { hasAnyScope, MCP_METHOD_SCOPES, MCP_SCOPES } from '../services/mcp/scopes.js';
import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

/**
 * Resolve the URL of the RFC 9728 protected-resource metadata document.
 * Advertised in the 401 WWW-Authenticate challenge so MCP clients can
 * discover the authorization server (MCP auth spec, 2025-06-18).
 *
 * @param {import('express').Request} req - Express request object
 * @returns {string} Absolute URL of /.well-known/oauth-protected-resource
 */
function resourceMetadataUrl(req) {
  const mcpConfig = (configCache.getPlatform() || {}).mcpServer || {};
  let base = null;
  if (mcpConfig.publicUrl) {
    // publicUrl points at the app base (possibly with a subpath); the
    // well-known document lives at the host root per RFC 9728.
    try {
      base = new URL(mcpConfig.publicUrl).origin;
    } catch {
      // Misconfigured (non-absolute) publicUrl — fall through to the
      // request-derived origin so the challenge always carries an
      // absolute URL.
      base = null;
    }
  }
  if (!base) {
    const protocol = req.protocol || (req.secure ? 'https' : 'http');
    base = `${protocol}://${req.get('host')}`;
  }
  return `${base}/.well-known/oauth-protected-resource${buildServerPath('/mcp')}`;
}

/**
 * Bearer-token middleware for the MCP gateway (`/mcp` and `/mcp/sse`).
 *
 * Design principles (per issue #1461):
 *   - Anonymous access is never permitted on the MCP path.
 *   - Both human-via-MCP-client (authorization_code) and server-to-server
 *     (client_credentials) tokens are validated by the SAME code path.
 *   - The resulting req.user is identical in shape to what jwtAuth produces,
 *     so downstream code (configCache.getAppsForUser, runTool, etc.) works
 *     without any MCP-specific branches.
 */
export default async function mcpAuth(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const oauthConfig = platform.oauth || {};
  const mcpConfig = platform.mcpServer || {};

  if (!mcpConfig.enabled) {
    return sendUnauthorized(req, res, 'mcp_disabled', 'MCP gateway is not enabled on this server');
  }

  // The MCP authorization model is OAuth-only — even if the platform allows
  // anonymous access for the web UI, the MCP surface always requires a
  // bearer token.
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendUnauthorized(req, res, 'missing_token', 'Bearer token required');
  }

  const token = authHeader.substring(7).trim();
  const decoded = verifyOAuthToken(token);
  if (!decoded) {
    return sendUnauthorized(req, res, 'invalid_token', 'Token is invalid or expired');
  }

  // Look up the OAuth client. Required for both auth_code (per-client
  // allowlist application) and client_credentials (service-account identity).
  const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
  let client = null;
  try {
    const clientsConfig = loadOAuthClients(clientsFilePath);
    if (clientsConfig?.metadata?.error) {
      logger.error('OAuth clients config unavailable for MCP auth', {
        component: 'McpAuth',
        loaderError: clientsConfig.metadata.error
      });
      return sendError(res, 503, 'service_unavailable', 'OAuth client store unavailable');
    }
    client = findClientById(clientsConfig, decoded.client_id);
  } catch (err) {
    logger.error('Failed to load OAuth clients for MCP auth', {
      component: 'McpAuth',
      error: err.message
    });
    return sendError(res, 503, 'service_unavailable', 'OAuth client store unavailable');
  }

  if (!client || !client.active) {
    return sendUnauthorized(req, res, 'invalid_client', 'OAuth client not found or suspended');
  }

  // Build req.user with shape identical to jwtAuth (so downstream filtering
  // works unchanged).
  let user;
  if (
    decoded.authMode === 'oauth_client_credentials' ||
    decoded.authMode === 'oauth_static_api_key'
  ) {
    user = {
      id: decoded.client_id,
      username: decoded.client_name || decoded.client_id,
      name: decoded.client_name || decoded.client_id,
      email: '',
      groups: decoded.groups || ['oauth_clients'],
      authMode: decoded.authMode,
      isOAuthClient: true,
      scopes: decoded.scopes || [],
      allowedApps: client.allowedApps || [],
      allowedModels: client.allowedModels || [],
      allowedPrompts: client.allowedPrompts || []
    };
  } else if (decoded.authMode === 'oauth_personal_key') {
    // Personal API key: the acting user comes from the client record, never
    // from the token, so a revoked key or a disabled feature stops working
    // immediately on the gateway too.
    if (!isPersonalKeysEnabled(platform)) {
      return sendUnauthorized(req, res, 'invalid_token', 'Personal API keys are not enabled');
    }

    if (client.personal !== true || client.ownerUserId !== decoded.sub) {
      return sendUnauthorized(req, res, 'invalid_token', 'API key has been revoked');
    }

    // Second granularity on both sides: see the equivalent check in jwtAuth.
    if (
      client.lastRotated &&
      decoded.iat < Math.floor(new Date(client.lastRotated).getTime() / 1000)
    ) {
      return sendUnauthorized(
        req,
        res,
        'invalid_token',
        'API key was issued before the last rotation'
      );
    }

    user = {
      id: client.ownerUserId,
      username: client.ownerUsername || client.ownerUserId,
      name: client.ownerName || client.ownerUsername || client.ownerUserId,
      email: client.ownerEmail || '',
      groups: Array.isArray(client.ownerGroups) ? client.ownerGroups : [],
      authMode: 'oauth_personal_key',
      isPersonalApiKey: true,
      clientId: client.clientId,
      scopes: decoded.scopes || [],
      clientAllowedApps: client.allowedApps || [],
      clientAllowedModels: client.allowedModels || [],
      clientAllowedPrompts: client.allowedPrompts || []
    };
  } else if (decoded.authMode === 'oauth_authorization_code') {
    user = {
      id: decoded.sub || decoded.username,
      username: decoded.username || decoded.preferred_username || decoded.sub,
      name: decoded.name || decoded.username,
      email: decoded.email || '',
      groups: decoded.groups || [],
      authMode: 'oauth_authorization_code',
      isOAuthAuthCode: true,
      clientId: decoded.client_id || null,
      scopes: decoded.scopes || [],
      clientAllowedApps: client.allowedApps || [],
      clientAllowedModels: client.allowedModels || [],
      clientAllowedPrompts: client.allowedPrompts || []
    };
  } else {
    // Reject any non-OAuth token — only OAuth-issued tokens are valid for MCP.
    return sendUnauthorized(req, res, 'invalid_token', 'Only OAuth tokens are accepted on /mcp');
  }

  // Enforce that the token bears at least one MCP scope. Method-level scope
  // checks (e.g. tools/call requires mcp:tools:call) are applied in the
  // McpServerService dispatch.
  if (!hasAnyScope(user.scopes, Object.values(MCP_SCOPES))) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="ihub-mcp", error="insufficient_scope", resource_metadata="${resourceMetadataUrl(req)}"`
    );
    return sendError(res, 403, 'insufficient_scope', 'Token does not carry any mcp:* scopes');
  }

  // Apply group permissions exactly as the web-side does so resource
  // filtering on the gateway path matches what the same user sees in the UI.
  req.user = enhanceUserWithPermissions(user, platform.auth || {}, platform);

  // For audit logging downstream, remember the raw decoded token claims.
  req._mcpToken = {
    clientId: decoded.client_id,
    sub: decoded.sub,
    scopes: user.scopes,
    authMode: decoded.authMode
  };

  next();
}

function sendUnauthorized(req, res, error, description) {
  // The resource_metadata parameter (RFC 9728 §5.1) tells MCP clients where
  // to find the protected-resource metadata, which in turn points at the
  // OAuth authorization server — this is how Claude & co. bootstrap the
  // whole auth flow from a single 401.
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="ihub-mcp", resource_metadata="${resourceMetadataUrl(req)}"`
  );
  res.status(401).json({ error, error_description: description });
}

function sendError(res, status, error, description) {
  res.status(status).json({ error, error_description: description });
}

export { MCP_METHOD_SCOPES };
