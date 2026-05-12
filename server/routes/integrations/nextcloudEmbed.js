// Nextcloud Embed Integration Routes
// Serves runtime configuration and generates the Nextcloud appinfo/info.xml
// for the Nextcloud-side app shell. This is a separate surface from
// `routes/integrations/nextcloud.js`, which provides the WebDAV-backed
// file picker used by the existing cloud-storage flow. The embed routes
// describe iHub-as-an-iframe-inside-Nextcloud; the cloud-storage routes
// describe Nextcloud-as-a-file-source inside iHub.

import express from 'express';
import { requireFeature } from '../../featureRegistry.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import configCache from '../../configCache.js';
import { getLocalizedContent } from '../../../shared/localize.js';
import logger from '../../utils/logger.js';

const router = express.Router();

router.use(requireFeature('integrations'));

/**
 * Keep only `{ [lang: string]: string }` entries. Defensive sanitizer used on
 * the public embed config endpoint so a manually corrupted platform.json can't
 * crash the embed during rendering.
 */
function sanitizeLocalizedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [lang, val] of Object.entries(value)) {
    if (typeof lang === 'string' && typeof val === 'string') out[lang] = val;
  }
  return out;
}

function sanitizeStarterPrompts(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const title = sanitizeLocalizedObject(item.title);
    const message = sanitizeLocalizedObject(item.message);
    if (Object.keys(title).length === 0 || Object.keys(message).length === 0) continue;
    out.push({ title, message });
  }
  return out;
}

function sanitizeAllowedOrigins(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    // Admin route already canonicalizes on save, but defend in depth in case
    // someone hand-edits platform.json.
    try {
      const u = new URL(item);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      out.push(u.origin);
    } catch {
      /* ignore malformed entry */
    }
  }
  return out;
}

/**
 * @swagger
 * /api/integrations/nextcloud-embed/config:
 *   get:
 *     summary: Get Nextcloud embed runtime configuration
 *     description: Returns runtime configuration the embedded iHub UI needs to bootstrap inside Nextcloud. No authentication required.
 *     tags:
 *       - Integrations - Nextcloud Embed
 *     responses:
 *       200:
 *         description: Runtime configuration object
 *       404:
 *         description: Nextcloud embed integration not enabled
 */
router.get('/config', (req, res) => {
  const platform = configCache.getPlatform();
  const cfg = platform?.nextcloudEmbed;

  if (!cfg?.enabled) {
    return res.status(404).json({ error: 'Nextcloud embed integration is not enabled' });
  }

  const baseUrl = buildPublicBaseUrl(req);

  res.json({
    baseUrl,
    clientId: cfg.oauthClientId || '',
    redirectUri: `${baseUrl}/nextcloud/callback.html`,
    displayName: sanitizeLocalizedObject(cfg.displayName),
    description: sanitizeLocalizedObject(cfg.description),
    starterPrompts: sanitizeStarterPrompts(cfg.starterPrompts),
    allowedHostOrigins: sanitizeAllowedOrigins(cfg.allowedHostOrigins)
  });
});

/**
 * @swagger
 * /api/integrations/nextcloud-embed/info.xml:
 *   get:
 *     summary: Get Nextcloud app info.xml
 *     description: Dynamically generates the Nextcloud appinfo/info.xml with the embed URL baked in.
 *     tags:
 *       - Integrations - Nextcloud Embed
 *     responses:
 *       200:
 *         description: Nextcloud app info.xml
 *         content:
 *           application/xml:
 *             schema:
 *               type: string
 *       404:
 *         description: Nextcloud embed integration not enabled
 */
router.get('/info.xml', (req, res) => {
  const platform = configCache.getPlatform();
  const cfg = platform?.nextcloudEmbed;

  if (!cfg?.enabled) {
    return res.status(404).json({ error: 'Nextcloud embed integration is not enabled' });
  }

  const baseUrl = buildPublicBaseUrl(req);
  const lang = req.acceptsLanguages('de', 'en') === 'de' ? 'de' : 'en';
  const displayName = getLocalizedContent(cfg.displayName, lang) || 'iHub Apps';
  const description =
    getLocalizedContent(cfg.description, lang) || 'AI-powered assistant for Nextcloud';

  logger.debug('Generating Nextcloud appinfo/info.xml', {
    component: 'NextcloudEmbedRoutes',
    baseUrl,
    displayName
  });

  const xml = generateInfoXml({ baseUrl, displayName, description });

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="info.xml"');
  res.send(xml);
});

function generateInfoXml({ baseUrl, displayName, description }) {
  // We deliberately mirror the shape of `nextcloud-app/appinfo/info.xml`
  // that ships in this repo (Nextcloud 28-33, navigation entry, no
  // settings/embed-url fields). Admins are supposed to drop this file
  // into their app skeleton, so anything we emit that the skeleton
  // doesn't implement just causes confusion or install-time errors.
  //
  // The `<description>` element uses standard XML escaping rather than a
  // CDATA section so an admin-supplied description containing `]]>` can't
  // truncate the CDATA early and produce malformed XML. We don't need
  // CDATA: the description is short prose that escapes cleanly.
  // `baseUrl` is unused in the generated XML; the embed URL lives on the
  // JS bundle, configured via `occ config:app:set ihub_chat ihub_base_url`.
  void baseUrl;
  return `<?xml version="1.0"?>
<info xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:noNamespaceSchemaLocation="https://apps.nextcloud.com/schema/apps/info.xsd">
  <id>ihub_chat</id>
  <name>${escapeXml(displayName)}</name>
  <summary>${escapeXml(description)}</summary>
  <description>${escapeXml(description)}</description>
  <version>1.0.0</version>
  <licence>agpl</licence>
  <author>intrafind</author>
  <namespace>IhubChat</namespace>
  <category>integration</category>
  <bugs>https://github.com/intrafind/ihub-apps/issues</bugs>
  <dependencies>
    <nextcloud min-version="28" max-version="33"/>
  </dependencies>
  <navigations>
    <navigation>
      <name>${escapeXml(displayName)}</name>
      <route>ihub_chat.page.index</route>
    </navigation>
  </navigations>
</info>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default router;
