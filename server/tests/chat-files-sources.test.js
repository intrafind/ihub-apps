// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Slice 4 (#3160): direct server-side ingest from connected systems
 * (`{ source: { kind, ref, refreshOnRun? } }`) in the chat and scheduled-task
 * file routes, and `refreshOnRun` re-ingest at the start of a scheduled run.
 *
 * The connectors are swapped for fakes through the item kind registry (the same
 * seam the projects tests use); what is under test is the ingest, the error
 * mapping and the refresh, not the HTTP calls of the integration services.
 *
 * Run: node --test server/tests/chat-files-sources.test.js
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-file-sources-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const harness = await import('./helpers/scheduledTaskHarness.js');
const { default: registerRoutes } = await import('../routes/scheduledTasks.js');
const tasks = await import('../services/scheduler/tasks/taskService.js');
const { executeTaskRun } = await import('../services/scheduler/tasks/taskExecution.js');
const { registerItemKind, getItemKind } = await import('../services/projects/kinds/registry.js');
const { ProjectError } = await import('../services/projects/projectErrors.js');
const { getChatFileRepository } = await import('../services/chatFiles/ChatFileRepository.js');
const { ingestRequestFile } = await import('../services/chatFiles/fileUploadRequest.js');
const {
  fetchSourceFile,
  ingestFromSource,
  refreshTaskFiles,
  setIfinderProviderForTests,
  FILE_SOURCE_KINDS
} = await import('../services/chatFiles/fileSources.js');
const { chatFilePolicy } = await import('../services/chatFiles/chatFilePolicy.js');
const { openaiText } = await import('./loop/helpers/llmFixtures.js');

const {
  principal,
  taskInput,
  cleanup,
  setupHarness,
  teardownHarness,
  scriptedChatService,
  setPlatform
} = harness;

/** What the fake Nextcloud serves right now. */
const remote = {
  name: 'brief.md',
  type: 'text/markdown',
  text: 'Version one of the brief',
  lastModified: 'v1',
  fail: null
};
const fetchCalls = [];

function installFakeNextcloud() {
  const original = getItemKind('nextcloud');
  registerItemKind({
    id: 'nextcloud',
    name: { en: 'Nextcloud' },
    storage: { ihub: 'text' },
    credentials: 'picking-user',
    picker: { type: 'cloud', provider: 'nextcloud' },
    refSchema: z
      .object({
        providerId: z.string().min(1),
        path: z.string().min(1),
        name: z.string().optional()
      })
      .strict(),
    async fetch(item, ctx) {
      fetchCalls.push({ ref: item.ref, userId: ctx.user?.id });
      if (remote.fail) throw remote.fail;
      return {
        bytes: Buffer.from(remote.text),
        contentType: remote.type,
        name: remote.name,
        lastModified: remote.lastModified
      };
    }
  });
  return original;
}

const ada = () => principal({ id: 'user-ada', name: 'Ada' });
const REF = { providerId: 'nc', path: '/Documents/brief.md' };
const SOURCE = { kind: 'nextcloud', ref: REF };

let restoreNextcloud;
before(async () => {
  await setupHarness();
  restoreNextcloud = installFakeNextcloud();
});
after(async () => {
  if (restoreNextcloud) registerItemKind(restoreNextcloud);
  await teardownHarness();
});
beforeEach(() => {
  Object.assign(remote, {
    name: 'brief.md',
    type: 'text/markdown',
    text: 'Version one of the brief',
    lastModified: 'v1',
    fail: null
  });
  fetchCalls.length = 0;
  setPlatform({});
});

const scope = { type: 'chat', id: 'chat-source-1' };

function request(body) {
  return {
    req: { body },
    scope,
    ownerId: 'user-ada',
    policy: chatFilePolicy(),
    store: getChatFileRepository(),
    user: ada()
  };
}

describe('server-side connector ingest', () => {
  it('knows the four systems', () => {
    assert.deepEqual(
      [...FILE_SOURCE_KINDS],
      ['nextcloud', 'office365', 'google-drive', 'ifinder-document']
    );
  });

  it('fetches the original with the signed-in user and stores text and original', async () => {
    const file = await ingestRequestFile(request({ source: SOURCE }));
    assert.equal(file.name, 'brief.md');
    assert.equal(file.origin, 'connector');
    assert.equal(file.hasOriginal, true);
    assert.equal(file.source.kind, 'nextcloud');
    assert.deepEqual(file.source.ref, REF);
    assert.equal(file.source.refreshOnRun, undefined, 'a chat file is a snapshot');
    assert.ok(file.source.lastFetchedAt);
    assert.equal(file.source.sourceModified, 'v1');
    assert.deepEqual(fetchCalls, [{ ref: REF, userId: 'user-ada' }]);
    const store = getChatFileRepository();
    assert.equal((await store.getText(scope, file.id)).text, 'Version one of the brief');
    assert.equal(
      (await store.getOriginal(scope, file.id)).data.toString(),
      'Version one of the brief'
    );
  });

  it('serves client_text_only as server text only: the server fetched the bytes itself', async () => {
    setPlatform({ uploads: { storageMode: 'client_text_only' } });
    const file = await ingestRequestFile({
      ...request({ source: SOURCE }),
      policy: chatFilePolicy()
    });
    assert.equal(file.hasOriginal, false);
    assert.equal(
      (await getChatFileRepository().getText(scope, file.id)).text,
      'Version one of the brief'
    );
  });

  it('refuses a bad source with a readable 400', async () => {
    for (const [body, pattern] of [
      [{ source: { kind: 'dropbox', ref: REF } }, /must be one of/],
      [{ source: { kind: 'nextcloud', ref: { providerId: 'nc' } } }, /not valid for nextcloud/],
      [{ source: { kind: 'nextcloud' } }, /not valid for nextcloud/],
      [{ source: 'nextcloud' }, /must be an object/]
    ]) {
      await assert.rejects(ingestRequestFile(request(body)), error => {
        assert.equal(error.status, 400, JSON.stringify(body));
        assert.match(error.message, pattern);
        return true;
      });
    }
    assert.equal(fetchCalls.length, 0);
  });

  it('needs a signed-in user', async () => {
    await assert.rejects(
      ingestRequestFile({ ...request({ source: SOURCE }), user: { id: 'anonymous' } }),
      { status: 403, code: 'SOURCE_FORBIDDEN' }
    );
  });

  it('maps what the connector says: forbidden, gone, anything else', async () => {
    remote.fail = new ProjectError(
      'SOURCE_FORBIDDEN',
      'You have no access to this Nextcloud document'
    );
    await assert.rejects(ingestRequestFile(request({ source: SOURCE })), {
      status: 403,
      code: 'SOURCE_FORBIDDEN'
    });
    remote.fail = new ProjectError('SOURCE_GONE', 'The document is no longer at Nextcloud');
    await assert.rejects(ingestRequestFile(request({ source: SOURCE })), {
      status: 404,
      code: 'SOURCE_GONE'
    });
    remote.fail = new Error('socket hang up');
    await assert.rejects(ingestRequestFile(request({ source: SOURCE })), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'SOURCE_FAILED');
      assert.match(error.message, /socket hang up/);
      return true;
    });
  });

  it('refuses a file over the size cap before storing it', async () => {
    setPlatform({ uploads: { quotas: { maxFileBytes: 10 } } });
    const capScope = { type: 'chat', id: 'chat-source-cap' };
    await assert.rejects(
      ingestRequestFile({
        ...request({ source: SOURCE }),
        scope: capScope,
        policy: chatFilePolicy()
      }),
      { status: 413, code: 'QUOTA_FILE_BYTES' }
    );
    assert.equal((await getChatFileRepository().list(capScope)).length, 0);
  });

  it('reports a kind that is not enabled on the installation', async () => {
    const original = getItemKind('nextcloud');
    registerItemKind({ ...original, enabled: () => false });
    try {
      await assert.rejects(fetchSourceFile({ source: SOURCE, user: ada() }), {
        status: 400,
        code: 'SOURCE_UNAVAILABLE'
      });
    } finally {
      registerItemKind(original);
    }
  });
});

describe('iFinder documents', () => {
  const IFINDER = { kind: 'ifinder-document', ref: { documentId: 'doc-1', searchProfile: 'sp' } };
  const calls = [];
  let responses;
  let restoreKind;
  let restoreIntegrations;

  // The grant GET /api/integrations/ifinder/files/* checks: the installation exists and the
  // user's groups grant it (`permissions.integrations`).
  const granted = () => {
    const user = ada();
    user.permissions = { ...user.permissions, integrations: new Set(['ifinder']) };
    return user;
  };

  // What the real provider returns for a download: the body as a Node stream.
  const stream = chunks => {
    const body = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      }
    };
    return { contentType: 'application/pdf', stream: body };
  };

  before(async () => {
    const { default: configCache } = await import('../configCache.js');
    const original = configCache.getIntegrations;
    configCache.getIntegrations = () => ({
      data: {
        installed: [
          { id: 'ifinder', definition: 'com.intrafind/ifinder', enabled: true, values: {} }
        ]
      },
      etag: 'test'
    });
    restoreIntegrations = () => {
      configCache.getIntegrations = original;
    };
    const originalKind = getItemKind('ifinder-document');
    restoreKind = () => registerItemKind(originalKind);
    registerItemKind({ ...originalKind, enabled: () => true });
    setIfinderProviderForTests({
      async content({ ref, user, format }) {
        calls.push({ ref, userId: user?.id, format });
        const answer = responses[format];
        if (answer instanceof Error) throw answer;
        return answer;
      }
    });
  });
  after(() => {
    setIfinderProviderForTests(null);
    restoreKind();
    restoreIntegrations();
  });
  beforeEach(() => {
    calls.length = 0;
    responses = {};
  });

  it('refuses a user whose groups do not grant iFinder, without asking iFinder', async () => {
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: ada() }), {
      status: 403,
      code: 'SOURCE_FORBIDDEN'
    });
    assert.deepEqual(calls, []);
  });

  it('downloads the original with the reading user and the search profile', async () => {
    const body = Buffer.from('%PDF-1.4 original');
    const content = stream([body.subarray(0, 5), body.subarray(5)]);
    content.contentDisposition = 'attachment; filename="Quarterly Report.pdf"';
    responses.original = content;
    const fetched = await fetchSourceFile({ source: IFINDER, user: granted() });
    assert.deepEqual(calls, [
      { ref: { id: 'doc-1', scope: 'sp' }, userId: 'user-ada', format: 'original' }
    ]);
    assert.ok(fetched.bytes.equals(body));
    assert.equal(fetched.contentType, 'application/pdf');
    assert.equal(fetched.name, 'Quarterly Report.pdf');
  });

  it('prefers the provider file name, and reads an encoded Content-Disposition name', async () => {
    responses.original = {
      body: Buffer.from('x'),
      contentType: 'application/pdf',
      fileName: 'a.pdf'
    };
    assert.equal((await fetchSourceFile({ source: IFINDER, user: granted() })).name, 'a.pdf');
    responses.original = {
      body: Buffer.from('x'),
      contentType: 'application/pdf',
      contentDisposition: "attachment; filename*=UTF-8''Bericht%20M%C3%A4rz.pdf"
    };
    assert.equal(
      (await fetchSourceFile({ source: IFINDER, user: granted() })).name,
      'Bericht März.pdf'
    );
  });

  it('falls back to the text when the document has no download link', async () => {
    responses.original = Object.assign(new Error('no link'), { code: 'SOURCE_GONE' });
    responses.text = { body: 'Extracted text of the document', contentType: 'text/plain' };
    const fetched = await fetchSourceFile({ source: IFINDER, user: granted() });
    assert.deepEqual(
      calls.map(c => c.format),
      ['original', 'text']
    );
    assert.equal(fetched.bytes.toString('utf8'), 'Extracted text of the document');
    assert.equal(fetched.contentType, 'text/plain');
    assert.equal(fetched.name, 'doc-1.txt');
    // Stored, it is a connector file of this system.
    const target = { type: 'chat', id: 'chat-ifinder-text' };
    const stored = await ingestFromSource({
      source: IFINDER,
      user: granted(),
      scope: target,
      ownerId: 'user-ada',
      policy: chatFilePolicy(),
      store: getChatFileRepository()
    });
    assert.equal(stored.origin, 'connector');
    assert.equal(stored.source.kind, 'ifinder-document');
    assert.equal(stored.mimeType, 'text/plain');
    assert.equal(stored.name, 'doc-1.txt');
  });

  it('stops a download that grows past the size cap and refuses a buffered one', async () => {
    const content = stream([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]);
    responses.original = content;
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: granted(), maxBytes: 10 }), {
      status: 413,
      code: 'QUOTA_FILE_BYTES'
    });
    assert.equal(content.stream.destroyed, true, 'the stream is closed, not read to the end');
    responses.original = { body: Buffer.alloc(11), contentType: 'application/pdf' };
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: granted(), maxBytes: 10 }), {
      status: 413,
      code: 'QUOTA_FILE_BYTES'
    });
    responses.original = { body: Buffer.alloc(10), contentType: 'application/pdf' };
    assert.equal(
      (await fetchSourceFile({ source: IFINDER, user: granted(), maxBytes: 10 })).bytes.length,
      10
    );
  });

  it('maps what iFinder says when the text fallback fails too', async () => {
    responses.original = new Error('no link');
    responses.text = new ProjectError('SOURCE_FORBIDDEN', 'No access to this document');
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: granted() }), {
      status: 403,
      code: 'SOURCE_FORBIDDEN'
    });
    responses.text = new ProjectError('SOURCE_GONE', 'The document is gone');
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: granted() }), {
      status: 404,
      code: 'SOURCE_GONE'
    });
    responses.text = new ProjectError('SOURCE_TIMEOUT', 'iFinder timed out');
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: granted() }), {
      status: 504,
      code: 'SOURCE_UNAVAILABLE'
    });
    responses.text = new Error('socket hang up');
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: granted() }), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'SOURCE_FAILED');
      assert.match(error.message, /ifinder-document/);
      return true;
    });
  });

  it('needs a signed-in user and a valid reference', async () => {
    await assert.rejects(fetchSourceFile({ source: IFINDER, user: { id: 'anonymous' } }), {
      status: 403,
      code: 'SOURCE_FORBIDDEN'
    });
    await assert.rejects(
      fetchSourceFile({ source: { kind: 'ifinder-document', ref: {} }, user: granted() }),
      { status: 400, code: 'SOURCE_INVALID' }
    );
    assert.deepEqual(calls, []);
  });
});

describe('task files from a connected system', () => {
  const routes = [];
  registerRoutes({
    get: (p, ...h) => routes.push({ method: 'get', routePath: p, handlers: h }),
    post: (p, ...h) => routes.push({ method: 'post', routePath: p, handlers: h }),
    put: () => {},
    patch: () => {},
    delete: () => {},
    use: () => {}
  });
  const makeRes = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = code => ((res.statusCode = code), res);
    res.json = value => ((res.body = value), res);
    res.setHeader = () => res;
    res.send = value => ((res.body = value), res);
    return res;
  };
  async function attach(user, taskId, body) {
    const route = routes.find(r => r.method === 'post' && r.routePath.endsWith('/:taskId/files'));
    const res = makeRes();
    await route.handlers.at(-1)(
      {
        params: { taskId },
        body,
        query: {},
        headers: {},
        user,
        ip: '127.0.0.1',
        originalUrl: '/x'
      },
      res
    );
    return res;
  }

  it('keeps refreshOnRun on a task file and fetches it with the task owner', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const res = await attach(user, task.id, { source: { ...SOURCE, refreshOnRun: true } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.file.source.refreshOnRun, true);
    assert.equal(res.body.file.origin, 'connector');
    await cleanup(user);
  });

  it('answers the route errors of a refused source', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    remote.fail = new ProjectError('SOURCE_GONE', 'gone');
    const gone = await attach(user, task.id, { source: SOURCE });
    assert.equal(gone.statusCode, 404);
    assert.equal(gone.body.code, 'SOURCE_GONE');
    await cleanup(user);
  });

  it('re-ingests a changed file in place, skips an unchanged one, and keeps one that fails', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const store = getChatFileRepository();
    const taskScope = { type: 'task', id: task.id };
    const stored = await ingestFromSource({
      source: { ...SOURCE, refreshOnRun: true },
      user,
      scope: taskScope,
      ownerId: task.ownerId
    });
    // A file that is not kept fresh is left alone.
    await store.put(taskScope, {
      ownerId: task.ownerId,
      name: 'static.txt',
      mimeType: 'text/plain',
      text: 'static'
    });

    fetchCalls.length = 0;
    let results = await refreshTaskFiles(task.id, user, { ownerId: task.ownerId });
    assert.deepEqual(
      results.map(r => [r.name, r.status]),
      [['brief.md', 'unchanged']]
    );
    assert.equal(fetchCalls.length, 1, 'only the refreshOnRun file is fetched');

    remote.text = 'Version two of the brief';
    remote.lastModified = 'v2';
    results = await refreshTaskFiles(task.id, user, { ownerId: task.ownerId });
    assert.deepEqual(
      results.map(r => r.status),
      ['refreshed']
    );
    const files = await store.list(taskScope);
    assert.equal(files.length, 2, 'replaced in place, not added');
    const refreshed = files.find(f => f.id === stored.id);
    assert.equal(refreshed.source.sourceModified, 'v2');
    assert.equal((await store.getText(taskScope, stored.id)).text, 'Version two of the brief');
    assert.equal(
      (await store.getOriginal(taskScope, stored.id)).data.toString(),
      'Version two of the brief'
    );

    remote.fail = new ProjectError('SOURCE_FORBIDDEN', 'access revoked');
    results = await refreshTaskFiles(task.id, user, { ownerId: task.ownerId });
    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].code, 'SOURCE_FORBIDDEN');
    assert.equal((await store.getText(taskScope, stored.id)).text, 'Version two of the brief');
    await cleanup(user);
  });

  it('refreshes at the start of a run, so the run reads the newest version', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    await ingestFromSource({
      source: { ...SOURCE, refreshOnRun: true },
      user,
      scope: { type: 'task', id: task.id },
      ownerId: task.ownerId
    });
    remote.text = 'Version three: NEWEST-CONTENT';
    remote.lastModified = 'v3';

    const queued = await tasks.requestRun(user, task.id);
    const { service, requests } = scriptedChatService([openaiText(['Done.'])]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'succeeded');
    const sent = JSON.stringify(requests[0].body.messages);
    assert.match(sent, /NEWEST-CONTENT/);
    assert.ok(
      fetchCalls.some(call => call.userId === 'user-ada'),
      'fetched with the task owner'
    );
    await cleanup(user);
  });

  it('runs on with the stored version and tells the model when a refresh fails', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    await ingestFromSource({
      source: { ...SOURCE, refreshOnRun: true },
      user,
      scope: { type: 'task', id: task.id },
      ownerId: task.ownerId
    });
    remote.fail = new ProjectError('SOURCE_GONE', 'deleted at the source');

    const queued = await tasks.requestRun(user, task.id);
    const { service, requests } = scriptedChatService([openaiText(['Done.'])]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'succeeded');
    const messages = requests[0].body.messages;
    const sent = JSON.stringify(messages);
    assert.match(sent, /Version one of the brief/, 'the last stored version is still used');
    const system = messages.find(m => m.role === 'system').content;
    assert.match(system, /could not be refreshed from their source/);
    assert.match(system, /brief\.md/);
    await cleanup(user);
  });
});
