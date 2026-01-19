import { validateClientCredentials } from '../utils/oauthClientManager.js';
import { generateOAuthToken, introspectOAuthToken } from '../utils/oauthTokenService.js';
import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';

/**
 * OAuth 2.0 token endpoints
 * Implements RFC 6749 Client Credentials grant type
 */

/**
 * Sanitize OAuth input
 * @param {string} value - Input value
 * @param {string} fieldName - Field name for error messages
 * @param {number} maxLength - Maximum length
 * @returns {string|null} Sanitized value or null
 */
function sanitizeOAuthInput(value, fieldName, maxLength = 255) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }

  // Remove null bytes and control characters
  const sanitized = trimmed.replace(/\0/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Send OAuth error response per RFC 6749
 * @param {Object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {string} error - Error code
 * @param {string} description - Human-readable description
 */
function sendOAuthError(res, status, error, description) {
  console.log(`[OAuth] Error response | error=${error} | description=${description}`);
  res.status(status).json({
    error: error,
    error_description: description
  });
}

export default function registerOAuthRoutes(app, basePath = '') {
  /**
   * @swagger
   * /api/oauth/token:
   *   post:
   *     summary: OAuth 2.0 token endpoint
   *     description: |
   *       Generate access token using client credentials grant type.
   *       Implements RFC 6749 Client Credentials flow.
   *     tags:
   *       - OAuth
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - grant_type
   *               - client_id
   *               - client_secret
   *             properties:
   *               grant_type:
   *                 type: string
   *                 enum: [client_credentials]
   *                 description: OAuth grant type (must be 'client_credentials')
   *               client_id:
   *                 type: string
   *                 description: OAuth client ID
   *               client_secret:
   *                 type: string
   *                 description: OAuth client secret
   *               scope:
   *                 type: string
   *                 description: Optional space-separated list of scopes
   *     responses:
   *       200:
   *         description: Token generated successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 access_token:
   *                   type: string
   *                   description: JWT access token
   *                 token_type:
   *                   type: string
   *                   example: Bearer
   *                 expires_in:
   *                   type: number
   *                   description: Token expiration in seconds
   *                 scope:
   *                   type: string
   *                   description: Granted scopes (space-separated)
   *       400:
   *         description: Invalid request
   *       401:
   *         description: Invalid credentials
   *       403:
   *         description: Client suspended
   */
  app.post(buildServerPath('/api/oauth/token', basePath), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      // Check if OAuth is enabled
      if (!oauthConfig.enabled) {
        return sendOAuthError(res, 400, 'invalid_request', 'OAuth is not enabled on this server');
      }

      const { grant_type, client_id, client_secret, scope } = req.body;

      // Sanitize inputs
      let sanitizedGrantType, sanitizedClientId, sanitizedClientSecret, sanitizedScope;

      try {
        sanitizedGrantType = sanitizeOAuthInput(grant_type, 'grant_type', 50);
        sanitizedClientId = sanitizeOAuthInput(client_id, 'client_id', 255);
        sanitizedClientSecret = sanitizeOAuthInput(client_secret, 'client_secret', 1024);
        sanitizedScope = sanitizeOAuthInput(scope, 'scope', 500);
      } catch (error) {
        return sendOAuthError(res, 400, 'invalid_request', error.message);
      }

      // Validate grant_type
      if (!sanitizedGrantType) {
        return sendOAuthError(res, 400, 'invalid_request', 'grant_type is required');
      }

      if (sanitizedGrantType !== 'client_credentials') {
        return sendOAuthError(
          res,
          400,
          'invalid_grant',
          'Unsupported grant type. Only client_credentials is supported'
        );
      }

      // Validate client_id and client_secret
      if (!sanitizedClientId || !sanitizedClientSecret) {
        return sendOAuthError(
          res,
          400,
          'invalid_request',
          'client_id and client_secret are required'
        );
      }

      // Validate client credentials
      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const client = await validateClientCredentials(
        sanitizedClientId,
        sanitizedClientSecret,
        clientsFilePath
      );

      if (!client) {
        return sendOAuthError(res, 401, 'invalid_client', 'Invalid client credentials');
      }

      // Check if client is active
      if (!client.active) {
        return sendOAuthError(
          res,
          403,
          'access_denied',
          'Client account is suspended. Please contact your administrator'
        );
      }

      // Generate token
      try {
        const tokenResponse = generateOAuthToken(client, {
          requestedScope: sanitizedScope
        });

        // Log token issuance
        console.log(
          `[OAuth] Token issued | client_id=${sanitizedClientId} | scopes=${tokenResponse.scope} | expires_in=${tokenResponse.expires_in} | ip=${req.ip}`
        );

        res.json(tokenResponse);
      } catch (error) {
        // Handle scope validation errors
        if (error.message.includes('Invalid scopes')) {
          return sendOAuthError(
            res,
            400,
            'invalid_scope',
            error.message
          );
        }
        throw error;
      }
    } catch (error) {
      console.error('[OAuth] Token endpoint error:', error);
      sendOAuthError(res, 500, 'server_error', 'An internal error occurred');
    }
  });

  /**
   * @swagger
   * /api/oauth/introspect:
   *   post:
   *     summary: OAuth 2.0 token introspection endpoint
   *     description: |
   *       Introspect and validate an OAuth access token.
   *       Returns information about the token's validity and claims.
   *     tags:
   *       - OAuth
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - token
   *             properties:
   *               token:
   *                 type: string
   *                 description: Access token to introspect
   *     responses:
   *       200:
   *         description: Introspection result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 active:
   *                   type: boolean
   *                   description: Whether the token is active
   *                 client_id:
   *                   type: string
   *                   description: Client ID (if token is active)
   *                 scopes:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: Granted scopes
   *                 exp:
   *                   type: number
   *                   description: Expiration timestamp
   *       400:
   *         description: Invalid request
   */
  app.post(buildServerPath('/api/oauth/introspect', basePath), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      // Check if OAuth is enabled
      if (!oauthConfig.enabled) {
        return sendOAuthError(res, 400, 'invalid_request', 'OAuth is not enabled on this server');
      }

      const { token } = req.body;

      // Sanitize token
      let sanitizedToken;
      try {
        sanitizedToken = sanitizeOAuthInput(token, 'token', 10000);
      } catch (error) {
        return sendOAuthError(res, 400, 'invalid_request', error.message);
      }

      if (!sanitizedToken) {
        return sendOAuthError(res, 400, 'invalid_request', 'token is required');
      }

      // Introspect token
      const introspection = introspectOAuthToken(sanitizedToken);

      console.log(
        `[OAuth] Token introspected | active=${introspection.active} | client_id=${introspection.client_id || 'N/A'} | ip=${req.ip}`
      );

      res.json(introspection);
    } catch (error) {
      console.error('[OAuth] Introspection endpoint error:', error);
      sendOAuthError(res, 500, 'server_error', 'An internal error occurred');
    }
  });
}
