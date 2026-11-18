// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import {
  RATE_LIMITER_KEYS,
  USER_KEYED_LIMITERS,
  resolveRateLimitConfigs
} from '../../middleware/rateLimiting.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { logAudit } from '../../services/AuditLogService.js';
import logger from '../../utils/logger.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

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
    counts: z.enum(COUNT_MODES),
    // General limiters only: count per user or per IP address, and the
    // per-address limit of anonymous requests.
    keyBy: z.enum(['user', 'ip']).optional(),
    anonymousLimit: z
      .number()
      .int()
      .min(RATE_LIMIT_BOUNDS.limit.min)
      .max(RATE_LIMIT_BOUNDS.limit.max)
      .optional(),
    // authApi only: the ceiling per IP address.
    perIpLimit: z
      .number()
      .int()
      .min(RATE_LIMIT_BOUNDS.limit.min)
      .max(RATE_LIMIT_BOUNDS.limit.max)
      .optional()
  })
  .strict();

/** The extra fields a limiter has, beyond window, limit and counts. */
function extraFieldsOf(key) {
  if (USER_KEYED_LIMITERS.includes(key)) return ['keyBy', 'anonymousLimit'];
  if (key === 'authApi') return ['perIpLimit'];
  return [];
}

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
 * The settings of every limiter, in the page's shape. The general limiters
 * also carry `keyBy` and `anonymousLimit`, the credential limiter `perIpLimit`.
 *
 * @param {Object} platform - Platform configuration
 * @returns {Record<string, {windowMs: number, limit: number, counts: string,
 *   keyBy?: string, anonymousLimit?: number, perIpLimit?: number}>}
 */
export function describeRateLimits(platform) {
  const resolved = resolveRateLimitConfigs(platform || {});
  return Object.fromEntries(
    RATE_LIMITER_KEYS.map(key => {
      const config = resolved[key];
      const described = {
        windowMs: config.windowMs,
        limit: config.limit,
        counts: countsOf(config)
      };
      if (USER_KEYED_LIMITERS.includes(key)) {
        described.keyBy = config.keyBy === 'ip' ? 'ip' : 'user';
        described.anonymousLimit = config.anonymousLimit || config.limit;
      }
      if (key === 'authApi' && config.perIpLimit) described.perIpLimit = config.perIpLimit;
      return [key, described];
    })
  );
}

const COMPARED_FIELDS = ['windowMs', 'limit', 'counts', 'keyBy', 'anonymousLimit', 'perIpLimit'];

function sameLimits(a, b) {
  return RATE_LIMITER_KEYS.every(key =>
    COMPARED_FIELDS.every(field => a[key][field] === b[key][field])
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
    res.json(statusPayload(req));
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
   *                     keyBy: { type: string, enum: [user, ip], description: 'publicApi, adminApi, inferenceApi' }
   *                     anonymousLimit: { type: integer, description: 'publicApi, adminApi, inferenceApi' }
   *                     perIpLimit: { type: integer, description: 'authApi' }
   *     responses:
   *       200:
   *         description: Saved; same shape as GET
   *       400:
   *         description: Invalid limits
   */
  app.put(buildServerPath('/api/admin/rate-limits'), adminAuth, async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ServiceError('VALIDATION_FAILED', 'Invalid rate limits', {
        details: parsed.error.issues
      });
    }
    const changes = Object.entries(parsed.data.limiters).filter(([, value]) => value);
    if (changes.length === 0) throw new ServiceError('BAD_REQUEST', 'No rate limits to save');

    // The stored file, not the cache: the cache holds env overrides and
    // decrypted secrets, which must not be written back.
    await updatePlatform(stored => {
      const rateLimit = { ...stored.rateLimit };
      for (const [key, { windowMs, limit, counts, ...extra }] of changes) {
        rateLimit[key] = {
          ...rateLimit[key],
          windowMs,
          limit,
          skipSuccessfulRequests: counts === 'failed',
          skipFailedRequests: counts === 'successful'
        };
        // Only the fields this limiter has; the others would do nothing.
        for (const field of extraFieldsOf(key)) {
          if (extra[field] !== undefined) rateLimit[key][field] = extra[field];
        }
      }
      stored.rateLimit = rateLimit;
    });
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
  });
}
