// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Scheduled task routes — the caller's own tasks.
 *
 *   GET    /api/scheduled-tasks                          the caller's tasks (+ limits)
 *   POST   /api/scheduled-tasks                          create
 *   POST   /api/scheduled-tasks/_preview                 validate a schedule, describe it, next runs
 *   GET    /api/scheduled-tasks/_notifications           runs the caller has not seen
 *   POST   /api/scheduled-tasks/_notifications/seen      mark them seen
 *   GET    /api/scheduled-tasks/_apps/:appId/tools       tools a task of this app may use
 *                                                         (`?select=` resolves a chat's tool references)
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
 *   DELETE /api/scheduled-tasks/:taskId/runs/:runId      delete one finished run (and its chat)
 *   POST   /api/scheduled-tasks/:taskId/runs/delete      delete `{ runIds }` or `{ all: true }` finished runs
 *   POST   /api/scheduled-tasks/:taskId/runs/:runId/cancel
 *   POST   /api/scheduled-tasks/:taskId/runs/:runId/approval   { decision, alwaysAllow }
 *   GET    /api/scheduled-tasks/:taskId/files            files attached to the task (kept until the task is deleted)
 *   POST   /api/scheduled-tasks/:taskId/files            attach a file (multipart `file`, or JSON `text` / `data`)
 *   GET    /api/scheduled-tasks/:taskId/files/:fileId    one file (`?format=text` extracted text, `?download=1` original)
 *   DELETE /api/scheduled-tasks/:taskId/files/:fileId    remove it
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
import { assertValidId } from '../utils/pathSecurity.js';
import { ServiceError } from '../utils/ServiceError.js';
import { buildContentDisposition } from '../utils/safeContentDisposition.js';
import { servedMediaType } from '../services/artifacts/artifactPolicy.js';
import { chatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { withUserFileLimit } from '../services/quota/quotaService.js';
import { getChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import {
  ingestRequestFile,
  isChatFileFailure,
  isMultipartRequest,
  parseChatFileMultipart,
  sendChatFileFailure
} from '../services/chatFiles/fileUploadRequest.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import { canUserAccessResource } from '../utils/authorization.js';
import configCache from '../configCache.js';
import { logAudit } from '../services/AuditLogService.js';
import {
  SCHEDULED_TASKS_FEATURE,
  checkTaskPrincipal
} from '../services/scheduler/tasks/taskPolicy.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';

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

/** Attaching files to a task: a person picking documents, not a script. */
const fileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Too many file uploads, please try again later', code: 'RATE_LIMITED' }
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
        maxRunChatsPerTask: settings.maxRunChatsPerTask,
        maxRunsPerTask: settings.maxRunsPerTask,
        runRetentionDays: settings.runRetentionDays
      },
      canCreate: checkTaskPrincipal(req.user).ok
    });
  });

  app.post(base, ...guard, createLimiter, async (req, res) => {
    const body = req.body || {};
    const task = await tasks.createTask(req.user, body, {
      language: requestLanguage(req),
      timezone: requestTimezone(req),
      createdVia: body.proposalId ? 'tool' : 'ui',
      proposalId: body.proposalId,
      sourceChatId: body.sourceChatId
    });
    audit(req, 'create', task.id, `Created scheduled task "${task.name}" (${task.schedule.type})`);
    res.status(201).json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
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
    tasks.assertAvailable();
    const count = Math.max(1, Math.min(10, Number(req.body?.count) || 5));
    res.json(
      tasks.previewTaskSchedule(req.body?.schedule || {}, {
        language: requestLanguage(req),
        timezone: requestTimezone(req),
        count
      })
    );
  });

  app.get(`${base}/_notifications`, ...guard, async (req, res) => {
    res.json({ items: await tasks.listNotifications(req.user) });
  });

  app.post(`${base}/_notifications/seen`, ...guard, async (req, res) => {
    const runIds = Array.isArray(req.body?.runIds)
      ? req.body.runIds.filter(id => typeof id === 'string').slice(0, 200)
      : undefined;
    const cleared = await tasks.markNotificationsSeen(req.user, { runIds });
    res.json({ cleared });
  });

  app.get(`${base}/_apps/:appId/tools`, ...guard, async (req, res) => {
    assertValidId(req.params.appId, 'app');
    tasks.assertAvailable();
    const { data: apps = [] } = configCache.getApps() || {};
    const appConfig = findByIdCaseInsensitive(apps, req.params.appId);
    if (!appConfig || !canUserAccessResource(req.user, 'apps', appConfig.id)) {
      throw new ServiceError('NOT_FOUND', 'App not found');
    }
    const language = requestLanguage(req);
    // `select`: a chat's `enabledTools` (references such as `ifinder` or an
    // MCP server id); each item then says whether they select it.
    const rawSelect = req.query.select;
    const select =
      rawSelect === undefined
        ? undefined
        : (Array.isArray(rawSelect) ? rawSelect : [rawSelect])
            .filter(ref => typeof ref === 'string')
            .slice(0, 200);
    // `requiresApproval` is the resolved policy of the tool as this app
    // offers it (platform default, tool or installation, action, app; #2945).
    const offered = await tasks.toolsOfferedByApp(appConfig, req.user, language, { select });
    res.json({
      items: offered.map(({ selectedByApp, ...tool }) => ({
        ...tool,
        // Tools the app lists itself can be toggled; injected ones
        // (web search, sources, workflows, skills) always come along.
        toggleable: selectedByApp
      }))
    });
  });

  app.get(`${base}/:taskId`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    res.json(await tasks.getTask(req.user, req.params.taskId, { language: requestLanguage(req) }));
  });

  const update = async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const task = await tasks.updateTask(req.user, req.params.taskId, req.body || {}, {
      language: requestLanguage(req),
      timezone: requestTimezone(req)
    });
    audit(req, 'update', task.id, `Updated scheduled task "${task.name}"`);
    res.json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
  };
  app.put(`${base}/:taskId`, ...guard, update);
  app.patch(`${base}/:taskId`, ...guard, update);

  app.delete(`${base}/:taskId`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const deleteChats = ['1', 'true'].includes(String(req.query.deleteChats || ''));
    const result = await tasks.deleteTask(req.user, req.params.taskId, { deleteChats });
    audit(
      req,
      'delete',
      req.params.taskId,
      `Deleted scheduled task${deleteChats ? ` and ${result.chatsDeleted} run chats` : ''}`
    );
    res.json(result);
  });

  app.post(`${base}/:taskId/run`, ...guard, runLimiter, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const run = await tasks.requestRun(req.user, req.params.taskId);
    audit(req, 'execute', req.params.taskId, 'Started a scheduled task run manually');
    res.status(202).json(run);
  });

  for (const [action, status] of [
    ['pause', 'paused'],
    ['resume', 'active']
  ]) {
    app.post(`${base}/:taskId/${action}`, ...guard, async (req, res) => {
      assertValidId(req.params.taskId, 'task');
      if (status === 'active') tasks.assertPrincipal(req.user);
      const task = await tasks.setTaskStatus(req.user, req.params.taskId, status);
      audit(req, 'toggle', task.id, `${action === 'pause' ? 'Paused' : 'Resumed'} scheduled task`);
      res.json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
    });
  }

  app.post(`${base}/:taskId/duplicate`, ...guard, createLimiter, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const task = await tasks.duplicateTask(req.user, req.params.taskId, {
      language: requestLanguage(req)
    });
    audit(req, 'create', task.id, `Duplicated scheduled task ${req.params.taskId}`);
    res.status(201).json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
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
    assertValidId(req.params.taskId, 'task');
    res.json(await tasks.getTaskMemory(req.user, req.params.taskId));
  });

  app.put(`${base}/:taskId/memory`, ...guard, memoryLimiter, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const result = await tasks.setTaskMemory(req.user, req.params.taskId, {
      content: req.body?.content,
      expectedVersion: req.body?.expectedVersion
    });
    auditMemory(req, 'update', req.params.taskId, 'Edited the notes of a scheduled task');
    res.json(result);
  });

  app.delete(`${base}/:taskId/memory`, ...guard, memoryLimiter, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const result = await tasks.deleteTaskMemory(req.user, req.params.taskId);
    auditMemory(req, 'delete', req.params.taskId, 'Cleared the notes of a scheduled task');
    res.json(result);
  });

  // ── attached files ─────────────────────────────────────────────────────────
  // Files of the task definition, in the `task` scope of the chat-file store:
  // they stay until the task (or the file) is deleted and every run sees them.

  /** The file store for a request; throws a 503 while it is down. */
  function taskFileStore() {
    const store = getChatFileRepository();
    if (!store.isAvailable()) {
      throw new ServiceError('STORAGE_UNAVAILABLE', 'File storage is unavailable');
    }
    return store;
  }

  /** Chat-file failures keep their own answer; everything else goes to the error middleware. */
  function sendTaskFileError(res, error, next) {
    if (isChatFileFailure(error)) return sendChatFileFailure(res, error);
    return next(error);
  }

  app.get(`${base}/:taskId/files`, ...guard, async (req, res, next) => {
    try {
      assertValidId(req.params.taskId, 'task');
      const { scope } = await tasks.authorizeTaskFiles(req.user, req.params.taskId);
      const store = taskFileStore();
      res.json({ items: await store.list(scope) });
    } catch (error) {
      sendTaskFileError(res, error, next);
    }
  });

  app.post(`${base}/:taskId/files`, ...guard, fileLimiter, async (req, res, next) => {
    try {
      assertValidId(req.params.taskId, 'task');
      tasks.assertPrincipal(req.user);
      const { task, ownerId, scope } = await tasks.authorizeTaskFiles(req.user, req.params.taskId);
      const store = taskFileStore();
      const taskApp = findByIdCaseInsensitive(configCache.getApps()?.data || [], task.appId);
      const policy = withUserFileLimit(chatFilePolicy(taskApp), req.user);
      if (!policy.enabled) {
        throw new ServiceError('UPLOADS_DISABLED', 'File uploads are disabled');
      }
      if (isMultipartRequest(req)) {
        if (!(await parseChatFileMultipart(req, res, policy.quotas?.maxFileBytes))) return;
      }
      const file = await ingestRequestFile({
        req,
        scope,
        ownerId,
        appConfig: taskApp,
        policy,
        store,
        user: req.user
      });
      audit(req, 'file-add', task.id, `Attached "${file.name}" to scheduled task`);
      res.status(201).json({ file });
    } catch (error) {
      sendTaskFileError(res, error, next);
    }
  });

  app.get(`${base}/:taskId/files/:fileId`, ...guard, async (req, res, next) => {
    try {
      assertValidId(req.params.taskId, 'task');
      assertValidId(req.params.fileId, 'file');
      const { scope } = await tasks.authorizeTaskFiles(req.user, req.params.taskId);
      const store = taskFileStore();
      const { fileId } = req.params;
      if (req.query.format === 'text') {
        const text = await store.getText(scope, fileId);
        if (!text) throw new ServiceError('NOT_FOUND', 'File not found');
        return res.json({ file: text });
      }
      const original = await store.getOriginal(scope, fileId);
      if (!original) throw new ServiceError('NOT_FOUND', 'File not found');
      if (original.discarded) {
        throw new ServiceError(
          'ORIGINAL_DISCARDED',
          'The original file is not stored; its extracted text is'
        );
      }
      const download = req.query.download === '1' || req.query.download === 'true';
      res.setHeader('Content-Type', servedMediaType(original.mimeType));
      res.setHeader('Content-Length', String(original.data.length));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader(
        'Content-Disposition',
        download ? buildContentDisposition(original.name) : 'inline'
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(original.data);
    } catch (error) {
      sendTaskFileError(res, error, next);
    }
  });

  app.delete(`${base}/:taskId/files/:fileId`, ...guard, async (req, res, next) => {
    try {
      assertValidId(req.params.taskId, 'task');
      assertValidId(req.params.fileId, 'file');
      const { task, scope } = await tasks.authorizeTaskFiles(req.user, req.params.taskId);
      const store = taskFileStore();
      const deleted = await store.delete(scope, req.params.fileId);
      if (!deleted) throw new ServiceError('NOT_FOUND', 'File not found');
      audit(req, 'file-remove', task.id, 'Removed a file from scheduled task');
      res.json({ deleted: true });
    } catch (error) {
      sendTaskFileError(res, error, next);
    }
  });

  app.get(`${base}/:taskId/runs`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const page = await tasks.listRuns(req.user, req.params.taskId, {
      limit: req.query.limit,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
    });
    res.json(page);
  });

  app.get(`${base}/:taskId/runs/:runId`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    assertValidId(req.params.runId, 'run');
    res.json(await tasks.getRun(req.user, req.params.taskId, req.params.runId));
  });

  app.delete(`${base}/:taskId/runs/:runId`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    assertValidId(req.params.runId, 'run');
    const result = await tasks.deleteRuns(req.user, req.params.taskId, {
      runIds: [req.params.runId],
      deleteChats: req.query.deleteChats !== '0'
    });
    audit(req, 'delete', req.params.taskId, `Deleted run ${req.params.runId}`);
    res.json(result);
  });

  app.post(`${base}/:taskId/runs/delete`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    const body = req.body || {};
    const result = await tasks.deleteRuns(req.user, req.params.taskId, {
      runIds: body.runIds,
      all: body.all === true,
      deleteChats: body.deleteChats !== false
    });
    audit(
      req,
      'delete',
      req.params.taskId,
      `Deleted ${result.deleted} run${result.deleted === 1 ? '' : 's'}`
    );
    res.json(result);
  });

  app.post(`${base}/:taskId/runs/:runId/cancel`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    assertValidId(req.params.runId, 'run');
    const run = await tasks.cancelRun(req.user, req.params.taskId, req.params.runId);
    audit(req, 'update', req.params.taskId, `Cancelled run ${req.params.runId}`);
    res.json(run);
  });

  app.post(`${base}/:taskId/runs/:runId/approval`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    assertValidId(req.params.runId, 'run');
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
  });

  app.delete(`${base}/:taskId/allowed-tools/:toolId`, ...guard, async (req, res) => {
    assertValidId(req.params.taskId, 'task');
    assertValidId(req.params.toolId, 'tool');
    const task = await tasks.revokeAllowedTool(req.user, req.params.taskId, req.params.toolId);
    audit(req, 'update', req.params.taskId, `Revoked "always allow" for ${req.params.toolId}`);
    res.json(tasks.toPublicTask(task, { language: requestLanguage(req) }));
  });
}
