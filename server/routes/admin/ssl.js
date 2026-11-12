// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

export default function registerAdminSSLRoutes(app) {
  /**
   * @swagger
   * /api/admin/ssl/config:
   *   get:
   *     summary: Get current SSL configuration
   *     tags: [Admin - SSL]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Current SSL configuration
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ignoreInvalidCertificates:
   *                   type: boolean
   *                   description: Whether to ignore invalid SSL certificates
   *                 domainWhitelist:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: List of domains to bypass SSL validation
   */
  app.get(buildServerPath('/api/admin/ssl/config'), adminAuth, async (req, res) => {
    const platformConfig = configCache.getPlatform() || {};
    const sslConfig = platformConfig.ssl || {
      ignoreInvalidCertificates: false,
      domainWhitelist: []
    };

    res.json(sslConfig);
  });

  /**
   * @swagger
   * /api/admin/ssl/config:
   *   put:
   *     summary: Update SSL configuration
   *     tags: [Admin - SSL]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               ignoreInvalidCertificates:
   *                 type: boolean
   *                 description: Whether to ignore invalid SSL certificates
   *               domainWhitelist:
   *                 type: array
   *                 items:
   *                   type: string
   *                 description: List of domains to bypass SSL validation
   *     responses:
   *       200:
   *         description: SSL configuration updated successfully
   *       400:
   *         description: Invalid SSL configuration
   */
  app.put(buildServerPath('/api/admin/ssl/config'), adminAuth, async (req, res) => {
    const { ignoreInvalidCertificates, domainWhitelist } = req.body;

    // Validate configuration
    if (typeof ignoreInvalidCertificates !== 'boolean') {
      throw new ServiceError(
        'BAD_REQUEST',
        'Invalid SSL configuration: ignoreInvalidCertificates must be a boolean'
      );
    }

    if (!Array.isArray(domainWhitelist)) {
      throw new ServiceError(
        'BAD_REQUEST',
        'Invalid SSL configuration: domainWhitelist must be an array'
      );
    }

    // Validate domain patterns
    for (const domain of domainWhitelist) {
      if (typeof domain !== 'string' || !domain.trim()) {
        throw new ServiceError(
          'BAD_REQUEST',
          'Invalid SSL configuration: all domains must be non-empty strings'
        );
      }
    }

    // Update SSL configuration
    await updatePlatform({
      ssl: {
        ignoreInvalidCertificates,
        domainWhitelist
      }
    });

    // Refresh config cache
    await configCache.refreshCacheEntry('config/platform.json');

    logger.info('SSL configuration updated', {
      component: 'AdminSSL',
      ignoreInvalidCertificates,
      domainWhitelist
    });

    res.json({
      ignoreInvalidCertificates,
      domainWhitelist
    });
  });
}
