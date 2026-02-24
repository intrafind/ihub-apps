import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import { getJwtAlgorithm } from '../utils/tokenService.js';
import logger from '../utils/logger.js';
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
      const baseUrl = getBaseUrl(req);
      const platform = configCache.getPlatform() || {};
      const algorithm = getJwtAlgorithm();
      
      // Build OpenID Connect Discovery response
      const discovery = {
        issuer: 'ihub-apps',
        jwks_uri: `${baseUrl}/.well-known/jwks.json`,
        authorization_endpoint: `${baseUrl}/api/auth/oidc`,
        token_endpoint: `${baseUrl}/api/oauth/token`,
        response_types_supported: ['token', 'code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: [algorithm],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        grant_types_supported: ['client_credentials', 'authorization_code'],
        scopes_supported: ['openid', 'profile', 'email']
      };
      
      logger.info('Served OpenID Connect Discovery', {
        component: 'WellKnown',
        algorithm,
        baseUrl
      });
      
      res.json(discovery);
    } catch (error) {
      logger.error('Error serving OpenID Connect Discovery:', {
        component: 'WellKnown',
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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
        return res.status(501).json({
          error: 'JWKS not configured',
          message: 'RSA key pair not initialized. Server may need to be restarted.'
        });
      }
      
      // Convert PEM to JWK
      const jwk = await pemToJwk(keyPair.publicKey);
      
      // Add standard JWK fields
      jwk.use = 'sig';
      jwk.kid = crypto.createHash('sha256').update(keyPair.publicKey).digest('hex').substring(0, 16);
      jwk.alg = 'RS256';
      
      logger.info('Served JWKS endpoint', {
        component: 'WellKnown',
        algorithm: 'RS256',
        kid: jwk.kid
      });
      
      res.json({ keys: [jwk] });
    } catch (error) {
      logger.error('Error serving JWKS:', {
        component: 'WellKnown',
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
