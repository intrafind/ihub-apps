import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

export default function registerAdminLoggingRoutes(app, basePath = '') {
  /**
   * @swagger
   * /api/admin/logging/level:
   *   get:
   *     summary: Get current log level and available levels
   *     tags: [Admin - Logging]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Current log level information
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 current:
   *                   type: string
   *                   description: Current log level
   *                 available:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: Available log levels
   */
  app.get(`${basePath}/api/admin/logging/level`, adminAuth, (req, res) => {
    try {
      const levelInfo = logger.getLogLevelInfo();
      res.json(levelInfo);
    } catch (error) {
      logger.error('Error getting log level:', error);
      res.status(500).json({ error: 'Failed to get log level' });
    }
  });

  /**
   * @swagger
   * /api/admin/logging/level:
   *   put:
   *     summary: Update log level
   *     tags: [Admin - Logging]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - level
   *             properties:
   *               level:
   *                 type: string
   *                 enum: [error, warn, info, http, verbose, debug, silly]
   *               persist:
   *                 type: boolean
   *                 default: true
   *                 description: Whether to persist the change to platform.json
   *     responses:
   *       200:
   *         description: Log level updated successfully
   *       400:
   *         description: Invalid log level
   */
  app.put(`${basePath}/api/admin/logging/level`, adminAuth, async (req, res) => {
    try {
      const { level, persist = true } = req.body;

      // Validate log level
      const validLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
      if (!validLevels.includes(level)) {
        return res.status(400).json({
          error: 'Invalid log level',
          validLevels
        });
      }

      // Update logger immediately
      logger.setLogLevel(level);
      logger.info(`Log level changed to: ${level}`);

      // Optionally persist to platform.json
      if (persist) {
        const rootDir = getRootDir();
        const contentsDir = process.env.CONTENTS_DIR || 'contents';
        const platformPath = join(rootDir, contentsDir, 'config', 'platform.json');

        // Read current platform config
        const platformContent = await fs.readFile(platformPath, 'utf8');
        const platformConfig = JSON.parse(platformContent);

        // Update logging level
        if (!platformConfig.logging) {
          platformConfig.logging = {};
        }
        platformConfig.logging.level = level;

        // Write back atomically
        await atomicWriteJSON(platformPath, platformConfig);

        // Refresh config cache
        await configCache.refreshCacheEntry('config/platform.json');

        // Reconfigure logger to pick up any other changes
        logger.reconfigureLogger();

        logger.info(`Log level persisted to platform.json: ${level}`);
      }

      res.json({
        success: true,
        level,
        persisted: persist,
        message: `Log level updated to ${level}${persist ? ' and saved to configuration' : ' (runtime only)'}`
      });
    } catch (error) {
      logger.error('Error updating log level:', error);
      res.status(500).json({ error: 'Failed to update log level' });
    }
  });

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
  app.get(`${basePath}/api/admin/logging/config`, adminAuth, (req, res) => {
    try {
      const platformConfig = configCache.get('platform');
      const loggingConfig = platformConfig?.logging || {
        level: 'info',
        file: {
          enabled: false,
          path: 'logs/app.log',
          maxSize: 10485760,
          maxFiles: 5
        }
      };

      res.json(loggingConfig);
    } catch (error) {
      logger.error('Error getting logging config:', error);
      res.status(500).json({ error: 'Failed to get logging configuration' });
    }
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
  app.put(`${basePath}/api/admin/logging/config`, adminAuth, async (req, res) => {
    try {
      const newLoggingConfig = req.body;

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const platformPath = join(rootDir, contentsDir, 'config', 'platform.json');

      // Read current platform config
      const platformContent = await fs.readFile(platformPath, 'utf8');
      const platformConfig = JSON.parse(platformContent);

      // Update logging config
      platformConfig.logging = {
        ...platformConfig.logging,
        ...newLoggingConfig
      };

      // Write back atomically
      await atomicWriteJSON(platformPath, platformConfig);

      // Refresh config cache
      await configCache.refreshCacheEntry('config/platform.json');

      // Reconfigure logger to pick up changes
      logger.reconfigureLogger();

      logger.info('Logging configuration updated:', newLoggingConfig);

      res.json({
        success: true,
        config: platformConfig.logging,
        message: 'Logging configuration updated successfully'
      });
    } catch (error) {
      logger.error('Error updating logging config:', error);
      res.status(500).json({ error: 'Failed to update logging configuration' });
    }
  });
}
