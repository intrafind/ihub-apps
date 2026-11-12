// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

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
    const platformConfig = configCache.getPlatform() || {};
    const corsConfig = platformConfig.cors
      ? { ...DEFAULT_CORS_CONFIG, ...platformConfig.cors }
      : { ...DEFAULT_CORS_CONFIG };

    res.json(corsConfig);
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
    const { origin, credentials, maxAge, methods, allowedHeaders } = req.body;

    if (!Array.isArray(origin)) {
      throw new ServiceError('BAD_REQUEST', 'Invalid CORS configuration: origin must be an array');
    }

    for (const o of origin) {
      if (typeof o !== 'string' || !o.trim()) {
        throw new ServiceError(
          'BAD_REQUEST',
          'Invalid CORS configuration: all origins must be non-empty strings'
        );
      }
    }

    if (typeof credentials !== 'boolean') {
      throw new ServiceError(
        'BAD_REQUEST',
        'Invalid CORS configuration: credentials must be a boolean'
      );
    }

    if (!Number.isInteger(maxAge) || maxAge < 0) {
      throw new ServiceError(
        'BAD_REQUEST',
        'Invalid CORS configuration: maxAge must be a non-negative integer'
      );
    }

    if (!Array.isArray(methods) || methods.length === 0) {
      throw new ServiceError(
        'BAD_REQUEST',
        'Invalid CORS configuration: methods must be a non-empty array'
      );
    }

    for (const m of methods) {
      if (typeof m !== 'string' || !m.trim()) {
        throw new ServiceError(
          'BAD_REQUEST',
          'Invalid CORS configuration: all methods must be non-empty strings'
        );
      }
    }

    if (!Array.isArray(allowedHeaders)) {
      throw new ServiceError(
        'BAD_REQUEST',
        'Invalid CORS configuration: allowedHeaders must be an array'
      );
    }

    for (const h of allowedHeaders) {
      if (typeof h !== 'string' || !h.trim()) {
        throw new ServiceError(
          'BAD_REQUEST',
          'Invalid CORS configuration: all allowedHeaders must be non-empty strings'
        );
      }
    }

    const { data: platformConfig } = await updatePlatform({
      cors: { origin, credentials, maxAge, methods, allowedHeaders }
    });
    await configCache.refreshCacheEntry('config/platform.json');

    logger.info('CORS configuration updated', {
      component: 'AdminCORS',
      originCount: origin.length,
      credentials,
      maxAge
    });

    res.json(platformConfig.cors);
  });
}
