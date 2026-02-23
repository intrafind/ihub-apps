import { promises as fs } from 'fs';
import { join } from 'path';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { resolveFeatures, featureCategories, featureRegistry } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';

export default function registerAdminFeaturesRoutes(app) {
  /**
   * @swagger
   * /api/admin/features:
   *   get:
   *     summary: Get feature flags with metadata
   *     description: Returns the resolved feature list with registry metadata and categories
   *     tags:
   *       - Admin - Features
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Feature list with categories
   *       401:
   *         description: Admin authentication required
   */
  app.get(buildServerPath('/api/admin/features'), adminAuth, (req, res) => {
    const featureConfig = configCache.getFeatures();
    res.json({
      features: resolveFeatures(featureConfig),
      categories: featureCategories
    });
  });

  /**
   * @swagger
   * /api/admin/features:
   *   put:
   *     summary: Update feature flags
   *     description: Updates feature flags in features.json. Only known feature IDs are accepted.
   *     tags:
   *       - Admin - Features
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties:
   *               type: boolean
   *     responses:
   *       200:
   *         description: Features updated successfully
   *       400:
   *         description: Invalid request body
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.put(buildServerPath('/api/admin/features'), adminAuth, async (req, res) => {
    try {
      const updates = req.body;

      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ error: 'Request body must be an object of feature flags' });
      }

      // Validate that all keys are known feature IDs and values are booleans
      const knownIds = new Set(featureRegistry.map(f => f.id));
      for (const [key, value] of Object.entries(updates)) {
        if (!knownIds.has(key)) {
          return res.status(400).json({ error: `Unknown feature ID: ${key}` });
        }
        if (typeof value !== 'boolean') {
          return res.status(400).json({ error: `Feature "${key}" must be a boolean value` });
        }
      }

      // Read existing features.json
      const rootDir = getRootDir();
      const featuresPath = join(rootDir, 'contents', 'config', 'features.json');

      let existing = {};
      try {
        const data = await fs.readFile(featuresPath, 'utf8');
        existing = JSON.parse(data);
      } catch {
        // File doesn't exist yet, start fresh
      }

      // Merge updates
      const merged = { ...existing, ...updates };

      // Write back
      await atomicWriteJSON(featuresPath, merged);

      // Refresh cache
      await configCache.refreshCacheEntry('config/features.json');

      logger.info('Feature flags updated', {
        component: 'AdminFeatures',
        updates
      });

      res.json({
        message: 'Features updated successfully',
        features: resolveFeatures(merged),
        categories: featureCategories
      });
    } catch (error) {
      logger.error('Error updating feature flags:', {
        component: 'AdminFeatures',
        error: error.message
      });
      res.status(500).json({ error: 'Failed to update feature flags' });
    }
  });
}
