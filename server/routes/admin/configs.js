import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { reconfigureOidcProviders } from '../../middleware/oidcAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import logger from '../../utils/logger.js';

/**
 * Check if a value is an environment variable placeholder
 * @param {string} value - Value to check
 * @returns {boolean} - True if the value is an environment variable placeholder
 */
function isEnvVarPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value);
}

/**
 * Sanitize a secret value for API responses
 * - Preserve environment variable placeholders like ${VARIABLE_NAME}
 * - Replace actual secret values with ***REDACTED***
 * @param {string} value - Value to sanitize
 * @returns {string|undefined} - Sanitized value
 */
function sanitizeSecret(value) {
  if (!value) return undefined;
  // Preserve environment variable placeholders
  if (isEnvVarPlaceholder(value)) {
    return value;
  }
  // Redact actual secret values
  return '***REDACTED***';
}

/**
 * Restore secret values from existing config when ***REDACTED*** is received
 * @param {string} newValue - New value from client
 * @param {string} existingValue - Existing value from config file
 * @returns {string} - Value to use (existing if newValue is redacted, otherwise newValue)
 */
function restoreSecretIfRedacted(newValue, existingValue) {
  // If the new value is the redacted placeholder, use the existing value
  if (newValue === '***REDACTED***') {
    return existingValue;
  }
  // Otherwise use the new value (could be a new secret or env var placeholder)
  return newValue;
}

/**
 * Decrypt a value if it is encrypted (ENC[...] format)
 * Used to decrypt secrets read from disk before sanitization or runtime use
 * @param {string} value - Value to check and potentially decrypt
 * @returns {string} - Decrypted value, or original if not encrypted
 */
function decryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (tokenStorageService.isEncrypted(value)) {
    return tokenStorageService.decryptString(value);
  }
  return value;
}

/**
 * Encrypt a value if it's not empty, not an env var placeholder, and not already encrypted
 * @param {string} value - Value to potentially encrypt
 * @returns {string} - Encrypted value, or original if skipped
 */
function encryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (isEnvVarPlaceholder(value)) return value;
  if (tokenStorageService.isEncrypted(value)) return value;
  return tokenStorageService.encryptString(value);
}

/**
 * Decrypt all known secret fields in platform config (in-place mutation)
 * @param {Object} config - Platform config object
 */
function decryptPlatformSecrets(config) {
  // Jira
  if (config.jira?.clientSecret) {
    config.jira.clientSecret = decryptIfNeeded(config.jira.clientSecret);
  }

  // Cloud storage providers
  if (config.cloudStorage?.providers) {
    for (const provider of config.cloudStorage.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = decryptIfNeeded(provider.clientSecret);
      }
      if (provider.type === 'office365' && provider.tenantId) {
        provider.tenantId = decryptIfNeeded(provider.tenantId);
      }
    }
  }

  // OIDC providers
  if (config.oidcAuth?.providers) {
    for (const provider of config.oidcAuth.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = decryptIfNeeded(provider.clientSecret);
      }
    }
  }

  // LDAP providers
  if (config.ldapAuth?.providers) {
    for (const provider of config.ldapAuth.providers) {
      if (provider.adminPassword) {
        provider.adminPassword = decryptIfNeeded(provider.adminPassword);
      }
    }
  }

  // NTLM
  if (config.ntlmAuth?.domainControllerPassword) {
    config.ntlmAuth.domainControllerPassword = decryptIfNeeded(
      config.ntlmAuth.domainControllerPassword
    );
  }
}

/**
 * Encrypt all known secret fields in platform config (in-place mutation)
 * @param {Object} config - Platform config object
 */
function encryptPlatformSecrets(config) {
  // Jira
  if (config.jira?.clientSecret) {
    config.jira.clientSecret = encryptIfNeeded(config.jira.clientSecret);
  }

  // Cloud storage providers
  if (config.cloudStorage?.providers) {
    for (const provider of config.cloudStorage.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = encryptIfNeeded(provider.clientSecret);
      }
      if (provider.type === 'office365' && provider.tenantId) {
        provider.tenantId = encryptIfNeeded(provider.tenantId);
      }
    }
  }

  // OIDC providers
  if (config.oidcAuth?.providers) {
    for (const provider of config.oidcAuth.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = encryptIfNeeded(provider.clientSecret);
      }
    }
  }

  // LDAP providers
  if (config.ldapAuth?.providers) {
    for (const provider of config.ldapAuth.providers) {
      if (provider.adminPassword) {
        provider.adminPassword = encryptIfNeeded(provider.adminPassword);
      }
    }
  }

  // NTLM
  if (config.ntlmAuth?.domainControllerPassword) {
    config.ntlmAuth.domainControllerPassword = encryptIfNeeded(
      config.ntlmAuth.domainControllerPassword
    );
  }
}

/**
 * Reconfigure authentication methods when platform configuration changes
 * @param {Object} oldConfig - Previous configuration
 * @param {Object} newConfig - New configuration
 * @returns {Object} Reconfiguration results
 */
function reconfigureAuthenticationMethods(oldConfig = {}, newConfig = {}) {
  const results = {
    reconfigured: [],
    requiresRestart: [],
    notes: []
  };

  // Check what authentication methods changed
  const oidcChanged = JSON.stringify(oldConfig.oidcAuth) !== JSON.stringify(newConfig.oidcAuth);
  const ntlmChanged = JSON.stringify(oldConfig.ntlmAuth) !== JSON.stringify(newConfig.ntlmAuth);
  const ldapChanged = JSON.stringify(oldConfig.ldapAuth) !== JSON.stringify(newConfig.ldapAuth);
  const localChanged = JSON.stringify(oldConfig.localAuth) !== JSON.stringify(newConfig.localAuth);
  const proxyChanged = JSON.stringify(oldConfig.proxyAuth) !== JSON.stringify(newConfig.proxyAuth);
  const anonymousChanged =
    JSON.stringify(oldConfig.anonymousAuth) !== JSON.stringify(newConfig.anonymousAuth);

  // OIDC - Can be reconfigured dynamically
  if (oidcChanged) {
    try {
      reconfigureOidcProviders();
      results.reconfigured.push('OIDC providers');
      results.notes.push('OIDC providers reconfigured successfully');
    } catch (error) {
      logger.error('Failed to reconfigure OIDC providers:', error);
      results.notes.push(`OIDC reconfiguration failed: ${error.message}`);
    }
  }

  // NTLM - Requires server restart (middleware cannot be dynamically removed)
  if (ntlmChanged) {
    results.requiresRestart.push('NTLM authentication');
    results.notes.push(
      'NTLM authentication changes require server restart (middleware limitation)'
    );
  }

  // LDAP - No reconfiguration needed (loads config dynamically)
  if (ldapChanged) {
    results.notes.push('LDAP configuration updated (applied automatically on next authentication)');
  }

  // Local Auth - No reconfiguration needed (loads config dynamically)
  if (localChanged) {
    results.notes.push('Local authentication configuration updated (applied automatically)');
  }

  // Proxy Auth - No reconfiguration needed (loads config dynamically)
  if (proxyChanged) {
    results.notes.push('Proxy authentication configuration updated (applied automatically)');
  }

  // Anonymous Auth - No reconfiguration needed (loads config dynamically)
  if (anonymousChanged) {
    results.notes.push('Anonymous authentication configuration updated (applied automatically)');
  }

  return results;
}

export default function registerAdminConfigRoutes(app, basePath = '') {
  /**
   * @swagger
   * /admin/configs/platform:
   *   get:
   *     summary: Get platform configuration
   *     description: Retrieves the current platform configuration (admin access required)
   *     tags:
   *       - Admin - Configuration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Platform configuration
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 auth:
   *                   type: object
   *                   description: Authentication configuration
   *                 anonymousAuth:
   *                   type: object
   *                   description: Anonymous authentication settings
   *                 features:
   *                   type: object
   *                   description: Feature flags
   *                 swagger:
   *                   type: object
   *                   description: Swagger documentation settings
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/configs/platform'), adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');

      let platformConfig = {};
      try {
        const platformConfigData = await fs.readFile(platformConfigPath, 'utf8');
        platformConfig = JSON.parse(platformConfigData);
      } catch {
        logger.info('Platform config not found, returning default config');
        platformConfig = {
          auth: {
            mode: 'proxy',
            authenticatedGroup: 'authenticated'
          },
          anonymousAuth: {
            enabled: true,
            defaultGroups: ['anonymous']
          },
          proxyAuth: {
            enabled: false,
            userHeader: 'X-Forwarded-User',
            groupsHeader: 'X-Forwarded-Groups',
            jwtProviders: []
          },
          localAuth: {
            enabled: false,
            usersFile: 'contents/config/users.json',
            sessionTimeoutMinutes: 480,
            jwtSecret: '${JWT_SECRET}'
          },
          oidcAuth: {
            enabled: false,
            providers: []
          },
          anonymousAuth: {
            enabled: true,
            defaultGroups: ['anonymous']
          }
        };
      }

      // Decrypt any encrypted secrets so sanitization sees plaintext (not ENC[...])
      decryptPlatformSecrets(platformConfig);

      // Sanitize sensitive fields even for admin endpoint
      // Preserve environment variable placeholders but redact actual secrets
      const sanitizedConfig = { ...platformConfig };

      // Sanitize JWT secret from auth config
      if (sanitizedConfig.auth?.jwtSecret) {
        sanitizedConfig.auth = {
          ...sanitizedConfig.auth,
          jwtSecret: sanitizeSecret(sanitizedConfig.auth.jwtSecret)
        };
      }

      // Sanitize JWT secret from localAuth config
      if (sanitizedConfig.localAuth?.jwtSecret) {
        sanitizedConfig.localAuth = {
          ...sanitizedConfig.localAuth,
          jwtSecret: sanitizeSecret(sanitizedConfig.localAuth.jwtSecret)
        };
      }

      // Sanitize OIDC provider secrets
      if (sanitizedConfig.oidcAuth?.providers) {
        sanitizedConfig.oidcAuth = {
          ...sanitizedConfig.oidcAuth,
          providers: sanitizedConfig.oidcAuth.providers.map(provider => ({
            ...provider,
            clientSecret: sanitizeSecret(provider.clientSecret)
          }))
        };
      }

      // Sanitize LDAP provider secrets
      if (sanitizedConfig.ldapAuth?.providers) {
        sanitizedConfig.ldapAuth = {
          ...sanitizedConfig.ldapAuth,
          providers: sanitizedConfig.ldapAuth.providers.map(provider => ({
            ...provider,
            adminPassword: sanitizeSecret(provider.adminPassword)
          }))
        };
      }

      // Sanitize proxy auth JWT provider secrets
      if (sanitizedConfig.proxyAuth?.jwtProviders) {
        sanitizedConfig.proxyAuth = {
          ...sanitizedConfig.proxyAuth,
          jwtProviders: sanitizedConfig.proxyAuth.jwtProviders.map(provider => ({
            name: provider.name,
            header: provider.header,
            issuer: provider.issuer,
            audience: provider.audience
            // Exclude jwkUrl and any other potentially sensitive configuration
          }))
        };
      }

      // Sanitize Jira client secret
      if (sanitizedConfig.jira?.clientSecret) {
        sanitizedConfig.jira = {
          ...sanitizedConfig.jira,
          clientSecret: sanitizeSecret(sanitizedConfig.jira.clientSecret)
        };
      }

      // Sanitize NTLM domain controller password
      if (sanitizedConfig.ntlmAuth?.domainControllerPassword) {
        sanitizedConfig.ntlmAuth = {
          ...sanitizedConfig.ntlmAuth,
          domainControllerPassword: sanitizeSecret(
            sanitizedConfig.ntlmAuth.domainControllerPassword
          )
        };
      }

      // Sanitize cloud storage provider secrets
      if (sanitizedConfig.cloudStorage?.providers) {
        sanitizedConfig.cloudStorage = {
          ...sanitizedConfig.cloudStorage,
          providers: sanitizedConfig.cloudStorage.providers.map(provider => ({
            ...provider,
            clientSecret: sanitizeSecret(provider.clientSecret),
            tenantId:
              provider.type === 'office365' ? sanitizeSecret(provider.tenantId) : provider.tenantId
          }))
        };
      }

      res.json(sanitizedConfig);
    } catch (error) {
      logger.error('Error getting platform configuration:', error);
      res.status(500).json({ error: 'Failed to get platform configuration' });
    }
  });

  /**
   * Update platform configuration
   */
  app.post(buildServerPath('/api/admin/configs/platform'), adminAuth, async (req, res) => {
    try {
      const newConfig = req.body;

      if (!newConfig || typeof newConfig !== 'object') {
        return res.status(400).json({ error: 'Invalid configuration data' });
      }

      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');

      // Load existing config to preserve other fields and track changes
      let existingConfig = {};
      try {
        const existingConfigData = await fs.readFile(platformConfigPath, 'utf8');
        existingConfig = JSON.parse(existingConfigData);
      } catch {
        // File doesn't exist, start with empty config
        logger.info('Creating new platform config file');
      }

      // Decrypt existing secrets so restoreSecretIfRedacted compares against plaintext
      decryptPlatformSecrets(existingConfig);

      // Merge the authentication-related config with existing config
      const mergedConfig = {
        ...existingConfig,
        auth: newConfig.auth || existingConfig.auth,
        anonymousAuth: newConfig.anonymousAuth || existingConfig.anonymousAuth,
        proxyAuth: newConfig.proxyAuth || existingConfig.proxyAuth,
        localAuth: newConfig.localAuth || existingConfig.localAuth,
        oidcAuth: newConfig.oidcAuth || existingConfig.oidcAuth,
        ldapAuth: newConfig.ldapAuth || existingConfig.ldapAuth,
        ntlmAuth: newConfig.ntlmAuth || existingConfig.ntlmAuth,
        authorization: newConfig.authorization || existingConfig.authorization,
        oauth: newConfig.oauth || existingConfig.oauth,
        jira: newConfig.jira || existingConfig.jira,
        cloudStorage: newConfig.cloudStorage || existingConfig.cloudStorage
      };

      // Restore secrets that were redacted in the client
      // This prevents environment variable placeholders from being overwritten with ***REDACTED***

      // Restore JWT secrets
      if (newConfig.auth?.jwtSecret) {
        if (!mergedConfig.auth) mergedConfig.auth = {};
        mergedConfig.auth.jwtSecret = restoreSecretIfRedacted(
          newConfig.auth.jwtSecret,
          existingConfig.auth?.jwtSecret
        );
      }

      if (newConfig.localAuth?.jwtSecret) {
        if (!mergedConfig.localAuth) mergedConfig.localAuth = {};
        mergedConfig.localAuth.jwtSecret = restoreSecretIfRedacted(
          newConfig.localAuth.jwtSecret,
          existingConfig.localAuth?.jwtSecret
        );
      }

      // Restore OIDC provider client secrets
      if (newConfig.oidcAuth?.providers && existingConfig.oidcAuth?.providers) {
        if (!mergedConfig.oidcAuth) mergedConfig.oidcAuth = {};
        mergedConfig.oidcAuth.providers = newConfig.oidcAuth.providers.map((provider, index) => {
          const existingProvider = existingConfig.oidcAuth?.providers?.[index];
          return {
            ...provider,
            clientSecret: restoreSecretIfRedacted(
              provider.clientSecret,
              existingProvider?.clientSecret
            )
          };
        });
      }

      // Restore LDAP provider admin passwords
      if (newConfig.ldapAuth?.providers && existingConfig.ldapAuth?.providers) {
        if (!mergedConfig.ldapAuth) mergedConfig.ldapAuth = {};
        mergedConfig.ldapAuth.providers = newConfig.ldapAuth.providers.map((provider, index) => {
          const existingProvider = existingConfig.ldapAuth?.providers?.[index];
          return {
            ...provider,
            adminPassword: restoreSecretIfRedacted(
              provider.adminPassword,
              existingProvider?.adminPassword
            )
          };
        });
      }

      // Restore Jira client secret
      if (newConfig.jira?.clientSecret) {
        if (!mergedConfig.jira) mergedConfig.jira = {};
        mergedConfig.jira.clientSecret = restoreSecretIfRedacted(
          newConfig.jira.clientSecret,
          existingConfig.jira?.clientSecret
        );
      }

      // Restore cloud storage provider secrets
      if (newConfig.cloudStorage?.providers && existingConfig.cloudStorage?.providers) {
        if (!mergedConfig.cloudStorage) mergedConfig.cloudStorage = {};
        mergedConfig.cloudStorage.providers = newConfig.cloudStorage.providers.map(
          (provider, index) => {
            const existingProvider = existingConfig.cloudStorage?.providers?.[index];
            return {
              ...provider,
              clientSecret: restoreSecretIfRedacted(
                provider.clientSecret,
                existingProvider?.clientSecret
              ),
              tenantId:
                provider.type === 'office365'
                  ? restoreSecretIfRedacted(provider.tenantId, existingProvider?.tenantId)
                  : provider.tenantId
            };
          }
        );
      }

      // Restore NTLM domain controller password
      if (newConfig.ntlmAuth?.domainControllerPassword) {
        if (!mergedConfig.ntlmAuth) mergedConfig.ntlmAuth = {};
        mergedConfig.ntlmAuth.domainControllerPassword = restoreSecretIfRedacted(
          newConfig.ntlmAuth.domainControllerPassword,
          existingConfig.ntlmAuth?.domainControllerPassword
        );
      }

      // Encrypt secrets before writing to disk
      encryptPlatformSecrets(mergedConfig);

      // Save to file
      await atomicWriteJSON(platformConfigPath, mergedConfig);

      // Refresh cache
      await configCache.refreshCacheEntry('config/platform.json');

      // Reconfigure authentication methods dynamically where possible
      const reconfigResults = reconfigureAuthenticationMethods(existingConfig, newConfig);

      // Log results
      if (reconfigResults.reconfigured.length > 0) {
        logger.info(`🔄 Reconfigured: ${reconfigResults.reconfigured.join(', ')}`);
      }
      if (reconfigResults.requiresRestart.length > 0) {
        logger.info(`⚠️  Requires restart: ${reconfigResults.requiresRestart.join(', ')}`);
      }
      reconfigResults.notes.forEach(note => logger.info(`ℹ️  ${note}`));

      logger.info('🔧 Platform authentication configuration updated');

      // Decrypt for sanitization before sending response (mergedConfig has encrypted values on disk)
      const responseConfig = JSON.parse(JSON.stringify(mergedConfig));
      decryptPlatformSecrets(responseConfig);

      // Sanitize secrets in response — admin UI should see ***REDACTED***, not raw values
      if (responseConfig.jira?.clientSecret) {
        responseConfig.jira.clientSecret = sanitizeSecret(responseConfig.jira.clientSecret);
      }
      if (responseConfig.oidcAuth?.providers) {
        responseConfig.oidcAuth.providers = responseConfig.oidcAuth.providers.map(p => ({
          ...p,
          clientSecret: sanitizeSecret(p.clientSecret)
        }));
      }
      if (responseConfig.ldapAuth?.providers) {
        responseConfig.ldapAuth.providers = responseConfig.ldapAuth.providers.map(p => ({
          ...p,
          adminPassword: sanitizeSecret(p.adminPassword)
        }));
      }
      if (responseConfig.ntlmAuth?.domainControllerPassword) {
        responseConfig.ntlmAuth.domainControllerPassword = sanitizeSecret(
          responseConfig.ntlmAuth.domainControllerPassword
        );
      }
      if (responseConfig.cloudStorage?.providers) {
        responseConfig.cloudStorage.providers = responseConfig.cloudStorage.providers.map(p => ({
          ...p,
          clientSecret: sanitizeSecret(p.clientSecret),
          tenantId: p.type === 'office365' ? sanitizeSecret(p.tenantId) : p.tenantId
        }));
      }
      if (responseConfig.auth?.jwtSecret) {
        responseConfig.auth.jwtSecret = sanitizeSecret(responseConfig.auth.jwtSecret);
      }
      if (responseConfig.localAuth?.jwtSecret) {
        responseConfig.localAuth.jwtSecret = sanitizeSecret(responseConfig.localAuth.jwtSecret);
      }

      res.json({
        message: 'Platform configuration updated successfully',
        config: responseConfig,
        reconfiguration: {
          reconfigured: reconfigResults.reconfigured,
          requiresRestart: reconfigResults.requiresRestart,
          notes: reconfigResults.notes
        }
      });
    } catch (error) {
      logger.error('Error updating platform configuration:', error);
      res.status(500).json({ error: 'Failed to update platform configuration' });
    }
  });
}
