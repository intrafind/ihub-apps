// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin views and settings of usage limits (services/quota):
 *
 *   GET  /api/admin/usage/limits/settings          — platform budget + reset schedule
 *   PUT  /api/admin/usage/limits/settings
 *   GET  /api/admin/usage/limits/users             — users with their buckets (paged)
 *   GET  /api/admin/usage/limits/users/:userKey    — one user in detail
 *   POST /api/admin/usage/limits/users/:userKey/_reset
 *   GET  /api/admin/usage/limits/models            — per model
 *   GET  /api/admin/usage/limits/groups            — per group
 *   GET  /api/admin/usage/limits/near              — users above 80 % of a limit, soonest reset first
 *
 * Model, group and user limits are edited with their own admin editors
 * (`usageLimits` on each config).
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import configCache from '../../configCache.js';
import { usageLimitBucketSchema } from '../../validators/common.js';
import {
  currentWindows,
  isValidTimeZone,
  normalizeResets,
  WEEKDAYS,
  WINDOWS
} from '../../services/quota/resetSchedule.js';
import { getCurrentWindows } from '../../services/quota/quotaService.js';
import { getQuotaLedger } from '../../services/quota/QuotaLedger.js';
import {
  getGroupOverview,
  getModelOverview,
  getQuotaUser,
  listNearLimitUsers,
  listQuotaUsers
} from '../../services/quota/quotaAdmin.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A user key as it appears in the ledger or users.json. */
function validUserKey(key) {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 256 &&
    !/[\u0000-\u001f]/.test(key) &&
    !['__proto__', 'constructor', 'prototype'].includes(key)
  );
}

function settingsResponse(platform) {
  const usageLimits = platform?.usageLimits || {};
  const schedule = normalizeResets(usageLimits.resets);
  const windows = currentWindows(usageLimits.resets);
  return {
    allModels: usageLimits.allModels || {},
    resets: {
      timezone: usageLimits.resets?.timezone ?? null,
      dailyAt: schedule.dailyAt,
      weeklyOn: schedule.weeklyOn,
      weeklyAt: schedule.weeklyAt,
      monthlyAt: schedule.monthlyAt
    },
    effectiveTimezone: schedule.timezone,
    nextResets: {
      day: windows.day.resetAt,
      week: windows.week.resetAt,
      month: windows.month.resetAt
    }
  };
}

export default function registerAdminUsageLimitRoutes(app) {
  /**
   * @swagger
   * /admin/usage/limits/settings:
   *   get:
   *     summary: Platform usage limit settings
   *     description: The budget across all models and the reset schedule, with the next reset times.
   *     tags: [Admin - Usage]
   *     responses:
   *       200: { description: Settings }
   *   put:
   *     summary: Update the platform usage limit settings
   *     tags: [Admin - Usage]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               allModels: { type: object, description: "{ day, week, month } tokens, -1/null = unlimited" }
   *               resets:
   *                 type: object
   *                 properties:
   *                   timezone: { type: string, nullable: true }
   *                   dailyAt: { type: string, example: "00:00" }
   *                   weeklyOn: { type: string, example: monday }
   *                   weeklyAt: { type: string, example: "00:00" }
   *                   monthlyAt: { type: string, example: "00:00" }
   *     responses:
   *       200: { description: Saved settings }
   *       400: { description: Invalid settings }
   */
  app.get(buildServerPath('/api/admin/usage/limits/settings'), adminAuth, (req, res) => {
    res.json(settingsResponse(configCache.getPlatform() || {}));
  });

  app.put(buildServerPath('/api/admin/usage/limits/settings'), adminAuth, async (req, res) => {
    const body = req.body || {};
    const parsedBudget = usageLimitBucketSchema.safeParse(body.allModels || {});
    if (!parsedBudget.success) throw new ServiceError('BAD_REQUEST', 'Invalid allModels budget');
    const resets = body.resets || {};
    if (resets.timezone !== null && resets.timezone !== undefined && resets.timezone !== '') {
      if (!isValidTimeZone(resets.timezone))
        throw new ServiceError('BAD_REQUEST', 'Unknown time zone');
    }
    for (const key of ['dailyAt', 'weeklyAt', 'monthlyAt']) {
      if (resets[key] !== undefined && !TIME.test(resets[key])) {
        throw new ServiceError('BAD_REQUEST', `${key} must be HH:MM`);
      }
    }
    if (resets.weeklyOn !== undefined && !WEEKDAYS.includes(resets.weeklyOn)) {
      throw new ServiceError('BAD_REQUEST', 'weeklyOn must be a weekday name');
    }

    // Unreadable platform.json: updateJson throws rather than overwrite it.
    const { data: platform } = await updatePlatform(platform => {
      const current = platform.usageLimits || {};
      platform.usageLimits = {
        ...current,
        allModels: Object.fromEntries(
          Object.entries(parsedBudget.data).filter(([, v]) => v !== undefined && v !== null)
        ),
        resets: {
          ...(current.resets || {}),
          timezone: resets.timezone ? resets.timezone : null,
          ...(resets.dailyAt ? { dailyAt: resets.dailyAt } : {}),
          ...(resets.weeklyOn ? { weeklyOn: resets.weeklyOn } : {}),
          ...(resets.weeklyAt ? { weeklyAt: resets.weeklyAt } : {}),
          ...(resets.monthlyAt ? { monthlyAt: resets.monthlyAt } : {})
        }
      };
    });
    await configCache.refreshCacheEntry('config/platform.json');
    res.json(settingsResponse(configCache.getPlatform() || platform));
  });

  /**
   * @swagger
   * /admin/usage/limits/users:
   *   get:
   *     summary: Users with their usage against their limits
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: query, name: search, schema: { type: string } }
   *       - { in: query, name: status, schema: { type: string, enum: [all, limited, warning, exceeded] } }
   *       - { in: query, name: modelId, schema: { type: string } }
   *       - { in: query, name: limit, schema: { type: integer, default: 25, maximum: 200 } }
   *       - { in: query, name: cursor, schema: { type: string } }
   *     responses:
   *       200: { description: "{ items, nextCursor, total }" }
   */
  app.get(buildServerPath('/api/admin/usage/limits/users'), adminAuth, async (req, res) => {
    const { search, status, modelId, limit, cursor } = req.query;
    res.json(
      await listQuotaUsers({
        search: typeof search === 'string' ? search : '',
        status: ['all', 'limited', 'warning', 'exceeded'].includes(status) ? status : 'all',
        modelId: typeof modelId === 'string' && modelId ? modelId : null,
        limit,
        cursor
      })
    );
  });

  /**
   * @swagger
   * /admin/usage/limits/users/{userKey}:
   *   get:
   *     summary: One user's usage, limits and limit sources
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: path, name: userKey, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: User usage }
   *       404: { description: Unknown user }
   */
  app.get(
    buildServerPath('/api/admin/usage/limits/users/:userKey'),
    adminAuth,
    async (req, res) => {
      const { userKey } = req.params;
      if (!validUserKey(userKey)) throw new ServiceError('BAD_REQUEST', 'Invalid user');
      const user = await getQuotaUser(userKey);
      if (!user) throw new ServiceError('NOT_FOUND', 'User not found');
      res.json(user);
    }
  );

  /**
   * @swagger
   * /admin/usage/limits/users/{userKey}/_reset:
   *   post:
   *     summary: Reset a user's token counts for the current window(s)
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: path, name: userKey, required: true, schema: { type: string } }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               modelId: { type: string, description: "Only this model (all when omitted)" }
   *               window: { type: string, enum: [day, week, month], description: "Only this window (all when omitted)" }
   *     responses:
   *       200: { description: The user's usage after the reset }
   */
  app.post(
    buildServerPath('/api/admin/usage/limits/users/:userKey/_reset'),
    adminAuth,
    async (req, res) => {
      const { userKey } = req.params;
      if (!validUserKey(userKey)) throw new ServiceError('BAD_REQUEST', 'Invalid user');
      const { modelId, window } = req.body || {};
      if (window !== undefined && window !== null && !WINDOWS.includes(window)) {
        throw new ServiceError('BAD_REQUEST', 'window must be day, week or month');
      }
      if (modelId !== undefined && modelId !== null && typeof modelId !== 'string') {
        throw new ServiceError('BAD_REQUEST', 'Invalid modelId');
      }
      await getQuotaLedger().reset(userKey, getCurrentWindows(), {
        modelId: modelId || undefined,
        window: window || undefined
      });
      res.json((await getQuotaUser(userKey)) || { userKey });
    }
  );

  /**
   * @swagger
   * /admin/usage/limits/models:
   *   get:
   *     summary: Per model — global limits, tokens and users near or over their budget
   *     tags: [Admin - Usage]
   *     responses:
   *       200: { description: Model rows }
   * /admin/usage/limits/groups:
   *   get:
   *     summary: Per group — limits, members and their combined tokens
   *     tags: [Admin - Usage]
   *     responses:
   *       200: { description: Group rows }
   */
  app.get(buildServerPath('/api/admin/usage/limits/models'), adminAuth, async (req, res) => {
    res.json({ items: await getModelOverview(), resets: getCurrentWindows() });
  });

  /**
   * @swagger
   * /admin/usage/limits/near:
   *   get:
   *     summary: Users near a usage limit
   *     description: One row per user and budget at or above `threshold` (default 0.8) of its limit, the soonest reset first.
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: query, name: threshold, schema: { type: number, minimum: 0, maximum: 1 } }
   *       - { in: query, name: limit, schema: { type: integer, maximum: 500 } }
   *     responses:
   *       200: { description: "{ threshold, items, total }" }
   */
  app.get(buildServerPath('/api/admin/usage/limits/near'), adminAuth, async (req, res) => {
    // Optional numbers: one non-empty value each, or a 400 (an empty value
    // must not silently become 0 and list everyone).
    const numberParam = name => {
      const raw = req.query[name];
      if (raw === undefined) return { value: undefined };
      if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(Number(raw))) {
        return { error: `${name} must be a number` };
      }
      return { value: Number(raw) };
    };
    const threshold = numberParam('threshold');
    const limit = numberParam('limit');
    const invalid = threshold.error || limit.error;
    if (invalid) throw new ServiceError('BAD_REQUEST', invalid);
    if (threshold.value !== undefined && (threshold.value < 0 || threshold.value > 1)) {
      throw new ServiceError('BAD_REQUEST', 'threshold must be between 0 and 1');
    }
    res.json(await listNearLimitUsers({ threshold: threshold.value, limit: limit.value }));
  });

  app.get(buildServerPath('/api/admin/usage/limits/groups'), adminAuth, async (req, res) => {
    res.json({ items: await getGroupOverview() });
  });
}
