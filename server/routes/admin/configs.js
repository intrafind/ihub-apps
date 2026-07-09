import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { reconfigureOidcProviders } from '../../middleware/oidcAuth.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { testRealtimeConnection } from '../../websocket/realtimeTranscription.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';

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
 * Encrypt a secret string for storage, unless it is an env var placeholder or
 * already encrypted. Mirrors the guard pattern used for model API keys.
 * @param {string} value
 * @returns {string}
 */
function encryptSecretIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (isEnvVarPlaceholder(value)) return value;
  if (tokenStorageService.isEncrypted(value)) return value;
  return tokenStorageService.encryptString(value);
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
      logger.error('Failed to reconfigure OIDC providers', { component: 'AdminConfigs', error });
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

export default function registerAdminConfigRoutes(app) {
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
        logger.info('Platform config not found, returning default config', {
          component: 'AdminConfigs'
        });
        platformConfig = {
          auth: {
            mode: 'local',
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
            sessionTimeoutMinutes: 480
          },
          oidcAuth: {
            enabled: false,
            providers: []
          }
        };
      }

      // Integration secrets (jira/cloudStorage/oidc/ldap/ntlm/iFinder) no longer
      // live in platform.json — they are stored in the central credential store
      // and referenced by *Ref ids, so there is nothing to sanitize for them
      // here. Only the JWT secrets and proxy JWT provider config remain inline.
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

      // Sanitize the realtime speech API key (server-side secret).
      if (sanitizedConfig.speech?.realtime?.apiKey) {
        sanitizedConfig.speech = {
          ...sanitizedConfig.speech,
          realtime: {
            ...sanitizedConfig.speech.realtime,
            apiKey: sanitizeSecret(sanitizedConfig.speech.realtime.apiKey)
          }
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
      return sendInternalError(res, error, 'get platform configuration');
    }
  });

  /**
   * Update platform configuration
   */
  app.post(buildServerPath('/api/admin/configs/platform'), adminAuth, async (req, res) => {
    try {
      const newConfig = req.body;

      if (!newConfig || typeof newConfig !== 'object') {
        return sendBadRequest(res, 'Invalid configuration data');
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
        logger.info('Creating new platform config file', { component: 'AdminConfigs' });
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
        oauth: newConfig.oauth || existingConfig.oauth,
        jira: newConfig.jira || existingConfig.jira,
        cloudStorage: newConfig.cloudStorage || existingConfig.cloudStorage,
        iFinder: newConfig.iFinder || existingConfig.iFinder,
        iAssistant: newConfig.iAssistant || existingConfig.iAssistant,
        telemetry:
          newConfig.telemetry !== undefined ? newConfig.telemetry : existingConfig.telemetry,
        speech: newConfig.speech !== undefined ? newConfig.speech : existingConfig.speech
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

      // Integration secrets (jira/cloudStorage/oidc/ldap/ntlm/iFinder) live in
      // the central credential store and are referenced by *Ref ids that are
      // plain config values — they pass through the merge above unchanged and
      // require no encrypt/restore handling here.

      // Realtime speech API key: restore if the client sent the redacted
      // placeholder, otherwise encrypt the newly provided secret at rest.
      if (newConfig.speech?.realtime && Object.hasOwn(newConfig.speech.realtime, 'apiKey')) {
        if (!mergedConfig.speech) mergedConfig.speech = {};
        if (!mergedConfig.speech.realtime) mergedConfig.speech.realtime = {};
        const restored = restoreSecretIfRedacted(
          newConfig.speech.realtime.apiKey,
          existingConfig.speech?.realtime?.apiKey
        );
        mergedConfig.speech.realtime.apiKey = encryptSecretIfNeeded(restored);
      }

      // Save to file
      await atomicWriteJSON(platformConfigPath, mergedConfig);

      // Refresh cache
      await configCache.refreshCacheEntry('config/platform.json');

      // Apply runtime-mutable telemetry settings without server restart
      try {
        const telemetryChanged =
          JSON.stringify(existingConfig.telemetry) !== JSON.stringify(newConfig.telemetry);
        if (telemetryChanged && newConfig.telemetry) {
          const { reloadTelemetryConfig } = await import('../../telemetry.js');
          const { default: activityTracker } = await import('../../telemetry/ActivityTracker.js');
          reloadTelemetryConfig(newConfig.telemetry);
          activityTracker.configure(newConfig.telemetry.activitySummary || {});
          logger.info('Telemetry runtime configuration updated', { component: 'AdminConfigs' });
        }
      } catch (telemetryError) {
        logger.warn('Failed to apply runtime telemetry config update', {
          component: 'AdminConfigs',
          error: telemetryError.message
        });
      }

      // Reset iFinder/iAssistant service caches so they pick up new config
      const iFinderChanged =
        JSON.stringify(existingConfig.iFinder) !== JSON.stringify(newConfig.iFinder);
      const iAssistantChanged =
        JSON.stringify(existingConfig.iAssistant) !== JSON.stringify(newConfig.iAssistant);
      if (iFinderChanged || iAssistantChanged) {
        try {
          const { default: iAssistantService } =
            await import('../../services/integrations/iAssistantService.js');
          const { default: iFinderService } =
            await import('../../services/integrations/iFinderService.js');
          iAssistantService.resetConfig();
          iFinderService.resetConfig();
          logger.info('iFinder/iAssistant service caches reset after config change', {
            component: 'AdminConfigs'
          });
        } catch (error) {
          logger.warn('Could not reset iFinder caches', { component: 'AdminConfigs', error: err });
        }
      }

      // Reconfigure authentication methods dynamically where possible
      const reconfigResults = reconfigureAuthenticationMethods(existingConfig, newConfig);

      // Log results
      if (reconfigResults.reconfigured.length > 0) {
        logger.info('Reconfigured authentication methods', {
          component: 'AdminConfigs',
          reconfigured: reconfigResults.reconfigured.join(', ')
        });
      }
      if (reconfigResults.requiresRestart.length > 0) {
        logger.info('Authentication methods require restart', {
          component: 'AdminConfigs',
          requiresRestart: reconfigResults.requiresRestart.join(', ')
        });
      }
      reconfigResults.notes.forEach(note =>
        logger.info('Authentication reconfiguration note', { component: 'AdminConfigs', note })
      );

      logger.info('Platform authentication configuration updated', { component: 'AdminConfigs' });

      // Sanitize the remaining inline secrets in the response — the admin UI
      // should see ***REDACTED*** for JWT secrets, not raw values. Integration
      // secrets no longer live in platform.json (they are in the credential
      // store), so only the JWT secrets need sanitizing here.
      const responseConfig = JSON.parse(JSON.stringify(mergedConfig));
      if (responseConfig.auth?.jwtSecret) {
        responseConfig.auth.jwtSecret = sanitizeSecret(responseConfig.auth.jwtSecret);
      }
      if (responseConfig.localAuth?.jwtSecret) {
        responseConfig.localAuth.jwtSecret = sanitizeSecret(responseConfig.localAuth.jwtSecret);
      }

      await saveSnapshot({
        resource: 'platform',
        id: 'platform',
        before: existingConfig,
        after: mergedConfig,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });
      await logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'platform',
        summary: 'Updated platform configuration'
      });
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
      return sendInternalError(res, error, 'update platform configuration');
    }
  });

  /**
   * Test connectivity to the vLLM realtime speech endpoint.
   * Accepts optional { url, model, apiKey } to test unsaved form values. When
   * the apiKey is omitted, blank, or the redacted placeholder, the saved
   * (decrypted) key from the platform cache is used so the secret is never sent
   * to the browser.
   */
  app.post(buildServerPath('/api/admin/voice/realtime/test'), adminAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const saved = (configCache.getPlatform() || {}).speech?.realtime || {};

      const url = (body.url ?? saved.url ?? '').trim();
      const model = body.model ?? saved.model ?? '';

      // Resolve the API key without leaking the stored secret.
      let apiKey = body.apiKey;
      if (!apiKey || apiKey === '***REDACTED***' || isEnvVarPlaceholder(apiKey)) {
        apiKey = saved.apiKey || ''; // already decrypted by configCache
      }

      if (!url) {
        return res.json({ ok: false, message: 'No realtime URL configured' });
      }

      const result = await testRealtimeConnection({ url, model, apiKey });
      return res.json(result);
    } catch (error) {
      return sendInternalError(res, error, 'test realtime speech connection');
    }
  });
}
