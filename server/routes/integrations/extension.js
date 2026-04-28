// Browser Extension Integration Routes
// Serves runtime configuration the extension needs before OAuth can start.

import express from 'express';
import { requireFeature } from '../../featureRegistry.js';
import { getBasePath } from '../../utils/basePath.js';
import configCache from '../../configCache.js';

const router = express.Router();

// Gate behind the integrations feature flag (consistent with the Office add-in)
router.use(requireFeature('integrations'));

function buildPublicBaseUrl(req) {
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const host = req.get('X-Forwarded-Host') || req.get('host');
  const basePath = getBasePath();
  return `${proto}://${host}${basePath}`;
}

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

/**
 * @swagger
 * /api/integrations/extension/config:
 *   get:
 *     summary: Get browser extension runtime configuration
 *     description: Returns runtime configuration the browser extension needs before it can authenticate. No authentication required.
 *     tags:
 *       - Integrations - Browser Extension
 *     responses:
 *       200:
 *         description: Runtime configuration object
 *       404:
 *         description: Browser extension integration not enabled
 */
router.get('/config', (req, res) => {
  const platform = configCache.getPlatform();
  const cfg = platform?.extensionIntegration;

  if (!cfg?.enabled) {
    return res.status(404).json({ error: 'Browser extension integration is not enabled' });
  }

  const baseUrl = buildPublicBaseUrl(req);

  res.json({
    baseUrl,
    clientId: cfg.oauthClientId || '',
    displayName: sanitizeLocalizedObject(cfg.displayName),
    description: sanitizeLocalizedObject(cfg.description),
    starterPrompts: sanitizeStarterPrompts(cfg.starterPrompts)
  });
});

export default router;
