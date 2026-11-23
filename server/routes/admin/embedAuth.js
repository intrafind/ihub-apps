// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Administration of the sign-in for iHub in a frame of another site (Admin → Integrations →
 * iHub in another site). The feature itself is `routes/embedAuth.js`; this is its switch and the
 * list of sites that may show iHub in a frame (`utils/embedAuth.js`).
 *
 * Saved settings are in force at once: the routes and the app pages read them per request.
 *
 * @module routes/admin/embedAuth
 */

import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';
import { sanitizeHostOrigins } from '../../utils/hostOrigins.js';
import { getEmbedAuthOrigins } from '../../utils/embedAuth.js';

const CONFIG_PATH = '/api/admin/embed-auth/config';

/**
 * The settings as the page shows them.
 *
 * @param {object} [platform] - The platform configuration.
 * @returns {{enabled: boolean, allowedHostOrigins: string[], active: boolean}} `active` is whether
 *   the sign-in in a frame is in force: switched on and at least one origin allowed.
 */
function toResource(platform) {
  const cfg = platform?.embedAuth || {};
  return {
    enabled: cfg.enabled === true,
    allowedHostOrigins: Array.isArray(cfg.allowedHostOrigins)
      ? cfg.allowedHostOrigins.filter(origin => typeof origin === 'string')
      : [],
    active: getEmbedAuthOrigins(platform).length > 0
  };
}

export default function registerAdminEmbedAuthRoutes(app) {
  /**
   * @swagger
   * /admin/embed-auth/config:
   *   get:
   *     summary: Get the settings of the sign-in for iHub in a frame of another site
   *     description: >
   *       Admin only. `active` is true while the sign-in in a frame is in force: switched on, and at
   *       least one host origin allowed.
   *     tags:
   *       - Admin - Embed Auth
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: The settings
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled: { type: boolean }
   *                 allowedHostOrigins: { type: array, items: { type: string } }
   *                 active: { type: boolean }
   */
  app.get(buildServerPath(CONFIG_PATH), adminAuth, (req, res) => {
    res.json(toResource(configCache.getPlatform()));
  });

  /**
   * @swagger
   * /admin/embed-auth/config:
   *   put:
   *     summary: Replace the settings of the sign-in for iHub in a frame of another site
   *     description: >
   *       Admin only. Both fields are required: the page sends its whole state. Origins are
   *       canonicalised and de-duplicated; each must be an `http(s)` origin without path, query,
   *       fragment or credentials, at most 50 of them. The change is in force at once.
   *     tags:
   *       - Admin - Embed Auth
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [enabled, allowedHostOrigins]
   *             properties:
   *               enabled: { type: boolean }
   *               allowedHostOrigins: { type: array, items: { type: string } }
   *     responses:
   *       200:
   *         description: The settings now stored
   *       400:
   *         description: "`BAD_REQUEST`, a field is missing or invalid"
   */
  app.put(buildServerPath(CONFIG_PATH), adminAuth, async (req, res) => {
    const { enabled, allowedHostOrigins } = req.body || {};
    if (typeof enabled !== 'boolean') {
      throw new ServiceError('BAD_REQUEST', 'enabled must be a boolean');
    }
    if (allowedHostOrigins === undefined) {
      throw new ServiceError('BAD_REQUEST', 'allowedHostOrigins is required');
    }
    const origins = sanitizeHostOrigins(allowedHostOrigins);

    // Merged into what is stored, so a key of the block that this page does not know survives.
    await updatePlatform(draft => {
      draft.embedAuth = { ...(draft.embedAuth || {}), enabled, allowedHostOrigins: origins };
    });
    await configCache.refreshCacheEntry('config/platform.json');

    logAudit({
      req,
      action: 'update',
      resource: 'platform',
      resourceId: 'embedAuth',
      summary: enabled
        ? `Sign-in for iHub in a frame of another site is on; allowed hosts: ${
            origins.length > 0 ? origins.join(', ') : 'none'
          }`
        : 'Sign-in for iHub in a frame of another site is off'
    });
    logger.info('Embed auth settings updated', {
      component: 'AdminEmbedAuth',
      enabled,
      origins: origins.length
    });

    res.json(toResource(configCache.getPlatform()));
  });
}
