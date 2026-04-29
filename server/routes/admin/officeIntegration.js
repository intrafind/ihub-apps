import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import { createOAuthClient } from '../../utils/oauthClientManager.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';

async function savePlatformConfig(updates) {
  const rootDir = getRootDir();
  const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
  const existing = configCache.getPlatform() || {};
  const merged = { ...existing, ...updates };
  await atomicWriteJSON(platformConfigPath, merged);
  await configCache.refreshCacheEntry('config/platform.json');
  return merged;
}

export default function registerAdminOfficeIntegrationRoutes(app) {
  /**
   * @swagger
   * /api/admin/office-integration/status:
   *   get:
   *     summary: Get Office integration status
   *     tags:
   *       - Admin - Office Integration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Office integration status
   */
  app.get(buildServerPath('/api/admin/office-integration/status'), adminAuth, (req, res) => {
    const platform = configCache.getPlatform();
    const officeConfig = platform?.officeIntegration || {};
    const baseUrl = buildPublicBaseUrl(req);

    res.json({
      enabled: officeConfig.enabled || false,
      oauthClientId: officeConfig.oauthClientId || '',
      displayName: officeConfig.displayName || { en: 'iHub Apps', de: 'iHub Apps' },
      description: officeConfig.description || {
        en: 'AI-powered assistant for Outlook',
        de: 'KI-gestützter Assistent für Outlook'
      },
      starterPrompts: Array.isArray(officeConfig.starterPrompts) ? officeConfig.starterPrompts : [],
      manifestUrl: `${baseUrl}/api/integrations/office-addin/manifest.xml`,
      taskpaneUrl: `${baseUrl}/office/taskpane.html`
    });
  });

  /**
   * @swagger
   * /api/admin/office-integration/enable:
   *   post:
   *     summary: Enable Office integration and auto-create OAuth client
   *     tags:
   *       - Admin - Office Integration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Office integration enabled
   */
  app.post(buildServerPath('/api/admin/office-integration/enable'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform();
      const officeConfig = platform?.officeIntegration || {};
      const baseUrl = buildPublicBaseUrl(req);

      let oauthClientId = officeConfig.oauthClientId;

      // Auto-create OAuth client if one doesn't exist yet
      if (!oauthClientId) {
        const oauthConfig = platform?.oauth || {};
        const clientsFile = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';

        const newClient = await createOAuthClient(
          {
            name: 'Office Add-in',
            description: 'Auto-generated client for the Outlook add-in (PKCE public client)',
            clientType: 'public',
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [`${baseUrl}/office/callback.html`],
            trusted: true,
            consentRequired: false,
            scopes: ['openid', 'profile', 'email']
          },
          clientsFile,
          req.user?.id || 'admin'
        );

        oauthClientId = newClient.clientId;

        logger.info('Created OAuth client for Office add-in', {
          component: 'AdminOfficeIntegration',
          clientId: oauthClientId
        });
      }

      // Ensure OAuth authorization code flow is enabled
      const oauthUpdates = {
        oauth: {
          ...(platform?.oauth || {}),
          enabled: {
            ...(platform?.oauth?.enabled || {}),
            authz: true,
            clients: true
          },
          authorizationCodeEnabled: true,
          refreshTokenEnabled: true
        }
      };

      const updates = {
        ...oauthUpdates,
        officeIntegration: {
          ...(platform?.officeIntegration || {}),
          enabled: true,
          oauthClientId
        }
      };

      await savePlatformConfig(updates);

      logger.info('Office integration enabled', {
        component: 'AdminOfficeIntegration',
        oauthClientId
      });

      res.json({
        message: 'Office integration enabled successfully',
        oauthClientId,
        manifestUrl: `${baseUrl}/api/integrations/office-addin/manifest.xml`
      });
    } catch (error) {
      return sendInternalError(res, error, 'enable Office integration');
    }
  });

  /**
   * @swagger
   * /api/admin/office-integration/disable:
   *   post:
   *     summary: Disable Office integration
   *     tags:
   *       - Admin - Office Integration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Office integration disabled
   */
  app.post(
    buildServerPath('/api/admin/office-integration/disable'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform();

        await savePlatformConfig({
          officeIntegration: {
            ...(platform?.officeIntegration || {}),
            enabled: false
          }
        });

        logger.info('Office integration disabled', { component: 'AdminOfficeIntegration' });

        res.json({ message: 'Office integration disabled successfully' });
      } catch (error) {
        return sendInternalError(res, error, 'disable Office integration');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/office-integration/config:
   *   put:
   *     summary: Update Office integration display settings
   *     tags:
   *       - Admin - Office Integration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               displayName:
   *                 type: object
   *               description:
   *                 type: object
   *     responses:
   *       200:
   *         description: Config updated
   */
  app.put(buildServerPath('/api/admin/office-integration/config'), adminAuth, async (req, res) => {
    try {
      const { displayName, description, starterPrompts } = req.body;
      const platform = configCache.getPlatform();

      // Accept only `{ [lang: string]: string }` objects. Any non-string locale value
      // is rejected to prevent garbage (or attacker-crafted) data from reaching the
      // taskpane renderer, where React can't render objects/arrays as text.
      const validateLocalizedObject = (fieldName, value, { maxLength, requireNonEmpty }) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { error: `${fieldName} must be a localized object like { en: "...", de: "..." }` };
        }
        const sanitized = {};
        for (const [lang, rawValue] of Object.entries(value)) {
          if (typeof rawValue !== 'string') {
            return { error: `${fieldName}.${lang} must be a string` };
          }
          if (rawValue.length > maxLength) {
            return { error: `${fieldName}.${lang} must not exceed ${maxLength} characters` };
          }
          const trimmed = rawValue.trim();
          if (trimmed.length > 0) sanitized[lang] = trimmed;
        }
        if (requireNonEmpty && Object.keys(sanitized).length === 0) {
          return { error: `${fieldName} must have at least one non-empty locale value` };
        }
        return { value: sanitized };
      };

      const allowed = {};
      if (displayName !== undefined) {
        const result = validateLocalizedObject('displayName', displayName, {
          maxLength: 250,
          requireNonEmpty: true
        });
        if (result.error) return sendBadRequest(res, result.error);
        allowed.displayName = result.value;
      }
      if (description !== undefined) {
        const result = validateLocalizedObject('description', description, {
          maxLength: 250,
          requireNonEmpty: false
        });
        if (result.error) return sendBadRequest(res, result.error);
        allowed.description = result.value;
      }
      if (starterPrompts !== undefined) {
        if (!Array.isArray(starterPrompts)) {
          return sendBadRequest(res, 'starterPrompts must be an array');
        }
        if (starterPrompts.length > 20) {
          return sendBadRequest(res, 'starterPrompts must not contain more than 20 entries');
        }
        const sanitized = [];
        for (let i = 0; i < starterPrompts.length; i++) {
          const prompt = starterPrompts[i];
          if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
            return sendBadRequest(res, `starterPrompts[${i}] must be an object`);
          }
          const titleResult = validateLocalizedObject(`starterPrompts[${i}].title`, prompt.title, {
            maxLength: 250,
            requireNonEmpty: true
          });
          if (titleResult.error) return sendBadRequest(res, titleResult.error);
          const messageResult = validateLocalizedObject(
            `starterPrompts[${i}].message`,
            prompt.message,
            { maxLength: 4000, requireNonEmpty: true }
          );
          if (messageResult.error) return sendBadRequest(res, messageResult.error);
          sanitized.push({ title: titleResult.value, message: messageResult.value });
        }
        allowed.starterPrompts = sanitized;
      }

      await savePlatformConfig({
        officeIntegration: {
          ...(platform?.officeIntegration || {}),
          ...allowed
        }
      });

      logger.info('Office integration config updated', {
        component: 'AdminOfficeIntegration',
        fields: Object.keys(allowed)
      });

      res.json({
        message: 'Office integration configuration updated',
        officeIntegration: configCache.getPlatform()?.officeIntegration
      });
    } catch (error) {
      return sendInternalError(res, error, 'update Office integration config');
    }
  });
}
