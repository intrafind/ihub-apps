import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { buildServerPath } from '../../utils/basePath.js';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

const DEFAULT_CORS_CONFIG = {
  origin: [],
  credentials: true,
  maxAge: 86400,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Forwarded-User',
    'X-Forwarded-Groups',
    // Sent on every request by the iHub Axios client for session tracking.
    'X-Session-ID',
    'Accept',
    'Origin',
    'Cache-Control',
    'X-File-Name'
  ]
};

export default function registerAdminCorsRoutes(app) {
  /**
   * @swagger
   * /api/admin/cors/config:
   *   get:
   *     summary: Get current CORS configuration
   *     tags: [Admin - CORS]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Current CORS configuration
   */
  app.get(buildServerPath('/api/admin/cors/config'), adminAuth, async (req, res) => {
    try {
      const platformConfig = configCache.getPlatform() || {};
      const corsConfig = platformConfig.cors
        ? { ...DEFAULT_CORS_CONFIG, ...platformConfig.cors }
        : { ...DEFAULT_CORS_CONFIG };

      res.json(corsConfig);
    } catch (error) {
      return sendInternalError(res, error, 'get CORS configuration');
    }
  });

  /**
   * @swagger
   * /api/admin/cors/config:
   *   put:
   *     summary: Update CORS configuration
   *     tags: [Admin - CORS]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: CORS configuration updated successfully
   *       400:
   *         description: Invalid CORS configuration
   */
  app.put(buildServerPath('/api/admin/cors/config'), adminAuth, async (req, res) => {
    try {
      const { origin, credentials, maxAge, methods, allowedHeaders } = req.body;

      if (!Array.isArray(origin)) {
        return sendBadRequest(res, 'Invalid CORS configuration: origin must be an array');
      }

      for (const o of origin) {
        if (typeof o !== 'string' || !o.trim()) {
          return sendBadRequest(
            res,
            'Invalid CORS configuration: all origins must be non-empty strings'
          );
        }
      }

      if (typeof credentials !== 'boolean') {
        return sendBadRequest(res, 'Invalid CORS configuration: credentials must be a boolean');
      }

      if (!Number.isInteger(maxAge) || maxAge < 0) {
        return sendBadRequest(
          res,
          'Invalid CORS configuration: maxAge must be a non-negative integer'
        );
      }

      if (!Array.isArray(methods) || methods.length === 0) {
        return sendBadRequest(res, 'Invalid CORS configuration: methods must be a non-empty array');
      }

      for (const m of methods) {
        if (typeof m !== 'string' || !m.trim()) {
          return sendBadRequest(
            res,
            'Invalid CORS configuration: all methods must be non-empty strings'
          );
        }
      }

      if (!Array.isArray(allowedHeaders)) {
        return sendBadRequest(res, 'Invalid CORS configuration: allowedHeaders must be an array');
      }

      for (const h of allowedHeaders) {
        if (typeof h !== 'string' || !h.trim()) {
          return sendBadRequest(
            res,
            'Invalid CORS configuration: all allowedHeaders must be non-empty strings'
          );
        }
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const platformPath = join(rootDir, contentsDir, 'config', 'platform.json');

      const platformContent = await fs.readFile(platformPath, 'utf8');
      const platformConfig = JSON.parse(platformContent);

      platformConfig.cors = { origin, credentials, maxAge, methods, allowedHeaders };

      await atomicWriteJSON(platformPath, platformConfig);
      await configCache.refreshCacheEntry('config/platform.json');

      logger.info('CORS configuration updated', {
        component: 'AdminCORS',
        originCount: origin.length,
        credentials,
        maxAge
      });

      res.json({
        message: 'CORS configuration updated successfully',
        config: platformConfig.cors
      });
    } catch (error) {
      return sendInternalError(res, error, 'update CORS configuration');
    }
  });
}
