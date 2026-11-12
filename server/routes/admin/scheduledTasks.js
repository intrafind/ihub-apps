// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin scheduled tasks — every user's tasks, and the platform limits.
 *
 *   GET    /api/admin/scheduled-tasks                 all tasks, settings, gate status
 *   GET    /api/admin/scheduled-tasks/:taskId         one task
 *   PATCH  /api/admin/scheduled-tasks/:taskId         { status: paused|active|disabled, reason? }
 *   DELETE /api/admin/scheduled-tasks/:taskId        ?deleteChats=1
 *   GET    /api/admin/scheduled-tasks/:taskId/runs    run history (cursor-paged)
 *   DELETE /api/admin/scheduled-tasks/:taskId/runs        delete all finished runs of the task
 *   PUT    /api/admin/scheduled-tasks/settings        update `platform.scheduledTasks`
 *
 * An admin can stop any task but never runs one or edits what it does: a run
 * always acts as its owner, and changing a task's instructions would make it
 * act for the owner in a way they did not ask for.
 *
 * @module routes/admin/scheduledTasks
 */
import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import configCache from '../../configCache.js';
import { logAudit } from '../../services/AuditLogService.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import { isChatHistoryConfigured } from '../../services/chat/chatPersistence.js';
import {
  SCHEDULED_TASKS_FEATURE,
  scheduledTaskSettings
} from '../../services/scheduler/tasks/taskPolicy.js';
import * as tasks from '../../services/scheduler/tasks/taskService.js';
import { getScheduler } from '../../services/scheduler/SchedulerService.js';
import { getScheduledTaskRepository } from '../../services/scheduler/tasks/ScheduledTaskRepository.js';
import { requestLanguage, runDeletionFromQuery } from '../scheduledTasks.js';
import { updatePlatform, SKIP } from '../../utils/platformConfigStore.js';

const int = (min, max) => z.number().int().min(min).max(max);

/** Every field optional; unknown fields rejected rather than stored. */
const settingsBodySchema = z
  .object({
    enabled: z.boolean(),
    maxTasksPerUser: int(0, 10_000),
    minIntervalMinutes: int(1, 60 * 24 * 31),
    maxConcurrentRuns: int(1, 100),
    maxConcurrentRunsPerUser: int(1, 100),
    staggerMinutes: int(0, 60),
    catchUpWindowHours: int(0, 24 * 31),
    maxConsecutiveFailures: int(0, 1000),
    approvalTimeoutHours: int(1, 24 * 31),
    runRetentionDays: int(0, 3650),
    maxRunsPerTask: int(0, 10_000),
    maxRunChatsPerTask: int(0, 10_000),
    maxInstructionLength: int(100, 100_000),
    maxRunMinutes: int(1, 30),
    memoryEnabled: z.boolean(),
    memoryMaxChars: int(1000, 64_000),
    maxHistoryReadChars: int(1000, 50_000)
  })
  .partial()
  .strict();

const statusBodySchema = z
  .object({
    status: z.enum(['paused', 'active', 'disabled']),
    reason: z.string().max(500).optional()
  })
  .strict();

function resolveStatus(platform, features) {
  const featureEnabled = isFeatureEnabled(SCHEDULED_TASKS_FEATURE, features);
  const chatPersistence = isChatHistoryConfigured(features, platform);
  const settings = scheduledTaskSettings(platform);
  return {
    featureEnabled,
    chatPersistence,
    platformEnabled: settings.enabled,
    storageReady: isStorageReady(),
    active: featureEnabled && chatPersistence && settings.enabled
  };
}

export default function registerAdminScheduledTaskRoutes(app) {
  const base = buildServerPath('/api/admin/scheduled-tasks');

  /**
   * @swagger
   * /api/admin/scheduled-tasks:
   *   get:
   *     summary: List every scheduled task
   *     description: All users' scheduled tasks with owner, app, schedule, status and last run.
   *     tags:
   *       - Admin - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [active, paused, completed, disabled]
   *     responses:
   *       200:
   *         description: "`{ items, settings, status, scheduler }`"
   *       403:
   *         description: Admin access required
   */
  app.get(base, adminAuth, async (req, res) => {
    const platform = configCache.getPlatform() || {};
    const features = configCache.getFeatures() || {};
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const items = getScheduledTaskRepository().isAvailable()
      ? await tasks.adminListTasks({ status, language: requestLanguage(req) })
      : [];
    const scheduler = getScheduler();
    res.json({
      items,
      settings: scheduledTaskSettings(platform),
      status: resolveStatus(platform, features),
      scheduler: {
        owner: scheduler.isActiveOwner(),
        ...(scheduler.isActiveOwner() ? { sources: scheduler.describe() } : {})
      }
    });
  });

  /**
   * @swagger
   * /api/admin/scheduled-tasks/settings:
   *   put:
   *     summary: Update scheduled task limits
   *     description: Writes `platform.scheduledTasks`. Only the fields sent are changed.
   *     tags:
   *       - Admin - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: "`{ ok, changed, settings, status }`"
   *       400:
   *         description: Invalid settings
   */
  app.put(`${base}/settings`, adminAuth, async (req, res) => {
    const parsed = { data: settingsBodySchema.parse(req.body || {}) };
    // Compared with the stored file under the update lock; reruns on conflict.
    let changed = [];
    const { data: platformConfig } = await updatePlatform(platformConfig => {
      const current = scheduledTaskSettings(platformConfig);
      changed = [];
      for (const [key, value] of Object.entries(parsed.data)) {
        if (current[key] === value) continue;
        platformConfig.scheduledTasks = { ...platformConfig.scheduledTasks, [key]: value };
        changed.push(`scheduledTasks.${key}`);
      }
      if (changed.length === 0) return SKIP;
    });
    if (changed.length > 0) {
      await configCache.refreshCacheEntry('config/platform.json');
      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'scheduled-tasks',
        summary: `Updated ${changed.join(', ')}`
      });
    }
    const platform = configCache.getPlatform() || platformConfig;
    res.json({
      changed,
      settings: scheduledTaskSettings(platform),
      status: resolveStatus(platform, configCache.getFeatures() || {})
    });
  });

  app.get(`${base}/:taskId`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    res.json(await tasks.adminGetTask(req.params.taskId, { language: requestLanguage(req) }));
  });

  /**
   * @swagger
   * /api/admin/scheduled-tasks/{taskId}:
   *   patch:
   *     summary: Pause, resume or disable a scheduled task
   *     tags:
   *       - Admin - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [status]
   *             properties:
   *               status: { type: string, enum: [paused, active, disabled] }
   *               reason: { type: string }
   *     responses:
   *       200:
   *         description: The task
   *       404:
   *         description: Task not found
   *   delete:
   *     summary: Delete a scheduled task
   *     tags:
   *       - Admin - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: deleteChats
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: "`{ deleted, chatsDeleted }`"
   */
  app.patch(`${base}/:taskId`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const parsed = statusBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      throw new ServiceError(
        'INVALID_BODY',
        'Body must be { status: paused|active|disabled, reason? }'
      );
    }
    const task = await tasks.adminSetTaskStatus(
      req.user,
      req.params.taskId,
      parsed.data.status,
      parsed.data.reason
    );
    logAudit({
      req,
      action: 'toggle',
      resource: 'scheduledTask',
      resourceId: task.id,
      summary: `Set scheduled task of ${task.owner?.username || task.ownerId} to ${parsed.data.status}`
    });
    res.json(tasks.toPublicTask(task, { language: requestLanguage(req), admin: true }));
  });

  app.delete(`${base}/:taskId`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const deleteChats = ['1', 'true'].includes(String(req.query.deleteChats || ''));
    const result = await tasks.adminDeleteTask(req.params.taskId, { deleteChats });
    logAudit({
      req,
      action: 'delete',
      resource: 'scheduledTask',
      resourceId: req.params.taskId,
      summary: `Deleted a scheduled task${deleteChats ? ` and ${result.chatsDeleted} run chats` : ''}`
    });
    res.json(result);
  });

  /**
   * @swagger
   * /api/admin/scheduled-tasks/{taskId}/memory:
   *   get:
   *     summary: Metadata of the notes a task keeps between runs
   *     description: >
   *       Size, version, last update and last writer of the task's notes. Admins never get
   *       the content; only the owner reads it.
   *     tags:
   *       - Admin - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: "`{ enabled, platformEnabled, version, chars, updatedAt, updatedBy }`"
   *       404:
   *         description: Task not found
   *   delete:
   *     summary: Clear the notes of a task
   *     tags:
   *       - Admin - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: "`{ version }`"
   */
  app.get(`${base}/:taskId/memory`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    res.json(await tasks.adminGetTaskMemory(req.params.taskId));
  });

  app.delete(`${base}/:taskId/memory`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const result = await tasks.adminClearTaskMemory(req.params.taskId);
    logAudit({
      req,
      action: 'delete',
      resource: 'scheduledTaskMemory',
      resourceId: req.params.taskId,
      summary: 'Cleared the notes of a scheduled task'
    });
    res.json(result);
  });

  app.get(`${base}/:taskId/runs`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    res.json(
      await tasks.adminListRuns(req.params.taskId, {
        limit: req.query.limit,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
      })
    );
  });

  app.delete(`${base}/:taskId/runs`, adminAuth, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const result = await tasks.adminDeleteRuns(req.params.taskId, runDeletionFromQuery(req.query));
    logAudit({
      req,
      action: 'delete',
      resource: 'scheduledTask',
      resourceId: req.params.taskId,
      summary: `Admin deleted ${result.deleted} run${result.deleted === 1 ? '' : 's'}`
    });
    res.json(result);
  });
}
