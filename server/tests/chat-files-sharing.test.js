// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Slice 3 (#3159), server half: what a chat share does with the files the
 * owner uploaded to the chat. Default `none` (PM-07), `extracted_text` and
 * `original` opt-ins, a per-file allow-list (`sharedFileIds`), pinning only the
 * shared files against deletion, and the viewer routes
 * `/api/shares/:shareId/files[/:fileId]`.
 *
 * Run: node --test server/tests/chat-files-sharing.test.js
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getChatShareRepository } from '../services/chat/ChatShareRepository.js';
import registerChatShareRoutes from '../routes/chatShares.js';
import errorHandler from '../middleware/errorHandler.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let baseDir;
let chatCounter = 0;

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
const shareRoutes = captureRoutes(registerChatShareRoutes);

function handlersFor(method, suffix) {
  const route = shareRoutes.find(
    entry => entry.method === method && entry.routePath.endsWith(suffix)
  );
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

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
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  res.set = res.setHeader;
  return res;
}

async function drive(handlers, { params = {}, query = {}, body = {}, user } = {}) {
  const req = { params, query, body, headers: {}, user, ip: '127.0.0.1', method: 'GET', url: '/' };
  const res = makeResponse();
  // Like Express 5: a thrown error or rejected promise goes to the error middleware.
  for (let index = 0; index < handlers.length; index += 1) {
    let advanced = false;
    try {
      await handlers[index](req, res, error => {
        if (error) throw error;
        advanced = true;
      });
    } catch (error) {
      errorHandler(error, req, res, () => {});
      break;
    }
    if (!advanced) break;
  }
  return res;
}

const createHandlers = handlersFor('post', '/api/chats/:chatId/shares');
const openHandlers = handlersFor('get', '/api/shares/:shareId');
const listFilesHandlers = handlersFor('get', '/api/shares/:shareId/files');
const fileHandlers = handlersFor('get', '/api/shares/:shareId/files/:fileId');

/** A chat of Ada's with two uploaded files named on its first message. */
async function seedChatWithFiles() {
  chatCounter += 1;
  const chatId = `chat-files-${chatCounter}`;
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: ADA.id, appId: 'chat', title: 'With files' });
  const store = repository.fileStore();
  const scope = repository.fileScope(chatId);
  const plan = await store.put(scope, {
    ownerId: ADA.id,
    name: 'plan.docx',
    mimeType: DOCX,
    text: 'The plan: launch in March.',
    originalBuffer: Buffer.from('PLAN-ORIGINAL-BYTES'),
    storageMode: 'original_and_text'
  });
  const secret = await store.put(scope, {
    ownerId: ADA.id,
    name: 'salaries.csv',
    mimeType: 'text/csv',
    text: 'name,salary\nBob,99',
    storageMode: 'server_text_only'
  });
  await repository.appendMessage(chatId, {
    role: 'user',
    content: 'summarize these',
    clientMessageId: 'c1',
    attachments: [
      { id: plan.id, type: plan.mimeType, name: plan.name, bytes: plan.bytes },
      { id: secret.id, type: secret.mimeType, name: secret.name, bytes: secret.bytes }
    ]
  });
  await repository.appendMessage(chatId, { role: 'assistant', content: 'done' });
  return { chatId, plan, secret, scope };
}

async function share(chatId, body = {}) {
  const res = await drive(createHandlers, {
    params: { chatId },
    body: { mode: 'public', ...body },
    user: ADA
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-files-sharing-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true, chatSharing: true });
  configCache.setCacheEntry('config/platform.json', {
    chats: {
      enabled: true,
      sharing: {
        enabled: true,
        allowUsers: true,
        allowAuthenticated: true,
        allowPublic: true,
        defaultExpiryDays: 0,
        maxExpiryDays: 0,
        maxViewsCap: 0
      }
    }
  });
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('uploaded files on a share', () => {
  it('a picture of a message opens for a viewer only when the originals are shared', async () => {
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(30, 5)
    ]);
    chatCounter += 1;
    const chatId = `chat-picture-${chatCounter}`;
    const repository = getChatRepository();
    await repository.ensureChat({ chatId, ownerId: ADA.id, appId: 'chat', title: 'Picture' });
    const picture = await repository.fileStore().put(repository.fileScope(chatId), {
      ownerId: ADA.id,
      name: 'whiteboard.png',
      mimeType: 'image/png',
      originalBuffer: PNG,
      origin: 'image',
      storageMode: 'original_and_text'
    });
    await repository.appendMessage(chatId, {
      role: 'user',
      content: 'what is this',
      clientMessageId: 'p1',
      attachments: [
        { id: picture.id, type: 'image/png', name: 'whiteboard.png', bytes: picture.bytes }
      ]
    });
    await repository.appendMessage(chatId, { role: 'assistant', content: 'A whiteboard' });
    const flagFor = async access => {
      const created = await share(chatId, {
        uploadedFilesAccess: access,
        sharedFileIds: [picture.id]
      });
      const open = await drive(openHandlers, { params: { shareId: created.id } });
      return { created, flag: open.body.messages[0].attachments[0].shared };
    };

    // Text only: a picture has no text, so there is nothing to open, and nothing to list
    const textOnly = await flagFor('extracted_text');
    assert.equal(textOnly.flag, false);
    const textOnlyList = await drive(listFilesHandlers, {
      params: { shareId: textOnly.created.id }
    });
    assert.deepEqual(textOnlyList.body.items, []);

    const original = await flagFor('original');
    assert.equal(original.flag, true);
    const originalList = await drive(listFilesHandlers, {
      params: { shareId: original.created.id }
    });
    assert.deepEqual(
      originalList.body.items.map(item => item.name),
      ['whiteboard.png']
    );
    const served = await drive(fileHandlers, {
      params: { shareId: original.created.id, fileId: picture.id }
    });
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(served.body, PNG);
  });

  it('shares no uploaded file by default: chips stay, the files answer 403', async () => {
    const { chatId, plan } = await seedChatWithFiles();
    const created = await share(chatId);
    assert.equal(created.uploadedFilesAccess, 'none');
    assert.equal(created.fileIds, undefined);

    const open = await drive(openHandlers, { params: { shareId: created.id } });
    assert.equal(open.statusCode, 200);
    assert.equal(open.body.share.uploadedFilesAccess, 'none');
    const chips = open.body.messages[0].attachments;
    assert.deepEqual(
      chips.map(chip => [chip.name, chip.shared]),
      [
        ['plan.docx', false],
        ['salaries.csv', false]
      ]
    );

    const list = await drive(listFilesHandlers, { params: { shareId: created.id } });
    assert.deepEqual(list.body, { uploadedFilesAccess: 'none', items: [] });
    for (const query of [{ format: 'text' }, { download: '1' }, {}]) {
      const res = await drive(fileHandlers, {
        params: { shareId: created.id, fileId: plan.id },
        query
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, 'FILES_NOT_SHARED');
    }
  });

  it('extracted_text lets viewers read the text of the ticked files only', async () => {
    const { chatId, plan, secret } = await seedChatWithFiles();
    const created = await share(chatId, {
      uploadedFilesAccess: 'extracted_text',
      sharedFileIds: [plan.id]
    });
    assert.deepEqual(created.fileIds, [plan.id]);

    const open = await drive(openHandlers, { params: { shareId: created.id } });
    assert.deepEqual(
      open.body.messages[0].attachments.map(chip => [chip.name, chip.shared]),
      [
        ['plan.docx', true],
        ['salaries.csv', false]
      ]
    );
    const list = await drive(listFilesHandlers, { params: { shareId: created.id } });
    assert.deepEqual(
      list.body.items.map(item => item.name),
      ['plan.docx']
    );

    const text = await drive(fileHandlers, {
      params: { shareId: created.id, fileId: plan.id },
      query: { format: 'text' }
    });
    assert.equal(text.statusCode, 200);
    assert.match(text.body.text, /launch in March/);
    assert.equal(text.body.hasOriginal, false, 'no original is offered at this level');
    assert.equal(text.body.ownerId, undefined);

    const original = await drive(fileHandlers, {
      params: { shareId: created.id, fileId: plan.id },
      query: { download: '1' }
    });
    assert.equal(original.statusCode, 403);
    assert.equal(original.body.code, 'ORIGINAL_NOT_SHARED');

    // A file left out answers like one that does not exist.
    const hidden = await drive(fileHandlers, {
      params: { shareId: created.id, fileId: secret.id },
      query: { format: 'text' }
    });
    assert.equal(hidden.statusCode, 404);
  });

  it('original also serves the binary, and 410 once it was discarded', async () => {
    const { chatId, plan, scope } = await seedChatWithFiles();
    const created = await share(chatId, { uploadedFilesAccess: 'original' });
    assert.equal(created.fileIds.length, 2);

    const download = await drive(fileHandlers, {
      params: { shareId: created.id, fileId: plan.id },
      query: { download: '1' }
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body.toString(), 'PLAN-ORIGINAL-BYTES');
    assert.match(download.headers['content-disposition'], /attachment/);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.equal(download.headers['x-robots-tag'], 'noindex, nofollow');

    await getChatRepository()
      .fileStore()
      .discardOriginal(scope, plan.id, { reason: 'ttl_expired' });
    const gone = await drive(fileHandlers, { params: { shareId: created.id, fileId: plan.id } });
    assert.equal(gone.statusCode, 410);
    assert.equal(gone.body.code, 'ORIGINAL_DISCARDED');
    // The text is still there.
    const text = await drive(fileHandlers, {
      params: { shareId: created.id, fileId: plan.id },
      query: { format: 'text' }
    });
    assert.equal(text.statusCode, 200);
  });

  it('rejects an unknown access level', async () => {
    const { chatId } = await seedChatWithFiles();
    const res = await drive(createHandlers, {
      params: { chatId },
      body: { mode: 'public', uploadedFilesAccess: 'everything' },
      user: ADA
    });
    assert.equal(res.statusCode, 400);
  });

  it('pins only the shared files against deletion while the share is active', async () => {
    const { chatId, plan, secret } = await seedChatWithFiles();
    const none = await share(chatId);
    const shares = getChatShareRepository();
    assert.equal((await shares.fileIdsRetainedByShares(chatId)).size, 0);

    await share(chatId, { uploadedFilesAccess: 'extracted_text', sharedFileIds: [plan.id] });
    const retained = await shares.fileIdsRetainedByShares(chatId);
    assert.deepEqual([...retained], [plan.id]);
    assert.ok(!retained.has(secret.id));
    assert.ok(none.id);
  });
});
