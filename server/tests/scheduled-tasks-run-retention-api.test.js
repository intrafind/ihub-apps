// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run-deletion and settings routes: who may delete runs, what the admin
 * settings page can save, and that the new `maxRunsPerTask` setting persists.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-memory-api-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const harness = await import('./helpers/scheduledTaskHarness.js');
const { default: registerRoutes } = await import('../routes/scheduledTasks.js');
const { default: registerAdminRoutes } = await import('../routes/admin/scheduledTasks.js');
const tasks = await import('../services/scheduler/tasks/taskService.js');
const { newRunDocument } = await import('../services/scheduler/tasks/taskModel.js');
const { getScheduledTaskRepository } =
  await import('../services/scheduler/tasks/ScheduledTaskRepository.js');

const { principal, taskInput, cleanup } = harness;

function captureRoutes(register) {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
  });
  return routes;
}

const ownerRoutes = captureRoutes(registerRoutes);
const adminRoutes = captureRoutes(registerAdminRoutes);

function route(routes, method, suffix) {
  const found = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(found, `${method.toUpperCase()} ${suffix} must be registered`);
  return found;
}

function makeResponse() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.send = value => {
    res.body = value;
    return res;
  };
  res.setHeader = () => res;
  return res;
}

/** Run the route's own handler (the last in its chain), after the guards. */
async function call(routes, method, suffix, { params = {}, body = {}, query = {}, user, url }) {
  const { handlers } = route(routes, method, suffix);
  const req = {
    params,
    body,
    query,
    headers: {},
    user,
    ip: '127.0.0.1',
    originalUrl: url || '/api/scheduled-tasks'
  };
  const res = makeResponse();
  await handlers[handlers.length - 1](req, res);
  return res;
}

const ada = () => principal({ id: 'user-ada', name: 'Ada' });
const grace = () => principal({ id: 'user-grace', name: 'Grace' });
const adminUser = { id: 'admin', username: 'admin', groups: ['admins'] };

async function taskWithRun(user = ada()) {
  const task = await tasks.createTask(user, taskInput());
  const run = newRunDocument(task, { trigger: 'manual', status: 'succeeded', now: Date.now() });
  run.startedAt = run.queuedAt;
  await getScheduledTaskRepository().putRun(run);
  return { task, run };
}

before(async () => {
  await harness.setupHarness();
});
after(async () => {
  await harness.teardownHarness();
  await fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('deleting runs through the owner routes', () => {
  it('deletes one run and refuses another user', async () => {
    const { task, run } = await taskWithRun();
    const denied = await call(ownerRoutes, 'delete', '/:taskId/runs/:runId', {
      params: { taskId: task.id, runId: run.id },
      user: grace()
    });
    assert.equal(denied.statusCode, 404);
    const res = await call(ownerRoutes, 'delete', '/:taskId/runs/:runId', {
      params: { taskId: task.id, runId: run.id },
      user: ada()
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, 1);
    await cleanup(ada());
  });

  it('deletes a selection and all runs through the bulk route', async () => {
    const { task, run } = await taskWithRun();
    const bulk = body =>
      call(ownerRoutes, 'post', '/:taskId/runs/delete', {
        params: { taskId: task.id },
        body,
        user: ada()
      });
    assert.equal((await bulk({ runIds: [] })).statusCode, 400);
    assert.equal((await bulk({ runIds: [run.id] })).body.deleted, 1);
    assert.equal((await bulk({ all: true })).body.deleted, 0);
    await cleanup(ada());
  });

  it('lets an admin delete the runs of any task', async () => {
    const { task } = await taskWithRun();
    const res = await call(adminRoutes, 'post', '/:taskId/runs/delete', {
      params: { taskId: task.id },
      body: { all: true },
      user: adminUser
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, 1);
    await cleanup(ada());
  });

  it('puts the admin run deletion behind the admin guard', () => {
    const list = adminRoutes.find(
      entry => entry.method === 'get' && entry.routePath.endsWith('/admin/scheduled-tasks')
    ).handlers[0];
    assert.equal(route(adminRoutes, 'post', '/:taskId/runs/delete').handlers[0], list);
  });
});

describe('the admin settings route', () => {
  it('saves the full body the settings page sends, including maxRunsPerTask', async () => {
    const body = {
      enabled: true,
      maxTasksPerUser: 10,
      minIntervalMinutes: 15,
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerUser: 1,
      staggerMinutes: 5,
      catchUpWindowHours: 24,
      maxConsecutiveFailures: 3,
      approvalTimeoutHours: 24,
      runRetentionDays: 90,
      maxRunsPerTask: 25,
      maxRunChatsPerTask: 20,
      maxInstructionLength: 8000,
      maxRunMinutes: 30,
      memoryEnabled: true,
      memoryMaxChars: 16000,
      maxHistoryReadChars: 8000
    };
    const res = await call(adminRoutes, 'put', '/settings', {
      body,
      user: adminUser,
      url: '/api/admin/scheduled-tasks/settings'
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.maxRunsPerTask, 25);
    assert.ok(res.body.changed.includes('scheduledTasks.maxRunsPerTask'));
  });

  it('still rejects unknown keys', async () => {
    const res = await call(adminRoutes, 'put', '/settings', {
      body: { nope: 1 },
      user: adminUser,
      url: '/api/admin/scheduled-tasks/settings'
    });
    assert.equal(res.statusCode, 400);
  });
});
