// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
import { ServiceError } from '../../utils/ServiceError.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { getStorage, isStorageReady } from '../../storage/bootstrap.js';
import runLog from '../../services/loop/RunLog.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import {
  CHAT_PERSISTENCE_FEATURE,
  chatRetentionSettings,
  chatTitleSettings,
  isChatHistoryConfigured,
  isChatStorageAvailable,
  MAX_TEMPORARY_RETENTION_HOURS
} from '../../services/chat/chatPersistence.js';
import {
  CHAT_SHARING_FEATURE,
  chatSharingSettings,
  isChatSharingConfigured,
  sanitizeOrigins,
  shareState
} from '../../services/chat/chatSharing.js';
import { getChatShareRepository, isShareId } from '../../services/chat/ChatShareRepository.js';
import { sweepChats } from '../../services/chat/chatRetention.js';
import { collectChatStats } from '../../services/chat/chatAdminStats.js';
import { getRunSummaryRepository } from '../../services/runtime/RunSummaryRepository.js';
import { STORAGE_MODES, chatFileSettings } from '../../services/chatFiles/chatFilePolicy.js';
import { updatePlatform, SKIP } from '../../utils/platformConfigStore.js';

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
    maxMessagesPerChat: z.number().int(),
    // Unlike the others it cannot switch its rule off: a temporary chat must
    // expire, so the value has to be a positive number of hours.
    temporaryRetentionHours: z.number().int().positive().max(MAX_TEMPORARY_RETENTION_HOURS)
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

// The title block lives under `platform.chats.titles` and is edited next to
// the retention rules but as its own section, like sharing.
const titlesSettingsSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.string().trim().max(200)
  })
  .partial()
  .strict();

// The sharing block lives under `platform.chats.sharing` but is edited as its
// own form section, so it travels as its own block here. Day and view caps
// are integers; zero or less is the documented "no cap".
const sharingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    allowUsers: z.boolean(),
    allowAuthenticated: z.boolean(),
    allowPublic: z.boolean(),
    defaultExpiryDays: z.number().int(),
    maxExpiryDays: z.number().int(),
    maxViewsCap: z.number().int(),
    allowArtifacts: z.boolean(),
    embedEnabled: z.boolean(),
    embedAllowedOrigins: z.array(z.string().max(300)).max(50)
  })
  .partial()
  .strict();

// Uploaded files of chats and scheduled tasks (`platform.uploads`). Sizes are
// bytes; zero or less is "no cap" (the three that name a size or count).
const uploadsSettingsSchema = z
  .object({
    enabled: z.boolean(),
    storageMode: z.enum(STORAGE_MODES),
    originalRetentionDays: z.number().int(),
    evictOldestOriginalsOnQuota: z.boolean(),
    quotas: z
      .object({
        maxFileBytes: z.number().int(),
        maxChatBytes: z.number().int(),
        maxChatFiles: z.number().int(),
        maxUserBytes: z.number().int(),
        maxServerBytes: z.number().int(),
        maxApiFiles: z.number().int(),
        maxApiBytes: z.number().int()
      })
      .partial()
      .strict()
  })
  .partial()
  .strict();

const settingsBodySchema = z
  .object({
    chats: chatsSettingsSchema.optional(),
    titles: titlesSettingsSchema.optional(),
    runLog: runLogSettingsSchema.optional(),
    sharing: sharingSettingsSchema.optional(),
    uploads: uploadsSettingsSchema.optional()
  })
  .strict();

/** Most shares the admin listing returns. */
const ADMIN_SHARES_LIMIT = 200;

const retentionRunSchema = z
  .object({ target: z.enum(['chats', 'ledger', 'all']).optional() })
  .strict();

/** A manual retention run in flight — one at a time is plenty. */
let retentionRunning = false;

/**
 * The effective settings, defaults filled in, in the shape the page edits.
 *
 * @param {Object} platform - Platform configuration.
 * @returns {{chats: Object, titles: Object, sharing: Object, uploads: Object, runLog: Object}}
 */
function resolveSettings(platform) {
  const chats = platform?.chats || {};
  const ledger = platform?.runLog || {};
  return {
    chats: {
      enabled: chats.enabled !== false,
      ...chatRetentionSettings(platform)
    },
    titles: chatTitleSettings(platform),
    sharing: chatSharingSettings(platform),
    uploads: (() => {
      const { enabled, storageMode, originalRetentionDays, evictOldestOriginalsOnQuota, quotas } =
        chatFileSettings(platform);
      return { enabled, storageMode, originalRetentionDays, evictOldestOriginalsOnQuota, quotas };
    })(),
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
  const featureChatSharing = isFeatureEnabled(CHAT_SHARING_FEATURE, features);
  const chatPersistenceActive = isChatHistoryConfigured(features, platform);
  return {
    featureChatPersistence,
    featureRunLog,
    featureChatSharing,
    sharingEnabled: chatSharingSettings(platform).enabled !== false,
    chatSharingActive: isChatSharingConfigured(features, platform),
    chatsEnabled: platform?.chats?.enabled !== false,
    runLogEnabled: platform?.runLog?.enabled !== false,
    storageReady: isStorageReady() === true,
    storageProvider: providerName || platform?.storage?.provider || 'filesystem',
    chatPersistenceActive,
    // Stored chats turn the ledger on regardless of its own flag, because a
    // chat is materialized from its run's ledger events — and every chat is
    // stored once storage is up, kept or temporary.
    ledgerActive: runLog.isEnabled(),
    ledgerForcedByChats:
      isChatStorageAvailable() && !(featureRunLog && platform?.runLog?.enabled !== false)
  };
}

export default function registerAdminChatHistoryRoutes(app) {
  /**
   * GET /api/admin/chat-history
   * Settings, gate status and storage statistics in one read.
   */
  app.get(buildServerPath('/api/admin/chat-history'), adminAuth, async (_req, res) => {
    const platform = configCache.getPlatform?.() || {};
    const features = configCache.getFeatures?.() || {};
    const settings = resolveSettings(platform);
    const [chats, ledger, shares] = await Promise.all([
      collectChatStats({ repository: getChatRepository(), settings: settings.chats }),
      getRunSummaryRepository().stats(),
      getChatShareRepository().collectStats()
    ]);
    res.json({
      settings,
      status: resolveStatus(platform, features),
      stats: { chats, ledger, shares },
      generatedAt: new Date().toISOString()
    });
  });

  /**
   * PUT /api/admin/chat-history/settings
   * Update `platform.chats` and/or `platform.runLog`. Only fields present in
   * the body are written; unknown fields are rejected rather than stored.
   */
  app.put(buildServerPath('/api/admin/chat-history/settings'), adminAuth, async (req, res) => {
    const parsed = settingsBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      throw new ServiceError(
        'BAD_REQUEST',
        `Invalid chat history settings: ${parsed.error.issues
          .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    const { chats, runLog: ledger, titles, sharing, uploads } = parsed.data;
    // Computed from the stored file under the update lock; reruns on conflict, so
    // everything it needs is derived from the body it is handed.
    let changed = [];
    const { data: platformConfig } = await updatePlatform(platformConfig => {
      changed = [];
      // Only values that differ from what is in force are written: the page
      // sends its whole form, and an unchanged field should neither land in
      // the audit entry nor ask for a restart.
      const current = resolveSettings(platformConfig);
      for (const [block, patch] of [
        ['chats', chats],
        ['runLog', ledger]
      ]) {
        for (const [key, value] of Object.entries(patch || {})) {
          if (current[block][key] === value) continue;
          platformConfig[block] = { ...platformConfig[block], [key]: value };
          changed.push(`${block}.${key}`);
        }
      }
      // The titles form section is `platform.chats.titles` on disk.
      for (const [key, value] of Object.entries(titles || {})) {
        if (current.titles[key] === value) continue;
        platformConfig.chats = {
          ...platformConfig.chats,
          titles: { ...platformConfig.chats?.titles, [key]: value }
        };
        changed.push(`chats.titles.${key}`);
      }
      // The sharing form section is `platform.chats.sharing` on disk.
      const nextSharing = { ...current.sharing, ...sharing };
      if (
        nextSharing.defaultExpiryDays > 0 &&
        nextSharing.maxExpiryDays > 0 &&
        nextSharing.defaultExpiryDays > nextSharing.maxExpiryDays
      ) {
        throw new ServiceError(
          'BAD_REQUEST',
          'Invalid chat history settings: sharing.defaultExpiryDays must not exceed sharing.maxExpiryDays'
        );
      }
      for (const [key, rawValue] of Object.entries(sharing || {})) {
        // Origins are stored as bare `http(s)` origins; anything else is dropped.
        const value = key === 'embedAllowedOrigins' ? sanitizeOrigins(rawValue) : rawValue;
        if (JSON.stringify(current.sharing[key]) === JSON.stringify(value)) continue;
        platformConfig.chats = {
          ...platformConfig.chats,
          sharing: { ...platformConfig.chats?.sharing, [key]: value }
        };
        changed.push(`chats.sharing.${key}`);
      }

      // `platform.uploads`: top-level values and the `quotas` block, written
      // one by one so only what changed shows up in the audit entry.
      for (const [key, value] of Object.entries(uploads || {})) {
        if (key === 'quotas') {
          for (const [quota, limit] of Object.entries(value || {})) {
            if (current.uploads.quotas[quota] === limit) continue;
            platformConfig.uploads = {
              ...platformConfig.uploads,
              quotas: { ...platformConfig.uploads?.quotas, [quota]: limit }
            };
            changed.push(`uploads.quotas.${quota}`);
          }
        } else if (current.uploads[key] !== value) {
          platformConfig.uploads = { ...platformConfig.uploads, [key]: value };
          changed.push(`uploads.${key}`);
        }
      }

      if (changed.length === 0) return SKIP;
    });

    if (changed.length > 0) {
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
      changed,
      settings: resolveSettings(platform),
      status: resolveStatus(platform, configCache.getFeatures?.() || {}),
      // The ledger reads its flush interval once, when it is constructed.
      restartRequired: changed.includes('runLog.flushIntervalMs')
    });
  });

  /**
   * GET /api/admin/chat-history/shares
   * The newest shares across the installation, with their state — for
   * support and compliance. Bounded; `truncated` says when the walk was cut.
   */
  app.get(buildServerPath('/api/admin/chat-history/shares'), adminAuth, async (_req, res) => {
    const now = Date.now();
    const { shares, truncated } = await getChatShareRepository().scanShares();
    const items = shares.slice(0, ADMIN_SHARES_LIMIT).map(share => ({
      id: share.id,
      chatId: share.chatId,
      ownerId: share.ownerId,
      ownerName: share.ownerName || null,
      appId: share.appId || null,
      title: share.title || '',
      target: share.target || 'chat',
      embeddable: share.embeddable === true,
      mode: share.mode,
      state: shareState(share, now),
      recipientCount: Array.isArray(share.recipients) ? share.recipients.length : 0,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt || null,
      revokedAt: share.revokedAt || null,
      maxViews: share.maxViews || null,
      viewCount: share.viewCount || 0,
      lastViewedAt: share.lastViewedAt || null
    }));
    res.json({ items, truncated: truncated || shares.length > ADMIN_SHARES_LIMIT });
  });

  /**
   * DELETE /api/admin/chat-history/shares/:shareId
   * Revoke any share. The owner's own revoke goes through
   * `DELETE /api/shares/:shareId`; this is the admin's, and it is audited as
   * such.
   */
  app.delete(
    buildServerPath('/api/admin/chat-history/shares/:shareId'),
    adminAuth,
    async (req, res) => {
      const { shareId } = req.params;
      if (!isShareId(shareId)) throw new ServiceError('NOT_FOUND', 'Share not found');
      const revoked = await getChatShareRepository().revokeShare(shareId);
      if (!revoked) throw new ServiceError('NOT_FOUND', 'Share not found');
      logAudit({
        req,
        action: 'delete',
        resource: 'chatShare',
        resourceId: shareId,
        summary: `Admin revoked share of chat ${revoked.chatId} (${revoked.mode})`
      });
      res.json({ ...revoked, views: undefined, state: 'revoked' });
    }
  );

  /**
   * POST /api/admin/chat-history/retention/_run
   * Apply the retention rules now instead of waiting for the daily sweep.
   * Body: `{ target: 'chats' | 'ledger' | 'all' }` (default `all`).
   *
   * Uses the same predicates as the scheduled sweeps: stored chats are only
   * swept while durable chats are configured (switching the feature off must
   * not start deleting what is kept), and the ledger only while its cleanup
   * is enabled.
   */
  app.post(
    buildServerPath('/api/admin/chat-history/retention/_run'),
    adminAuth,
    async (req, res) => {
      const parsed = retentionRunSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new ServiceError(
          'BAD_REQUEST',
          "Invalid target; expected 'chats', 'ledger' or 'all'"
        );
      }
      if (retentionRunning) {
        throw new ServiceError('CONFLICT', 'A retention run is already in progress');
      }
      retentionRunning = true;
      try {
        const target = parsed.data.target || 'all';
        const platform = configCache.getPlatform?.() || {};
        const features = configCache.getFeatures?.() || {};
        const settings = resolveSettings(platform);
        const result = { chats: null, ledger: null };

        if (target === 'chats' || target === 'all') {
          // Temporary chats expire whenever storage is up; the history rules
          // only while there is a history to apply them to.
          const history = isChatHistoryConfigured(features, platform);
          if (isChatStorageAvailable()) {
            const { removed } = await sweepChats({
              repository: getChatRepository(),
              retentionDays: history ? settings.chats.retentionDays : 0,
              maxChatsPerUser: history ? settings.chats.maxChatsPerUser : 0,
              temporaryRetentionHours: chatRetentionSettings(platform).temporaryRetentionHours
            });
            result.chats = { ran: true, removed, ...(history ? {} : { historyRules: false }) };
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
        res.json({ target, ...result });
      } finally {
        retentionRunning = false;
      }
    }
  );
}
