// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who may read an evidence record (#3687): the chat's owner through
 * `/api/chats/...`, the run's caller through `/api/runs/...`, an admin through
 * `/api/admin/...` (audited) — and nobody else. Errors are problem+json with a
 * registry code.
 *
 * The route handlers are driven directly, as in `chat-persistence-routes`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import {
  contentItem,
  evidenceScope,
  getChatEvidenceRepository
} from '../services/chat/ChatEvidenceRepository.js';
import registerChatRoutes from '../routes/chats.js';
import registerRunRoutes from '../routes/runs.js';
import registerAdminEvidenceRoutes from '../routes/admin/evidence.js';
import { adminAuth } from '../middleware/adminAuth.js';
import errorHandler from '../middleware/errorHandler.js';
import { guestOwnerId, setGuestId } from '../services/chat/chatOwner.js';

const ADA = { id: 'user-ada', name: 'Ada' };
const GRACE = { id: 'user-grace', name: 'Grace' };
const ROOT = { id: 'user-root', name: 'Root', isAdmin: true, groups: ['admins'] };

/** Every route a register function adds, by method and path. */
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

const routes = [
  ...captureRoutes(registerChatRoutes),
  ...captureRoutes(registerRunRoutes),
  ...captureRoutes(registerAdminEvidenceRoutes)
];

/** The handler of a route — the last one; the auth middleware in front is skipped. */
function handlerFor(suffix) {
  const route = routes.find(entry => entry.method === 'get' && entry.routePath.endsWith(suffix));
  assert.ok(route, `GET ${suffix} must be registered`);
  return route.handlers.at(-1);
}

/** Run one handler the way Express would, with the global error handler. */
async function get(suffix, params, user) {
  const req = { params, query: {}, body: {}, headers: {}, user };
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
  res.type = value => {
    res.headers['content-type'] = value;
    return res;
  };
  res.end = () => res;
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  try {
    await handlerFor(suffix)(req, res, () => {});
  } catch (error) {
    errorHandler(error, req, res, () => {});
  }
  return { res, req };
}

const CHAT_RECORD = '/api/chats/:chatId/evidence/:messageId';
const CHAT_CONTENT = '/api/chats/:chatId/evidence/:messageId/content/:sha256';
const RUN_RECORD = '/api/runs/:runId/evidence';
const RUN_CONTENT = '/api/runs/:runId/evidence/content/:sha256';
const ADMIN_CHAT_RECORD = '/api/admin/chats/:chatId/evidence/:messageId';
const ADMIN_CHAT_CONTENT = '/api/admin/chats/:chatId/evidence/:messageId/content/:sha256';
const ADMIN_RUN_RECORD = '/api/admin/runs/:runId/evidence';
const ADMIN_RUN_CONTENT = '/api/admin/runs/:runId/evidence/content/:sha256';

const PROMPT = contentItem('You are helpful.');
let baseDir;
let stored;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-evidence-routes-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });

  await getChatRepository().ensureChat({ chatId: 'chat-ada', ownerId: ADA.id, appId: 'chat' });
  const evidence = getChatEvidenceRepository();
  stored = await evidence.writeRecord(
    'chat',
    'chat-ada',
    { messageId: 'm1', calls: [{ system: [`sha256:${PROMPT.sha256}`] }] },
    new Map([[PROMPT.sha256, PROMPT.text]]),
    { ownerId: ADA.id, maxContentBytes: 1e6 }
  );
  await evidence.writeRecord(
    'run',
    'run-ada',
    { runId: 'run-ada' },
    new Map([[PROMPT.sha256, PROMPT.text]]),
    { ownerId: ADA.id, maxContentBytes: 1e6 }
  );
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Assert a problem+json error with its registry code. */
function assertProblem(res, status, code) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.equal(res.body.code, code);
}

describe('chat evidence: the owner', () => {
  it('reads the record with its etag, and its content', async () => {
    const { res } = await get(CHAT_RECORD, { chatId: 'chat-ada', messageId: 'm1' }, ADA);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.messageId, 'm1');
    assert.equal(res.headers.etag, `"${stored.sha256}"`);
    assert.equal(res.headers['cache-control'], 'private, no-cache');

    const content = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm1', sha256: PROMPT.sha256 },
      ADA
    );
    assert.equal(content.res.statusCode, 200);
    assert.equal(content.res.body.toString('utf8'), PROMPT.text);
    assert.equal(content.res.headers.etag, `"${PROMPT.sha256}"`);
    assert.equal(content.res.headers['cache-control'], 'private, no-cache');
  });

  it('gets EVIDENCE_NOT_RECORDED for an answer without one, and 400 for a bad hash', async () => {
    const missing = await get(CHAT_RECORD, { chatId: 'chat-ada', messageId: 'm2' }, ADA);
    assertProblem(missing.res, 404, 'EVIDENCE_NOT_RECORDED');
    const bad = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm1', sha256: 'ABC' },
      ADA
    );
    assertProblem(bad.res, 400, 'BAD_REQUEST');
    const absent = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm1', sha256: 'f'.repeat(64) },
      ADA
    );
    assertProblem(absent.res, 404, 'EVIDENCE_NOT_RECORDED');
    const otherAnswer = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm2', sha256: PROMPT.sha256 },
      ADA
    );
    assertProblem(otherAnswer.res, 404, 'EVIDENCE_NOT_RECORDED');
  });

  it('gets EVIDENCE_NOT_RECORDED for a v1 record, its content included', async () => {
    const { documents, blobs } = (await import('../storage/bootstrap.js')).getStorage();
    const prefix = `${evidenceScope('chat-ada')}__`;
    await documents.put(
      'chat-evidence',
      `${prefix}${evidenceScope('m-v1')}`,
      { v: 1, messageId: 'm-v1', calls: [{ system: [`sha256:${PROMPT.sha256}`] }] },
      { ownerId: ADA.id }
    );
    await blobs.put('chat-evidence-content', `${prefix}${PROMPT.sha256}`, PROMPT.text);
    const record = await get(CHAT_RECORD, { chatId: 'chat-ada', messageId: 'm-v1' }, ADA);
    assertProblem(record.res, 404, 'EVIDENCE_NOT_RECORDED');
    const content = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm-v1', sha256: PROMPT.sha256 },
      ADA
    );
    assertProblem(content.res, 404, 'EVIDENCE_NOT_RECORDED');
  });

  it('gets EVIDENCE_NOT_RECORDED while the switch is off', async () => {
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true, evidence: { enabled: false } }
    });
    try {
      const { res } = await get(CHAT_RECORD, { chatId: 'chat-ada', messageId: 'm1' }, ADA);
      assertProblem(res, 404, 'EVIDENCE_NOT_RECORDED');
      const run = await get(RUN_RECORD, { runId: 'run-ada' }, ADA);
      assertProblem(run.res, 404, 'EVIDENCE_NOT_RECORDED');
    } finally {
      configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
    }
  });
});

describe('chat evidence: content shared across answers', () => {
  it("reads an item of a later answer from an earlier answer's pack, also after that answer went", async () => {
    await getChatRepository().ensureChat({ chatId: 'chat-ada-2', ownerId: ADA.id, appId: 'chat' });
    const evidence = getChatEvidenceRepository();
    const QUESTION = contentItem({ role: 'user', content: 'and then?' });
    await evidence.writeRecord(
      'chat',
      'chat-ada-2',
      { messageId: 'n1' },
      new Map([[PROMPT.sha256, PROMPT.text]]),
      { ownerId: ADA.id, onlyIf: async () => [] }
    );
    await evidence.writeRecord(
      'chat',
      'chat-ada-2',
      { messageId: 'n2' },
      new Map([
        [PROMPT.sha256, PROMPT.text],
        [QUESTION.sha256, QUESTION.text]
      ]),
      { ownerId: ADA.id, onlyIf: async () => ['n1'] }
    );
    const read = () =>
      get(CHAT_CONTENT, { chatId: 'chat-ada-2', messageId: 'n2', sha256: PROMPT.sha256 }, ADA);
    const before = await read();
    assert.equal(before.res.statusCode, 200);
    assert.equal(before.res.body.toString('utf8'), PROMPT.text);

    assert.equal(await evidence.deleteMessages('chat-ada-2', ['n1']), 1);
    const after = await read();
    assert.equal(after.res.statusCode, 200, 'the pack of n1 stays while n2 points into it');
    assert.equal(after.res.body.toString('utf8'), PROMPT.text);
    const gone = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada-2', messageId: 'n1', sha256: PROMPT.sha256 },
      ADA
    );
    assertProblem(gone.res, 404, 'EVIDENCE_NOT_RECORDED');
  });
});

describe('chat evidence: everybody else', () => {
  it('another user (a share recipient included) gets 404 for record and content', async () => {
    const record = await get(CHAT_RECORD, { chatId: 'chat-ada', messageId: 'm1' }, GRACE);
    assertProblem(record.res, 404, 'NOT_FOUND');
    const content = await get(
      CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm1', sha256: PROMPT.sha256 },
      GRACE
    );
    assertProblem(content.res, 404, 'NOT_FOUND');
  });

  it('a guest gets 404 even for its own chat', async () => {
    const guestSecret = 'a'.repeat(64);
    const guest = { id: 'anonymous', name: 'Anonymous', groups: ['anonymous'] };
    setGuestId(guest, guestSecret);
    await getChatRepository().ensureChat({
      chatId: 'chat-guest',
      ownerId: guestOwnerId(guestSecret),
      appId: 'chat'
    });
    await getChatEvidenceRepository().writeRecord(
      'chat',
      'chat-guest',
      { messageId: 'm1' },
      new Map(),
      { ownerId: guestOwnerId(guestSecret) }
    );
    const { res } = await get(CHAT_RECORD, { chatId: 'chat-guest', messageId: 'm1' }, guest);
    assertProblem(res, 404, 'NOT_FOUND');
  });

  it("an admin gets 404 on the owner's route, which does not rest on ownership", async () => {
    // The same `nonOwner` branch a project member's read takes.
    const { res } = await get(CHAT_RECORD, { chatId: 'chat-ada', messageId: 'm1' }, ROOT);
    assertProblem(res, 404, 'NOT_FOUND');
  });

  it('an admin reads it through the admin route, and the read is audited', async () => {
    const { res, req } = await get(
      ADMIN_CHAT_RECORD,
      { chatId: 'chat-ada', messageId: 'm1' },
      ROOT
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.messageId, 'm1');
    assert.equal(req._auditLogged, true);

    const content = await get(
      ADMIN_CHAT_CONTENT,
      { chatId: 'chat-ada', messageId: 'm1', sha256: PROMPT.sha256 },
      ROOT
    );
    assert.equal(content.res.statusCode, 200);
    assert.equal(content.res.body.toString('utf8'), PROMPT.text);
    assert.equal(content.req._auditLogged, true);

    const run = await get(ADMIN_RUN_RECORD, { runId: 'run-ada' }, ROOT);
    assert.equal(run.res.statusCode, 200);
    assert.equal(run.req._auditLogged, true);

    const runContent = await get(
      ADMIN_RUN_CONTENT,
      { runId: 'run-ada', sha256: PROMPT.sha256 },
      ROOT
    );
    assert.equal(runContent.res.statusCode, 200);
    assert.equal(runContent.res.headers.etag, `"${PROMPT.sha256}"`);
    assert.equal(runContent.req._auditLogged, true);
  });
});

describe('run evidence', () => {
  it('the caller reads record and content; another user gets 404', async () => {
    const own = await get(RUN_RECORD, { runId: 'run-ada' }, ADA);
    assert.equal(own.res.statusCode, 200);
    assert.equal(own.res.body.runId, 'run-ada');
    const content = await get(RUN_CONTENT, { runId: 'run-ada', sha256: PROMPT.sha256 }, ADA);
    assert.equal(content.res.body.toString('utf8'), PROMPT.text);

    assertProblem(
      (await get(RUN_RECORD, { runId: 'run-ada' }, GRACE)).res,
      404,
      'EVIDENCE_NOT_RECORDED'
    );
    assertProblem(
      (await get(RUN_CONTENT, { runId: 'run-ada', sha256: PROMPT.sha256 }, GRACE)).res,
      404,
      'EVIDENCE_NOT_RECORDED'
    );
  });
});

describe('the admin evidence routes', () => {
  it('are all behind adminAuth, which refuses a non-admin', () => {
    const admin = routes.filter(
      route => route.routePath.includes('/api/admin/') && route.routePath.includes('evidence')
    );
    assert.equal(admin.length, 4);
    for (const route of admin) {
      assert.equal(route.handlers[0], adminAuth, `${route.routePath} is guarded`);
      assert.throws(
        () => route.handlers[0]({ user: GRACE }, {}, () => {}),
        error => error.code === 'FORBIDDEN'
      );
    }
  });
});
