import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { reconfigureOidcProviders } from '../../middleware/oidcAuth.js';
import { buildServerPath } from '../../utils/basePath.js';

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
      console.error('Failed to reconfigure OIDC providers:', error);
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
  app.get(buildServerPath('/api/admin/configs/platform', basePath), adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');

      let platformConfig = {};
      try {
        const platformConfigData = await fs.readFile(platformConfigPath, 'utf8');
        platformConfig = JSON.parse(platformConfigData);
      } catch {
        console.log('Platform config not found, returning default config');
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

      res.json(platformConfig);
    } catch (error) {
      console.error('Error getting platform configuration:', error);
      res.status(500).json({ error: 'Failed to get platform configuration' });
    }
  });

  /**
   * Update platform configuration
   */
  app.post(
    buildServerPath('/api/admin/configs/platform', basePath),
    adminAuth,
    async (req, res) => {
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
          console.log('Creating new platform config file');
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
          authDebug: newConfig.authDebug || existingConfig.authDebug
        };

        // Save to file
        await atomicWriteJSON(platformConfigPath, mergedConfig);

        // Refresh cache
        await configCache.refreshCacheEntry('config/platform.json');

        // Reconfigure authentication methods dynamically where possible
        const reconfigResults = reconfigureAuthenticationMethods(existingConfig, newConfig);

        // Log results
        if (reconfigResults.reconfigured.length > 0) {
          console.log(`🔄 Reconfigured: ${reconfigResults.reconfigured.join(', ')}`);
        }
        if (reconfigResults.requiresRestart.length > 0) {
          console.log(`⚠️  Requires restart: ${reconfigResults.requiresRestart.join(', ')}`);
        }
        reconfigResults.notes.forEach(note => console.log(`ℹ️  ${note}`));

        console.log('🔧 Platform authentication configuration updated');

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
        console.error('Error updating platform configuration:', error);
        res.status(500).json({ error: 'Failed to update platform configuration' });
      }
    }
  );
}
