import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { reconfigureOidcProviders } from '../../middleware/oidcAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
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

      // Sanitize admin secret
      if (sanitizedConfig.admin?.secret) {
        sanitizedConfig.admin = {
          ...sanitizedConfig.admin,
          secret: sanitizeSecret(sanitizedConfig.admin.secret)
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
        oauth: newConfig.oauth || existingConfig.oauth
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

      // Restore admin secret
      if (newConfig.admin?.secret) {
        if (!mergedConfig.admin) mergedConfig.admin = {};
        mergedConfig.admin.secret = restoreSecretIfRedacted(
          newConfig.admin.secret,
          existingConfig.admin?.secret
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

      res.json({
        message: 'Platform configuration updated successfully',
        config: mergedConfig,
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
