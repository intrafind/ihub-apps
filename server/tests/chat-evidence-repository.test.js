// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ChatEvidenceRepository against a real filesystem provider: records and
 * content round-trip, content is stored once per chat, an oversized item is
 * not stored, and every delete leaves exactly what it should.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestStorage } from './helpers/testStorage.js';
import {
  contentItem,
  getChatEvidenceRepository,
  sha256Hex
} from '../services/chat/ChatEvidenceRepository.js';

let storage;
let repo;

before(async () => {
  storage = await startTestStorage({ prefix: 'ihub-evidence-repo-' });
  repo = getChatEvidenceRepository();
});
after(async () => {
  await storage.stop();
});

/** Items map for some values. */
function itemsOf(...values) {
  const items = new Map();
  for (const value of values) {
    const { sha256, text } = contentItem(value);
    items.set(sha256, text);
  }
  return items;
}

async function blobCount(ns, prefix = '') {
  const page = await storage.provider.blobs.list(ns, { limit: 1000, prefix });
  return page.items.length;
}

describe('ChatEvidenceRepository', () => {
  it('stores a record and its content; the id and sha256 are what the message keeps', async () => {
    const items = itemsOf('system prompt', { role: 'user', content: 'hi' });
    const ref = await repo.writeRecord(
      'chat',
      'chat-1',
      { v: 1, chatId: 'chat-1', messageId: 'm1' },
      items,
      { ownerId: 'alice', maxContentBytes: 1000 }
    );
    assert.equal(ref.id, 'm1');
    const doc = await repo.getRecord('chat', 'chat-1', 'm1');
    assert.equal(doc.etag, ref.sha256);
    assert.equal(doc.ownerId, 'alice');
    assert.equal(doc.data.messageId, 'm1');

    const { sha256, text } = contentItem('system prompt');
    const content = await repo.getContent('chat', 'chat-1', sha256);
    assert.equal(content.toString('utf8'), text);
    assert.equal(sha256Hex(content), sha256, 'the blob hashes to its name');
    assert.equal(await repo.getContent('chat', 'chat-2', sha256), null, 'per chat');
  });

  it('writes shared content once per chat and keeps it when a message goes', async () => {
    const shared = itemsOf('system prompt');
    await repo.writeRecord('chat', 'chat-3', { messageId: 'a' }, shared, { maxContentBytes: 1e6 });
    const before = await blobCount('chat-evidence-content');
    await repo.writeRecord('chat', 'chat-3', { messageId: 'b' }, shared, { maxContentBytes: 1e6 });
    assert.equal(await blobCount('chat-evidence-content'), before);

    assert.equal(await repo.deleteMessages('chat-3', ['a']), 1);
    assert.equal(await repo.getRecord('chat', 'chat-3', 'a'), null);
    assert.ok(await repo.getRecord('chat', 'chat-3', 'b'));
    const { sha256 } = contentItem('system prompt');
    assert.ok(await repo.getContent('chat', 'chat-3', sha256), 'shared blob stays');
    assert.ok((await repo.chatBytes('chat-3')) > 0);
  });

  it('does not store an item above maxContentBytes and marks it truncated', async () => {
    const big = 'x'.repeat(200);
    const items = itemsOf(big, 'small');
    await repo.writeRecord('chat', 'chat-4', { messageId: 'm' }, items, { maxContentBytes: 100 });
    const { sha256 } = contentItem(big);
    assert.equal(await repo.getContent('chat', 'chat-4', sha256), null);
    const doc = await repo.getRecord('chat', 'chat-4', 'm');
    assert.deepEqual(doc.data.truncated, [{ sha256, bytes: 202, truncated: true }]);
  });

  it('deleteChat removes every record and blob of the chat and nothing else', async () => {
    await repo.writeRecord('chat', 'chat-5', { messageId: 'm' }, itemsOf('five'), {
      maxContentBytes: 1e6
    });
    await repo.writeRecord('chat', 'chat-6', { messageId: 'm' }, itemsOf('six'), {
      maxContentBytes: 1e6
    });
    assert.equal(await repo.deleteChat('chat-5'), 2);
    assert.equal(await repo.getRecord('chat', 'chat-5', 'm'), null);
    assert.equal(await repo.chatBytes('chat-5'), 0);
    assert.ok(await repo.getRecord('chat', 'chat-6', 'm'));
    assert.equal(await repo.deleteChat('chat-5'), 0, 'idempotent');
  });

  it('run evidence: owner delete, age sweep and single delete', async () => {
    const opts = owner => ({ ownerId: owner, maxContentBytes: 1e6 });
    await repo.writeRecord('run', 'run-a', { runId: 'run-a' }, itemsOf('a'), opts('bob'));
    await repo.writeRecord('run', 'run-b', { runId: 'run-b' }, itemsOf('b'), opts('bob'));
    await repo.writeRecord('run', 'run-c', { runId: 'run-c' }, itemsOf('c'), opts('carol'));
    assert.equal((await repo.getRecord('run', 'run-a')).ownerId, 'bob');

    assert.equal(await repo.deleteRunsOfOwner('bob'), 2);
    assert.equal(await repo.getRecord('run', 'run-a'), null);
    assert.equal(await repo.getContent('run', 'run-a', contentItem('a').sha256), null);
    assert.ok(await repo.getRecord('run', 'run-c'));

    assert.equal(await repo.sweepRuns(Date.now() - 60_000), 0, 'not old enough');
    assert.equal(await repo.sweepRuns(Date.now() + 60_000), 1);
    assert.equal(await repo.getRecord('run', 'run-c'), null);
    assert.equal(await repo.deleteRun('run-c'), false);
  });
});
