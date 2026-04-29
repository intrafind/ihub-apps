import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath, getBasePath } from '../../utils/basePath.js';
import { createOAuthClient, updateOAuthClient } from '../../utils/oauthClientManager.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';

// The browser extension uses a fixed redirect URI scheme:
//   https://<extension-id>.chromiumapp.org/cb     (Chrome / Edge)
//   https://<extension-id>.extensions.allizom.org/cb  (Firefox)
// We don't know the extension id until the admin has it loaded, so we let
// admins register any number of extension IDs as part of the config and
// derive redirectUris from them.

function buildPublicBaseUrl(req) {
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const host = req.get('X-Forwarded-Host') || req.get('host');
  const basePath = getBasePath();
  return `${proto}://${host}${basePath}`;
}

async function savePlatformConfig(updates) {
  const rootDir = getRootDir();
  const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
  const existing = configCache.getPlatform() || {};
  const merged = { ...existing, ...updates };
  await atomicWriteJSON(platformConfigPath, merged);
  await configCache.refreshCacheEntry('config/platform.json');
  return merged;
}

function buildRedirectUrisFromExtensionIds(extensionIds = []) {
  const out = [];
  for (const id of extensionIds) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim().toLowerCase();
    // Chromium extension IDs are 32 lowercase letters [a-p]; Firefox add-on IDs
    // can be GUIDs or simple strings. Be lenient — admin pasted it themselves.
    if (!/^[a-z0-9.-]{8,128}$/i.test(trimmed)) continue;
    out.push(`https://${trimmed}.chromiumapp.org/cb`);
    out.push(`https://${trimmed}.extensions.allizom.org/cb`);
  }
  return out;
}

function validateLocalizedObject(fieldName, value, { maxLength, requireNonEmpty }) {
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
}

export default function registerAdminBrowserExtensionRoutes(app) {
  /**
   * @swagger
   * /api/admin/browser-extension/status:
   *   get:
   *     summary: Get browser extension integration status
   *     tags:
   *       - Admin - Browser Extension
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Browser extension integration status
   */
  app.get(buildServerPath('/api/admin/browser-extension/status'), adminAuth, (req, res) => {
    const platform = configCache.getPlatform();
    const cfg = platform?.browserExtension || {};
    const baseUrl = buildPublicBaseUrl(req);

    res.json({
      enabled: cfg.enabled || false,
      oauthClientId: cfg.oauthClientId || '',
      displayName: cfg.displayName || { en: 'iHub Apps', de: 'iHub Apps' },
      description: cfg.description || {
        en: 'AI-powered assistant for the browser',
        de: 'KI-gestützter Assistent für den Browser'
      },
      starterPrompts: Array.isArray(cfg.starterPrompts) ? cfg.starterPrompts : [],
      extensionIds: Array.isArray(cfg.extensionIds) ? cfg.extensionIds : [],
      allowedGroups: Array.isArray(cfg.allowedGroups) ? cfg.allowedGroups : ['browser-extension'],
      configUrl: `${baseUrl}/api/integrations/browser-extension/config`
    });
  });

  /**
   * @swagger
   * /api/admin/browser-extension/enable:
   *   post:
   *     summary: Enable browser extension integration and auto-create OAuth client
   *     tags:
   *       - Admin - Browser Extension
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.post(buildServerPath('/api/admin/browser-extension/enable'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform();
      const cfg = platform?.browserExtension || {};

      let oauthClientId = cfg.oauthClientId;

      const allowedGroups = Array.isArray(cfg.allowedGroups)
        ? cfg.allowedGroups
        : ['browser-extension'];
      const extensionIds = Array.isArray(cfg.extensionIds) ? cfg.extensionIds : [];
      const redirectUris = buildRedirectUrisFromExtensionIds(extensionIds);

      if (!oauthClientId) {
        const oauthConfig = platform?.oauth || {};
        const clientsFile = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';

        const newClient = await createOAuthClient(
          {
            name: 'Browser Extension',
            description:
              'Auto-generated client for the iHub browser extension (PKCE public client)',
            clientType: 'public',
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris,
            trusted: true,
            consentRequired: false,
            scopes: ['openid', 'profile', 'email'],
            allowedGroups
          },
          clientsFile,
          req.user?.id || 'admin'
        );

        oauthClientId = newClient.clientId;

        logger.info('Created OAuth client for browser extension', {
          component: 'AdminBrowserExtension',
          clientId: oauthClientId
        });
      } else {
        // Re-sync redirectUris and allowedGroups onto the existing client so
        // the admin can manage extension IDs without rotating the secret.
        const oauthConfig = platform?.oauth || {};
        const clientsFile = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        await updateOAuthClient(
          oauthClientId,
          { redirectUris, allowedGroups, active: true },
          clientsFile,
          req.user?.id || 'admin'
        );
      }

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
        browserExtension: {
          ...cfg,
          enabled: true,
          oauthClientId,
          allowedGroups
        }
      };

      await savePlatformConfig(updates);

      const baseUrl = buildPublicBaseUrl(req);

      logger.info('Browser extension integration enabled', {
        component: 'AdminBrowserExtension',
        oauthClientId
      });

      res.json({
        message: 'Browser extension integration enabled successfully',
        oauthClientId,
        configUrl: `${baseUrl}/api/integrations/browser-extension/config`
      });
    } catch (error) {
      return sendInternalError(res, error, 'enable browser extension integration');
    }
  });

  /**
   * @swagger
   * /api/admin/browser-extension/disable:
   *   post:
   *     summary: Disable browser extension integration
   *     tags:
   *       - Admin - Browser Extension
   */
  app.post(buildServerPath('/api/admin/browser-extension/disable'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform();

      await savePlatformConfig({
        browserExtension: {
          ...(platform?.browserExtension || {}),
          enabled: false
        }
      });

      logger.info('Browser extension integration disabled', {
        component: 'AdminBrowserExtension'
      });

      res.json({ message: 'Browser extension integration disabled successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'disable browser extension integration');
    }
  });

  /**
   * @swagger
   * /api/admin/browser-extension/config:
   *   put:
   *     summary: Update browser extension integration display + redirect settings
   *     tags:
   *       - Admin - Browser Extension
   */
  app.put(buildServerPath('/api/admin/browser-extension/config'), adminAuth, async (req, res) => {
    try {
      const { displayName, description, starterPrompts, extensionIds, allowedGroups } = req.body;
      const platform = configCache.getPlatform();
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
      if (extensionIds !== undefined) {
        if (!Array.isArray(extensionIds)) {
          return sendBadRequest(res, 'extensionIds must be an array of strings');
        }
        const sanitized = [];
        for (const id of extensionIds) {
          if (typeof id !== 'string') {
            return sendBadRequest(res, 'extensionIds entries must be strings');
          }
          const trimmed = id.trim();
          if (!trimmed) continue;
          if (!/^[a-zA-Z0-9._-]{8,128}$/.test(trimmed)) {
            return sendBadRequest(
              res,
              `extensionIds entry "${trimmed}" must contain only alphanumeric, dot, dash or underscore characters (8-128 chars)`
            );
          }
          sanitized.push(trimmed.toLowerCase());
        }
        allowed.extensionIds = Array.from(new Set(sanitized));
      }
      if (allowedGroups !== undefined) {
        if (!Array.isArray(allowedGroups)) {
          return sendBadRequest(res, 'allowedGroups must be an array of strings');
        }
        const sanitized = [];
        for (const g of allowedGroups) {
          if (typeof g !== 'string') {
            return sendBadRequest(res, 'allowedGroups entries must be strings');
          }
          const trimmed = g.trim();
          if (trimmed) sanitized.push(trimmed);
        }
        allowed.allowedGroups = Array.from(new Set(sanitized));
      }

      // If extensionIds or allowedGroups changed, re-sync the OAuth client.
      const previous = platform?.browserExtension || {};
      const merged = { ...previous, ...allowed };

      if (
        previous.oauthClientId &&
        (allowed.extensionIds !== undefined || allowed.allowedGroups !== undefined)
      ) {
        const oauthConfig = platform?.oauth || {};
        const clientsFile = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
        const newRedirectUris = buildRedirectUrisFromExtensionIds(merged.extensionIds || []);
        const newAllowedGroups = merged.allowedGroups || ['browser-extension'];
        try {
          await updateOAuthClient(
            previous.oauthClientId,
            { redirectUris: newRedirectUris, allowedGroups: newAllowedGroups },
            clientsFile,
            req.user?.id || 'admin'
          );
        } catch (err) {
          logger.warn('Failed to sync OAuth client for extension integration', {
            component: 'AdminBrowserExtension',
            error: err
          });
        }
      }

      await savePlatformConfig({
        browserExtension: merged
      });

      logger.info('Browser extension integration config updated', {
        component: 'AdminBrowserExtension',
        fields: Object.keys(allowed)
      });

      res.json({
        message: 'Browser extension integration configuration updated',
        browserExtension: configCache.getPlatform()?.browserExtension
      });
    } catch (error) {
      return sendInternalError(res, error, 'update browser extension integration config');
    }
  });
}
