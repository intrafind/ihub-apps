// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import rateLimit from 'express-rate-limit';
import { adminAuth } from '../../middleware/adminAuth.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { findBlockedHosts } from '../../shortLinkManager.js';
import { logAudit } from '../../services/AuditLogService.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { normalizeAllowedHostEntry } from '../../utils/shortLinkTarget.js';
import logger from '../../utils/logger.js';

const PLATFORM_FILE = 'config/platform.json';

/**
 * The admin API limiter in `middleware/setup.js` already covers `/api/admin`;
 * this one sits on the routes themselves, where CodeQL's
 * js/missing-rate-limiting looks (it ignores suppression comments).
 */
const configLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

/** The settings answer: the allowlist and the hosts stored links lead to that it refuses. */
async function settingsPayload() {
  const configured = configCache.getPlatform()?.shortLinks?.allowedHosts;
  const allowedHosts = Array.isArray(configured) ? configured : [];
  return { allowedHosts, blockedHosts: await findBlockedHosts(allowedHosts) };
}

export default function registerAdminShortLinkRoutes(app) {
  /**
   * @swagger
   * /api/admin/shortlinks/config:
   *   get:
   *     summary: Get the hosts short links may lead to
   *     description: |
   *       `allowedHosts` is `platform.shortLinks.allowedHosts`: the hosts a short
   *       link may redirect to with an absolute http(s) URL. Paths on this server
   *       are always allowed. `blockedHosts` lists the hosts that stored, unexpired
   *       links lead to but the list refuses; those links answer "Not found".
   *       The SSRF allowlist (`ssrf.allowedHosts`) does not apply to short links.
   *     tags: [Admin - Short Links]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: The allowlist and the refused hosts of stored links
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 allowedHosts:
   *                   type: array
   *                   items:
   *                     type: string
   *                 blockedHosts:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       host:
   *                         type: string
   *                       links:
   *                         type: integer
   *       403:
   *         description: FORBIDDEN — not an administrator
   */
  app.get(
    buildServerPath('/api/admin/shortlinks/config'),
    configLimiter,
    adminAuth,
    async (req, res) => {
      res.json(await settingsPayload());
    }
  );

  /**
   * @swagger
   * /api/admin/shortlinks/config:
   *   put:
   *     summary: Replace the hosts short links may lead to
   *     description: |
   *       Each entry is an exact host (`docs.example.com`), a subdomain pattern
   *       (`*.example.com` or `.example.com`, not the domain itself) or a `/regex/`
   *       matched against the whole hostname. Host entries are stored in lower case
   *       and internationalised names in their `xn--` form. A URL is refused; enter
   *       its host. Takes effect at once, for new and stored links.
   *     tags: [Admin - Short Links]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [allowedHosts]
   *             properties:
   *               allowedHosts:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Saved; same shape as GET
   *       400:
   *         description: VALIDATION_FAILED — `errors` names each unusable entry
   *       403:
   *         description: FORBIDDEN — not an administrator
   */
  app.put(
    buildServerPath('/api/admin/shortlinks/config'),
    configLimiter,
    adminAuth,
    async (req, res) => {
      const { allowedHosts } = req.body || {};
      if (!Array.isArray(allowedHosts)) {
        throw new ServiceError('VALIDATION_FAILED', 'allowedHosts must be an array', {
          details: [{ path: ['allowedHosts'], code: 'INVALID_TYPE', message: 'must be an array' }]
        });
      }

      const cleaned = [];
      const problems = [];
      allowedHosts.forEach((value, index) => {
        const result = normalizeAllowedHostEntry(value);
        if (result.error) {
          problems.push({
            path: ['allowedHosts', index],
            code: 'INVALID_HOST',
            message: `${JSON.stringify(value)} ${result.error}`
          });
        } else if (!cleaned.includes(result.entry)) {
          cleaned.push(result.entry);
        }
      });
      if (problems.length) {
        throw new ServiceError(
          'VALIDATION_FAILED',
          `Invalid allowed hosts: ${problems.map(p => p.message).join('; ')}`,
          { details: problems }
        );
      }

      // The stored file, not the cache: the cache holds env overrides and
      // decrypted secrets, which must not be written back.
      const stored = await configStore.readJsonStrict(PLATFORM_FILE);
      if (!stored) throw new Error('Unable to read config/platform.json');
      stored.shortLinks = { ...stored.shortLinks, allowedHosts: cleaned };
      await configStore.writeJson(PLATFORM_FILE, stored);
      await configCache.refreshCacheEntry(PLATFORM_FILE);

      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'shortLinks.allowedHosts',
        summary: `Short links may lead to: ${cleaned.join(', ') || '(paths on this server only)'}`
      });
      logger.info('Short link allowed hosts saved', {
        component: 'AdminShortLinks',
        allowedHosts: cleaned
      });

      res.json(await settingsPayload());
    }
  );
}
