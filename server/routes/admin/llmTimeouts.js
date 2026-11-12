// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import config from '../../config.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { logAudit } from '../../services/AuditLogService.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import { LLM_TIMEOUT_KEYS, LLM_TIMEOUT_MAX_MS } from '../../services/llmProviders.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

/**
 * Admin → Providers → "Timeouts for all providers": read and change the
 * installation-wide transport ceilings in the `llm` section of platform.json.
 *
 * `LLMClient` reads the platform config on every call, so a change applies to
 * the next request and needs no restart. A provider entry and a model can still
 * override either value (see docs/llm-client.md#tuning-the-ceilings).
 */

const PLATFORM_FILE = 'config/platform.json';
const COMPONENT = 'AdminLlmTimeouts';

const timeoutSchema = z
  .number()
  .int()
  .min(0, 'Timeout cannot be negative')
  .max(LLM_TIMEOUT_MAX_MS, 'Timeout cannot exceed 5 minutes')
  .nullable()
  .optional();

/** `null` removes the saved value; an absent key leaves it alone. */
const updateSchema = z
  .object(Object.fromEntries(LLM_TIMEOUT_KEYS.map(key => [key, timeoutSchema])))
  .strict();

/** What applies when nothing is saved in platform.json: the environment / built-in default. */
function defaultsOf() {
  return {
    connectTimeoutMs: config.LLM_CONNECT_TIMEOUT_MS,
    streamIdleTimeoutMs: config.LLM_STREAM_IDLE_TIMEOUT_MS
  };
}

/**
 * The installation's ceilings: `saved` is what platform.json holds (a key is
 * absent when unset), `defaults` is what applies without it, `effective` is
 * what the next request runs with.
 *
 * @param {Object} platform - Platform configuration
 */
export function describeLlmTimeouts(platform) {
  const defaults = defaultsOf();
  const saved = {};
  const effective = {};
  for (const key of LLM_TIMEOUT_KEYS) {
    const value = platform?.llm?.[key];
    if (Number.isFinite(value)) saved[key] = value;
    effective[key] = key in saved ? saved[key] : defaults[key];
  }
  return { saved, effective, defaults };
}

export default function registerAdminLlmTimeoutRoutes(app) {
  /**
   * @swagger
   * /api/admin/llm-timeouts:
   *   get:
   *     summary: Get the installation-wide LLM timeouts
   *     description: |
   *       `saved` holds the values in platform.json (a key is absent when unset),
   *       `defaults` the environment / built-in values that apply without them, and
   *       `effective` what the next request runs with. A provider entry or a model
   *       can still override either one. `0` means no ceiling.
   *     tags: [Admin - Providers]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: connectTimeoutMs and streamIdleTimeoutMs, in milliseconds
   */
  app.get(buildServerPath('/api/admin/llm-timeouts'), adminAuth, (req, res) => {
    res.json(describeLlmTimeouts(configCache.getPlatform()));
  });

  /**
   * @swagger
   * /api/admin/llm-timeouts:
   *   put:
   *     summary: Change the installation-wide LLM timeouts
   *     description: |
   *       Saves the given ceilings to `llm` in platform.json. A number from 0
   *       (no ceiling) to 300000; `null` removes the saved value so the
   *       environment / built-in default applies. Keys left out are unchanged.
   *       Takes effect on the next request, without a restart.
   *     tags: [Admin - Providers]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               connectTimeoutMs: { type: integer, nullable: true, minimum: 0, maximum: 300000 }
   *               streamIdleTimeoutMs: { type: integer, nullable: true, minimum: 0, maximum: 300000 }
   *     responses:
   *       200:
   *         description: Saved; same shape as GET
   *       400:
   *         description: "`VALIDATION_FAILED`: a value is not a whole number from 0 to 300000"
   */
  app.put(buildServerPath('/api/admin/llm-timeouts'), adminAuth, async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ServiceError(
        'VALIDATION_FAILED',
        `Invalid LLM timeouts: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        {
          details: {
            issues: parsed.error.issues.map(issue => ({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message
            }))
          }
        }
      );
    }
    const changes = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    if (changes.length === 0) {
      throw new ServiceError('BAD_REQUEST', 'No LLM timeouts to save');
    }

    // The stored file, not the cache: the cache holds env overrides and
    // decrypted secrets, which must not be written back.
    await updatePlatform(stored => {
      const llm = { ...stored.llm };
      for (const [key, value] of changes) {
        if (value === null) delete llm[key];
        else llm[key] = value;
      }
      stored.llm = llm;
    });
    await configCache.refreshCacheEntry(PLATFORM_FILE);

    const summary = changes.map(([key, value]) => `${key}=${value ?? 'default'}`).join(', ');
    logAudit({
      req,
      action: 'update',
      resource: 'platform',
      resourceId: 'llm',
      summary: `Changed LLM timeouts: ${summary}`
    });
    logger.info('LLM timeouts saved', { component: COMPONENT, changes: summary });

    res.json(describeLlmTimeouts(configCache.getPlatform()));
  });
}
