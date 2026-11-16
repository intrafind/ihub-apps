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
  ChatEvidenceRepository,
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

/** A record naming the given items, as a built record does. */
function recordOf(messageId, ...values) {
  return { messageId, refs: values.map(value => `sha256:${contentItem(value).sha256}`) };
}

describe('ChatEvidenceRepository', () => {
  it('stores a record and its content; the id and sha256 come back', async () => {
    const ref = await repo.writeRecord(
      'chat',
      'chat-1',
      { v: 1, chatId: 'chat-1', messageId: 'm1' },
      itemsOf('system prompt', { role: 'user', content: 'hi' }),
      { ownerId: 'alice' }
    );
    assert.equal(ref.id, 'm1');
    const doc = await repo.getRecord('chat', 'chat-1', 'm1');
    assert.equal(doc.etag, ref.sha256);
    assert.equal(doc.ownerId, 'alice');

    const { sha256, text } = contentItem('system prompt');
    const content = await repo.getContent('chat', 'chat-1', sha256);
    assert.equal(content.toString('utf8'), text);
    assert.equal(sha256Hex(content), sha256, 'the blob hashes to its name');
    assert.equal(await repo.getContent('chat', 'chat-2', sha256), null, 'per chat');
  });

  it('writes shared content once; removing a message sweeps only what nobody names', async () => {
    await repo.writeRecord(
      'chat',
      'chat-3',
      recordOf('a', 'shared', 'only a'),
      itemsOf('shared', 'only a')
    );
    const before = await blobCount('chat-evidence-content');
    await repo.writeRecord('chat', 'chat-3', recordOf('b', 'shared'), itemsOf('shared'));
    assert.equal(await blobCount('chat-evidence-content'), before, 'shared blob written once');

    assert.equal(await repo.deleteMessages('chat-3', ['a']), 1);
    assert.equal(await repo.getRecord('chat', 'chat-3', 'a'), null);
    assert.ok(await repo.getRecord('chat', 'chat-3', 'b'));
    assert.ok(
      await repo.getContent('chat', 'chat-3', contentItem('shared').sha256),
      'shared stays'
    );
    assert.equal(
      await repo.getContent('chat', 'chat-3', contentItem('only a').sha256),
      null,
      'what only the removed record named goes'
    );
  });

  it('writes nothing when onlyIf says no (the chat is gone)', async () => {
    const ref = await repo.writeRecord('chat', 'chat-gone', recordOf('m', 'x'), itemsOf('x'), {
      onlyIf: async () => false
    });
    assert.equal(ref, null);
    assert.equal(await repo.chatBytes('chat-gone'), 0);
  });

  it('deleteChat removes every record and blob of the chat and nothing else', async () => {
    await repo.writeRecord('chat', 'chat-5', recordOf('m', 'five'), itemsOf('five'));
    await repo.writeRecord('chat', 'chat-6', recordOf('m', 'six'), itemsOf('six'));
    assert.equal(await repo.deleteChat('chat-5'), 2);
    assert.equal(await repo.getRecord('chat', 'chat-5', 'm'), null);
    assert.equal(await repo.chatBytes('chat-5'), 0);
    assert.ok(await repo.getRecord('chat', 'chat-6', 'm'));
    assert.equal(await repo.deleteChat('chat-5'), 0, 'idempotent');
  });

  it('run evidence: owner delete, age sweep and single delete', async () => {
    await repo.writeRecord('run', 'run-a', { runId: 'run-a' }, itemsOf('a'), { ownerId: 'bob' });
    await repo.writeRecord('run', 'run-b', { runId: 'run-b' }, itemsOf('b'), { ownerId: 'bob' });
    await repo.writeRecord('run', 'run-c', { runId: 'run-c' }, itemsOf('c'), { ownerId: 'carol' });
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

  it('a failed write leaves no content behind: a failing blob put or record put', async () => {
    const { provider } = storage;
    const failingBlobs = Object.create(provider.blobs);
    let puts = 0;
    failingBlobs.put = async (...args) => {
      puts += 1;
      if (puts === 3) throw new Error('disk full');
      return provider.blobs.put(...args);
    };
    const broken = new ChatEvidenceRepository({
      documents: provider.documents,
      blobs: failingBlobs,
      locks: provider.locks
    });
    const values = Array.from({ length: 12 }, (_, index) => `blob ${index}`);
    await assert.rejects(
      broken.writeRecord('chat', 'chat-fail-1', recordOf('m', ...values), itemsOf(...values)),
      /disk full/
    );
    assert.equal(await repo.chatBytes('chat-fail-1'), 0, 'the blobs it wrote are taken back');

    const failingDocs = Object.create(provider.documents);
    failingDocs.put = async () => {
      throw new Error('document store down');
    };
    const brokenDoc = new ChatEvidenceRepository({
      documents: failingDocs,
      blobs: provider.blobs,
      locks: provider.locks
    });
    await assert.rejects(
      brokenDoc.writeRecord('run', 'run-fail-1', { runId: 'run-fail-1' }, itemsOf('lost'), {
        ownerId: 'dan'
      }),
      /document store down/
    );
    assert.equal(await repo.getContent('run', 'run-fail-1', contentItem('lost').sha256), null);
  });

  it("removes chat evidence filed under an owner, with its chats' content", async () => {
    await repo.writeRecord('chat', 'chat-left', recordOf('m', 'left'), itemsOf('left'), {
      ownerId: 'erin'
    });
    await repo.writeRecord('chat', 'chat-kept', recordOf('m', 'kept'), itemsOf('kept'), {
      ownerId: 'frank'
    });
    assert.equal(await repo.deleteChatEvidenceOfOwner('erin'), 1);
    assert.equal(await repo.chatBytes('chat-left'), 0);
    assert.ok(await repo.getRecord('chat', 'chat-kept', 'm'));
  });
});
