import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import { createOAuthClient } from '../../utils/oauthClientManager.js';
import { encryptPlatformSecrets } from '../../utils/platformSecrets.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';

async function savePlatformConfig(updates) {
  const rootDir = getRootDir();
  const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
  // `configCache.getPlatform()` returns secrets in their *decrypted* form. We
  // must re-encrypt before writing back to disk so unrelated sections
  // (Jira / OIDC / LDAP / cloud storage providers) keep their at-rest
  // encryption — otherwise enabling/disabling the Nextcloud embed silently
  // downgrades every secret in platform.json to plaintext.
  const existing = configCache.getPlatform() || {};
  const merged = encryptPlatformSecrets({ ...existing, ...updates });
  await atomicWriteJSON(platformConfigPath, merged);
  await configCache.refreshCacheEntry('config/platform.json');
  return merged;
}

/**
 * Validate a single `allowedHostOrigins` entry. We accept only well-formed
 * `http`/`https` origins (scheme + host, optionally + port — no path, no
 * query, no fragment) so a misconfigured entry can't widen the
 * postMessage / CSP `frame-ancestors` allowlist in unexpected ways.
 *
 * Returns the canonicalized origin (no trailing slash) or null when invalid.
 */
function canonicalizeOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname && url.pathname !== '/') return null;
  if (url.search || url.hash) return null;
  return url.origin;
}

export default function registerAdminNextcloudEmbedRoutes(app) {
  /**
   * @swagger
   * /api/admin/nextcloud-embed/status:
   *   get:
   *     summary: Get Nextcloud embed integration status
   *     tags:
   *       - Admin - Nextcloud Embed
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Nextcloud embed integration status
   */
  app.get(buildServerPath('/api/admin/nextcloud-embed/status'), adminAuth, (req, res) => {
    try {
      const platform = configCache.getPlatform();
      const cfg = platform?.nextcloudEmbed || {};
      const baseUrl = buildPublicBaseUrl(req);

      res.json({
        enabled: cfg.enabled || false,
        oauthClientId: cfg.oauthClientId || '',
        displayName: cfg.displayName || { en: 'iHub Apps', de: 'iHub Apps' },
        description: cfg.description || {
          en: 'AI-powered assistant for Nextcloud',
          de: 'KI-gestützter Assistent für Nextcloud'
        },
        starterPrompts: Array.isArray(cfg.starterPrompts) ? cfg.starterPrompts : [],
        allowedHostOrigins: Array.isArray(cfg.allowedHostOrigins) ? cfg.allowedHostOrigins : [],
        embedUrl: `${baseUrl}/nextcloud/full-embed.html`
      });
    } catch (error) {
      return sendInternalError(res, error, 'load Nextcloud embed status');
    }
  });

  /**
   * @swagger
   * /api/admin/nextcloud-embed/enable:
   *   post:
   *     summary: Enable Nextcloud embed integration and auto-create OAuth client
   *     tags:
   *       - Admin - Nextcloud Embed
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Nextcloud embed integration enabled
   */
  app.post(buildServerPath('/api/admin/nextcloud-embed/enable'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform();
      const cfg = platform?.nextcloudEmbed || {};
      const baseUrl = buildPublicBaseUrl(req);

      let oauthClientId = cfg.oauthClientId;

      if (!oauthClientId) {
        const oauthConfig = platform?.oauth || {};
        const clientsFile = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';

        const newClient = await createOAuthClient(
          {
            name: 'Nextcloud Embed',
            description: 'Auto-generated client for the Nextcloud embed (PKCE public client)',
            clientType: 'public',
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [`${baseUrl}/nextcloud/callback.html`],
            trusted: true,
            consentRequired: false,
            scopes: ['openid', 'profile', 'email']
          },
          clientsFile,
          req.user?.id || 'admin'
        );

        oauthClientId = newClient.clientId;

        logger.info('Created OAuth client for Nextcloud embed', {
          component: 'AdminNextcloudEmbed',
          clientId: oauthClientId
        });
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
        nextcloudEmbed: {
          ...(platform?.nextcloudEmbed || {}),
          enabled: true,
          oauthClientId
        }
      };

      await savePlatformConfig(updates);

      logger.info('Nextcloud embed enabled', {
        component: 'AdminNextcloudEmbed',
        oauthClientId
      });

      res.json({
        message: 'Nextcloud embed enabled successfully',
        oauthClientId,
        embedUrl: `${baseUrl}/nextcloud/full-embed.html`
      });
    } catch (error) {
      return sendInternalError(res, error, 'enable Nextcloud embed');
    }
  });

  /**
   * @swagger
   * /api/admin/nextcloud-embed/disable:
   *   post:
   *     summary: Disable Nextcloud embed integration
   *     tags:
   *       - Admin - Nextcloud Embed
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Nextcloud embed integration disabled
   */
  app.post(buildServerPath('/api/admin/nextcloud-embed/disable'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform();

      await savePlatformConfig({
        nextcloudEmbed: {
          ...(platform?.nextcloudEmbed || {}),
          enabled: false
        }
      });

      logger.info('Nextcloud embed disabled', { component: 'AdminNextcloudEmbed' });

      res.json({ message: 'Nextcloud embed disabled successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'disable Nextcloud embed');
    }
  });

  /**
   * @swagger
   * /api/admin/nextcloud-embed/config:
   *   put:
   *     summary: Update Nextcloud embed display settings and allowed host origins
   *     tags:
   *       - Admin - Nextcloud Embed
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
   *               starterPrompts:
   *                 type: array
   *               allowedHostOrigins:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Config updated
   */
  app.put(buildServerPath('/api/admin/nextcloud-embed/config'), adminAuth, async (req, res) => {
    try {
      const { displayName, description, starterPrompts, allowedHostOrigins } = req.body;
      const platform = configCache.getPlatform();

      // Accept only `{ [lang: string]: string }` objects. Any non-string locale value
      // is rejected to prevent garbage (or attacker-crafted) data from reaching the
      // embed renderer, where React can't render objects/arrays as text.
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
      if (allowedHostOrigins !== undefined) {
        if (!Array.isArray(allowedHostOrigins)) {
          return sendBadRequest(res, 'allowedHostOrigins must be an array');
        }
        if (allowedHostOrigins.length > 50) {
          return sendBadRequest(res, 'allowedHostOrigins must not contain more than 50 entries');
        }
        const sanitized = [];
        const seen = new Set();
        for (let i = 0; i < allowedHostOrigins.length; i++) {
          const canonical = canonicalizeOrigin(allowedHostOrigins[i]);
          if (!canonical) {
            return sendBadRequest(
              res,
              `allowedHostOrigins[${i}] must be a valid http(s) origin (e.g. https://cloud.example.com)`
            );
          }
          if (!seen.has(canonical)) {
            seen.add(canonical);
            sanitized.push(canonical);
          }
        }
        allowed.allowedHostOrigins = sanitized;
      }

      await savePlatformConfig({
        nextcloudEmbed: {
          ...(platform?.nextcloudEmbed || {}),
          ...allowed
        }
      });

      logger.info('Nextcloud embed config updated', {
        component: 'AdminNextcloudEmbed',
        fields: Object.keys(allowed)
      });

      res.json({
        message: 'Nextcloud embed configuration updated',
        nextcloudEmbed: configCache.getPlatform()?.nextcloudEmbed
      });
    } catch (error) {
      return sendInternalError(res, error, 'update Nextcloud embed config');
    }
  });
}
