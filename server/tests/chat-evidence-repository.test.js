// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ChatEvidenceRepository against a real filesystem provider: records and
 * their packs round-trip, an answer stores only what the previous record does
 * not map (two writes per answer), and every delete leaves exactly what it
 * should.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestStorage } from './helpers/testStorage.js';
import {
  ChatEvidenceRepository,
  contentItem,
  evidenceScope,
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

/** The item `value` as the record of `messageId` resolves it, or null. */
async function contentOf(kind, id, messageId, value) {
  const doc = await repo.getRecord(kind, id, messageId);
  const buffer = await repo.getContent(kind, id, doc?.data, contentItem(value).sha256);
  return buffer ? buffer.toString('utf8') : null;
}

/** Pack keys of a chat, without the chat prefix. */
async function packsOf(chatId) {
  const prefix = `${evidenceScope(chatId)}__`;
  const page = await storage.provider.blobs.list('chat-evidence-content', { limit: 1000, prefix });
  return page.items.map(item => item.key.slice(prefix.length)).sort();
}

/** `onlyIf` of answer `messageId` of a chat whose answers so far are `earlier`. */
const answersBefore =
  (...earlier) =>
  async () =>
    [...earlier].reverse();

describe('ChatEvidenceRepository', () => {
  it('stores a v2 record and one pack; the id, sha256 and items come back', async () => {
    const ref = await repo.writeRecord(
      'chat',
      'chat-1',
      { chatId: 'chat-1', messageId: 'm1' },
      itemsOf('system prompt', { role: 'user', content: 'hi' }),
      { ownerId: 'alice' }
    );
    assert.equal(ref.id, 'm1');
    const doc = await repo.getRecord('chat', 'chat-1', 'm1');
    assert.equal(doc.etag, ref.sha256);
    assert.equal(doc.ownerId, 'alice');
    assert.equal(doc.data.v, 2);
    const { sha256, text } = contentItem('system prompt');
    assert.equal(doc.data.content[sha256], 'm1');
    assert.deepEqual(await packsOf('chat-1'), [evidenceScope('m1')], 'one pack');

    const content = await repo.getContent('chat', 'chat-1', doc.data, sha256);
    assert.equal(content.toString('utf8'), text);
    assert.equal(sha256Hex(content), sha256, 'the item hashes to its name');
    assert.equal(await repo.getContent('chat', 'chat-2', doc.data, sha256), null, 'per chat');
    assert.equal(
      await repo.getContent('chat', 'chat-1', doc.data, 'f'.repeat(64)),
      null,
      'only what the record maps'
    );
    assert.equal(
      await repo.getContent('chat', 'chat-1', { ...doc.data, v: 1 }, sha256),
      null,
      'a v1 record maps nothing'
    );
  });

  it('two writes per answer: pack and record; none for items the previous record maps', async () => {
    const { provider } = storage;
    let writes = 0;
    const count = facet => {
      const counted = Object.create(facet);
      counted.put = (...args) => {
        writes += 1;
        return facet.put(...args);
      };
      return counted;
    };
    const counting = new ChatEvidenceRepository({
      documents: count(provider.documents),
      blobs: count(provider.blobs),
      locks: provider.locks
    });
    const history = Array.from({ length: 10 }, (_, index) => `history ${index}`);
    await counting.writeRecord('chat', 'chat-w', recordOf('a1', ...history), itemsOf(...history), {
      onlyIf: answersBefore()
    });
    assert.equal(writes, 2, 'ten items, one pack and one record');
    writes = 0;
    await counting.writeRecord(
      'chat',
      'chat-w',
      recordOf('a2', ...history, 'new'),
      itemsOf(...history, 'new'),
      { onlyIf: answersBefore('a1') }
    );
    assert.equal(writes, 2, 'the new item goes into a pack of its own');
    writes = 0;
    await counting.writeRecord('chat', 'chat-w', recordOf('a3', 'new'), itemsOf('new'), {
      onlyIf: answersBefore('a1', 'a2')
    });
    assert.equal(writes, 1, 'nothing new: the record only');
    assert.deepEqual(await packsOf('chat-w'), [evidenceScope('a1'), evidenceScope('a2')].sort());
  });

  it('answer 2 stores only new items; its record maps the history to answer 1', async () => {
    await repo.writeRecord('chat', 'chat-d', recordOf('a1', 'sys', 'q1'), itemsOf('sys', 'q1'), {
      onlyIf: answersBefore()
    });
    await repo.writeRecord(
      'chat',
      'chat-d',
      recordOf('a2', 'sys', 'q1', 'q2'),
      itemsOf('sys', 'q1', 'q2'),
      // A user message in between has no record; it is not an answer.
      { onlyIf: answersBefore('a1') }
    );
    const second = (await repo.getRecord('chat', 'chat-d', 'a2')).data;
    assert.equal(second.content[contentItem('sys').sha256], 'a1');
    assert.equal(second.content[contentItem('q1').sha256], 'a1');
    assert.equal(second.content[contentItem('q2').sha256], 'a2');
    const pack = await storage.provider.blobs.get(
      'chat-evidence-content',
      `${evidenceScope('chat-d')}__${evidenceScope('a2')}`
    );
    assert.deepEqual(Object.keys(JSON.parse(pack.data.toString('utf8'))), [
      contentItem('q2').sha256
    ]);
    assert.equal(await contentOf('chat', 'chat-d', 'a2', 'q1'), contentItem('q1').text);
  });

  it('a v1 previous record is no previous record: everything goes into the pack', async () => {
    await storage.provider.documents.put(
      'chat-evidence',
      `${evidenceScope('chat-v1')}__${evidenceScope('old')}`,
      { v: 1, messageId: 'old' }
    );
    await repo.writeRecord('chat', 'chat-v1', recordOf('new', 'x'), itemsOf('x'), {
      onlyIf: answersBefore('old')
    });
    const doc = await repo.getRecord('chat', 'chat-v1', 'new');
    assert.equal(doc.data.content[contentItem('x').sha256], 'new');
  });

  it('removing a middle answer keeps its pack while a later record points into it', async () => {
    await repo.writeRecord('chat', 'chat-m', recordOf('a1', 'one'), itemsOf('one'), {
      onlyIf: answersBefore()
    });
    await repo.writeRecord('chat', 'chat-m', recordOf('a2', 'one', 'two'), itemsOf('one', 'two'), {
      onlyIf: answersBefore('a1')
    });
    await repo.writeRecord(
      'chat',
      'chat-m',
      recordOf('a3', 'one', 'two', 'three'),
      itemsOf('one', 'two', 'three'),
      { onlyIf: answersBefore('a1', 'a2') }
    );
    assert.equal(await repo.deleteMessages('chat-m', ['a2']), 1);
    assert.equal(await repo.getRecord('chat', 'chat-m', 'a2'), null);
    assert.deepEqual(
      await packsOf('chat-m'),
      ['a1', 'a2', 'a3'].map(evidenceScope).sort(),
      'a3 still points into the pack of a2'
    );
    assert.equal(await contentOf('chat', 'chat-m', 'a3', 'two'), contentItem('two').text);
  });

  it('removing a message sweeps the packs no remaining record points into', async () => {
    await repo.writeRecord(
      'chat',
      'chat-3',
      recordOf('a', 'shared', 'only a'),
      itemsOf('shared', 'only a'),
      {
        onlyIf: answersBefore()
      }
    );
    // `b` does not name `only a`, so after `a` goes nothing points into its pack.
    await repo.writeRecord('chat', 'chat-3', recordOf('b', 'only b'), itemsOf('only b'), {
      onlyIf: answersBefore('a')
    });
    assert.equal(await repo.deleteMessages('chat-3', ['a']), 1);
    assert.deepEqual(await packsOf('chat-3'), [evidenceScope('b')]);
    assert.ok(await repo.getRecord('chat', 'chat-3', 'b'));
    assert.equal(await contentOf('chat', 'chat-3', 'b', 'only b'), contentItem('only b').text);
  });

  it('writes nothing when onlyIf says no (the chat is gone)', async () => {
    const ref = await repo.writeRecord('chat', 'chat-gone', recordOf('m', 'x'), itemsOf('x'), {
      onlyIf: async () => false
    });
    assert.equal(ref, null);
    assert.equal(await repo.chatBytes('chat-gone'), 0);
  });

  it('deleteChat removes every record and pack of the chat and nothing else', async () => {
    await repo.writeRecord('chat', 'chat-5', recordOf('m', 'five'), itemsOf('five'));
    await repo.writeRecord('chat', 'chat-6', recordOf('m', 'six'), itemsOf('six'));
    assert.equal(await repo.deleteChat('chat-5'), 2);
    assert.equal(await repo.getRecord('chat', 'chat-5', 'm'), null);
    assert.equal(await repo.chatBytes('chat-5'), 0);
    assert.ok(await repo.getRecord('chat', 'chat-6', 'm'));
    assert.equal(await repo.deleteChat('chat-5'), 0, 'idempotent');
  });

  it('run evidence: one pack per run; owner delete, age sweep and single delete', async () => {
    await repo.writeRecord('run', 'run-a', { runId: 'run-a' }, itemsOf('a', 'a2'), {
      ownerId: 'bob'
    });
    await repo.writeRecord('run', 'run-b', { runId: 'run-b' }, itemsOf('b'), { ownerId: 'bob' });
    await repo.writeRecord('run', 'run-c', { runId: 'run-c' }, itemsOf('c'), { ownerId: 'carol' });
    const runA = await repo.getRecord('run', 'run-a');
    assert.equal(runA.ownerId, 'bob');
    assert.equal(runA.data.content[contentItem('a').sha256], 'run-a');
    assert.equal(await contentOf('run', 'run-a', undefined, 'a2'), contentItem('a2').text);
    const runPacks = await storage.provider.blobs.list('run-evidence-content', {
      limit: 100,
      prefix: `${evidenceScope('run-a')}__`
    });
    assert.deepEqual(
      runPacks.items.map(item => item.key),
      [`${evidenceScope('run-a')}__${evidenceScope('run-a')}`]
    );

    assert.equal(await repo.deleteRunsOfOwner('bob'), 2);
    assert.equal(await repo.getRecord('run', 'run-a'), null);
    assert.equal(await repo.getContent('run', 'run-a', runA.data, contentItem('a').sha256), null);
    assert.ok(await repo.getRecord('run', 'run-c'));

    assert.equal(await repo.sweepRuns(Date.now() - 60_000), 0, 'not old enough');
    assert.equal(await repo.sweepRuns(Date.now() + 60_000), 1);
    assert.equal(await repo.getRecord('run', 'run-c'), null);
    assert.equal(await repo.deleteRun('run-c'), false);
  });

  it('a failed write leaves no content behind: a failing pack put or record put', async () => {
    const { provider } = storage;
    const failingBlobs = Object.create(provider.blobs);
    failingBlobs.put = async () => {
      throw new Error('disk full');
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
    assert.equal(await repo.chatBytes('chat-fail-1'), 0, 'no record without its pack');

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
    assert.equal(
      await blobCount('run-evidence-content', `${evidenceScope('run-fail-1')}__`),
      0,
      'the pack is taken back'
    );
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
