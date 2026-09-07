import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import { getJwtAlgorithm } from '../utils/tokenService.js';
import logger from '../utils/logger.js';
import { sendInternalError, sendErrorResponse } from '../utils/responseHelpers.js';
import crypto from 'crypto';
import * as jose from 'jose';

/**
 * Well-known endpoints for JWT/OIDC discovery
 * Implements OpenID Connect Discovery and JWKS endpoints
 */

/**
 * Get the base URL for the server
 * @param {Object} req - Express request object
 * @returns {string} Base URL
 */
function getBaseUrl(req) {
  const protocol = req.protocol || (req.secure ? 'https' : 'http');
  const host = req.get('host');
  const basePath = buildServerPath('').replace(/\/$/, ''); // Remove trailing slash
  return `${protocol}://${host}${basePath}`;
}

/**
 * Convert PEM public key to JWK format
 * @param {string} publicKeyPem - PEM formatted public key
 * @returns {Promise<Object>} JWK representation
 */
async function pemToJwk(publicKeyPem) {
  try {
    // Import the PEM key using jose
    const key = await jose.importSPKI(publicKeyPem, 'RS256');

    // Export as JWK
    const jwk = await jose.exportJWK(key);

    return jwk;
  } catch (error) {
    logger.error('Failed to convert PEM to JWK:', {
      component: 'WellKnown',
      error: error.message
    });
    throw error;
  }
}

/**
 * Build the authorization-server discovery document served at both
 * /.well-known/openid-configuration (OIDC Discovery 1.0) and
 * /.well-known/oauth-authorization-server (RFC 8414). MCP clients such as
 * Claude try the RFC 8414 path first, so both must resolve to the same
 * metadata.
 *
 * @param {import('express').Request} req - Express request object
 * @returns {Object} Discovery metadata document
 */
function buildAuthServerMetadata(req) {
  const baseUrl = getBaseUrl(req);
  const platform = configCache.getPlatform() || {};
  const algorithm = getJwtAlgorithm();

  // Use configured issuer or fall back to dynamic base URL.
  // OIDC spec (RFC 8414 §2) requires issuer to be a URL starting with https:// or http://.
  const oauthConfig = platform.oauth || {};
  const issuer =
    oauthConfig.issuer && oauthConfig.issuer.startsWith('http') ? oauthConfig.issuer : baseUrl;

  const mcpConfig = platform.mcpServer || {};
  const mcpScopes = mcpConfig.enabled
    ? [
        'mcp:tools:read',
        'mcp:tools:call',
        'mcp:apps:invoke',
        'mcp:workflows:run',
        'mcp:resources:read'
      ]
    : [];

  return {
    issuer,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    userinfo_endpoint: `${baseUrl}/api/oauth/userinfo`,
    revocation_endpoint: `${baseUrl}/api/oauth/revoke`,
    end_session_endpoint: `${baseUrl}/api/oauth/logout`,
    // RFC 7591 Dynamic Client Registration — advertised only when DCR *and*
    // the authorization server are enabled, since /api/oauth/register
    // hard-404s unless both are on (advertising it earlier would send MCP
    // clients into a guaranteed registration failure).
    ...(oauthConfig.dcr?.enabled && oauthConfig.enabled?.authz
      ? { registration_endpoint: `${baseUrl}/api/oauth/register` }
      : {}),
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [algorithm],
    // 'none' covers public PKCE clients (RFC 8414 §2) — the token endpoint
    // accepts secret-less clients with clientType 'public'.
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access', ...mcpScopes],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'name', 'email', 'groups', 'iss', 'aud', 'exp', 'iat', 'nonce'],
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    // Non-standard but useful for MCP-aware clients: advertise the gateway
    // endpoint so an agent can auto-discover it from the well-known URL.
    ...(mcpConfig.enabled
      ? {
          mcp_endpoint: mcpConfig.publicUrl
            ? `${mcpConfig.publicUrl.replace(/\/$/, '')}/mcp`
            : `${baseUrl}/mcp`
        }
      : {})
  };
}

/**
 * Build the OAuth Protected Resource Metadata document (RFC 9728) for the
 * MCP gateway. MCP clients resolve this from the `resource_metadata`
 * parameter of the gateway's 401 WWW-Authenticate challenge to find out
 * which authorization server protects /mcp and which scopes to request.
 *
 * @param {import('express').Request} req - Express request object
 * @returns {Object} Protected resource metadata document
 */
function buildProtectedResourceMetadata(req) {
  const baseUrl = getBaseUrl(req);
  const platform = configCache.getPlatform() || {};
  const oauthConfig = platform.oauth || {};
  const mcpConfig = platform.mcpServer || {};

  const issuer =
    oauthConfig.issuer && oauthConfig.issuer.startsWith('http') ? oauthConfig.issuer : baseUrl;
  const publicBase = mcpConfig.publicUrl ? mcpConfig.publicUrl.replace(/\/$/, '') : baseUrl;

  return {
    resource: `${publicBase}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [
      'mcp:tools:read',
      'mcp:tools:call',
      'mcp:apps:invoke',
      'mcp:workflows:run',
      'mcp:resources:read'
    ],
    resource_name: 'iHub Apps MCP gateway',
    resource_documentation: `${publicBase}/mcp/.well-known`
  };
}

export default function registerWellKnownRoutes(app) {
  /**
   * @swagger
   * /.well-known/openid-configuration:
   *   get:
   *     summary: OpenID Connect Discovery endpoint
   *     description: |
   *       Returns OpenID Connect Discovery metadata for JWT validation.
   *       This endpoint allows external applications to discover JWT configuration.
   *     tags:
   *       - Well-Known
   *     responses:
   *       200:
   *         description: OpenID Connect Discovery metadata
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 issuer:
   *                   type: string
   *                   description: JWT issuer identifier
   *                 jwks_uri:
   *                   type: string
   *                   description: URL to JSON Web Key Set
   *                 authorization_endpoint:
   *                   type: string
   *                   description: OAuth authorization endpoint
   *                 token_endpoint:
   *                   type: string
   *                   description: OAuth token endpoint
   *                 response_types_supported:
   *                   type: array
   *                   items:
   *                     type: string
   *                 subject_types_supported:
   *                   type: array
   *                   items:
   *                     type: string
   *                 id_token_signing_alg_values_supported:
   *                   type: array
   *                   items:
   *                     type: string
   */
  app.get('/.well-known/openid-configuration', (req, res) => {
    try {
      const discovery = buildAuthServerMetadata(req);

      logger.info('Served OpenID Connect Discovery', {
        component: 'WellKnown',
        issuer: discovery.issuer
      });

      res.json(discovery);
    } catch (error) {
      return sendInternalError(res, error, 'serve OpenID Connect Discovery');
    }
  });

  /**
   * @swagger
   * /.well-known/oauth-authorization-server:
   *   get:
   *     summary: OAuth 2.0 Authorization Server Metadata (RFC 8414)
   *     description: |
   *       Same metadata document as /.well-known/openid-configuration. MCP
   *       clients (Claude, Cursor, VS Code, …) resolve this path first when
   *       discovering how to authenticate against the MCP gateway.
   *     tags:
   *       - Well-Known
   *     responses:
   *       200:
   *         description: Authorization server metadata
   */
  const authServerMetadataHandler = (req, res) => {
    try {
      const discovery = buildAuthServerMetadata(req);

      logger.info('Served OAuth Authorization Server Metadata', {
        component: 'WellKnown',
        issuer: discovery.issuer
      });

      res.json(discovery);
    } catch (error) {
      return sendInternalError(res, error, 'serve OAuth Authorization Server Metadata');
    }
  };

  app.get('/.well-known/oauth-authorization-server', authServerMetadataHandler);
  // RFC 8414 §3.1 inserts the well-known segment between host and issuer
  // path, so subpath deployments are queried with the issuer path appended.
  app.get('/.well-known/oauth-authorization-server/{*issuerPath}', authServerMetadataHandler);

  /**
   * @swagger
   * /.well-known/oauth-protected-resource:
   *   get:
   *     summary: OAuth 2.0 Protected Resource Metadata (RFC 9728)
   *     description: |
   *       Describes the MCP gateway resource (/mcp) — which authorization
   *       server protects it and which scopes it understands. Served only
   *       while the MCP gateway is enabled; 404 otherwise so a disabled
   *       gateway stays invisible. Also registered with the /mcp path suffix
   *       because RFC 9728 §3.1 inserts the well-known segment between host
   *       and resource path.
   *     tags:
   *       - Well-Known
   *     responses:
   *       200:
   *         description: Protected resource metadata
   *       404:
   *         description: MCP gateway is not enabled
   */
  const protectedResourceHandler = (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      if (platform.mcpServer?.enabled !== true) {
        return res
          .status(404)
          .json({ error: 'not_found', error_description: 'MCP gateway is not enabled' });
      }
      res.json(buildProtectedResourceMetadata(req));
    } catch (error) {
      return sendInternalError(res, error, 'serve OAuth Protected Resource Metadata');
    }
  };

  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  // RFC 9728 §3.1 appends the resource path (/mcp, or <subpath>/mcp when the
  // app is deployed under a prefix) after the well-known segment.
  app.get('/.well-known/oauth-protected-resource/{*resourcePath}', protectedResourceHandler);

  /**
   * @swagger
   * /.well-known/jwks.json:
   *   get:
   *     summary: JSON Web Key Set endpoint
   *     description: |
   *       Returns public keys for JWT signature verification.
   *       For RS256: Returns public RSA keys in JWK format.
   *       For HS256: Returns metadata (public key cannot be shared for symmetric algorithms).
   *     tags:
   *       - Well-Known
   *     responses:
   *       200:
   *         description: JSON Web Key Set
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 keys:
   *                   type: array
   *                   items:
   *                     type: object
   *       501:
   *         description: JWKS not supported for current signing algorithm
   */
  app.get('/.well-known/jwks.json', async (req, res) => {
    try {
      const algorithm = getJwtAlgorithm();

      if (algorithm === 'HS256') {
        // For symmetric algorithms, we cannot expose the secret key
        // Return information about the algorithm but not the key
        logger.warn('JWKS endpoint called but HS256 (symmetric) algorithm is in use', {
          component: 'WellKnown'
        });

        return res.status(200).json({
          keys: [],
          note: 'JWKS not available for HS256 (symmetric) algorithm. Public key sharing requires RS256 (asymmetric) algorithm. Configure "jwt.algorithm": "RS256" in platform.json to enable public key sharing.'
        });
      }

      // For RS256, return the public key in JWK format
      const keyPair = tokenStorageService.getRSAKeyPair();

      if (!keyPair || !keyPair.publicKey) {
        logger.error('No RSA key pair available for JWKS', { component: 'WellKnown' });
        return sendErrorResponse(res, 501, 'JWKS not configured');
      }

      // Convert PEM to JWK
      const jwk = await pemToJwk(keyPair.publicKey);

      // Add standard JWK fields
      jwk.use = 'sig';
      jwk.kid = crypto
        .createHash('sha256')
        .update(keyPair.publicKey)
        .digest('hex')
        .substring(0, 16);
      jwk.alg = 'RS256';

      logger.info('Served JWKS endpoint', {
        component: 'WellKnown',
        algorithm: 'RS256',
        kid: jwk.kid
      });

      res.json({ keys: [jwk] });
    } catch (error) {
      return sendInternalError(res, error, 'serve JWKS');
    }
  });
}
