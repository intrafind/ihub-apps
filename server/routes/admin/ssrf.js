import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { buildServerPath } from '../../utils/basePath.js';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

export default function registerAdminSsrfRoutes(app) {
  /**
   * @swagger
   * /api/admin/ssrf/config:
   *   get:
   *     summary: Get the global SSRF allowlist
   *     description: |
   *       Returns the platform-wide list of hostnames/patterns that bypass the
   *       SSRF private-IP guard on outbound HTTP calls (OpenAPI tools, MCP
   *       servers, web tools). Supports wildcards (*.example.com), exact
   *       domains (api.example.com), and subdomain (.example.com) patterns.
   *     tags: [Admin - SSRF]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Current SSRF allowlist
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 allowedHosts:
   *                   type: array
   *                   items:
   *                     type: string
   */
  app.get(buildServerPath('/api/admin/ssrf/config'), adminAuth, async (req, res) => {
    try {
      const platformConfig = configCache.getPlatform() || {};
      const ssrfConfig = platformConfig.ssrf || { allowedHosts: [] };
      res.json({
        allowedHosts: Array.isArray(ssrfConfig.allowedHosts) ? ssrfConfig.allowedHosts : []
      });
    } catch (error) {
      return sendInternalError(res, error, 'get SSRF configuration');
    }
  });

  /**
   * @swagger
   * /api/admin/ssrf/config:
   *   put:
   *     summary: Update the global SSRF allowlist
   *     tags: [Admin - SSRF]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               allowedHosts:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: SSRF configuration updated successfully
   *       400:
   *         description: Invalid SSRF configuration
   */
  app.put(buildServerPath('/api/admin/ssrf/config'), adminAuth, async (req, res) => {
    try {
      const { allowedHosts } = req.body || {};

      if (!Array.isArray(allowedHosts)) {
        return sendBadRequest(res, 'Invalid SSRF configuration: allowedHosts must be an array');
      }

      const cleaned = [];
      for (const entry of allowedHosts) {
        if (typeof entry !== 'string') {
          return sendBadRequest(res, 'Invalid SSRF configuration: entries must be strings');
        }
        const trimmed = entry.trim();
        if (!trimmed) {
          return sendBadRequest(res, 'Invalid SSRF configuration: entries must be non-empty');
        }
        // Allow letters, digits, dots, hyphens, and a single leading "*." or "."
        // wildcard prefix. Matches the patterns supported by isDomainWhitelisted.
        if (
          !/^(\*\.|\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
            trimmed
          )
        ) {
          return sendBadRequest(
            res,
            `Invalid SSRF host pattern "${entry}". Use a hostname, *.domain.tld, or .domain.tld.`
          );
        }
        cleaned.push(trimmed);
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const platformPath = join(rootDir, contentsDir, 'config', 'platform.json');

      const platformContent = await fs.readFile(platformPath, 'utf8');
      const platformConfig = JSON.parse(platformContent);

      platformConfig.ssrf = { ...(platformConfig.ssrf || {}), allowedHosts: cleaned };

      await atomicWriteJSON(platformPath, platformConfig);
      await configCache.refreshCacheEntry('config/platform.json');

      logger.info('SSRF allowlist updated', {
        component: 'AdminSSRF',
        allowedHosts: cleaned
      });

      res.json({
        message: 'SSRF configuration updated successfully',
        config: { allowedHosts: cleaned }
      });
    } catch (error) {
      return sendInternalError(res, error, 'update SSRF configuration');
    }
  });
}
