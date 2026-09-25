import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import { createOAuthClient } from '../../utils/oauthClientManager.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import { sanitizeOfficeStartPage, validateOfficeStartPage } from '../../utils/officeStartPage.js';
import {
  sanitizeOfficeMailAction,
  validateOfficeMailAction
} from '../../utils/officeMailActions.js';
import {
  DEFAULT_OFFICE_JS_CDN_URL,
  OFFICE_JS_CDN_PRESETS,
  OFFICE_JS_MODES,
  resolveOfficeJsSource,
  validateOfficeJsUrl
} from '../../utils/officeJsSource.js';
import { probeOfficeJsUrl } from '../../services/OfficeJsProxyService.js';
import { assertPublicTarget, createPinnedLookup } from '../../utils/ssrfGuard.js';
import { oauthClientsFile } from '../../utils/contentsPath.js';
import { randomUUID } from 'crypto';
import { LEGACY_OFFICE_ADDIN_ID, resolveOfficeAddinId } from '../../utils/officeAddinManifest.js';

/**
 * Merge updates into the platform configuration and publish them.
 *
 * @param {Object} updates - Top-level platform keys to overwrite
 * @returns {Promise<Object>} The merged configuration that was written
 */
/** Enough to probe every known preset in one click, and no more. */
const MAX_PROBE_URLS = 8;

async function savePlatformConfig(updates) {
  const existing = configCache.getPlatform() || {};
  const merged = { ...existing, ...updates };
  await configStore.writeJson('config/platform.json', merged);
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
    const resolvedOfficeJs = resolveOfficeJsSource(platform);

    res.json({
      enabled: officeConfig.enabled || false,
      oauthClientId: officeConfig.oauthClientId || '',
      displayName: officeConfig.displayName || { en: 'iHub Apps', de: 'iHub Apps' },
      description: officeConfig.description || {
        en: 'AI-powered assistant for Outlook',
        de: 'KI-gestützter Assistent für Outlook'
      },
      starterPrompts: Array.isArray(officeConfig.starterPrompts) ? officeConfig.starterPrompts : [],
      // Always complete, so the admin form has a value for every control.
      startPage: sanitizeOfficeStartPage(officeConfig.startPage),
      defaultMailAction: sanitizeOfficeMailAction(officeConfig.defaultMailAction),
      officeJsMode: OFFICE_JS_MODES.includes(officeConfig.officeJsMode)
        ? officeConfig.officeJsMode
        : 'cdn',
      officeJsCdnUrl: officeConfig.officeJsCdnUrl || DEFAULT_OFFICE_JS_CDN_URL,
      officeJsCustomUrl: officeConfig.officeJsCustomUrl || '',
      // Served rather than hard-coded in the client so the known CDN URLs live
      // in one place.
      officeJsCdnPresets: OFFICE_JS_CDN_PRESETS,
      // What the add-in HTML will actually carry, so the admin can see the
      // effective URL without reading the page source.
      officeJsResolvedUrl: resolvedOfficeJs.scriptUrl,
      // The mode that actually resolved. It differs from `officeJsMode` only
      // when the configured source is unusable and resolution fell back, which
      // the admin page surfaces rather than showing a silent contradiction.
      officeJsResolvedMode: resolvedOfficeJs.mode,
      manifestUrl: `${baseUrl}/api/integrations/office-addin/manifest.xml`,
      taskpaneUrl: `${baseUrl}/office/taskpane.html`,
      addinId: resolveOfficeAddinId(officeConfig),
      // Every installation shares this Id until an admin regenerates it, so
      // two iHub instances (dev + prod) cannot be installed side by side.
      addinIdIsShared: resolveOfficeAddinId(officeConfig) === LEGACY_OFFICE_ADDIN_ID
    });
  });

  /**
   * @swagger
   * /api/admin/office-integration/regenerate-addin-id:
   *   post:
   *     summary: Give this installation's Outlook add-in a new manifest Id
   *     description: Outlook treats a manifest with a new Id as a different add-in. Users of the
   *       add-in deployed with the previous Id must install the new manifest.
   *     tags:
   *       - Admin - Office Integration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: The new add-in Id
   */
  app.post(
    buildServerPath('/api/admin/office-integration/regenerate-addin-id'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform();
        const addinId = randomUUID();
        await savePlatformConfig({
          officeIntegration: { ...(platform?.officeIntegration || {}), addinId }
        });
        logger.info('Office add-in Id regenerated', {
          component: 'AdminOfficeIntegration',
          addinId
        });
        res.json({ addinId });
      } catch (error) {
        return sendInternalError(res, error, 'regenerate the Office add-in Id');
      }
    }
  );

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
        const clientsFile = oauthClientsFile(oauthConfig);

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
   *               starterPrompts:
   *                 type: array
   *               officeJsMode:
   *                 type: string
   *                 enum: [cdn, proxy, bundled, custom]
   *                 description: Where the add-in loads Office.js from. `proxy` makes this server fetch and cache the library so clients never contact Microsoft.
   *               officeJsCdnUrl:
   *                 type: string
   *                 description: Upstream CDN URL used by the `cdn` and `proxy` modes. Must end in /office.js.
   *               officeJsCustomUrl:
   *                 type: string
   *                 description: Absolute URL used by the `custom` mode (own CDN or artifact proxy). Must end in /office.js.
   *               startPage:
   *                 type: object
   *                 description: Which view the pane opens after sign-in (`defaultPage` — `start` or `apps`), the default chat app (`defaultAppId`) and the curated app shortcuts (`featuredAppIds`).
   *               defaultMailAction:
   *                 type: string
   *                 enum: [auto, answer, answerAll, forward, new, insert]
   *                 description: What the answer button in the task pane does by default. `auto` follows the open item — reply all in the reading pane, insert while composing. Users may override it in the pane's Settings dialog.
   *     responses:
   *       200:
   *         description: Config updated
   *       400:
   *         description: A field failed validation
   */
  app.put(buildServerPath('/api/admin/office-integration/config'), adminAuth, async (req, res) => {
    try {
      const {
        displayName,
        description,
        starterPrompts,
        officeJsMode,
        officeJsCdnUrl,
        officeJsCustomUrl,
        startPage,
        defaultMailAction
      } = req.body || {};
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
      if (officeJsMode !== undefined) {
        if (!OFFICE_JS_MODES.includes(officeJsMode)) {
          return sendBadRequest(res, `officeJsMode must be one of: ${OFFICE_JS_MODES.join(', ')}`);
        }
        allowed.officeJsMode = officeJsMode;
      }
      if (officeJsCdnUrl !== undefined) {
        const result = validateOfficeJsUrl(officeJsCdnUrl);
        if (result.error) return sendBadRequest(res, `officeJsCdnUrl: ${result.error}`);
        allowed.officeJsCdnUrl = result.value;
      }
      if (officeJsCustomUrl !== undefined) {
        // Empty clears the field; it is only read when the mode is `custom`.
        if (typeof officeJsCustomUrl === 'string' && officeJsCustomUrl.trim() === '') {
          allowed.officeJsCustomUrl = '';
        } else {
          const result = validateOfficeJsUrl(officeJsCustomUrl);
          if (result.error) return sendBadRequest(res, `officeJsCustomUrl: ${result.error}`);
          allowed.officeJsCustomUrl = result.value;
        }
      }

      // `custom` without a URL would leave the add-in with no library at all.
      const effectiveMode = allowed.officeJsMode ?? platform?.officeIntegration?.officeJsMode;
      const effectiveCustomUrl =
        allowed.officeJsCustomUrl ?? platform?.officeIntegration?.officeJsCustomUrl;
      if (effectiveMode === 'custom') {
        if (!effectiveCustomUrl) {
          return sendBadRequest(res, 'officeJsCustomUrl is required when officeJsMode is "custom"');
        }
        // Truthiness is not enough: a stored value can arrive from an
        // `IHUB_PLATFORM__…` env override without passing through this route,
        // and an invalid one would silently resolve back to the CDN.
        const stored = validateOfficeJsUrl(effectiveCustomUrl);
        if (stored.error) return sendBadRequest(res, `officeJsCustomUrl: ${stored.error}`);
      }
      if (startPage !== undefined) {
        // Replaces the whole block: the admin form always sends every field,
        // and only the known ones are stored.
        const result = validateOfficeStartPage(startPage);
        if (result.error) return sendBadRequest(res, result.error);
        allowed.startPage = result.value;
      }
      if (defaultMailAction !== undefined) {
        const result = validateOfficeMailAction(defaultMailAction);
        if (result.error) return sendBadRequest(res, result.error);
        allowed.defaultMailAction = result.value;
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

  /**
   * @swagger
   * /api/admin/office-integration/office-js/test:
   *   post:
   *     summary: Check whether Office.js URLs are reachable from this server
   *     description: |
   *       Probes each URL and reports whether this server can fetch it. This is
   *       the question that matters for the `proxy` mode, where the server does
   *       the fetching. For the `cdn` and `custom` modes the Office client
   *       fetches the library itself, so the admin page pairs this with a check
   *       from the operator's own browser.
   *
   *       Redirects are not followed and no response body is returned. An
   *       unreachable URL is a 200 response with `reachable: false`, not an error.
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
   *               urls:
   *                 type: array
   *                 items:
   *                   type: string
   *                 description: Office.js URLs to probe (each must end in /office.js)
   *     responses:
   *       200:
   *         description: One result per URL
   *       400:
   *         description: A URL failed validation
   */
  app.post(
    buildServerPath('/api/admin/office-integration/office-js/test'),
    adminAuth,
    async (req, res) => {
      try {
        const { urls } = req.body || {};
        const candidates = Array.isArray(urls) ? urls : [urls];

        if (candidates.length === 0 || candidates.length > MAX_PROBE_URLS) {
          return sendBadRequest(res, `urls must hold between 1 and ${MAX_PROBE_URLS} entries`);
        }

        // Validated up front so a typo is a 400 naming the field rather than an
        // "unreachable" result the operator would read as a network problem.
        const validated = [];
        for (const candidate of candidates) {
          const result = validateOfficeJsUrl(candidate);
          if (result.error) return sendBadRequest(res, `urls: ${result.error}`);
          validated.push(result.value);
        }

        const results = await Promise.all(
          validated.map(async url => {
            // `assertPublicTarget` rather than `assertSafeHost`: it strips the
            // brackets URL parsing leaves on an IPv6 literal, blocks localhost
            // by name, and classifies IP literals without a DNS round trip. The
            // bracket handling is load-bearing — `dns.lookup('[::1]')` fails
            // ENOTFOUND, and a guard that treats a lookup failure as
            // inconclusive would let `http://[::1]:<port>/office.js` through and
            // turn this into a loopback port scanner.
            const target = await assertPublicTarget(new URL(url));
            if (!target.ok) {
              return {
                url,
                reachable: false,
                durationMs: 0,
                error: `Refused: ${target.reason}. This check only probes public hosts.`
              };
            }
            // Pin the socket to the addresses the guard actually vetted, so a
            // name that answers public-then-private between the two lookups
            // cannot reach an internal host. (No effect when an HTTP proxy is
            // configured — the proxy does egress DNS.)
            return probeOfficeJsUrl(url, { lookup: createPinnedLookup(target.addresses) });
          })
        );

        logger.info('Office.js reachability probed', {
          component: 'AdminOfficeIntegration',
          count: results.length,
          reachable: results.filter(r => r.reachable).length
        });

        res.json({ results });
      } catch (error) {
        return sendInternalError(res, error, 'test Office.js URLs');
      }
    }
  );
}
