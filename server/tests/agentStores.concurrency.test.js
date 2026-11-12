// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Agent memory and inbox files under concurrent runs of one profile.
 *
 * The version check and the write used to be separate steps, so two writers
 * passing the same `expectedVersion` both succeeded and the second replaced the
 * first, and concurrent inbox appends lost items.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-agent-stores-')));
fsSync.mkdirSync(path.join(ROOT, 'contents'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { writeMemory, readMemory } = await import('../agents/memory/memoryFile.js');
const inbox = await import('../agents/inbox/inboxStore.js');

after(() => fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('writeMemory', () => {
  it('lets exactly one of several writers with the same expectedVersion succeed', async () => {
    await writeMemory('p1', { content: 'start' });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        writeMemory('p1', { mode: 'append', content: `w${i}`, expectedVersion: 1 })
      )
    );
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results.filter(r => r.status === 'rejected')) {
      assert.equal(r.reason.code, 'VERSION_CONFLICT');
    }
    assert.equal((await readMemory('p1')).version, 2);
  });

  it('keeps every append made without an expectedVersion', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeMemory('p2', { mode: 'append', content: `line-${i}` })
      )
    );
    const memory = await readMemory('p2');
    assert.equal(memory.version, 8);
    for (let i = 0; i < 8; i++) assert.ok(memory.body.includes(`line-${i}`));
  });
});

describe('inbox store', () => {
  it('keeps every item added at the same time', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => inbox.addInboxItem('box1', { text: `item ${i}` }))
    );
    const { items, version } = await inbox.readInbox('box1');
    assert.equal(items.length, 8);
    assert.equal(version, 8);
  });

  it('an item marked done while another is added is neither lost nor reopened', async () => {
    await inbox.addInboxItem('box2', { text: 'alpha' });
    await Promise.all([
      inbox.markInboxItemDone('box2', { text: 'alpha' }),
      inbox.addInboxItem('box2', { text: 'beta' })
    ]);
    const { items } = await inbox.readInbox('box2');
    assert.equal(items.find(i => i.text.startsWith('alpha')).status, 'done');
    assert.equal(items.find(i => i.text.startsWith('beta')).status, 'open');
  });
});
