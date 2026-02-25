import crypto from 'crypto';
import { validateClientCredentials, findClientById, loadOAuthClients } from '../utils/oauthClientManager.js';
import { generateOAuthToken, introspectOAuthToken } from '../utils/oauthTokenService.js';
import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { consumeCode } from '../utils/authorizationCodeStore.js';
import { verifyCodeChallenge } from '../utils/pkceUtils.js';
import { generateJwt, verifyJwt } from '../utils/tokenService.js';
import {
  generateRefreshToken,
  storeRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken
} from '../utils/refreshTokenStore.js';

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
  logger.info(`[OAuth] Error response | error=${error} | description=${description}`);
  res.status(status).json({
    error: error,
    error_description: description
  });
}

export default function registerOAuthRoutes(app) {
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
  app.post(buildServerPath('/api/oauth/token'), async (req, res) => {
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

      const supportedGrants = ['client_credentials', 'authorization_code', 'refresh_token'];
      if (!supportedGrants.includes(sanitizedGrantType)) {
        return sendOAuthError(
          res,
          400,
          'unsupported_grant_type',
          `Unsupported grant type. Supported: ${supportedGrants.join(', ')}`
        );
      }

      // --- authorization_code grant ---
      if (sanitizedGrantType === 'authorization_code') {
        const { code, redirect_uri, code_verifier } = req.body;

        let sanitizedCode, sanitizedRedirectUri, sanitizedCodeVerifier;
        try {
          sanitizedCode = sanitizeOAuthInput(code, 'code', 1024);
          sanitizedRedirectUri = sanitizeOAuthInput(redirect_uri, 'redirect_uri', 2048);
          sanitizedCodeVerifier = sanitizeOAuthInput(code_verifier, 'code_verifier', 128);
        } catch (error) {
          return sendOAuthError(res, 400, 'invalid_request', error.message);
        }

        if (!sanitizedCode) {
          return sendOAuthError(res, 400, 'invalid_request', 'code is required');
        }
        if (!sanitizedRedirectUri) {
          return sendOAuthError(res, 400, 'invalid_request', 'redirect_uri is required');
        }

        // Consume the authorization code (single-use)
        const codeData = consumeCode(sanitizedCode);
        if (!codeData) {
          return sendOAuthError(
            res,
            400,
            'invalid_grant',
            'Authorization code is invalid or expired'
          );
        }

        // Validate client
        const authCodeClientsFilePath =
          oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        const authCodeClientsConfig = loadOAuthClients(authCodeClientsFilePath);
        const authClient = findClientById(
          authCodeClientsConfig,
          sanitizedClientId || codeData.clientId
        );

        if (!authClient) {
          return sendOAuthError(res, 401, 'invalid_client', 'Client not found');
        }

        // Confidential clients must authenticate with client_secret
        if (authClient.clientType !== 'public') {
          if (!sanitizedClientId || !sanitizedClientSecret) {
            return sendOAuthError(
              res,
              401,
              'invalid_client',
              'client_id and client_secret are required for confidential clients'
            );
          }
          const validatedClient = await validateClientCredentials(
            sanitizedClientId,
            sanitizedClientSecret,
            authCodeClientsFilePath
          );
          if (!validatedClient) {
            return sendOAuthError(res, 401, 'invalid_client', 'Invalid client credentials');
          }
        }

        // Verify client_id matches the code
        const effectiveClientId = sanitizedClientId || codeData.clientId;
        if (codeData.clientId !== effectiveClientId) {
          return sendOAuthError(res, 400, 'invalid_grant', 'client_id mismatch');
        }

        // Verify redirect_uri matches
        if (codeData.redirectUri !== sanitizedRedirectUri) {
          return sendOAuthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
        }

        // Verify PKCE if code_challenge was stored
        if (codeData.codeChallenge) {
          if (!sanitizedCodeVerifier) {
            return sendOAuthError(res, 400, 'invalid_request', 'code_verifier is required');
          }
          const pkceValid = verifyCodeChallenge(
            sanitizedCodeVerifier,
            codeData.codeChallenge,
            codeData.codeChallengeMethod || 'S256'
          );
          if (!pkceValid) {
            return sendOAuthError(res, 400, 'invalid_grant', 'PKCE verification failed');
          }
        } else if (authClient.clientType === 'public') {
          // Public clients must always use PKCE
          return sendOAuthError(res, 400, 'invalid_request', 'PKCE is required for public clients');
        }

        // Build the user object to embed in the JWT payload
        const userForAuthCode = {
          id: codeData.userId,
          name: codeData.userName || codeData.userId,
          email: codeData.userEmail || '',
          groups: codeData.userGroups || [],
          provider: 'oauth'
        };

        const platform = configCache.getPlatform() || {};
        const authCodeExpiresInMinutes = authClient.tokenExpirationMinutes || 60;

        const { token: accessToken, expiresIn: authCodeExpiresIn } = generateJwt(userForAuthCode, {
          authMode: 'oauth_authorization_code',
          expiresInMinutes: authCodeExpiresInMinutes,
          additionalClaims: {
            client_id: codeData.clientId,
            scopes: codeData.scopes || [],
            nonce: codeData.nonce || undefined,
            aud: codeData.clientId
          }
        });

        // Generate OIDC id_token with at_hash binding to the access token
        const { token: idToken } = generateJwt(userForAuthCode, {
          authMode: 'oauth_authorization_code',
          expiresInMinutes: authCodeExpiresInMinutes,
          additionalClaims: {
            client_id: codeData.clientId,
            scopes: codeData.scopes || [],
            nonce: codeData.nonce || undefined,
            aud: codeData.clientId,
            // at_hash: left half of SHA-256 of access token, base64url-encoded (OIDC Core 3.3.2.11)
            at_hash: crypto
              .createHash('sha256')
              .update(accessToken)
              .digest('base64url')
              .substring(0, 22)
          }
        });

        const authCodeResponse = {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: authCodeExpiresIn,
          scope: (codeData.scopes || []).join(' '),
          id_token: idToken
        };

        // Issue refresh token only if the client declares refresh_token grant support
        if ((authClient.grantTypes || []).includes('refresh_token')) {
          const newRefreshToken = generateRefreshToken();
          await storeRefreshToken(
            newRefreshToken,
            {
              clientId: codeData.clientId,
              userId: codeData.userId,
              userEmail: codeData.userEmail || '',
              userName: codeData.userName || '',
              userGroups: codeData.userGroups || [],
              scopes: codeData.scopes || []
            },
            platform.oauth?.refreshTokenExpirationDays || 30
          );
          authCodeResponse.refresh_token = newRefreshToken;
        }

        logger.info(
          `[OAuth] Authorization code exchanged | client=${codeData.clientId} | user=${codeData.userId}`
        );
        return res.json(authCodeResponse);
      }

      // --- refresh_token grant ---
      if (sanitizedGrantType === 'refresh_token') {
        const { refresh_token } = req.body;
        let sanitizedRefreshToken;
        try {
          sanitizedRefreshToken = sanitizeOAuthInput(refresh_token, 'refresh_token', 256);
        } catch (error) {
          return sendOAuthError(res, 400, 'invalid_request', error.message);
        }

        if (!sanitizedRefreshToken) {
          return sendOAuthError(res, 400, 'invalid_request', 'refresh_token is required');
        }

        // Consume the token (single-use rotation – deletes the entry)
        const tokenData = await consumeRefreshToken(sanitizedRefreshToken);
        if (!tokenData) {
          return sendOAuthError(
            res,
            400,
            'invalid_grant',
            'Refresh token is invalid, expired, or already used'
          );
        }

        // Validate client still exists and is active
        const refreshClientsFilePath =
          oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        const refreshClientsConfig = loadOAuthClients(refreshClientsFilePath);
        const refreshClient = findClientById(refreshClientsConfig, tokenData.clientId);

        if (!refreshClient || !refreshClient.active) {
          return sendOAuthError(res, 401, 'invalid_client', 'Client not found or suspended');
        }

        // Build user object for the new access token
        const userForRefresh = {
          id: tokenData.userId,
          name: tokenData.userName || tokenData.userId,
          email: tokenData.userEmail || '',
          groups: tokenData.userGroups || [],
          provider: 'oauth'
        };

        const refreshExpiresInMinutes = refreshClient.tokenExpirationMinutes || 60;
        const { token: newAccessToken, expiresIn: newExpiresIn } = generateJwt(userForRefresh, {
          authMode: 'oauth_authorization_code',
          expiresInMinutes: refreshExpiresInMinutes,
          additionalClaims: {
            client_id: tokenData.clientId,
            scopes: tokenData.scopes || [],
            aud: tokenData.clientId
          }
        });

        // Rotate refresh token: issue a brand new one and persist it
        const rotatedRefreshToken = generateRefreshToken();
        const refreshPlatform = configCache.getPlatform() || {};
        await storeRefreshToken(
          rotatedRefreshToken,
          {
            clientId: tokenData.clientId,
            userId: tokenData.userId,
            userEmail: tokenData.userEmail || '',
            userName: tokenData.userName || '',
            userGroups: tokenData.userGroups || [],
            scopes: tokenData.scopes || []
          },
          refreshPlatform.oauth?.refreshTokenExpirationDays || 30
        );

        logger.info(
          `[OAuth] Refresh token rotated | client=${tokenData.clientId} | user=${tokenData.userId}`
        );
        return res.json({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: newExpiresIn,
          scope: (tokenData.scopes || []).join(' '),
          refresh_token: rotatedRefreshToken
        });
      }

      // --- client_credentials grant ---
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
        logger.info(
          `[OAuth] Token issued | client_id=${sanitizedClientId} | scopes=${tokenResponse.scope} | expires_in=${tokenResponse.expires_in} | ip=${req.ip}`
        );

        res.json(tokenResponse);
      } catch (error) {
        // Handle scope validation errors
        if (error.message.includes('Invalid scopes')) {
          return sendOAuthError(res, 400, 'invalid_scope', error.message);
        }
        throw error;
      }
    } catch (error) {
      logger.error('[OAuth] Token endpoint error:', error);
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
  app.post(buildServerPath('/api/oauth/introspect'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      // Check if OAuth is enabled
      if (!oauthConfig.enabled) {
        return sendOAuthError(res, 400, 'invalid_request', 'OAuth is not enabled on this server');
      }

      // RFC 7662 requires the introspecting party to authenticate
      // For now, we require a valid client_id/client_secret OR an admin user token
      const { client_id: introspectClientId, client_secret: introspectClientSecret } = req.body;
      const isAdminUser = req.user && req.user.isAdmin;

      if (!isAdminUser) {
        if (!introspectClientId || !introspectClientSecret) {
          return sendOAuthError(
            res,
            401,
            'invalid_client',
            'Client authentication required for token introspection'
          );
        }
        const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        const introspectingClient = await validateClientCredentials(
          introspectClientId,
          introspectClientSecret,
          clientsFilePath
        );
        if (!introspectingClient) {
          return sendOAuthError(
            res,
            401,
            'invalid_client',
            'Invalid client credentials for introspection'
          );
        }
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

      logger.info(
        `[OAuth] Token introspected | active=${introspection.active} | client_id=${introspection.client_id || 'N/A'} | ip=${req.ip}`
      );

      res.json(introspection);
    } catch (error) {
      logger.error('[OAuth] Introspection endpoint error:', error);
      sendOAuthError(res, 500, 'server_error', 'An internal error occurred');
    }
  });

  /**
   * @swagger
   * /api/oauth/revoke:
   *   post:
   *     summary: OAuth 2.0 token revocation endpoint (RFC 7009)
   *     description: |
   *       Revoke a refresh token so it can no longer be used. Per RFC 7009 the
   *       server always responds with HTTP 200, whether or not the token was
   *       found, to avoid leaking token existence information.
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
   *                 description: Refresh token to revoke
   *     responses:
   *       200:
   *         description: Token revoked (or was already absent)
   *       400:
   *         description: Invalid request
   */
  app.post(buildServerPath('/api/oauth/revoke'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return sendOAuthError(res, 400, 'invalid_request', 'OAuth is not enabled on this server');
      }

      const { token } = req.body;

      let sanitizedToken;
      try {
        sanitizedToken = sanitizeOAuthInput(token, 'token', 10000);
      } catch (error) {
        return sendOAuthError(res, 400, 'invalid_request', error.message);
      }

      if (!sanitizedToken) {
        return sendOAuthError(res, 400, 'invalid_request', 'token is required');
      }

      // Attempt to revoke as a refresh token. Per RFC 7009 §2.2 the response is
      // always 200 so we do not surface whether the token existed.
      await revokeRefreshToken(sanitizedToken);

      logger.info(`[OAuth] Revocation request processed | ip=${req.ip}`);
      res.status(200).json({ revoked: true });
    } catch (error) {
      logger.error('[OAuth] Revocation endpoint error:', error);
      sendOAuthError(res, 500, 'server_error', 'An internal error occurred');
    }
  });

  /**
   * @swagger
   * /api/oauth/userinfo:
   *   get:
   *     summary: OIDC UserInfo endpoint
   *     description: |
   *       Returns claims about the authenticated user. Requires a valid Bearer
   *       access token obtained via the authorization_code grant. Client
   *       credentials tokens are rejected with `insufficient_scope`.
   *     tags:
   *       - OAuth
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: User claims
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 sub:
   *                   type: string
   *                   description: Subject (user identifier)
   *                 name:
   *                   type: string
   *                 email:
   *                   type: string
   *                 groups:
   *                   type: array
   *                   items:
   *                     type: string
   *       401:
   *         description: Missing or invalid Bearer token
   *       403:
   *         description: Token is not a user-delegated token
   */
  app.get(buildServerPath('/api/oauth/userinfo'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'OAuth is not enabled' });
      }

      // Extract Bearer token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res
          .status(401)
          .json({ error: 'invalid_token', error_description: 'Bearer token required' });
      }

      const token = authHeader.substring(7);
      const decoded = verifyJwt(token);

      if (!decoded || !decoded.sub) {
        return res
          .status(401)
          .json({ error: 'invalid_token', error_description: 'Token is invalid or expired' });
      }

      // Only user-delegated tokens (authorization_code) can access userinfo.
      // Client credentials tokens have no associated user and must be rejected.
      if (decoded.authMode !== 'oauth_authorization_code') {
        return res.status(403).json({
          error: 'insufficient_scope',
          error_description: 'UserInfo endpoint requires user-delegated token'
        });
      }

      const userInfo = {
        sub: decoded.sub,
        name: decoded.name,
        email: decoded.email,
        groups: decoded.groups || []
      };

      logger.info(
        `[OAuth] UserInfo served | sub=${decoded.sub} | client=${decoded.client_id || 'unknown'}`
      );
      res.json(userInfo);
    } catch (error) {
      logger.error('[OAuth] UserInfo endpoint error:', error);
      res.status(500).json({ error: 'server_error', error_description: 'An internal error occurred' });
    }
  });
}
