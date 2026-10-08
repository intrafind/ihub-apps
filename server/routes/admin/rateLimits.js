import { z } from 'zod';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { RATE_LIMITER_KEYS, resolveRateLimitConfigs } from '../../middleware/rateLimiting.js';
import { buildServerPath } from '../../utils/basePath.js';
import { logAudit } from '../../services/AuditLogService.js';
import logger from '../../utils/logger.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';

/**
 * Admin → Security → Rate limits: read and change the limits in the
 * `rateLimit` section of platform.json.
 *
 * The limiters are Express middleware built once at startup
 * (middleware/setup.js), so a change applies after a restart. The page shows
 * the saved settings next to the ones the server is running with, so it can
 * say when a restart is due.
 */

const PLATFORM_FILE = 'config/platform.json';
const COMPONENT = 'AdminRateLimits';

/** Bounds an admin can set: a second to a day, one request to a million. */
export const RATE_LIMIT_BOUNDS = Object.freeze({
  windowMs: { min: 1000, max: 24 * 60 * 60 * 1000 },
  limit: { min: 1, max: 1_000_000 }
});

/**
 * Which requests a limiter counts, as one choice instead of the two
 * express-rate-limit flags (`skipSuccessfulRequests`, `skipFailedRequests`).
 * A request failed when its response status is 400 or higher.
 */
export const COUNT_MODES = Object.freeze(['all', 'failed', 'successful']);

const limiterSchema = z
  .object({
    windowMs: z
      .number()
      .int()
      .min(RATE_LIMIT_BOUNDS.windowMs.min)
      .max(RATE_LIMIT_BOUNDS.windowMs.max),
    limit: z.number().int().min(RATE_LIMIT_BOUNDS.limit.min).max(RATE_LIMIT_BOUNDS.limit.max),
    counts: z.enum(COUNT_MODES)
  })
  .strict();

const updateSchema = z
  .object({
    limiters: z
      .object(Object.fromEntries(RATE_LIMITER_KEYS.map(key => [key, limiterSchema.optional()])))
      .strict()
  })
  .strict();

function countsOf(config) {
  if (config.skipSuccessfulRequests) return 'failed';
  if (config.skipFailedRequests) return 'successful';
  return 'all';
}

/**
 * The settings of every limiter, in the page's shape.
 *
 * @param {Object} platform - Platform configuration
 * @returns {Record<string, {windowMs: number, limit: number, counts: string}>}
 */
export function describeRateLimits(platform) {
  const resolved = resolveRateLimitConfigs(platform || {});
  return Object.fromEntries(
    RATE_LIMITER_KEYS.map(key => [
      key,
      {
        windowMs: resolved[key].windowMs,
        limit: resolved[key].limit,
        counts: countsOf(resolved[key])
      }
    ])
  );
}

function sameLimits(a, b) {
  return RATE_LIMITER_KEYS.every(
    key =>
      a[key].windowMs === b[key].windowMs &&
      a[key].limit === b[key].limit &&
      a[key].counts === b[key].counts
  );
}

function statusPayload(req) {
  const limiters = describeRateLimits(configCache.getPlatform());
  // The config the limiters were built from at startup.
  const running = describeRateLimits(req.app.get('platform') || configCache.getPlatform());
  return { limiters, running, restartRequired: !sameLimits(limiters, running) };
}

export default function registerAdminRateLimitRoutes(app) {
  /**
   * @swagger
   * /api/admin/rate-limits:
   *   get:
   *     summary: Get the rate limits
   *     description: |
   *       The saved limits (`limiters`), the limits the server started with
   *       (`running`), and whether they differ (`restartRequired`).
   *     tags: [Admin - Security]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Rate limits per limiter
   */
  app.get(buildServerPath('/api/admin/rate-limits'), adminAuth, (req, res) => {
    try {
      res.json(statusPayload(req));
    } catch (error) {
      return sendInternalError(res, error, 'get rate limits');
    }
  });

  /**
   * @swagger
   * /api/admin/rate-limits:
   *   put:
   *     summary: Change rate limits
   *     description: |
   *       Saves the given limiters' window, limit and which requests count to
   *       `rateLimit` in platform.json. Takes effect after a restart.
   *     tags: [Admin - Security]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               limiters:
   *                 type: object
   *                 additionalProperties:
   *                   type: object
   *                   properties:
   *                     windowMs: { type: integer }
   *                     limit: { type: integer }
   *                     counts: { type: string, enum: [all, failed, successful] }
   *     responses:
   *       200:
   *         description: Saved; same shape as GET
   *       400:
   *         description: Invalid limits
   */
  app.put(buildServerPath('/api/admin/rate-limits'), adminAuth, async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendBadRequest(res, 'Invalid rate limits', parsed.error.issues);
    }
    const changes = Object.entries(parsed.data.limiters).filter(([, value]) => value);
    if (changes.length === 0) return sendBadRequest(res, 'No rate limits to save');

    try {
      // The stored file, not the cache: the cache holds env overrides and
      // decrypted secrets, which must not be written back.
      const stored = (await configStore.readJsonStrict(PLATFORM_FILE)) || {};
      const rateLimit = { ...stored.rateLimit };
      for (const [key, { windowMs, limit, counts }] of changes) {
        rateLimit[key] = {
          ...rateLimit[key],
          windowMs,
          limit,
          skipSuccessfulRequests: counts === 'failed',
          skipFailedRequests: counts === 'successful'
        };
      }
      stored.rateLimit = rateLimit;
      await configStore.writeJson(PLATFORM_FILE, stored);
      await configCache.refreshCacheEntry(PLATFORM_FILE);

      const keys = changes.map(([key]) => key);
      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'rateLimit',
        summary: `Changed rate limits: ${keys.join(', ')}`
      });
      logger.info('Rate limits saved', { component: COMPONENT, limiters: keys });

      res.json(statusPayload(req));
    } catch (error) {
      return sendInternalError(res, error, 'save rate limits');
    }
  });
}
