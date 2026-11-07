// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A reload that finishes late must not put its data over a newer reload's.
 *
 * Reloads of one entry overlap: the TTL timer, the storage provider's change
 * event, an admin save, an invalidation relayed from another worker. Each reads
 * the disk at its own moment and stores when done. A save that writes several
 * files in a row starts a reload after the first write; if that reload is slow it
 * can finish after the final one, store last, and leave the cache holding the
 * state of the first write until the next reload, up to the 5-minute TTL.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-reload-order-')));
fsSync.mkdirSync(path.join(ROOT, 'contents', 'config'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { default: configCache } = await import('../configCache.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { ReloadSequence } = await import('../utils/reloadSequence.js');

const KEY = 'config/groups.json';
const groupsPath = path.join(ROOT, 'contents', 'config', 'groups.json');

const writeGroups = version =>
  fs.writeFile(groupsPath, JSON.stringify({ groups: { g: { id: 'g', version } } }), 'utf8');
const cachedVersion = () => configCache.get(KEY)?.data?.groups?.g?.version;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  await writeGroups(1);
  await configCache._reloadEntry(KEY);
});

after(async () => {
  for (const timer of configCache.refreshTimers.values()) clearTimeout(timer);
  configCache.refreshTimers.clear();
  await fs.rm(ROOT, { recursive: true, force: true });
});

/**
 * Make the next read of the entry return what is on disk now, but only after
 * `gate` is released: a reload that read before a write and is slow to finish.
 */
function slowNextRead() {
  const realRead = configStore.readJson.bind(configStore);
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let used = false;
  configStore.readJson = async (...args) => {
    if (!used && args[0] === KEY) {
      used = true;
      const data = await realRead(...args);
      await gate;
      return data;
    }
    return realRead(...args);
  };
  return {
    release,
    restore: () => {
      configStore.readJson = realRead;
    }
  };
}

describe('reloads of one entry that overlap', () => {
  it('an older reload that finishes last does not overwrite the newer data', async () => {
    const slow = slowNextRead();
    try {
      // Reload A reads version 1 and stalls before it can store.
      const older = configCache._reloadEntry(KEY);
      await tick();

      // The file changes, and reload B, started later, stores version 2.
      await writeGroups(2);
      await configCache._reloadEntry(KEY);
      assert.equal(cachedVersion(), 2, 'the newer reload stored');

      // A finally finishes with what it read before the write.
      slow.release();
      await older;
      assert.equal(cachedVersion(), 2, 'the older reload must not put version 1 back');
    } finally {
      slow.restore();
    }
  });

  it('reloads that finish in the order they started both apply', async () => {
    await writeGroups(3);
    const first = configCache._reloadEntry(KEY);
    await writeGroups(4);
    const second = configCache._reloadEntry(KEY);
    await Promise.all([first, second]);
    assert.equal(cachedVersion(), 4);
  });

  it('the next reload after a dropped one still stores', async () => {
    const slow = slowNextRead();
    try {
      const older = configCache._reloadEntry(KEY);
      await tick();
      await writeGroups(5);
      await configCache._reloadEntry(KEY);
      slow.release();
      await older;
    } finally {
      slow.restore();
    }
    await writeGroups(6);
    await configCache._reloadEntry(KEY);
    assert.equal(cachedVersion(), 6, 'a reload that was dropped does not block later ones');
  });

  it('entries are ordered independently of each other', async () => {
    const slow = slowNextRead();
    try {
      const older = configCache._reloadEntry(KEY);
      await tick();
      // A reload of another entry, started later, must not make the first one's data "old".
      await configCache._reloadEntry('config/features.json');
      await writeGroups(7);
      slow.release();
      await older;
      // Version 7 is on disk; the stalled reload read version 6 and is the newest
      // reload of this entry, so it stores. The next reload then catches up.
      await configCache._reloadEntry(KEY);
      assert.equal(cachedVersion(), 7);
    } finally {
      slow.restore();
    }
  });
});

describe('ReloadSequence', () => {
  it('numbers reloads of a key in the order they begin', () => {
    const sequence = new ReloadSequence();
    assert.equal(sequence.begin('a'), 1);
    assert.equal(sequence.begin('a'), 2);
    assert.equal(sequence.begin('b'), 1, 'keys are counted separately');
  });

  it('lets a reload store unless a later-started one has stored', () => {
    const sequence = new ReloadSequence();
    const older = sequence.begin('a');
    const newer = sequence.begin('a');
    assert.equal(sequence.claim('a', newer), true);
    assert.equal(sequence.claim('a', older), false, 'the older one finished last: refused');
  });

  it('lets reloads store in the order they began', () => {
    const sequence = new ReloadSequence();
    const older = sequence.begin('a');
    const newer = sequence.begin('a');
    assert.equal(sequence.claim('a', older), true);
    assert.equal(sequence.claim('a', newer), true);
  });

  it('refuses nothing for a key it has not seen store', () => {
    const sequence = new ReloadSequence();
    assert.equal(sequence.claim('never-begun', 1), true);
  });
});
