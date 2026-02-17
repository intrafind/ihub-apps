import {
  createOAuthClient,
  updateOAuthClient,
  deleteOAuthClient,
  rotateClientSecret,
  listOAuthClients,
  findClientById,
  loadOAuthClients
} from '../../utils/oauthClientManager.js';
import { generateStaticApiKey, introspectOAuthToken } from '../../utils/oauthTokenService.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import configCache from '../../configCache.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

/**
 * Admin routes for OAuth client management
 * All routes require admin authentication
 */

export default function registerAdminOAuthRoutes(app, basePath = '') {
  /**
   * @swagger
   * /api/admin/oauth/clients:
   *   get:
   *     summary: List all OAuth clients
   *     description: Get a list of all OAuth clients (secrets excluded)
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: List of OAuth clients
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 clients:
   *                   type: array
   *                   items:
   *                     type: object
   *       401:
   *         description: Unauthorized
   */
  app.get(buildServerPath('/api/admin/oauth/clients'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).json({
          success: false,
          error: 'OAuth is not enabled on this server'
        });
      }

      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const clients = listOAuthClients(clientsFilePath);

      res.json({
        success: true,
        clients
      });
    } catch (error) {
      logger.error('[OAuth Admin] List clients error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list OAuth clients'
      });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/clients/{clientId}:
   *   get:
   *     summary: Get OAuth client details
   *     description: Get detailed information about a specific OAuth client
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Client details
   *       404:
   *         description: Client not found
   */
  app.get(buildServerPath('/api/admin/oauth/clients/:clientId'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).json({
          success: false,
          error: 'OAuth is not enabled on this server'
        });
      }

      const { clientId } = req.params;

      // Validate clientId
      validateIdForPath(clientId, 'clientId');

      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const clientsConfig = loadOAuthClients(clientsFilePath);
      const client = findClientById(clientsConfig, clientId);

      if (!client) {
        return res.status(404).json({
          success: false,
          error: 'OAuth client not found'
        });
      }

      // Remove secret from response
      const { clientSecret: _clientSecret, ...clientWithoutSecret } = client;

      res.json({
        success: true,
        client: clientWithoutSecret
      });
    } catch (error) {
      logger.error('[OAuth Admin] Get client error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get OAuth client'
      });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/clients:
   *   post:
   *     summary: Create OAuth client
   *     description: Create a new OAuth client with generated credentials
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *             properties:
   *               name:
   *                 type: string
   *               description:
   *                 type: string
   *               scopes:
   *                 type: array
   *                 items:
   *                   type: string
   *               allowedApps:
   *                 type: array
   *                 items:
   *                   type: string
   *               allowedModels:
   *                 type: array
   *                 items:
   *                   type: string
   *               tokenExpirationMinutes:
   *                 type: number
   *     responses:
   *       201:
   *         description: Client created successfully
   *       400:
   *         description: Invalid request
   */
  app.post(buildServerPath('/api/admin/oauth/clients'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).json({
          success: false,
          error: 'OAuth is not enabled on this server'
        });
      }

      const {
        name,
        description,
        scopes,
        allowedApps,
        allowedModels,
        tokenExpirationMinutes,
        metadata
      } = req.body;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Client name is required'
        });
      }

      // Validate token expiration
      const maxExpiration = oauthConfig.maxTokenExpirationMinutes || 1440; // 24 hours default
      if (tokenExpirationMinutes && tokenExpirationMinutes > maxExpiration) {
        return res.status(400).json({
          success: false,
          error: `Token expiration cannot exceed ${maxExpiration} minutes`
        });
      }

      const clientData = {
        name: name.trim(),
        description: description?.trim() || '',
        scopes: Array.isArray(scopes) ? scopes : [],
        allowedApps: Array.isArray(allowedApps) ? allowedApps : [],
        allowedModels: Array.isArray(allowedModels) ? allowedModels : [],
        tokenExpirationMinutes:
          tokenExpirationMinutes || oauthConfig.defaultTokenExpirationMinutes || 60,
        metadata: metadata || {}
      };

      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const createdBy = req.user?.id || 'admin';

      const newClient = await createOAuthClient(clientData, clientsFilePath, createdBy);

      // Return client with plain text secret (only time it's shown)
      res.status(201).json({
        success: true,
        message:
          'OAuth client created successfully. Save the client_secret - it will not be shown again.',
        client: {
          clientId: newClient.clientId,
          clientSecret: newClient.clientSecret, // Plain text - only shown once
          name: newClient.name,
          description: newClient.description,
          scopes: newClient.scopes,
          allowedApps: newClient.allowedApps,
          allowedModels: newClient.allowedModels,
          tokenExpirationMinutes: newClient.tokenExpirationMinutes,
          active: newClient.active,
          createdAt: newClient.createdAt,
          createdBy: newClient.createdBy
        }
      });
    } catch (error) {
      logger.error('[OAuth Admin] Create client error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create OAuth client'
      });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/clients/{clientId}:
   *   put:
   *     summary: Update OAuth client
   *     description: Update an existing OAuth client's configuration
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Client updated successfully
   *       404:
   *         description: Client not found
   */
  app.put(buildServerPath('/api/admin/oauth/clients/:clientId'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).json({
          success: false,
          error: 'OAuth is not enabled on this server'
        });
      }

      const { clientId } = req.params;

      // Validate clientId
      validateIdForPath(clientId, 'clientId');

      const updates = req.body;

      // Validate token expiration if provided
      if (updates.tokenExpirationMinutes) {
        const maxExpiration = oauthConfig.maxTokenExpirationMinutes || 1440;
        if (updates.tokenExpirationMinutes > maxExpiration) {
          return res.status(400).json({
            success: false,
            error: `Token expiration cannot exceed ${maxExpiration} minutes`
          });
        }
      }

      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const updatedBy = req.user?.id || 'admin';

      const updatedClient = await updateOAuthClient(clientId, updates, clientsFilePath, updatedBy);

      res.json({
        success: true,
        message: 'OAuth client updated successfully',
        client: updatedClient
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }
      logger.error('[OAuth Admin] Update client error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update OAuth client'
      });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/clients/{clientId}:
   *   delete:
   *     summary: Delete OAuth client
   *     description: Permanently delete an OAuth client
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Client deleted successfully
   *       404:
   *         description: Client not found
   */
  app.delete(buildServerPath('/api/admin/oauth/clients/:clientId'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled) {
        return res.status(400).json({
          success: false,
          error: 'OAuth is not enabled on this server'
        });
      }

      const { clientId } = req.params;

      // Validate clientId
      validateIdForPath(clientId, 'clientId');

      const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
      const deletedBy = req.user?.id || 'admin';

      await deleteOAuthClient(clientId, clientsFilePath, deletedBy);

      res.json({
        success: true,
        message: 'OAuth client deleted successfully'
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }
      logger.error('[OAuth Admin] Delete client error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete OAuth client'
      });
    }
  });

  /**
   * @swagger
   * /api/admin/oauth/clients/{clientId}/rotate-secret:
   *   post:
   *     summary: Rotate client secret
   *     description: Generate a new client secret for an OAuth client
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Secret rotated successfully
   *       404:
   *         description: Client not found
   */
  app.post(
    buildServerPath('/api/admin/oauth/clients/:clientId/rotate-secret'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform() || {};
        const oauthConfig = platform.oauth || {};

        if (!oauthConfig.enabled) {
          return res.status(400).json({
            success: false,
            error: 'OAuth is not enabled on this server'
          });
        }

        const { clientId } = req.params;

        // Validate clientId
        validateIdForPath(clientId, 'clientId');

        const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        const rotatedBy = req.user?.id || 'admin';

        const result = await rotateClientSecret(clientId, clientsFilePath, rotatedBy);

        res.json({
          success: true,
          message:
            'Client secret rotated successfully. Save the new secret - it will not be shown again.',
          clientId: result.clientId,
          clientSecret: result.clientSecret, // Plain text - only shown once
          rotatedAt: result.rotatedAt
        });
      } catch (error) {
        if (error.message.includes('not found')) {
          return res.status(404).json({
            success: false,
            error: error.message
          });
        }
        logger.error('[OAuth Admin] Rotate secret error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to rotate client secret'
        });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/oauth/clients/{clientId}/generate-token:
   *   post:
   *     summary: Generate static API key
   *     description: Generate a long-lived static API key for clients that don't support OAuth flow
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               expirationDays:
   *                 type: number
   *                 description: "Token expiration in days (default: 365)"
   *     responses:
   *       200:
   *         description: API key generated successfully
   *       404:
   *         description: Client not found
   */
  app.post(
    buildServerPath('/api/admin/oauth/clients/:clientId/generate-token'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform() || {};
        const oauthConfig = platform.oauth || {};

        if (!oauthConfig.enabled) {
          return res.status(400).json({
            success: false,
            error: 'OAuth is not enabled on this server'
          });
        }

        const { clientId } = req.params;
        const { expirationDays = 365 } = req.body;

        // Validate clientId
        validateIdForPath(clientId, 'clientId');

        // Validate expiration
        if (expirationDays < 1 || expirationDays > 3650) {
          return res.status(400).json({
            success: false,
            error: 'Expiration must be between 1 and 3650 days'
          });
        }

        const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        const clientsConfig = loadOAuthClients(clientsFilePath);
        const client = findClientById(clientsConfig, clientId);

        if (!client) {
          return res.status(404).json({
            success: false,
            error: 'OAuth client not found'
          });
        }

        if (!client.active) {
          return res.status(400).json({
            success: false,
            error: 'Cannot generate token for suspended client'
          });
        }

        const apiKeyResult = generateStaticApiKey(client, expirationDays);

        res.json({
          success: true,
          message:
            'Static API key generated successfully. Save this key - it will not be shown again.',
          ...apiKeyResult
        });
      } catch (error) {
        logger.error('[OAuth Admin] Generate token error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to generate static API key'
        });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/oauth/clients/{clientId}/introspect-token:
   *   post:
   *     summary: Introspect client token
   *     description: Introspect a token to check its validity and claims
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: clientId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
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
   *     responses:
   *       200:
   *         description: Token introspection result
   */
  app.post(
    buildServerPath('/api/admin/oauth/clients/:clientId/introspect-token'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform() || {};
        const oauthConfig = platform.oauth || {};

        if (!oauthConfig.enabled) {
          return res.status(400).json({
            success: false,
            error: 'OAuth is not enabled on this server'
          });
        }

        const { clientId } = req.params;
        const { token } = req.body;

        // Validate clientId
        validateIdForPath(clientId, 'clientId');

        if (!token || typeof token !== 'string') {
          return res.status(400).json({
            success: false,
            error: 'Token is required'
          });
        }

        const introspection = introspectOAuthToken(token);

        // Verify token belongs to this client
        if (introspection.active && introspection.client_id !== clientId) {
          return res.status(400).json({
            success: false,
            error: 'Token does not belong to this client'
          });
        }

        res.json({
          success: true,
          introspection
        });
      } catch (error) {
        logger.error('[OAuth Admin] Introspect token error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to introspect token'
        });
      }
    }
  );
}
