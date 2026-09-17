// Nextcloud Embed Integration Routes
// Serves the runtime configuration the embedded iHub UI fetches on boot. This
// is a separate surface from `routes/integrations/nextcloud.js`, which
// provides the WebDAV-backed file picker used by the existing cloud-storage
// flow. The embed routes describe iHub-as-an-iframe-inside-Nextcloud; the
// cloud-storage routes describe Nextcloud-as-a-file-source inside iHub.
//
// The Nextcloud-side app skeleton ships a static `appinfo/info.xml` already
// (`nextcloud-app/appinfo/info.xml`); we deliberately do NOT generate one
// dynamically. A generator would drift from the scaffold and confuse admins
// who follow the docs.

import express from 'express';
import { requireFeature } from '../../featureRegistry.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import configCache from '../../configCache.js';

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

export default router;
