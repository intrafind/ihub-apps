/**
 * Scheduled task routes — the caller's own tasks.
 *
 *   GET    /api/scheduled-tasks                          the caller's tasks (+ limits)
 *   POST   /api/scheduled-tasks                          create
 *   POST   /api/scheduled-tasks/_preview                 validate a schedule, describe it, next runs
 *   GET    /api/scheduled-tasks/_notifications           runs the caller has not seen
 *   POST   /api/scheduled-tasks/_notifications/seen      mark them seen
 *   GET    /api/scheduled-tasks/_apps/:appId/tools       tools a task of this app may use
 *   GET    /api/scheduled-tasks/:taskId                  one task
 *   PUT    /api/scheduled-tasks/:taskId                  edit (absent fields keep their value)
 *   PATCH  /api/scheduled-tasks/:taskId                  same as PUT
 *   DELETE /api/scheduled-tasks/:taskId?deleteChats=1    delete (optionally with the run chats)
 *   POST   /api/scheduled-tasks/:taskId/run              run now
 *   POST   /api/scheduled-tasks/:taskId/pause            pause
 *   POST   /api/scheduled-tasks/:taskId/resume           resume
 *   POST   /api/scheduled-tasks/:taskId/duplicate        copy
 *   GET    /api/scheduled-tasks/:taskId/memory           the notes the task keeps between runs
 *   PUT    /api/scheduled-tasks/:taskId/memory           replace them { content, expectedVersion }
 *   DELETE /api/scheduled-tasks/:taskId/memory           clear them
 *   GET    /api/scheduled-tasks/:taskId/runs             run history, newest first (cursor-paged)
 *   GET    /api/scheduled-tasks/:taskId/runs/:runId      one run
 *   POST   /api/scheduled-tasks/:taskId/runs/:runId/cancel
 *   POST   /api/scheduled-tasks/:taskId/runs/:runId/approval   { decision, alwaysAllow }
 *   DELETE /api/scheduled-tasks/:taskId/allowed-tools/:toolId  revoke "always allow"
 *
 * `authenticatedOnly`: tasks are owned resources, and an id that is not the
 * caller's is a 404, never a 403. Creating, editing, running and resuming
 * also need the `scheduledTasks` group permission and an interactive
 * session; reading, pausing and deleting what one already owns do not, so a
 * user whose permission was withdrawn can still clean up.
 *
 * @module routes/scheduledTasks
 */
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { requireFeature } from '../featureRegistry.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { sendInternalError } from '../utils/responseHelpers.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import { canUserAccessResource } from '../utils/authorization.js';
import configCache from '../configCache.js';
import { logAudit } from '../services/AuditLogService.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import {
  SCHEDULED_TASKS_FEATURE,
  checkTaskPrincipal
} from '../services/scheduler/tasks/taskPolicy.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { requiresApproval } from '../services/scheduler/tasks/runSeams.js';

const COMPONENT = 'ScheduledTaskRoutes';

const checkFeature = requireFeature(SCHEDULED_TASKS_FEATURE);

function userKey(req) {
  // Anonymous callers share one principal id, so they are keyed by IP.
  return req.user?.id && req.user.id !== 'anonymous'
    ? `user:${req.user.id}`
    : ipKeyGenerator(req.ip || '');
}

/** Creating tasks: generous for a person, a wall for a script. */
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: {
    error: 'Too many scheduled tasks created, please try again later',
    code: 'RATE_LIMITED'
  }
});

/** Editing the notes of a task: a person typing, not a script. */
const memoryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many memory edits, please try again later', code: 'RATE_LIMITED' }
});

/** Starting runs by hand. */
const runLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many runs started, please try again later', code: 'RATE_LIMITED' }
});

export function requestLanguage(req) {
  const query = typeof req.query?.lang === 'string' ? req.query.lang : '';
  const header = req.headers['accept-language']?.split(',')[0] || '';
  return (query || header || configCache.getPlatform()?.defaultLanguage || 'en').slice(0, 10);
}

function requestTimezone(req) {
  const value = req.body?.timezone ?? req.query?.timezone;
  return typeof value === 'string' ? value.slice(0, 64) : undefined;
}

/** Send a service error as JSON. */
export function sendTaskError(res, error, operation) {
  if (error instanceof tasks.ScheduledTaskError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details !== undefined ? { details: error.details } : {})
    });
  }
  if (error instanceof StorageError) {
    const status = storageHttpStatus(error) || 503;
    return res.status(status).json({ error: error.message, code: error.code || 'STORAGE_ERROR' });
  }
  return sendInternalError(res, error, `${COMPONENT}: ${operation}`);
}

function validTaskId(req, res) {
  return validateIdForPath(req.params.taskId, 'task', res);
}

function validRunId(req, res) {
  return validateIdForPath(req.params.runId, 'run', res);
}

function audit(req, action, taskId, summary) {
  logAudit({ req, action, resource: 'scheduledTask', resourceId: taskId, summary });
}

/** The notes themselves are never part of an audit entry. */
function auditMemory(req, action, taskId, summary) {
  logAudit({ req, action, resource: 'scheduledTaskMemory', resourceId: taskId, summary });
}

export default function registerScheduledTaskRoutes(app) {
  const base = buildServerPath('/api/scheduled-tasks');
  const guard = [checkFeature, authenticatedOnly];

  /**
   * @swagger
   * /scheduled-tasks:
   *   get:
   *     summary: List your scheduled tasks
   *     description: The caller's scheduled tasks, newest first, with the platform limits.
   *     tags:
   *       - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: "`{ items, limits, canCreate }`"
   *       401:
   *         description: Authentication required
   *       503:
   *         description: Scheduled tasks are not available
   *   post:
   *     summary: Create a scheduled task
   *     tags:
   *       - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, instructions, appId, schedule]
   *             properties:
   *               name: { type: string }
   *               description: { type: string }
   *               instructions: { type: string }
   *               appId: { type: string }
   *               modelId: { type: string, nullable: true }
   *               variables: { type: object }
   *               enabledTools: { type: array, items: { type: string }, nullable: true }
   *               websearchEnabled: { type: boolean, nullable: true }
   *               notify: { type: string, enum: [always, failure, never] }
   *               schedule:
   *                 type: object
   *                 description: "`{ type: manual|once|interval|daily|weekdays|weekly|monthly|cron, ... }`"
   *               timezone: { type: string, description: Default timezone for the schedule }
   *               proposalId: { type: string, description: Confirmation card the task came from }
   *     responses:
   *       201:
   *         description: The task
   *       400:
   *         description: Invalid task (`details` lists every problem)
   *       403:
   *         description: Not allowed to use scheduled tasks
   *       409:
   *         description: Task limit reached, or the proposal was already saved
   */
  app.get(base, ...guard, async (req, res) => {
    try {
      const language = requestLanguage(req);
      const items = await tasks.listTasks(req.user, { language });
      const { settings } = tasks.currentPolicy();
      res.json({
        items,
        limits: {
          maxTasksPerUser: settings.maxTasksPerUser,
          minIntervalMinutes: settings.minIntervalMinutes,
          staggerMinutes: settings.staggerMinutes,
          maxInstructionLength: settings.maxInstructionLength,
          maxRunChatsPerTask: settings.maxRunChatsPerTask
        },
        canCreate: checkTaskPrincipal(req.user).ok
      });
    } catch (error) {
      sendTaskError(res, error, 'list tasks');
    }
  });

  app.post(base, ...guard, createLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const task = await tasks.createTask(req.user, body, {
        language: requestLanguage(req),
        timezone: requestTimezone(req),
        createdVia: body.proposalId ? 'tool' : 'ui',
        proposalId: body.proposalId,
        sourceChatId: body.sourceChatId
      });
      audit(
        req,
        'create',
        task.id,
        `Created scheduled task "${task.name}" (${task.schedule.type})`
      );
      res.status(201).json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
    } catch (error) {
      sendTaskError(res, error, 'create task');
    }
  });

  /**
   * @swagger
   * /scheduled-tasks/_preview:
   *   post:
   *     summary: Preview a schedule
   *     description: Validates a schedule and returns what it means and when it runs next.
   *     tags:
   *       - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               schedule: { type: object }
   *               timezone: { type: string }
   *               count: { type: integer, minimum: 1, maximum: 10 }
   *     responses:
   *       200:
   *         description: "`{ schedule, valid, errors, description, nextRuns, nextRunsLocal }`"
   */
  app.post(`${base}/_preview`, ...guard, (req, res) => {
    try {
      tasks.assertAvailable();
      const count = Math.max(1, Math.min(10, Number(req.body?.count) || 5));
      res.json(
        tasks.previewTaskSchedule(req.body?.schedule || {}, {
          language: requestLanguage(req),
          timezone: requestTimezone(req),
          count
        })
      );
    } catch (error) {
      sendTaskError(res, error, 'preview schedule');
    }
  });

  app.get(`${base}/_notifications`, ...guard, async (req, res) => {
    try {
      res.json({ items: await tasks.listNotifications(req.user) });
    } catch (error) {
      sendTaskError(res, error, 'list notifications');
    }
  });

  app.post(`${base}/_notifications/seen`, ...guard, async (req, res) => {
    try {
      const runIds = Array.isArray(req.body?.runIds)
        ? req.body.runIds.filter(id => typeof id === 'string').slice(0, 200)
        : undefined;
      const cleared = await tasks.markNotificationsSeen(req.user, { runIds });
      res.json({ cleared });
    } catch (error) {
      sendTaskError(res, error, 'mark notifications seen');
    }
  });

  app.get(`${base}/_apps/:appId/tools`, ...guard, async (req, res) => {
    try {
      if (!validateIdForPath(req.params.appId, 'app', res)) return;
      tasks.assertAvailable();
      const { data: apps = [] } = configCache.getApps() || {};
      const appConfig = findByIdCaseInsensitive(apps, req.params.appId);
      if (!appConfig || !canUserAccessResource(req.user, 'apps', appConfig.id)) {
        return res.status(404).json({ error: 'App not found' });
      }
      const language = requestLanguage(req);
      const offered = await tasks.toolsOfferedByApp(appConfig, req.user, language);
      const { data: toolDefs = [] } = configCache.getTools() || {};
      const selected = Array.isArray(appConfig.tools) ? appConfig.tools : [];
      res.json({
        items: offered.map(tool => {
          const def = toolDefs.find(entry => entry.id === tool.id);
          return {
            ...tool,
            requiresApproval: requiresApproval(def),
            // Tools the app lists itself can be toggled; injected ones
            // (web search, sources, workflows, skills) always come along.
            toggleable: selected.includes(tool.id) || selected.includes(tool.id.split('_')[0])
          };
        })
      });
    } catch (error) {
      sendTaskError(res, error, 'list app tools');
    }
  });

  app.get(`${base}/:taskId`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      res.json(
        await tasks.getTask(req.user, req.params.taskId, { language: requestLanguage(req) })
      );
    } catch (error) {
      sendTaskError(res, error, 'get task');
    }
  });

  const update = async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const task = await tasks.updateTask(req.user, req.params.taskId, req.body || {}, {
        language: requestLanguage(req),
        timezone: requestTimezone(req)
      });
      audit(req, 'update', task.id, `Updated scheduled task "${task.name}"`);
      res.json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
    } catch (error) {
      sendTaskError(res, error, 'update task');
    }
  };
  app.put(`${base}/:taskId`, ...guard, update);
  app.patch(`${base}/:taskId`, ...guard, update);

  app.delete(`${base}/:taskId`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const deleteChats = ['1', 'true'].includes(String(req.query.deleteChats || ''));
      const result = await tasks.deleteTask(req.user, req.params.taskId, { deleteChats });
      audit(
        req,
        'delete',
        req.params.taskId,
        `Deleted scheduled task${deleteChats ? ` and ${result.chatsDeleted} run chats` : ''}`
      );
      res.json(result);
    } catch (error) {
      sendTaskError(res, error, 'delete task');
    }
  });

  app.post(`${base}/:taskId/run`, ...guard, runLimiter, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const run = await tasks.requestRun(req.user, req.params.taskId);
      audit(req, 'execute', req.params.taskId, 'Started a scheduled task run manually');
      res.status(202).json(run);
    } catch (error) {
      sendTaskError(res, error, 'run task');
    }
  });

  for (const [action, status] of [
    ['pause', 'paused'],
    ['resume', 'active']
  ]) {
    app.post(`${base}/:taskId/${action}`, ...guard, async (req, res) => {
      try {
        if (!validTaskId(req, res)) return;
        if (status === 'active') tasks.assertPrincipal(req.user);
        const task = await tasks.setTaskStatus(req.user, req.params.taskId, status);
        audit(
          req,
          'toggle',
          task.id,
          `${action === 'pause' ? 'Paused' : 'Resumed'} scheduled task`
        );
        res.json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
      } catch (error) {
        sendTaskError(res, error, `${action} task`);
      }
    });
  }

  app.post(`${base}/:taskId/duplicate`, ...guard, createLimiter, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const task = await tasks.duplicateTask(req.user, req.params.taskId, {
        language: requestLanguage(req)
      });
      audit(req, 'create', task.id, `Duplicated scheduled task ${req.params.taskId}`);
      res.status(201).json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
    } catch (error) {
      sendTaskError(res, error, 'duplicate task');
    }
  });

  /**
   * @swagger
   * /scheduled-tasks/{taskId}/memory:
   *   get:
   *     summary: Read the notes a task keeps between runs
   *     description: >
   *       The owner's view of the task's memory: the markdown notes with their version, size
   *       and last writer. Readable while memory is switched off (the notes are kept).
   *     tags:
   *       - Scheduled Tasks
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
   *         description: "`{ enabled, platformEnabled, body, version, chars, maxChars, updatedAt, updatedBy }`"
   *       404:
   *         description: Not found, or not yours
   *   put:
   *     summary: Replace the notes of a task
   *     description: >
   *       Replaces the notes. With `expectedVersion` the write fails with 409 `VERSION_CONFLICT`
   *       (and `details.currentVersion`) when the notes changed since they were read, for
   *       example because a run updated them.
   *     tags:
   *       - Scheduled Tasks
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [content]
   *             properties:
   *               content: { type: string }
   *               expectedVersion: { type: integer, minimum: 0 }
   *     responses:
   *       200:
   *         description: "`{ version, chars, updatedAt }`"
   *       400:
   *         description: Invalid body, or `MEMORY_TOO_LONG` (`details.maxChars`)
   *       409:
   *         description: "`VERSION_CONFLICT`"
   *   delete:
   *     summary: Clear the notes of a task
   *     tags:
   *       - Scheduled Tasks
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
  app.get(`${base}/:taskId/memory`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      res.json(await tasks.getTaskMemory(req.user, req.params.taskId));
    } catch (error) {
      sendTaskError(res, error, 'get task memory');
    }
  });

  app.put(`${base}/:taskId/memory`, ...guard, memoryLimiter, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const result = await tasks.setTaskMemory(req.user, req.params.taskId, {
        content: req.body?.content,
        expectedVersion: req.body?.expectedVersion
      });
      auditMemory(req, 'update', req.params.taskId, 'Edited the notes of a scheduled task');
      res.json(result);
    } catch (error) {
      sendTaskError(res, error, 'set task memory');
    }
  });

  app.delete(`${base}/:taskId/memory`, ...guard, memoryLimiter, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const result = await tasks.deleteTaskMemory(req.user, req.params.taskId);
      auditMemory(req, 'delete', req.params.taskId, 'Cleared the notes of a scheduled task');
      res.json(result);
    } catch (error) {
      sendTaskError(res, error, 'clear task memory');
    }
  });

  app.get(`${base}/:taskId/runs`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      const page = await tasks.listRuns(req.user, req.params.taskId, {
        limit: req.query.limit,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
      });
      res.json(page);
    } catch (error) {
      sendTaskError(res, error, 'list runs');
    }
  });

  app.get(`${base}/:taskId/runs/:runId`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res) || !validRunId(req, res)) return;
      res.json(await tasks.getRun(req.user, req.params.taskId, req.params.runId));
    } catch (error) {
      sendTaskError(res, error, 'get run');
    }
  });

  app.post(`${base}/:taskId/runs/:runId/cancel`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res) || !validRunId(req, res)) return;
      const run = await tasks.cancelRun(req.user, req.params.taskId, req.params.runId);
      audit(req, 'update', req.params.taskId, `Cancelled run ${req.params.runId}`);
      res.json(run);
    } catch (error) {
      sendTaskError(res, error, 'cancel run');
    }
  });

  app.post(`${base}/:taskId/runs/:runId/approval`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res) || !validRunId(req, res)) return;
      const decision = req.body?.decision;
      const run = await tasks.answerApproval(req.user, req.params.taskId, req.params.runId, {
        decision,
        alwaysAllow: req.body?.alwaysAllow === true
      });
      audit(
        req,
        'update',
        req.params.taskId,
        `${decision === 'approve' ? 'Approved' : 'Rejected'} a tool call in run ${req.params.runId}${
          req.body?.alwaysAllow === true && decision === 'approve' ? ' (always allow)' : ''
        }`
      );
      res.json(run);
    } catch (error) {
      sendTaskError(res, error, 'answer approval');
    }
  });

  app.delete(`${base}/:taskId/allowed-tools/:toolId`, ...guard, async (req, res) => {
    try {
      if (!validTaskId(req, res)) return;
      if (!validateIdForPath(req.params.toolId, 'tool', res)) return;
      const task = await tasks.revokeAllowedTool(req.user, req.params.taskId, req.params.toolId);
      audit(req, 'update', req.params.taskId, `Revoked "always allow" for ${req.params.toolId}`);
      res.json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
    } catch (error) {
      sendTaskError(res, error, 'revoke allowed tool');
    }
  });
}
