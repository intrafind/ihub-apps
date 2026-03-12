import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { buildServerPath } from '../../utils/basePath.js';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

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
    try {
      const platformConfig = configCache.getPlatform() || {};
      const sslConfig = platformConfig.ssl || {
        ignoreInvalidCertificates: false,
        domainWhitelist: []
      };

      res.json(sslConfig);
    } catch (error) {
      return sendInternalError(res, error, 'get SSL configuration');
    }
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
    try {
      const { ignoreInvalidCertificates, domainWhitelist } = req.body;

      // Validate configuration
      if (typeof ignoreInvalidCertificates !== 'boolean') {
        return sendBadRequest(
          res,
          'Invalid SSL configuration: ignoreInvalidCertificates must be a boolean'
        );
      }

      if (!Array.isArray(domainWhitelist)) {
        return sendBadRequest(res, 'Invalid SSL configuration: domainWhitelist must be an array');
      }

      // Validate domain patterns
      for (const domain of domainWhitelist) {
        if (typeof domain !== 'string' || !domain.trim()) {
          return sendBadRequest(
            res,
            'Invalid SSL configuration: all domains must be non-empty strings'
          );
        }
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const platformPath = join(rootDir, contentsDir, 'config', 'platform.json');

      // Read current platform config
      const platformContent = await fs.readFile(platformPath, 'utf8');
      const platformConfig = JSON.parse(platformContent);

      // Update SSL configuration
      platformConfig.ssl = {
        ignoreInvalidCertificates,
        domainWhitelist
      };

      // Write back atomically
      await atomicWriteJSON(platformPath, platformConfig);

      // Refresh config cache
      await configCache.refreshCacheEntry('config/platform.json');

      logger.info('SSL configuration updated', {
        component: 'AdminSSL',
        ignoreInvalidCertificates,
        domainWhitelist
      });

      res.json({
        message: 'SSL configuration updated successfully',
        config: {
          ignoreInvalidCertificates,
          domainWhitelist
        }
      });
    } catch (error) {
      return sendInternalError(res, error, 'update SSL configuration');
    }
  });
}
