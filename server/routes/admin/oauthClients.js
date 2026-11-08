// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  createOAuthClient,
  updateOAuthClient,
  deleteOAuthClient,
  deleteUnusedDynamicClients,
  rotateClientSecret,
  listOAuthClients,
  findClientById,
  loadOAuthClients
} from '../../utils/oauthClientManager.js';
import { generateStaticApiKey } from '../../utils/oauthTokenService.js';
import { countByClient } from '../../services/oauth/ConnectionService.js';
import { listCimdClientRows } from '../../services/oauth/CimdGovernanceService.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import configCache from '../../configCache.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { logAudit } from '../../services/AuditLogService.js';
import { oauthClientsFile } from '../../utils/contentsPath.js';
import { sendCreated, segment } from '../../utils/created.js';

/**
 * The PEM public key the JWTs are signed with.
 *
 * @returns {Promise<string>}
 * @throws {ServiceError} `BAD_REQUEST` unless the algorithm is RS256, `NOT_FOUND` without a key pair
 */
async function loadRsaPublicKey() {
  const platform = configCache.getPlatform() || {};
  const jwtAlgorithm = platform.jwt?.algorithm || 'RS256';

  if (jwtAlgorithm !== 'RS256') {
    throw new ServiceError(
      'BAD_REQUEST',
      'Public key is only available for RS256 algorithm. Current algorithm: ' + jwtAlgorithm
    );
  }

  const tokenStorageService = (await import('../../services/TokenStorageService.js')).default;
  const keyPair = tokenStorageService.getRSAKeyPair();

  if (!keyPair || !keyPair.publicKey) {
    throw new ServiceError('NOT_FOUND', 'RSA public key not available');
  }
  return keyPair.publicKey;
}

/**
 * Admin routes for OAuth client management
 * All routes require admin authentication
 */

export default function registerAdminOAuthRoutes(app) {
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
    const platform = configCache.getPlatform() || {};
    const oauthConfig = platform.oauth || {};

    if (!oauthConfig.enabled?.clients) {
      throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
    }

    const clientsFilePath = oauthClientsFile(oauthConfig);
    const clients = listOAuthClients(clientsFilePath);

    // How many people are actually connected through each client. A row with
    // zero is a client nobody uses; a dynamic row with many is one worth
    // keeping. Neither is visible from the client record alone.
    const counts = countByClient();

    res.json({
      // CIMD policy records live in the same store but are not stored
      // clients: their identity still comes from the document they publish,
      // and they are rendered from `cimdClients` below with the actions that
      // apply to them. Listing them twice would offer "rotate secret" on a
      // client that has no secret.
      clients: clients
        .filter(client => client.metadata?.cimd !== true)
        .map(client => ({
          ...client,
          connectionCount: counts[client.clientId] || 0
        })),
      // The join of the CIMD policy records and the connections that exist,
      // so a client people connect through but nobody has decided anything
      // about yet is still on the page.
      cimdClients: listCimdClientRows(platform)
    });
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
    const platform = configCache.getPlatform() || {};
    const oauthConfig = platform.oauth || {};

    if (!oauthConfig.enabled?.clients) {
      throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
    }

    const { clientId } = req.params;

    // Validate clientId
    assertValidId(clientId, 'client');

    const clientsFilePath = oauthClientsFile(oauthConfig);
    const clientsConfig = loadOAuthClients(clientsFilePath);
    const client = findClientById(clientsConfig, clientId);

    if (!client) {
      throw new ServiceError('NOT_FOUND', 'OAuth client not found');
    }

    // Remove secret from response
    const { clientSecret: _clientSecret, ...clientWithoutSecret } = client;

    res.json({ client: clientWithoutSecret });
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
   *               allowedPrompts:
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
    const platform = configCache.getPlatform() || {};
    const oauthConfig = platform.oauth || {};

    if (!oauthConfig.enabled?.clients) {
      throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
    }

    const {
      name,
      description,
      scopes,
      allowedApps,
      allowedModels,
      allowedPrompts,
      allowedGroups,
      tokenExpirationMinutes,
      metadata,
      clientType,
      grantTypes,
      redirectUris,
      postLogoutRedirectUris,
      consentRequired,
      trusted
    } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new ServiceError('BAD_REQUEST', 'Client name is required');
    }

    // Validate token expiration
    const maxExpiration = oauthConfig.maxTokenExpirationMinutes || 1440; // 24 hours default
    if (tokenExpirationMinutes && tokenExpirationMinutes > maxExpiration) {
      throw new ServiceError(
        'BAD_REQUEST',
        `Token expiration cannot exceed ${maxExpiration} minutes`
      );
    }

    const clientData = {
      name: name.trim(),
      description: description?.trim() || '',
      scopes: Array.isArray(scopes) ? scopes : [],
      // Default to ["*"] (allow all) if not specified, making it clear to admins
      allowedApps: Array.isArray(allowedApps) && allowedApps.length > 0 ? allowedApps : ['*'],
      allowedModels:
        Array.isArray(allowedModels) && allowedModels.length > 0 ? allowedModels : ['*'],
      allowedPrompts:
        Array.isArray(allowedPrompts) && allowedPrompts.length > 0 ? allowedPrompts : ['*'],
      allowedGroups: Array.isArray(allowedGroups) ? allowedGroups : [],
      tokenExpirationMinutes:
        tokenExpirationMinutes || oauthConfig.defaultTokenExpirationMinutes || 60,
      metadata: metadata || {},
      clientType: clientType || 'confidential',
      grantTypes: Array.isArray(grantTypes) ? grantTypes : ['client_credentials'],
      redirectUris: Array.isArray(redirectUris) ? redirectUris : [],
      postLogoutRedirectUris: Array.isArray(postLogoutRedirectUris) ? postLogoutRedirectUris : [],
      consentRequired: consentRequired !== false,
      trusted: trusted === true
    };

    const clientsFilePath = oauthClientsFile(oauthConfig);
    const createdBy = req.user?.id || 'admin';

    const newClient = await createOAuthClient(clientData, clientsFilePath, createdBy);

    logAudit({
      req,
      action: 'create',
      resource: 'oauthClient',
      resourceId: newClient.clientId,
      summary: `Created OAuth client "${newClient.name}"`
    });

    // Return client with plain text secret (only time it's shown)
    sendCreated(res, `/api/admin/oauth/clients/${segment(newClient.clientId)}`, {
      client: {
        clientId: newClient.clientId,
        clientSecret: newClient.clientSecret, // Plain text - only shown once
        name: newClient.name,
        description: newClient.description,
        scopes: newClient.scopes,
        allowedApps: newClient.allowedApps,
        allowedModels: newClient.allowedModels,
        allowedPrompts: newClient.allowedPrompts,
        allowedGroups: newClient.allowedGroups,
        tokenExpirationMinutes: newClient.tokenExpirationMinutes,
        active: newClient.active,
        createdAt: newClient.createdAt,
        createdBy: newClient.createdBy,
        clientType: newClient.clientType,
        grantTypes: newClient.grantTypes,
        redirectUris: newClient.redirectUris,
        postLogoutRedirectUris: newClient.postLogoutRedirectUris,
        consentRequired: newClient.consentRequired,
        trusted: newClient.trusted
      }
    });
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
    const platform = configCache.getPlatform() || {};
    const oauthConfig = platform.oauth || {};

    if (!oauthConfig.enabled?.clients) {
      throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
    }

    const { clientId } = req.params;

    // Validate clientId
    assertValidId(clientId, 'client');

    const updates = req.body;

    // Validate token expiration if provided
    if (updates.tokenExpirationMinutes) {
      const maxExpiration = oauthConfig.maxTokenExpirationMinutes || 1440;
      if (updates.tokenExpirationMinutes > maxExpiration) {
        throw new ServiceError(
          'BAD_REQUEST',
          `Token expiration cannot exceed ${maxExpiration} minutes`
        );
      }
    }

    const clientsFilePath = oauthClientsFile(oauthConfig);
    const updatedBy = req.user?.id || 'admin';

    const updatedClient = await updateOAuthClient(clientId, updates, clientsFilePath, updatedBy);

    logAudit({
      req,
      action: 'update',
      resource: 'oauthClient',
      resourceId: clientId,
      summary: `Updated OAuth client "${updatedClient.name || clientId}"`
    });

    res.json({ client: updatedClient });
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
  /**
   * @swagger
   * /api/admin/oauth/clients/dynamic:
   *   delete:
   *     summary: Remove unused dynamically registered OAuth clients
   *     description: |
   *       Deletes every client created by RFC 7591 dynamic client registration
   *       whose last use (or, for a client never used, its registration) is
   *       older than `unusedForDays`. Deleting a client invalidates the consent
   *       memory and refresh tokens of everyone who connected through it — they
   *       simply reconnect — which is why this is never done automatically.
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: unusedForDays
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           default: 90
   *     responses:
   *       200:
   *         description: Clients removed
   *       400:
   *         description: Invalid unusedForDays value, or OAuth clients are not enabled
   */
  app.delete(buildServerPath('/api/admin/oauth/clients/dynamic'), adminAuth, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    const oauthConfig = platform.oauth || {};

    if (!oauthConfig.enabled?.clients) {
      throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
    }

    const raw = req.query.unusedForDays;
    const unusedForDays = raw === undefined || raw === '' ? 90 : Number(raw);
    if (!Number.isInteger(unusedForDays) || unusedForDays < 0 || unusedForDays > 3650) {
      throw new ServiceError('BAD_REQUEST', 'unusedForDays must be an integer between 0 and 3650');
    }

    const clientsFilePath = oauthClientsFile(oauthConfig);
    const deletedBy = req.user?.id || 'admin';

    const { deleted, clientIds } = await deleteUnusedDynamicClients(
      unusedForDays,
      clientsFilePath,
      deletedBy
    );

    logAudit({
      req,
      action: 'delete',
      resource: 'oauthClient',
      resourceId: 'dynamic',
      summary: `Removed ${deleted} dynamic OAuth client(s) unused for ${unusedForDays} day(s)`
    });

    res.json({ deleted, clientIds });
  });

  app.delete(buildServerPath('/api/admin/oauth/clients/:clientId'), adminAuth, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    const oauthConfig = platform.oauth || {};

    if (!oauthConfig.enabled?.clients) {
      throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
    }

    const { clientId } = req.params;

    // Validate clientId
    assertValidId(clientId, 'client');

    const clientsFilePath = oauthClientsFile(oauthConfig);
    const deletedBy = req.user?.id || 'admin';

    await deleteOAuthClient(clientId, clientsFilePath, deletedBy);

    logAudit({
      req,
      action: 'delete',
      resource: 'oauthClient',
      resourceId: clientId,
      summary: `Deleted OAuth client ${clientId}`
    });

    res.status(204).end();
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
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled?.clients) {
        throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
      }

      const { clientId } = req.params;

      // Validate clientId
      assertValidId(clientId, 'client');

      const clientsFilePath = oauthClientsFile(oauthConfig);
      const rotatedBy = req.user?.id || 'admin';

      const result = await rotateClientSecret(clientId, clientsFilePath, rotatedBy);

      logAudit({
        req,
        action: 'update',
        resource: 'oauthClient',
        resourceId: clientId,
        summary: `Rotated client secret for ${clientId}`
      });

      res.json({
        clientId: result.clientId,
        clientSecret: result.clientSecret, // Plain text - only shown once
        rotatedAt: result.rotatedAt
      });
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
      const platform = configCache.getPlatform() || {};
      const oauthConfig = platform.oauth || {};

      if (!oauthConfig.enabled?.clients) {
        throw new ServiceError('BAD_REQUEST', 'OAuth clients are not enabled on this server');
      }

      const { clientId } = req.params;
      const { expirationDays = 365 } = req.body;

      // Validate clientId
      assertValidId(clientId, 'client');

      // Validate expiration
      if (expirationDays < 1 || expirationDays > 3650) {
        throw new ServiceError('BAD_REQUEST', 'Expiration must be between 1 and 3650 days');
      }

      const clientsFilePath = oauthClientsFile(oauthConfig);
      const clientsConfig = loadOAuthClients(clientsFilePath);
      const client = findClientById(clientsConfig, clientId);

      if (!client) {
        throw new ServiceError('NOT_FOUND', 'OAuth client not found');
      }

      if (!client.active) {
        throw new ServiceError('BAD_REQUEST', 'Cannot generate token for suspended client');
      }

      const apiKeyResult = generateStaticApiKey(client, expirationDays);

      logAudit({
        req,
        action: 'create',
        resource: 'oauthToken',
        resourceId: clientId,
        summary: `Generated static API key for ${clientId} (expires in ${expirationDays} days)`
      });

      sendCreated(res, `/api/admin/oauth/clients/${segment(clientId)}`, { ...apiKeyResult });
    }
  );

  /**
   * @swagger
   * /api/admin/oauth/public-key/pem:
   *   get:
   *     summary: Download public key in PEM format
   *     description: Download the RSA public key used for JWT signature verification in PEM format
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Public key in PEM format
   *         content:
   *           application/x-pem-file:
   *             schema:
   *               type: string
   *       400:
   *         description: OAuth not configured or wrong algorithm
   *       404:
   *         description: Public key not available
   */
  app.get(buildServerPath('/api/admin/oauth/public-key/pem'), adminAuth, async (req, res) => {
    const publicKey = await loadRsaPublicKey();

    // Set headers for file download
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="jwt-public-key.pem"');
    res.send(publicKey);
  });

  /**
   * @swagger
   * /api/admin/oauth/public-key/base64:
   *   get:
   *     summary: Download public key in base64 format
   *     description: Download the RSA public key used for JWT signature verification in base64 format (for Spring Boot configs)
   *     tags:
   *       - Admin
   *       - OAuth
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Public key in base64 format
   *         content:
   *           text/plain:
   *             schema:
   *               type: string
   *       400:
   *         description: OAuth not configured or wrong algorithm
   *       404:
   *         description: Public key not available
   */
  app.get(buildServerPath('/api/admin/oauth/public-key/base64'), adminAuth, async (req, res) => {
    const publicKey = await loadRsaPublicKey();

    // Convert PEM to base64 (remove header, footer, and newlines)
    const base64Key = publicKey
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s/g, '');

    // Set headers for text download
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="jwt-public-key-base64.txt"');
    res.send(base64Key);
  });
}
