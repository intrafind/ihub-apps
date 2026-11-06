// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Slice 2 (#3158): files attached to a scheduled task. The owner attaches,
 * lists, reads and removes them over the routes; every run sees them without
 * copying their bytes; they outlive their runs and the age-based original TTL
 * and go with the task.
 *
 * Run: node --test server/tests/scheduled-tasks-files.test.js
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runHandler } from './helpers/runHandler.js';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-task-files-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const harness = await import('./helpers/scheduledTaskHarness.js');
const { default: registerRoutes } = await import('../routes/scheduledTasks.js');
const tasks = await import('../services/scheduler/tasks/taskService.js');
const { executeTaskRun } = await import('../services/scheduler/tasks/taskExecution.js');
const { getChatFileRepository } = await import('../services/chatFiles/ChatFileRepository.js');
const { loadTaskPromptFiles, withTaskFiles, copyTaskFiles } =
  await import('../services/chatFiles/taskFiles.js');
const { openaiText } = await import('./loop/helpers/llmFixtures.js');

const { principal, taskInput, cleanup, setupHarness, teardownHarness, scriptedChatService } =
  harness;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
const routes = captureRoutes(registerRoutes);

function makeResponse() {
  const res = { statusCode: 200, body: null, headers: {} };
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
  res.setHeader = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  return res;
}

async function call(method, suffix, { params = {}, body = {}, query = {}, user }) {
  const found = routes.find(r => r.method === method && r.routePath.endsWith(suffix));
  assert.ok(found, `${method.toUpperCase()} ${suffix} must be registered`);
  const req = { params, body, query, headers: {}, user, ip: '127.0.0.1', originalUrl: '/x' };
  const res = makeResponse();
  await runHandler(found.handlers[found.handlers.length - 1], req, res);
  return res;
}

const ada = () => principal({ id: 'user-ada', name: 'Ada' });
const grace = () => principal({ id: 'user-grace', name: 'Grace' });

before(async () => {
  await setupHarness();
});
after(async () => {
  await teardownHarness();
});

async function attach(user, taskId, body) {
  return call('post', '/:taskId/files', { params: { taskId }, body, user });
}

describe('task file routes', () => {
  it('attaches, lists, reads and removes files of the owner’s task', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());

    const created = await attach(user, task.id, {
      name: 'brief.md',
      mimeType: 'text/markdown',
      text: '# Brief\n\nAlways mention the roadmap.'
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.file.name, 'brief.md');

    const listed = await call('get', '/:taskId/files', { params: { taskId: task.id }, user });
    assert.deepEqual(
      listed.body.items.map(f => f.name),
      ['brief.md']
    );

    const text = await call('get', '/:taskId/files/:fileId', {
      params: { taskId: task.id, fileId: created.body.file.id },
      query: { format: 'text' },
      user
    });
    assert.match(text.body.file.text, /roadmap/);

    const removed = await call('delete', '/:taskId/files/:fileId', {
      params: { taskId: task.id, fileId: created.body.file.id },
      user
    });
    assert.deepEqual(removed.body, { deleted: true });
    const again = await call('delete', '/:taskId/files/:fileId', {
      params: { taskId: task.id, fileId: created.body.file.id },
      user
    });
    assert.equal(again.statusCode, 404);
    await cleanup(user);
  });

  it('keeps one user’s task files from every other user (404, never 403)', async () => {
    const task = await tasks.createTask(ada(), taskInput());
    const created = await attach(ada(), task.id, { name: 'a.txt', text: 'secret plan' });
    assert.equal(created.statusCode, 201);
    for (const [method, suffix, extra] of [
      ['get', '/:taskId/files', {}],
      ['post', '/:taskId/files', { body: { name: 'x.txt', text: 'x' } }],
      ['get', '/:taskId/files/:fileId', { query: { format: 'text' } }],
      ['delete', '/:taskId/files/:fileId', {}]
    ]) {
      const res = await call(method, suffix, {
        params: { taskId: task.id, fileId: created.body.file.id },
        user: grace(),
        ...extra
      });
      assert.equal(res.statusCode, 404, `${method} ${suffix}`);
    }
    await cleanup(ada());
  });

  it('refuses a request without a file and enforces the per-task file quota', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const empty = await attach(user, task.id, {});
    assert.equal(empty.statusCode, 400);
    harness.setPlatform({ uploads: { quotas: { maxChatFiles: 1 } } });
    try {
      assert.equal((await attach(user, task.id, { name: 'one.txt', text: 'one' })).statusCode, 201);
      const second = await attach(user, task.id, { name: 'two.txt', text: 'two' });
      assert.equal(second.statusCode, 413);
      assert.equal(second.body.code, 'QUOTA_CHAT_FILES');
    } finally {
      harness.setPlatform({});
    }
    await cleanup(user);
  });

  it('keeps the original binary of a task file (template-capable) in original_and_text mode', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const { buildDocx } = await import('../services/documents/docx/buildDocx.js');
    const { buffer } = await buildDocx({ title: 'T', markdown: 'Corporate letter body' });
    const created = await attach(user, task.id, {
      name: 'letter.docx',
      mimeType: DOCX,
      data: buffer.toString('base64')
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.file.hasOriginal, true);
    assert.equal(created.body.file.canUseAsTemplate, true);

    const download = await call('get', '/:taskId/files/:fileId', {
      params: { taskId: task.id, fileId: created.body.file.id },
      query: { download: '1' },
      user
    });
    assert.equal(download.statusCode, 200);
    assert.ok(Buffer.from(download.body).equals(buffer));
    await cleanup(user);
  });
});

describe('task files in runs and across the task lifecycle', () => {
  it('shows the files to every run without copying them into the run chat', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    await attach(user, task.id, {
      name: 'style-guide.md',
      text: 'Use short sentences. ZEBRA-RULE.'
    });

    const first = await tasks.requestRun(user, task.id);
    const { service, requests } = scriptedChatService([openaiText(['Done 1.'])]);
    const run1 = await executeTaskRun(
      { taskId: task.id, runId: first.id },
      { chatService: service }
    );
    assert.equal(run1.status, 'succeeded');
    const sent = JSON.stringify(requests[0].body.messages);
    assert.match(sent, /ZEBRA-RULE/);
    assert.match(sent, /style-guide\.md/);

    // The second run sees it too.
    const second = await tasks.requestRun(user, task.id);
    const next = scriptedChatService([openaiText(['Done 2.'])]);
    await executeTaskRun({ taskId: task.id, runId: second.id }, { chatService: next.service });
    assert.match(JSON.stringify(next.requests[0].body.messages), /ZEBRA-RULE/);

    // Nothing was copied: the run chats have no file of their own.
    const store = getChatFileRepository();
    assert.equal((await store.list({ type: 'chat', id: run1.chatId })).length, 0);
    assert.equal((await store.list({ type: 'task', id: task.id })).length, 1);

    // Pruning old runs leaves the task's files alone.
    await tasks.deleteRuns(user, task.id, { all: true });
    assert.equal((await store.list({ type: 'task', id: task.id })).length, 1);
    await cleanup(user);
  });

  it('is exempt from the age-based original TTL and from quota eviction', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const { buildDocx } = await import('../services/documents/docx/buildDocx.js');
    const { buffer } = await buildDocx({ title: 'T', markdown: 'Body' });
    const created = await attach(user, task.id, {
      name: 'ttl.docx',
      mimeType: DOCX,
      data: buffer.toString('base64')
    });
    const store = getChatFileRepository();
    const farFuture = () => Date.now() + 400 * 24 * 3600 * 1000;
    const swept = await store.discardExpiredOriginals({
      originalRetentionDays: 14,
      now: farFuture
    });
    assert.equal(swept.discarded, 0);
    const kept = await store.getOriginal({ type: 'task', id: task.id }, created.body.file.id);
    assert.equal(kept.discarded, false);
    await cleanup(user);
  });

  it('deletes the files with the task', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    await attach(user, task.id, { name: 'a.txt', text: 'a' });
    await attach(user, task.id, { name: 'b.txt', text: 'b' });
    const store = getChatFileRepository();
    assert.equal((await store.list({ type: 'task', id: task.id })).length, 2);
    await tasks.deleteTask(user, task.id);
    assert.equal((await store.list({ type: 'task', id: task.id })).length, 0);
  });

  it('copies the files when a task is duplicated', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    await attach(user, task.id, { name: 'ref.md', text: 'Reference text' });
    const copy = await tasks.duplicateTask(user, task.id);
    const store = getChatFileRepository();
    const copied = await store.list({ type: 'task', id: copy.id });
    assert.deepEqual(
      copied.map(f => f.name),
      ['ref.md']
    );
    assert.equal(
      (await store.getText({ type: 'task', id: copy.id }, copied[0].id)).text,
      'Reference text'
    );
    await cleanup(user);
  });
});

describe('taskFiles helpers', () => {
  it('puts the files on the first user message and keeps its own files', () => {
    const messages = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'go', fileData: { name: 'own.txt', content: 'own' } },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'again' }
    ];
    const out = withTaskFiles(messages, [{ name: 't.txt', content: 'task' }]);
    assert.deepEqual(
      out[1].fileData.map(f => f.name),
      ['t.txt', 'own.txt']
    );
    assert.equal(out[3].fileData, undefined);
    assert.equal(withTaskFiles(messages, []), messages);
  });

  it('cuts task file text to the prompt budget and notes it', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    await attach(user, task.id, { name: 'big.txt', text: 'x'.repeat(5000) });
    const files = await loadTaskPromptFiles(task.id, { maxChars: 1000 });
    assert.equal(files.length, 1);
    assert.match(files[0].content, /truncated/);
    assert.ok(files[0].content.length < 1300);
    assert.equal(await copyTaskFiles('', 'x'), 0);
    await cleanup(user);
  });
});
