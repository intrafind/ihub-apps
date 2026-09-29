/**
 * Admin scheduled tasks — every user's tasks, and the platform limits.
 *
 *   GET    /api/admin/scheduled-tasks                 all tasks, settings, gate status
 *   GET    /api/admin/scheduled-tasks/:taskId         one task
 *   PATCH  /api/admin/scheduled-tasks/:taskId         { status: paused|active|disabled, reason? }
 *   DELETE /api/admin/scheduled-tasks/:taskId        ?deleteChats=1
 *   GET    /api/admin/scheduled-tasks/:taskId/runs    run history (cursor-paged)
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
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { logAudit } from '../../services/AuditLogService.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import { isChatPersistenceConfigured } from '../../services/chat/chatPersistence.js';
import {
  SCHEDULED_TASKS_FEATURE,
  scheduledTaskSettings
} from '../../services/scheduler/tasks/taskPolicy.js';
import * as tasks from '../../services/scheduler/tasks/taskService.js';
import { getScheduler } from '../../services/scheduler/SchedulerService.js';
import { getScheduledTaskRepository } from '../../services/scheduler/tasks/ScheduledTaskRepository.js';
import { sendTaskError, requestLanguage } from '../scheduledTasks.js';

const COMPONENT = 'AdminScheduledTasks';

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
    maxRunChatsPerTask: int(0, 10_000),
    maxInstructionLength: int(100, 100_000),
    maxRunMinutes: int(1, 30)
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
  const chatPersistence = isChatPersistenceConfigured(features, platform);
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
    try {
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
    } catch (error) {
      sendTaskError(res, error, 'admin list tasks');
    }
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
    const parsed = settingsBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return sendBadRequest(
        res,
        `Invalid scheduled task settings: ${parsed.error.issues
          .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    try {
      const platformConfig = await configStore.readJson('config/platform.json');
      if (!platformConfig) throw new Error('Unable to read config/platform.json');
      const current = scheduledTaskSettings(platformConfig);
      const changed = [];
      for (const [key, value] of Object.entries(parsed.data)) {
        if (current[key] === value) continue;
        platformConfig.scheduledTasks = { ...(platformConfig.scheduledTasks || {}), [key]: value };
        changed.push(`scheduledTasks.${key}`);
      }
      if (changed.length > 0) {
        await configStore.writeJson('config/platform.json', platformConfig);
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
        ok: true,
        changed,
        settings: scheduledTaskSettings(platform),
        status: resolveStatus(platform, configCache.getFeatures() || {})
      });
    } catch (error) {
      sendInternalError(res, error, `${COMPONENT}: update settings`);
    }
  });

  app.get(`${base}/:taskId`, adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.taskId, 'task', res)) return;
      res.json(await tasks.adminGetTask(req.params.taskId, { language: requestLanguage(req) }));
    } catch (error) {
      sendTaskError(res, error, 'admin get task');
    }
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
    try {
      if (!validateIdForPath(req.params.taskId, 'task', res)) return;
      const parsed = statusBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendBadRequest(res, 'Body must be { status: paused|active|disabled, reason? }');
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
    } catch (error) {
      sendTaskError(res, error, 'admin set task status');
    }
  });

  app.delete(`${base}/:taskId`, adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.taskId, 'task', res)) return;
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
    } catch (error) {
      sendTaskError(res, error, 'admin delete task');
    }
  });

  app.get(`${base}/:taskId/runs`, adminAuth, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.taskId, 'task', res)) return;
      res.json(
        await tasks.adminListRuns(req.params.taskId, {
          limit: req.query.limit,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
        })
      );
    } catch (error) {
      sendTaskError(res, error, 'admin list runs');
    }
  });
}
