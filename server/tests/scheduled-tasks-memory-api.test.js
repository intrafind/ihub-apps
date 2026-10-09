/**
 * The memory routes: the owner reads and edits the notes of their task, an
 * admin sees metadata and can clear them but never reads them, and nobody
 * reaches the notes of a task that is not theirs.
 *
 * The real route handlers run over real storage; only the HTTP server and the
 * authentication middleware at the head of each chain are left out. The audit
 * log is written under the contents directory, so that is a temp directory.
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
const { getScheduledTaskRepository } =
  await import('../services/scheduler/tasks/ScheduledTaskRepository.js');
const { getTaskMemoryRepository } =
  await import('../services/scheduler/tasks/TaskMemoryRepository.js');
const { writeTaskMemory } = await import('../services/scheduler/tasks/taskMemory.js');
const { queryAuditLog } = await import('../services/AuditLogService.js');
const { default: configCache } = await import('../configCache.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');

const { principal, taskInput, cleanup, setPlatform } = harness;

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

const owner = (method, user, taskId, body) =>
  call(ownerRoutes, method, '/:taskId/memory', {
    params: { taskId },
    body,
    user,
    url: `/api/scheduled-tasks/${taskId}/memory`
  });

const admin = (method, taskId) =>
  call(adminRoutes, method, '/:taskId/memory', {
    params: { taskId },
    user: { id: 'admin', username: 'admin', groups: ['admins'] },
    url: `/api/admin/scheduled-tasks/${taskId}/memory`
  });

const ada = () => principal({ id: 'user-ada', name: 'Ada' });
const grace = () => principal({ id: 'user-grace', name: 'Grace' });

async function newTask(extra = { memory: { enabled: true } }) {
  return tasks.createTask(ada(), taskInput(extra));
}

before(async () => {
  await harness.setupHarness();
});
after(async () => {
  await harness.teardownHarness();
  await fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('the guards', () => {
  it('put the memory routes behind the same sign-in check as the other task routes', () => {
    const memory = route(ownerRoutes, 'get', '/:taskId/memory').handlers;
    const plain = ownerRoutes.find(
      entry => entry.method === 'get' && entry.routePath.endsWith('/scheduled-tasks/:taskId')
    ).handlers;
    assert.equal(memory[0], plain[0], 'feature check');
    assert.equal(memory[1], plain[1], 'authenticated users only');
    for (const method of ['put', 'delete']) {
      const handlers = route(ownerRoutes, method, '/:taskId/memory').handlers;
      assert.equal(handlers[0], plain[0]);
      assert.equal(handlers[1], plain[1]);
    }
  });

  it('put the admin memory routes behind admin authentication', () => {
    const list = adminRoutes.find(
      entry => entry.method === 'get' && entry.routePath.endsWith('/admin/scheduled-tasks')
    ).handlers[0];
    for (const method of ['get', 'delete']) {
      assert.equal(route(adminRoutes, method, '/:taskId/memory').handlers[0], list);
    }
  });
});

describe('GET /scheduled-tasks/:taskId/memory', () => {
  it('answers with empty notes for a task that never wrote any', async () => {
    const task = await newTask();
    const res = await owner('get', ada(), task.id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      enabled: true,
      platformEnabled: true,
      body: '',
      version: 0,
      chars: 0,
      maxChars: 16000,
      updatedAt: null,
      updatedBy: null
    });
    await cleanup(ada());
  });

  it('is readable while the task has memory off: the notes are kept', async () => {
    const task = await newTask();
    await writeTaskMemory(await getScheduledTaskRepository().getTask(task.id), {
      content: 'kept notes'
    });
    await tasks.updateTask(ada(), task.id, { memory: false });
    const res = await owner('get', ada(), task.id);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.body, 'kept notes\n');
    await cleanup(ada());
  });

  it('says when the installation switched memory off', async () => {
    const task = await newTask();
    setPlatform({ scheduledTasks: { memoryEnabled: false, memoryMaxChars: 3000 } });
    try {
      const res = await owner('get', ada(), task.id);
      assert.equal(res.body.platformEnabled, false);
      assert.equal(res.body.maxChars, 3000);
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });

  it('is a 404 for another user, and a 400 for an id that is not a task id', async () => {
    const task = await newTask();
    assert.equal((await owner('get', grace(), task.id)).statusCode, 404);
    assert.equal(
      (await owner('get', ada(), 'st-00000000-0000-0000-0000-000000000000')).statusCode,
      404
    );
    assert.equal((await owner('get', ada(), '../escape')).statusCode, 400);
    await cleanup(ada());
  });
});

describe('PUT /scheduled-tasks/:taskId/memory', () => {
  it('writes the notes as the owner and returns the new version', async () => {
    const task = await newTask();
    const res = await owner('put', ada(), task.id, {
      content: 'Reported up to v1.2',
      expectedVersion: 0
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.version, 1);
    assert.equal(res.body.chars, 'Reported up to v1.2\n'.length);
    assert.ok(res.body.updatedAt);

    const read = await owner('get', ada(), task.id);
    assert.equal(read.body.body, 'Reported up to v1.2\n');
    assert.equal(read.body.updatedBy, 'owner');
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.memorySummary.version, 1);
    assert.equal(stored.memorySummary.updatedBy, 'owner');
    await cleanup(ada());
  });

  it('refuses a stale version with the version to reload', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'first', expectedVersion: 0 });
    const res = await owner('put', ada(), task.id, { content: 'second', expectedVersion: 0 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'VERSION_CONFLICT');
    assert.deepEqual(res.body.details, { currentVersion: 1 });
    assert.equal((await owner('get', ada(), task.id)).body.body, 'first\n');
    await cleanup(ada());
  });

  it('lets the write win when no version is named', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'first' });
    const res = await owner('put', ada(), task.id, { content: 'second' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.version, 2);
    await cleanup(ada());
  });

  it('refuses notes over the limit and tells how long they may be', async () => {
    const task = await newTask();
    setPlatform({ scheduledTasks: { memoryMaxChars: 1000 } });
    try {
      const res = await owner('put', ada(), task.id, { content: 'x'.repeat(1200) });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'MEMORY_TOO_LONG');
      assert.equal(res.body.details.maxChars, 1000);
      assert.equal(res.body.details.chars, 1201);
      assert.equal((await owner('get', ada(), task.id)).body.version, 0);
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });

  it('refuses a body without text or with a version that is not a whole number', async () => {
    const task = await newTask();
    for (const body of [
      {},
      { content: 42 },
      { content: null },
      { content: 'x', expectedVersion: -1 },
      { content: 'x', expectedVersion: 1.5 },
      { content: 'x', expectedVersion: '3' }
    ]) {
      const res = await owner('put', ada(), task.id, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_BODY');
    }
    assert.equal((await owner('get', ada(), task.id)).body.version, 0);
    await cleanup(ada());
  });

  it('accepts empty text, which clears the notes', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'something' });
    const res = await owner('put', ada(), task.id, { content: '' });
    assert.equal(res.statusCode, 200);
    assert.equal((await owner('get', ada(), task.id)).body.body, '');
    await cleanup(ada());
  });

  it('is a 404 for another user and changes nothing', async () => {
    const task = await newTask();
    const res = await owner('put', grace(), task.id, { content: 'planted' });
    assert.equal(res.statusCode, 404);
    assert.equal((await owner('get', ada(), task.id)).body.version, 0);
    await cleanup(ada());
  });

  it('needs the permission to use scheduled tasks, like editing the task does', async () => {
    const task = await newTask();
    const withdrawn = principal({ id: 'user-ada', name: 'Ada', groups: ['noTasks'] });
    const res = await owner('put', withdrawn, task.id, { content: 'x' });
    assert.equal(res.statusCode, 403);
    // Reading and clearing what one owns do not need it.
    assert.equal((await owner('get', withdrawn, task.id)).statusCode, 200);
    await cleanup(ada());
  });
});

describe('DELETE /scheduled-tasks/:taskId/memory', () => {
  it('clears the notes and counts the version up', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'notes' });
    const res = await owner('delete', ada(), task.id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { version: 2 });
    const read = await owner('get', ada(), task.id);
    assert.equal(read.body.body, '');
    assert.equal(read.body.version, 2);
    assert.equal(read.body.updatedBy, 'owner');
    await cleanup(ada());
  });

  it('leaves notes that are already empty alone', async () => {
    const task = await newTask();
    assert.deepEqual((await owner('delete', ada(), task.id)).body, { version: 0 });
    await owner('put', ada(), task.id, { content: 'x' });
    await owner('delete', ada(), task.id);
    assert.deepEqual((await owner('delete', ada(), task.id)).body, { version: 2 });
    await cleanup(ada());
  });

  it('works for a user whose permission was withdrawn: cleaning up needs none', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'notes' });
    const withdrawn = principal({ id: 'user-ada', name: 'Ada', groups: ['noTasks'] });
    assert.equal((await owner('delete', withdrawn, task.id)).statusCode, 200);
    await cleanup(ada());
  });

  it('is a 404 for another user and keeps the notes', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'mine' });
    assert.equal((await owner('delete', grace(), task.id)).statusCode, 404);
    assert.equal((await owner('get', ada(), task.id)).body.body, 'mine\n');
    await cleanup(ada());
  });
});

describe('the admin memory routes', () => {
  it('give metadata and never the notes', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'the private watermark' });
    const res = await admin('get', task.id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'chars',
      'enabled',
      'platformEnabled',
      'updatedAt',
      'updatedBy',
      'version'
    ]);
    assert.equal(res.body.version, 1);
    assert.equal(res.body.chars, 'the private watermark\n'.length);
    assert.equal(res.body.updatedBy, 'owner');
    assert.ok(!JSON.stringify(res.body).includes('private watermark'));
    await cleanup(ada());
  });

  it('clear the notes', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'notes' });
    const res = await admin('delete', task.id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.version, 2);
    const read = await owner('get', ada(), task.id);
    assert.equal(read.body.body, '');
    assert.equal(read.body.updatedBy, 'admin');
    await cleanup(ada());
  });

  it('answer 404 for a task that does not exist and 400 for a bad id', async () => {
    assert.equal((await admin('get', 'st-00000000-0000-0000-0000-000000000000')).statusCode, 404);
    assert.equal(
      (await admin('delete', 'st-00000000-0000-0000-0000-000000000000')).statusCode,
      404
    );
    assert.equal((await admin('get', '../escape')).statusCode, 400);
  });

  it('are the only place an admin could learn about notes: the task list has a summary only', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'confidential details' });
    const list = await call(adminRoutes, 'get', '/admin/scheduled-tasks', {
      user: { id: 'admin', groups: ['admins'] },
      url: '/api/admin/scheduled-tasks'
    });
    assert.equal(list.statusCode, 200);
    const item = list.body.items.find(entry => entry.id === task.id);
    assert.equal(item.memorySummary.version, 1);
    assert.ok(!JSON.stringify(list.body).includes('confidential details'));
    await cleanup(ada());
  });
});

describe('the audit log', () => {
  it('records edits and clears, and never the notes', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'audit-me-not-this-text' });
    await owner('delete', ada(), task.id);
    await owner('put', ada(), task.id, { content: 'another note to clear' });
    await admin('delete', task.id);

    const { entries } = await queryAuditLog({ resource: 'scheduledTaskMemory', limit: 50 });
    const mine = entries.filter(entry => entry.resourceId === task.id);
    assert.deepEqual(mine.map(entry => entry.action).sort(), [
      'delete',
      'delete',
      'update',
      'update'
    ]);
    assert.ok(mine.every(entry => entry.result === 'success'));
    const text = JSON.stringify(mine);
    assert.ok(!text.includes('audit-me-not-this-text'));
    assert.ok(!text.includes('another note to clear'));
    assert.ok(mine.some(entry => entry.source === 'admin'));
    await cleanup(ada());
  });
});

describe('the settings an admin can change', () => {
  const settingsRoute = () => route(adminRoutes, 'put', '/admin/scheduled-tasks/settings');

  async function put(body) {
    const res = makeResponse();
    const req = {
      body,
      params: {},
      query: {},
      headers: {},
      ip: '127.0.0.1',
      user: { id: 'admin', groups: ['admins'] },
      originalUrl: '/api/admin/scheduled-tasks/settings'
    };
    const handlers = settingsRoute().handlers;
    await handlers[handlers.length - 1](req, res);
    return res;
  }

  it('include the three memory limits, with bounds', async () => {
    await configStore.writeJson('config/platform.json', {
      chats: { enabled: true },
      scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 10 }
    });
    try {
      const ok = await put({
        memoryEnabled: false,
        memoryMaxChars: 12000,
        maxHistoryReadChars: 4000
      });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.changed.sort(), [
        'scheduledTasks.maxHistoryReadChars',
        'scheduledTasks.memoryEnabled',
        'scheduledTasks.memoryMaxChars'
      ]);
      assert.equal(ok.body.settings.memoryEnabled, false);
      assert.equal(ok.body.settings.memoryMaxChars, 12000);
      assert.equal(ok.body.settings.maxHistoryReadChars, 4000);
      // The settings it did not name keep their value.
      assert.equal(ok.body.settings.maxTasksPerUser, 10);

      for (const bad of [
        { memoryMaxChars: 10 },
        { memoryMaxChars: 1_000_000 },
        { maxHistoryReadChars: 0 },
        { memoryEnabled: 'no' },
        { memory: { enabled: true } }
      ]) {
        const res = await put(bad);
        assert.equal(res.statusCode, 400, JSON.stringify(bad));
      }
      assert.equal(configCache.getPlatform().scheduledTasks.memoryMaxChars, 12000);
    } finally {
      // The settings route updated the cache; later tests start from the harness platform.
      setPlatform();
    }
  });
});

describe('what a deleted task leaves behind', () => {
  it('is nothing: the notes go with it', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'gone soon' });
    await tasks.deleteTask(ada(), task.id);
    assert.equal((await getTaskMemoryRepository().get(task.id)).version, 0);
    assert.equal((await owner('get', ada(), task.id)).statusCode, 404);
  });

  it('is nothing even when the run history cannot be removed', async () => {
    const task = await newTask();
    await owner('put', ada(), task.id, { content: 'must not be orphaned' });
    const repository = getScheduledTaskRepository();
    const original = repository.deleteRunsOfTask;
    repository.deleteRunsOfTask = async () => {
      throw new Error('storage hiccup');
    };
    try {
      await assert.rejects(() => tasks.deleteTask(ada(), task.id), /storage hiccup/);
    } finally {
      repository.deleteRunsOfTask = original;
    }
    // The task record is gone, so the notes would have no way to be reached.
    assert.equal((await getTaskMemoryRepository().get(task.id)).version, 0);
  });
});
