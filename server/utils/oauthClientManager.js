import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { atomicWriteJSON } from './atomicWrite.js';
import configCache from '../configCache.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load OAuth clients from the OAuth clients file
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @returns {Object} OAuth clients configuration
 */
export function loadOAuthClients(clientsFilePath) {
  try {
    // Convert file path to cache key format
    let cacheKey;
    if (clientsFilePath.startsWith('contents/')) {
      cacheKey = clientsFilePath.substring('contents/'.length);
    } else {
      cacheKey = path.relative(
        path.join(__dirname, '../../'),
        path.isAbsolute(clientsFilePath)
          ? clientsFilePath
          : path.join(__dirname, '../../', clientsFilePath)
      );
      if (cacheKey.startsWith('contents/')) {
        cacheKey = cacheKey.substring('contents/'.length);
      }
    }

    // Try to get from cache first
    const cached = configCache.get(cacheKey);
    if (cached && cached.data && cached.data.clients !== undefined) {
      return cached.data;
    }

    // Fallback to file system if cache miss
    logger.warn('OAuth clients configuration not found in cache, attempting file system fallback', {
      component: 'OAuthClientManager',
      cacheKey
    });

    const fullPath = path.isAbsolute(clientsFilePath)
      ? clientsFilePath
      : path.join(__dirname, '../../', clientsFilePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      logger.warn('OAuth clients file not found, creating empty structure', {
        component: 'OAuthClientManager',
        fullPath
      });
      const emptyConfig = {
        clients: {},
        metadata: { version: '1.0.0', lastUpdated: new Date().toISOString() }
      };

      // Cache the empty structure
      configCache.setCacheEntry(cacheKey, emptyConfig);
      return emptyConfig;
    }

    // Read from file system
    const fileData = fs.readFileSync(fullPath, 'utf8');
    const clientsConfig = JSON.parse(fileData);

    // Validate the loaded data
    if (!clientsConfig || typeof clientsConfig !== 'object') {
      throw new Error('Invalid OAuth clients configuration format');
    }

    // Ensure clients object exists
    if (!clientsConfig.clients || typeof clientsConfig.clients !== 'object') {
      clientsConfig.clients = {};
    }

    // Ensure metadata exists
    if (!clientsConfig.metadata) {
      clientsConfig.metadata = { version: '1.0.0', lastUpdated: new Date().toISOString() };
    }

    // Update cache with file data
    configCache.setCacheEntry(cacheKey, clientsConfig);

    return clientsConfig;
  } catch (error) {
    logger.error('Could not load OAuth clients configuration', {
      component: 'OAuthClientManager',
      error
    });

    // Return safe empty structure as last resort
    const safeConfig = {
      clients: {},
      metadata: { version: '1.0.0', lastUpdated: new Date().toISOString(), error: error.message }
    };

    logger.warn('Returning safe empty OAuth clients structure due to error', {
      component: 'OAuthClientManager'
    });
    return safeConfig;
  }
}

/**
 * Save OAuth clients to the OAuth clients file
 * @param {Object} clientsConfig - OAuth clients configuration object
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 */
export async function saveOAuthClients(clientsConfig, clientsFilePath) {
  try {
    const fullPath = path.isAbsolute(clientsFilePath)
      ? clientsFilePath
      : path.join(__dirname, '../../', clientsFilePath);

    // Update metadata
    if (!clientsConfig.metadata) {
      clientsConfig.metadata = { version: '1.0.0' };
    }
    clientsConfig.metadata.lastUpdated = new Date().toISOString();

    // Write to file atomically
    await atomicWriteJSON(fullPath, clientsConfig);

    // Update cache with the new data
    let cacheKey;
    if (clientsFilePath.startsWith('contents/')) {
      cacheKey = clientsFilePath.substring('contents/'.length);
    } else {
      cacheKey = path.relative(path.join(__dirname, '../../'), fullPath);
      if (cacheKey.startsWith('contents/')) {
        cacheKey = cacheKey.substring('contents/'.length);
      }
    }

    configCache.setCacheEntry(cacheKey, clientsConfig);
  } catch (error) {
    logger.error('Could not save OAuth clients configuration', {
      component: 'OAuthClientManager',
      error
    });
    throw error;
  }
}

/**
 * Generate a client ID from client name
 * @param {string} name - Client name
 * @returns {string} Client ID
 */
export function generateClientId(name) {
  // Sanitize name: lowercase, replace spaces and special chars with underscores
  const sanitizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, ''); // Remove leading/trailing underscores // lgtm[js/polynomial-redos]

  // Generate short UUID (first 8 characters)
  const shortUuid = uuidv4().split('-')[0];

  return `client_${sanitizedName}_${shortUuid}`;
}

/**
 * Generate a random client secret
 * @returns {Promise<string>} Client secret (plain text - only shown once)
 */
export async function generateClientSecret() {
  // Generate a secure random secret (32 bytes = 64 hex characters)
  const crypto = await import('crypto');
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a client secret using bcrypt
 * @param {string} secret - Plain text secret
 * @returns {Promise<string>} Hashed secret
 */
export async function hashClientSecret(secret) {
  const saltRounds = 10;
  return bcrypt.hash(secret, saltRounds);
}

/**
 * Verify a client secret against a hash
 * @param {string} secret - Plain text secret
 * @param {string} hash - Hashed secret
 * @returns {Promise<boolean>} True if secret matches
 */
export async function verifyClientSecret(secret, hash) {
  return bcrypt.compare(secret, hash);
}

/**
 * Find OAuth client by client ID
 * @param {Object} clientsConfig - OAuth clients configuration
 * @param {string} clientId - Client ID
 * @returns {Object|null} Client object or null if not found
 */
export function findClientById(clientsConfig, clientId) {
  const clients = clientsConfig.clients || {};
  const client = clients[clientId];
  return client ? { ...client } : null;
}

/**
 * Create a new OAuth client
 * @param {Object} clientData - Client data
 * @param {string} clientData.name - Client name
 * @param {string} clientData.description - Client description
 * @param {Array<string>} clientData.scopes - Allowed scopes
 * @param {Array<string>} clientData.allowedApps - Allowed app IDs
 * @param {Array<string>} clientData.allowedModels - Allowed model IDs
 * @param {number} clientData.tokenExpirationMinutes - Token expiration in minutes
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @param {string} createdBy - User ID who created this client
 * @returns {Promise<Object>} Created client with plain text secret (only time it's shown)
 */
export async function createOAuthClient(clientData, clientsFilePath, createdBy) {
  const clientsConfig = loadOAuthClients(clientsFilePath);

  // Generate client ID from name and secret
  const clientId = generateClientId(clientData.name);
  const clientSecret = await generateClientSecret();
  const hashedSecret = await hashClientSecret(clientSecret);

  const now = new Date().toISOString();

  const newClient = {
    id: clientId,
    clientId: clientId,
    name: clientData.name,
    description: clientData.description || '',
    clientSecret: hashedSecret,
    scopes: clientData.scopes || [],
    allowedApps: clientData.allowedApps || [],
    allowedModels: clientData.allowedModels || [],
    allowedPrompts: clientData.allowedPrompts || [],
    // allowedGroups: optional allowlist of internal iHub group IDs. When set
    //   (non-empty array) the user authenticating via this client must be a
    //   member of at least one of these groups; otherwise the authorize flow
    //   rejects the request with access_denied. Empty array (default) means
    //   any group is acceptable.
    allowedGroups: clientData.allowedGroups || [],
    tokenExpirationMinutes: clientData.tokenExpirationMinutes || 60,
    active: true,
    createdAt: now,
    createdBy: createdBy || 'system',
    lastUsed: null,
    lastRotated: now,
    metadata: clientData.metadata || {},
    // Authorization Code Flow fields
    // clientType: 'confidential' | 'public'
    //   confidential – can keep a client secret (server-side apps, daemons)
    //   public       – cannot keep a secret (SPAs, native apps); must use PKCE
    clientType: clientData.clientType || 'confidential',
    // grantTypes: which OAuth 2.0 grant types this client may use.
    //   Allowed values: 'client_credentials', 'authorization_code', 'refresh_token'
    grantTypes: clientData.grantTypes || ['client_credentials'],
    // redirectUris: explicit allowlist of redirect_uri values accepted during
    //   the authorization code flow. An empty array means the flow is disabled.
    redirectUris: clientData.redirectUris || [],
    // postLogoutRedirectUris: allowlist of URIs the server may redirect to
    //   after the user completes an RP-initiated logout.
    postLogoutRedirectUris: clientData.postLogoutRedirectUris || [],
    // consentRequired: when true the user sees a consent screen before the
    //   server issues an authorization code (overrides the platform default
    //   per client).
    consentRequired: clientData.consentRequired !== false,
    // trusted: when true the client is pre-approved and bypasses the consent
    //   screen even when consentRequired is true at the platform level.
    trusted: clientData.trusted || false
  };

  clientsConfig.clients[clientId] = newClient;
  await saveOAuthClients(clientsConfig, clientsFilePath);

  // Log client creation
  logger.info(
    `[OAuth] Client created | client_id=${clientId} | name=${clientData.name} | created_by=${createdBy}`
  );

  // Return client with plain text secret (only time it's shown)
  return {
    ...newClient,
    clientSecret: clientSecret, // Plain text secret
    clientSecretHash: hashedSecret // Also include hash for verification
  };
}

/**
 * Update an OAuth client
 * @param {string} clientId - Client ID
 * @param {Object} updates - Updates to apply
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @param {string} updatedBy - User ID who updated this client
 * @returns {Promise<Object>} Updated client (without secret)
 */
export async function updateOAuthClient(clientId, updates, clientsFilePath, updatedBy) {
  if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
    throw new Error(`Invalid client ID: ${clientId}`);
  }
  const clientsConfig = loadOAuthClients(clientsFilePath);
  const client = clientsConfig.clients[clientId];

  if (!client) {
    throw new Error(`OAuth client not found: ${clientId}`);
  }

  // Apply updates (excluding clientId, clientSecret, id).
  // Authorization Code Flow fields (clientType, grantTypes, redirectUris,
  // postLogoutRedirectUris, consentRequired, trusted) are intentionally
  // included so the admin UI can manage them without rotating the secret.
  const allowedUpdates = [
    'name',
    'description',
    'scopes',
    'allowedApps',
    'allowedModels',
    'allowedPrompts',
    'allowedGroups',
    'tokenExpirationMinutes',
    'active',
    'metadata',
    'clientType',
    'grantTypes',
    'redirectUris',
    'postLogoutRedirectUris',
    'consentRequired',
    'trusted'
  ];

  for (const key of allowedUpdates) {
    if (updates[key] !== undefined) {
      client[key] = updates[key];
    }
  }

  client.updatedAt = new Date().toISOString();
  client.updatedBy = updatedBy || 'system';

  await saveOAuthClients(clientsConfig, clientsFilePath);

  // Log client update
  logger.info(
    `[OAuth] Client updated | client_id=${clientId} | updated_by=${updatedBy} | changes=${Object.keys(updates).join(',')}`
  );

  // Return without secret
  // eslint-disable-next-line no-unused-vars
  const { clientSecret, ...clientWithoutSecret } = client;
  return clientWithoutSecret;
}

/**
 * Rotate OAuth client secret
 * @param {string} clientId - Client ID
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @param {string} rotatedBy - User ID who rotated the secret
 * @returns {Promise<Object>} New client secret (plain text - only time it's shown)
 */
export async function rotateClientSecret(clientId, clientsFilePath, rotatedBy) {
  if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
    throw new Error(`Invalid client ID: ${clientId}`);
  }
  const clientsConfig = loadOAuthClients(clientsFilePath);
  const client = clientsConfig.clients[clientId];

  if (!client) {
    throw new Error(`OAuth client not found: ${clientId}`);
  }

  // Generate new secret
  const newSecret = await generateClientSecret();
  const hashedSecret = await hashClientSecret(newSecret);

  // Update client
  client.clientSecret = hashedSecret;
  client.lastRotated = new Date().toISOString();
  client.rotatedBy = rotatedBy || 'system';

  await saveOAuthClients(clientsConfig, clientsFilePath);

  // Log secret rotation
  logger.info('OAuth secret rotated', {
    component: 'OAuthClientManager',
    clientId,
    rotatedBy
  });

  return {
    clientId: clientId,
    clientSecret: newSecret, // Plain text secret
    rotatedAt: client.lastRotated
  };
}

/**
 * Delete an OAuth client
 * @param {string} clientId - Client ID
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @param {string} deletedBy - User ID who deleted this client
 * @returns {Promise<void>}
 */
export async function deleteOAuthClient(clientId, clientsFilePath, deletedBy) {
  const clientsConfig = loadOAuthClients(clientsFilePath);

  if (!clientsConfig.clients[clientId]) {
    throw new Error(`OAuth client not found: ${clientId}`);
  }

  const clientName = clientsConfig.clients[clientId].name;
  delete clientsConfig.clients[clientId];

  await saveOAuthClients(clientsConfig, clientsFilePath);

  // Log client deletion
  logger.info('OAuth client deleted', {
    component: 'OAuthClientManager',
    clientId,
    name: clientName,
    deletedBy
  });
}

/**
 * List all OAuth clients (without secrets)
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @returns {Array<Object>} Array of clients without secrets
 */
export function listOAuthClients(clientsFilePath) {
  const clientsConfig = loadOAuthClients(clientsFilePath);
  const clients = clientsConfig.clients || {};

  return Object.values(clients).map(client => {
    const { clientSecret: _clientSecret, ...clientWithoutSecret } = client;
    return clientWithoutSecret;
  });
}

/**
 * Update last used timestamp for a client
 * @param {string} clientId - Client ID
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 */
export async function updateClientLastUsed(clientId, clientsFilePath) {
  try {
    const clientsConfig = loadOAuthClients(clientsFilePath);
    const client = Object.hasOwn(clientsConfig.clients, clientId)
      ? clientsConfig.clients[clientId]
      : undefined;

    if (!client) {
      return; // Client doesn't exist, skip update
    }

    const now = new Date().toISOString();

    // Only update if it's been more than 1 minute since last update (reduce writes)
    if (!client.lastUsed || new Date(now) - new Date(client.lastUsed) > 60000) {
      client.lastUsed = now;
      await saveOAuthClients(clientsConfig, clientsFilePath);
    }
  } catch (error) {
    logger.error('OAuth failed to update last used for client', {
      component: 'OAuthClientManager',
      clientId,
      error
    });
    // Don't throw - this is a non-critical operation
  }
}

/**
 * Validate client credentials
 * @param {string} clientId - Client ID
 * @param {string} clientSecret - Client secret (plain text)
 * @param {string} clientsFilePath - Path to oauth-clients.json file
 * @returns {Promise<Object|null>} Client object if valid, null otherwise
 */
export async function validateClientCredentials(clientId, clientSecret, clientsFilePath) {
  const clientsConfig = loadOAuthClients(clientsFilePath);
  const client = Object.hasOwn(clientsConfig.clients, clientId)
    ? clientsConfig.clients[clientId]
    : undefined;

  if (!client) {
    logger.info('OAuth client not found', { component: 'OAuthClientManager', clientId });
    return null;
  }

  if (!client.active) {
    logger.info('OAuth client suspended', { component: 'OAuthClientManager', clientId });
    return null;
  }

  // Verify secret
  const isValid = await verifyClientSecret(clientSecret, client.clientSecret);

  if (!isValid) {
    logger.info('OAuth invalid credentials', { component: 'OAuthClientManager', clientId });
    return null;
  }

  logger.info('OAuth client authenticated', {
    component: 'OAuthClientManager',
    clientId,
    name: client.name
  });

  // Update last used timestamp (async, non-blocking)
  updateClientLastUsed(clientId, clientsFilePath).catch(err => {
    logger.error('OAuth failed to update last used', {
      component: 'OAuthClientManager',
      error: err
    });
  });

  // Return client without secret

  const { clientSecret: _, ...clientWithoutSecret } = client;
  return clientWithoutSecret;
}
