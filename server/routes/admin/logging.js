// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { buildServerPath } from '../../utils/basePath.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

export default function registerAdminLoggingRoutes(app) {
  /**
   * @swagger
   * /api/admin/logging/config:
   *   get:
   *     summary: Get complete logging configuration
   *     tags: [Admin - Logging]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Logging configuration
   */
  app.get(buildServerPath('/api/admin/logging/config'), adminAuth, (req, res) => {
    const platformConfig = configCache.getPlatform();
    const loggingConfig = platformConfig?.logging || {
      level: 'info',
      format: 'json',
      file: {
        enabled: false,
        path: 'logs/app.log',
        maxSize: 10485760,
        maxFiles: 5
      }
    };

    res.json(loggingConfig);
  });

  /**
   * @swagger
   * /api/admin/logging/config:
   *   put:
   *     summary: Update complete logging configuration
   *     tags: [Admin - Logging]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               level:
   *                 type: string
   *               file:
   *                 type: object
   *                 properties:
   *                   enabled:
   *                     type: boolean
   *                   path:
   *                     type: string
   *                   maxSize:
   *                     type: number
   *                   maxFiles:
   *                     type: number
   *     responses:
   *       200:
   *         description: Logging configuration updated
   */
  app.put(buildServerPath('/api/admin/logging/config'), adminAuth, async (req, res) => {
    const newLoggingConfig = req.body;

    // Update logging config
    const { data: platformConfig } = await updatePlatform(platformConfig => {
      platformConfig.logging = {
        ...platformConfig.logging,
        ...newLoggingConfig
      };
    });

    // Refresh config cache
    await configCache.refreshCacheEntry('config/platform.json');

    // Reconfigure logger to pick up changes
    logger.reconfigureLogger();

    logger.info('Logging configuration updated', { component: 'AdminLogging', newLoggingConfig });

    res.json(platformConfig.logging);
  });
}
