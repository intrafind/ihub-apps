import { join } from 'path';
import { promises as fs } from 'fs';
import archiver from 'archiver';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath, getBasePath } from '../../utils/basePath.js';
import { createOAuthClient, updateOAuthClient } from '../../utils/oauthClientManager.js';
import {
  generateExtensionSigningKey,
  extensionIdFromPublicKeyBase64,
  packCrx3
} from '../../utils/chromeExtensionId.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest, sendNotFound } from '../../utils/responseHelpers.js';

// The browser extension uses a fixed redirect URI scheme:
//   https://<extension-id>.chromiumapp.org/cb     (Chrome / Edge)
//   https://<extension-id>.extensions.allizom.org/cb  (Firefox)
// Two sources feed the OAuth client's redirect URI allowlist:
//   1. browserExtension.signingKey.extensionId — the deterministic ID for the
//      packaged build the iHub server hands out (one ID for everyone).
//   2. browserExtension.extensionIds — manually-loaded unpacked dev builds
//      (each developer's machine assigns its own ID).
// They are unioned by buildAllRedirectUris() below.

const SIGNING_KEY_FILE = '.browser-extension-key.pem';

function signingKeyPath() {
  return join(getRootDir(), 'contents', SIGNING_KEY_FILE);
}

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

/**
 * Build the full deduplicated redirect-URI allowlist from the manual
 * `extensionIds` array plus the signing-key-derived extension ID(s).
 * `signingKey.previousExtensionId` is honoured for one rotation cycle so
 * users on the old build can still authenticate while they update.
 */
function buildAllRedirectUris(extensionIds, signingKey) {
  const ids = Array.isArray(extensionIds) ? [...extensionIds] : [];
  if (signingKey?.extensionId) ids.push(signingKey.extensionId);
  if (signingKey?.previousExtensionId) ids.push(signingKey.previousExtensionId);
  return Array.from(new Set(buildRedirectUrisFromExtensionIds(ids)));
}

/**
 * Read the on-disk private key PEM. Returns null when no key has been
 * generated yet (Enable hasn't been clicked, or the file was deleted).
 */
async function readSigningPrivateKey() {
  try {
    return await fs.readFile(signingKeyPath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Lazily ensure a signing keypair exists on disk + in platform config.
 *
 * Idempotent: when both the on-disk PEM and the public key in config are
 * present, it returns them as-is. Otherwise it generates a fresh keypair,
 * writes the private PEM with mode 0o600, and returns the public half.
 *
 * @param {Object|undefined} currentSigningKey - Existing signingKey from platform config
 * @returns {Promise<{ publicKey: string, extensionId: string, createdAt: string }>}
 */
async function ensureSigningKey(currentSigningKey) {
  const existingPem = await readSigningPrivateKey();
  if (existingPem && currentSigningKey?.publicKey && currentSigningKey?.extensionId) {
    return currentSigningKey;
  }
  const { privateKeyPem, publicKeySpkiBase64, extensionId } = generateExtensionSigningKey();
  await fs.writeFile(signingKeyPath(), privateKeyPem, { mode: 0o600 });
  return {
    publicKey: publicKeySpkiBase64,
    extensionId,
    createdAt: new Date().toISOString()
  };
}

/**
 * Generate a fresh signing keypair, replacing any existing one. Moves the
 * previous extensionId into `previousExtensionId` so users on the old build
 * keep working until their next refresh / install.
 *
 * @param {Object|undefined} currentSigningKey
 */
async function rotateSigningKey(currentSigningKey) {
  const { privateKeyPem, publicKeySpkiBase64, extensionId } = generateExtensionSigningKey();
  await fs.writeFile(signingKeyPath(), privateKeyPem, { mode: 0o600 });
  return {
    publicKey: publicKeySpkiBase64,
    extensionId,
    createdAt: new Date().toISOString(),
    previousExtensionId: currentSigningKey?.extensionId || undefined
  };
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

    // Re-derive extensionId on the fly in case the stored value drifted
    // from the public key (e.g. someone hand-edited platform.json).
    let signingKey = null;
    if (cfg.signingKey?.publicKey) {
      const derivedId = extensionIdFromPublicKeyBase64(cfg.signingKey.publicKey);
      signingKey = {
        publicKey: cfg.signingKey.publicKey,
        extensionId: derivedId,
        createdAt: cfg.signingKey.createdAt || null,
        previousExtensionId: cfg.signingKey.previousExtensionId || null
      };
    }

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
      signingKey,
      downloadAvailable: Boolean(cfg.enabled && signingKey?.extensionId),
      downloadZipUrl: `${baseUrl}/api/admin/browser-extension/download.zip`,
      downloadCrxUrl: `${baseUrl}/api/admin/browser-extension/download.crx`,
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
      // Signing-key generation is opt-in via /rotate-key. Unpacked dev
      // installs only need the manual extensionIds → redirect URIs path; the
      // signing key is only required for the packaged-download flow.
      const signingKey = cfg.signingKey || null;
      const redirectUris = buildAllRedirectUris(extensionIds, signingKey);

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
          allowedGroups,
          signingKey
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
        const newRedirectUris = buildAllRedirectUris(merged.extensionIds || [], merged.signingKey);
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

  /**
   * @swagger
   * /api/admin/browser-extension/rotate-key:
   *   post:
   *     summary: Rotate the browser extension signing key (changes the extension ID)
   *     description: |
   *       Generates a new RSA signing key. The derived extension ID changes, so
   *       previously-installed packaged copies will need to be reinstalled (or
   *       wait for a refresh). The previous extension ID is kept in the OAuth
   *       client's redirect URI allowlist for one rotation cycle as a grace
   *       period — rotate again to drop it.
   *     tags:
   *       - Admin - Browser Extension
   */
  app.post(
    buildServerPath('/api/admin/browser-extension/rotate-key'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform();
        const cfg = platform?.browserExtension || {};

        const newSigningKey = await rotateSigningKey(cfg.signingKey);
        const extensionIds = Array.isArray(cfg.extensionIds) ? cfg.extensionIds : [];
        const allowedGroups = Array.isArray(cfg.allowedGroups)
          ? cfg.allowedGroups
          : ['browser-extension'];

        // Resync the OAuth client redirect URIs to include the new ID + the
        // previous ID (one-cycle grace period) + manual side-load IDs.
        if (cfg.oauthClientId) {
          const oauthConfig = platform?.oauth || {};
          const clientsFile = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
          try {
            await updateOAuthClient(
              cfg.oauthClientId,
              {
                redirectUris: buildAllRedirectUris(extensionIds, newSigningKey),
                allowedGroups
              },
              clientsFile,
              req.user?.id || 'admin'
            );
          } catch (err) {
            logger.warn('Failed to resync OAuth client after extension key rotation', {
              component: 'AdminBrowserExtension',
              error: err
            });
          }
        }

        await savePlatformConfig({
          browserExtension: {
            ...cfg,
            signingKey: newSigningKey
          }
        });

        logger.warn('Browser extension signing key rotated', {
          component: 'AdminBrowserExtension',
          newExtensionId: newSigningKey.extensionId,
          previousExtensionId: newSigningKey.previousExtensionId || null
        });

        res.json({
          message: 'Browser extension signing key rotated',
          signingKey: {
            extensionId: newSigningKey.extensionId,
            publicKey: newSigningKey.publicKey,
            createdAt: newSigningKey.createdAt,
            previousExtensionId: newSigningKey.previousExtensionId || null
          }
        });
      } catch (error) {
        return sendInternalError(res, error, 'rotate browser extension signing key');
      }
    }
  );

  /**
   * Build the byte stream for a customised browser-extension package and
   * return both the buffered ZIP and the manifest used. Shared between the
   * .zip and .crx download endpoints.
   */
  async function buildExtensionZipBuffer({ req, cfg }) {
    const baseUrl = buildPublicBaseUrl(req);
    const extDir = join(getRootDir(), 'browser-extension');
    const distDir = join(getRootDir(), 'client', 'dist');
    const distExtensionDir = join(distDir, 'extension');
    const distAssetsDir = join(distDir, 'assets');

    // The packaged extension layout combines:
    //   * `manifest.json`   — rewritten here with the signing-key `key` field
    //   * `background.js`   — service-worker source, shipped verbatim
    //   * `icons/`          — source icons
    //   * `extension/sidepanel.html`, `extension/options.html`
    //                       — built React entries from `client/dist/extension/`
    //   * `extension/runtime-config.js`
    //                       — generated below; baked iHub URL + OAuth client
    //   * `assets/*`        — Vite-built JS/CSS chunks the HTML references
    //
    // The Vite build must have been run before this endpoint is hit. If
    // `client/dist/extension/sidepanel.html` is missing the admin UI shows
    // a clear "build the client first" error rather than a half-baked ZIP.
    const distSidepanel = join(distExtensionDir, 'sidepanel.html');
    try {
      await fs.access(distSidepanel);
    } catch {
      throw new Error(
        `Built extension assets not found at ${distSidepanel}. Run \`npm run build\` (or \`cd client && npx vite build\`) first.`
      );
    }

    // Bump the manifest version on each download so Chrome reloads the SW
    // with the new runtime-config. Append a build-stamp segment derived from
    // the current minute since epoch — fits Chrome's 4-dotted-int rule.
    const sourceManifest = JSON.parse(await fs.readFile(join(extDir, 'manifest.json'), 'utf8'));
    const buildStamp = Math.floor(Date.now() / 60000) % 100000;
    const baseVersion = String(sourceManifest.version || '0.1.0').replace(/[^0-9.]/g, '');
    const versionParts = baseVersion.split('.').filter(Boolean).slice(0, 3);
    while (versionParts.length < 3) versionParts.push('0');
    const downloadVersion = `${versionParts.join('.')}.${buildStamp}`;

    const manifest = {
      ...sourceManifest,
      version: downloadVersion,
      version_name: `${sourceManifest.version || '0.1.0'} (built ${new Date().toISOString()})`,
      key: cfg.signingKey.publicKey
    };

    const runtimeConfig = {
      baseUrl,
      clientId: cfg.oauthClientId || '',
      displayName: cfg.displayName || {},
      description: cfg.description || {},
      starterPrompts: Array.isArray(cfg.starterPrompts) ? cfg.starterPrompts : [],
      bakedAt: new Date().toISOString()
    };
    const runtimeConfigJs =
      '// Generated by /api/admin/browser-extension/download — do not edit by hand.\n' +
      `globalThis.IHUB_RUNTIME_CONFIG = ${JSON.stringify(runtimeConfig, null, 2)};\n`;

    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('warning', err => {
      if (err.code !== 'ENOENT') throw err;
    });

    // 1. Source files from browser-extension/: SW + icons. Skip the manifest
    //    (rewritten below) and the placeholder runtime-config.js (the React
    //    side panel reads its config from extension/runtime-config.js).
    archive.glob('**/*', {
      cwd: extDir,
      ignore: ['manifest.json', 'runtime-config.js']
    });

    // 2. Built React entries — landed at client/dist/extension/. Skip the
    //    placeholder runtime-config.js shipped by `client/public/extension/`;
    //    we generate the customised version below.
    archive.directory(distExtensionDir, 'extension', entry => {
      if (entry.name === 'runtime-config.js') return false;
      return entry;
    });

    // 3. Vite-built JS/CSS chunks — referenced by the entry HTML as ../assets/*.
    archive.directory(distAssetsDir, 'assets');

    // 4. Generated manifest.json (with `key` for fixed extension ID) +
    //    generated runtime-config.js next to the side panel HTML.
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.append(runtimeConfigJs, { name: 'extension/runtime-config.js' });

    await archive.finalize();
    return Buffer.concat(chunks);
  }

  /**
   * @swagger
   * /api/admin/browser-extension/download.zip:
   *   get:
   *     summary: Download the customised browser extension as an unsigned ZIP
   *     description: |
   *       Returns a ZIP containing the browser-extension folder with the
   *       deployment's iHub base URL, OAuth client ID and starter prompts
   *       baked in. End users unzip the file, "Load unpacked" in Chrome /
   *       Edge, and sign in. The extension ID is fixed by the manifest.key
   *       field, so this same ZIP works for everyone in the organization
   *       without per-user setup.
   *     tags:
   *       - Admin - Browser Extension
   */
  app.get(
    buildServerPath('/api/admin/browser-extension/download.zip'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform();
        const cfg = platform?.browserExtension || {};
        if (!cfg.enabled || !cfg.signingKey?.publicKey) {
          return sendNotFound(res, 'Browser extension is not enabled or has no signing key');
        }

        const zipBuffer = await buildExtensionZipBuffer({ req, cfg });
        const filename = `ihub-extension-${cfg.signingKey.extensionId}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(zipBuffer);

        logger.info('Browser extension package downloaded', {
          component: 'AdminBrowserExtension',
          format: 'zip',
          extensionId: cfg.signingKey.extensionId,
          userId: req.user?.id || 'admin'
        });
      } catch (error) {
        return sendInternalError(res, error, 'download browser extension package');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/browser-extension/download.crx:
   *   get:
   *     summary: Download the customised browser extension as a signed .crx3
   *     description: |
   *       Returns a CRX3-signed package suitable for hosting on an internal
   *       URL and pushing to managed devices via Chrome / Edge enterprise
   *       policy. End users can also drag-and-drop the file into
   *       chrome://extensions for a single-click install. The CRX is signed
   *       with the same RSA key whose public half lives in manifest.key.
   *     tags:
   *       - Admin - Browser Extension
   */
  app.get(
    buildServerPath('/api/admin/browser-extension/download.crx'),
    adminAuth,
    async (req, res) => {
      try {
        const platform = configCache.getPlatform();
        const cfg = platform?.browserExtension || {};
        if (!cfg.enabled || !cfg.signingKey?.publicKey) {
          return sendNotFound(res, 'Browser extension is not enabled or has no signing key');
        }
        const privateKeyPem = await readSigningPrivateKey();
        if (!privateKeyPem) {
          return sendNotFound(
            res,
            'Signing private key not found on disk. Re-enable the integration to regenerate it.'
          );
        }

        const zipBuffer = await buildExtensionZipBuffer({ req, cfg });
        const publicKeyDer = Buffer.from(cfg.signingKey.publicKey, 'base64');
        const crxBuffer = packCrx3({ zipBuffer, publicKeyDer, privateKeyPem });

        const filename = `ihub-extension-${cfg.signingKey.extensionId}.crx`;
        res.setHeader('Content-Type', 'application/x-chrome-extension');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(crxBuffer);

        logger.info('Browser extension package downloaded', {
          component: 'AdminBrowserExtension',
          format: 'crx',
          extensionId: cfg.signingKey.extensionId,
          userId: req.user?.id || 'admin'
        });
      } catch (error) {
        return sendInternalError(res, error, 'download browser extension package (crx)');
      }
    }
  );
}
