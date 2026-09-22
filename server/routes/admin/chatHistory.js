/**
 * Admin Chat History — configure and monitor durable chats and the run ledger.
 *
 * Durable chats (`platform.chats`) and the run ledger (`platform.runLog`) each
 * carry retention and behavior settings that were only reachable by editing
 * `platform.json`. This route gives the admin page one read for everything it
 * shows — the settings, whether each gate that decides persistence is open,
 * and what is stored — plus a validated write for the two settings blocks and
 * a manual retention run.
 *
 * Writes go through `ConfigStore` on the raw file, like the audit-log
 * settings, so encrypted secrets elsewhere in `platform.json` are left exactly
 * as they are.
 */
import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { getStorage, isStorageReady } from '../../storage/bootstrap.js';
import runLog from '../../services/loop/RunLog.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import {
  CHAT_PERSISTENCE_FEATURE,
  chatRetentionSettings,
  isChatPersistenceConfigured
} from '../../services/chat/chatPersistence.js';
import { sweepChats } from '../../services/chat/chatRetention.js';
import { collectChatStats } from '../../services/chat/chatAdminStats.js';
import { getRunSummaryRepository } from '../../services/runtime/RunSummaryRepository.js';

const COMPONENT = 'AdminChatHistory';

/** Ledger retention used when `runLog.retentionDays` is unset — RunLog's own default. */
const DEFAULT_RUNLOG_RETENTION_DAYS = 90;

// Integers only: a fractional day or message count is not something the
// runtime can honor, and zero or less is the documented "rule off" value.
const chatsSettingsSchema = z
  .object({
    enabled: z.boolean(),
    retentionDays: z.number().int(),
    maxChatsPerUser: z.number().int(),
    maxMessagesPerChat: z.number().int()
  })
  .partial()
  .strict();

const runLogSettingsSchema = z
  .object({
    enabled: z.boolean(),
    identityMode: z.enum(['full', 'default', 'pseudonymized']),
    retentionDays: z.number().int(),
    cleanupEnabled: z.boolean(),
    flushIntervalMs: z.number().int().positive(),
    spillThresholdBytes: z.number().int().positive()
  })
  .partial()
  .strict();

const settingsBodySchema = z
  .object({
    chats: chatsSettingsSchema.optional(),
    runLog: runLogSettingsSchema.optional()
  })
  .strict();

const retentionRunSchema = z
  .object({ target: z.enum(['chats', 'ledger', 'all']).optional() })
  .strict();

/** A manual retention run in flight — one at a time is plenty. */
let retentionRunning = false;

/**
 * The effective settings, defaults filled in, in the shape the page edits.
 *
 * @param {Object} platform - Platform configuration.
 * @returns {{chats: Object, runLog: Object}}
 */
function resolveSettings(platform) {
  const chats = platform?.chats || {};
  const ledger = platform?.runLog || {};
  return {
    chats: {
      enabled: chats.enabled !== false,
      ...chatRetentionSettings(platform)
    },
    runLog: {
      enabled: ledger.enabled !== false,
      identityMode: ledger.identityMode || 'default',
      retentionDays: Number.isFinite(ledger.retentionDays)
        ? ledger.retentionDays
        : DEFAULT_RUNLOG_RETENTION_DAYS,
      cleanupEnabled: ledger.cleanupEnabled !== false,
      flushIntervalMs: Number.isFinite(ledger.flushIntervalMs) ? ledger.flushIntervalMs : 2000,
      spillThresholdBytes: Number.isFinite(ledger.spillThresholdBytes)
        ? ledger.spillThresholdBytes
        : 65536
    }
  };
}

/**
 * Every gate that decides whether a chat is stored, each on its own, so the
 * page can say *which* one is closed instead of only "off".
 *
 * @param {Object} platform - Platform configuration.
 * @param {Object} features - Feature flags.
 * @returns {Object}
 */
function resolveStatus(platform, features) {
  let providerName = null;
  try {
    providerName = getStorage()?.name || null;
  } catch {
    providerName = null;
  }
  const featureChatPersistence = isFeatureEnabled(CHAT_PERSISTENCE_FEATURE, features);
  const featureRunLog = isFeatureEnabled('runLog', features);
  const chatPersistenceActive = isChatPersistenceConfigured(features, platform);
  return {
    featureChatPersistence,
    featureRunLog,
    chatsEnabled: platform?.chats?.enabled !== false,
    runLogEnabled: platform?.runLog?.enabled !== false,
    storageReady: isStorageReady() === true,
    storageProvider: providerName || platform?.storage?.provider || 'filesystem',
    chatPersistenceActive,
    // Durable chats turn the ledger on regardless of its own flag, because a
    // chat is materialized from its run's ledger events.
    ledgerActive: runLog.isEnabled(),
    ledgerForcedByChats:
      chatPersistenceActive && !(featureRunLog && platform?.runLog?.enabled !== false)
  };
}

export default function registerAdminChatHistoryRoutes(app) {
  /**
   * GET /api/admin/chat-history
   * Settings, gate status and storage statistics in one read.
   */
  app.get(buildServerPath('/api/admin/chat-history'), adminAuth, async (_req, res) => {
    try {
      const platform = configCache.getPlatform?.() || {};
      const features = configCache.getFeatures?.() || {};
      const settings = resolveSettings(platform);
      const [chats, ledger] = await Promise.all([
        collectChatStats({ repository: getChatRepository(), settings: settings.chats }),
        getRunSummaryRepository().stats()
      ]);
      res.json({
        settings,
        status: resolveStatus(platform, features),
        stats: { chats, ledger },
        generatedAt: new Date().toISOString()
      });
    } catch (error) {
      return sendInternalError(res, error, 'read chat history overview');
    }
  });

  /**
   * PUT /api/admin/chat-history/settings
   * Update `platform.chats` and/or `platform.runLog`. Only fields present in
   * the body are written; unknown fields are rejected rather than stored.
   */
  app.put(buildServerPath('/api/admin/chat-history/settings'), adminAuth, async (req, res) => {
    const parsed = settingsBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendBadRequest(
        res,
        `Invalid chat history settings: ${parsed.error.issues
          .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    try {
      const { chats, runLog: ledger } = parsed.data;
      const platformConfig = await configStore.readJson('config/platform.json');
      if (!platformConfig) throw new Error('Unable to read config/platform.json');

      // Only values that differ from what is in force are written: the page
      // sends its whole form, and an unchanged field should neither land in
      // the audit entry nor ask for a restart.
      const current = resolveSettings(platformConfig);
      const changed = [];
      for (const [block, patch] of [
        ['chats', chats],
        ['runLog', ledger]
      ]) {
        for (const [key, value] of Object.entries(patch || {})) {
          if (current[block][key] === value) continue;
          platformConfig[block] = { ...(platformConfig[block] || {}), [key]: value };
          changed.push(`${block}.${key}`);
        }
      }

      if (changed.length > 0) {
        await configStore.writeJson('config/platform.json', platformConfig);
        await configCache.refreshCacheEntry('config/platform.json');
        logAudit({
          req,
          action: 'update',
          resource: 'platform',
          resourceId: 'chat-history',
          summary: `Updated ${changed.join(', ')}`
        });
        logger.info('Chat history settings updated', { component: COMPONENT, changed });
      }

      const platform = configCache.getPlatform?.() || platformConfig;
      res.json({
        ok: true,
        changed,
        settings: resolveSettings(platform),
        status: resolveStatus(platform, configCache.getFeatures?.() || {}),
        // The ledger reads its flush interval once, when it is constructed.
        restartRequired: changed.includes('runLog.flushIntervalMs')
      });
    } catch (error) {
      return sendInternalError(res, error, 'update chat history settings');
    }
  });

  /**
   * POST /api/admin/chat-history/retention/run
   * Apply the retention rules now instead of waiting for the daily sweep.
   * Body: `{ target: 'chats' | 'ledger' | 'all' }` (default `all`).
   *
   * Uses the same predicates as the scheduled sweeps: stored chats are only
   * swept while durable chats are configured (switching the feature off must
   * not start deleting what is kept), and the ledger only while its cleanup
   * is enabled.
   */
  app.post(
    buildServerPath('/api/admin/chat-history/retention/run'),
    adminAuth,
    async (req, res) => {
      const parsed = retentionRunSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendBadRequest(res, "Invalid target; expected 'chats', 'ledger' or 'all'");
      }
      if (retentionRunning) {
        return res.status(409).json({ error: 'A retention run is already in progress' });
      }
      retentionRunning = true;
      try {
        const target = parsed.data.target || 'all';
        const platform = configCache.getPlatform?.() || {};
        const features = configCache.getFeatures?.() || {};
        const settings = resolveSettings(platform);
        const result = { chats: null, ledger: null };

        if (target === 'chats' || target === 'all') {
          if (isChatPersistenceConfigured(features, platform)) {
            const { removed } = await sweepChats({
              repository: getChatRepository(),
              retentionDays: settings.chats.retentionDays,
              maxChatsPerUser: settings.chats.maxChatsPerUser
            });
            result.chats = { ran: true, removed };
          } else {
            result.chats = { ran: false, removed: 0, reason: 'chatPersistenceInactive' };
          }
        }

        if (target === 'ledger' || target === 'all') {
          if (settings.runLog.cleanupEnabled) {
            const { removed } = await runLog.cleanup(settings.runLog.retentionDays);
            result.ledger = { ran: true, removed };
          } else {
            result.ledger = { ran: false, removed: 0, reason: 'cleanupDisabled' };
          }
        }

        logAudit({
          req,
          action: 'execute',
          resource: 'platform',
          resourceId: 'chat-history-retention',
          summary: `Retention run (${target}): chats removed ${result.chats?.removed ?? 0}, runs removed ${result.ledger?.removed ?? 0}`
        });
        res.json({ ok: true, target, ...result });
      } catch (error) {
        return sendInternalError(res, error, 'run chat history retention');
      } finally {
        retentionRunning = false;
      }
    }
  );
}
