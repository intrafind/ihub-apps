// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-atomic-')));
fsSync.mkdirSync(path.join(ROOT, 'contents'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { atomicCreateJSON, atomicWriteFile, atomicWriteJSON, renameWithRetry, writeInDirectory } =
  await import('../utils/atomicWrite.js');
const { saveSnapshot, listSnapshots } = await import('../services/ChangeHistoryService.js');

const modeOf = async p => (await fs.stat(p)).mode & 0o777;

describe('atomicWrite permissions', { skip: process.platform === 'win32' }, () => {
  it('keeps the mode of the file it replaces', async () => {
    const file = path.join(ROOT, 'secret.json');
    await fs.writeFile(file, '{}', { mode: 0o600 });
    await fs.chmod(file, 0o600);
    await atomicWriteJSON(file, { a: 1 });
    assert.equal(await modeOf(file), 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
  });

  it('sets an explicit mode on a new file, whatever the umask', async () => {
    const file = path.join(ROOT, 'new-secret.json');
    await atomicWriteJSON(file, { a: 1 }, { mode: 0o600 });
    assert.equal(await modeOf(file), 0o600);
    await atomicWriteFile(file, 'x', { encoding: 'utf8' });
    assert.equal(await modeOf(file), 0o600);
  });

  it('gives the default mode with keepMode: false, and still honours an explicit mode', async () => {
    const file = path.join(ROOT, 'store-doc.json');
    await fs.writeFile(file, '{}');
    await fs.chmod(file, 0o600);
    const fresh = path.join(ROOT, 'fresh.json');
    await fs.writeFile(fresh, '{}');
    const defaultMode = await modeOf(fresh);
    await atomicWriteJSON(file, { a: 1 }, { keepMode: false });
    assert.equal(await modeOf(file), defaultMode);
    await atomicWriteJSON(file, { a: 2 }, { keepMode: false, mode: 0o600 });
    assert.equal(await modeOf(file), 0o600);
  });

  it('writeInDirectory creates a missing directory and retries once', async () => {
    const dir = path.join(ROOT, 'later', 'nested');
    const file = path.join(dir, 'a.json');
    await writeInDirectory(dir, () => atomicWriteJSON(file, { a: 1 }));
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
    await assert.rejects(
      writeInDirectory(dir, async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
      /denied/
    );
  });

  it('atomicCreateJSON publishes the file whole, never opening the target to write it', async () => {
    const dir = path.join(ROOT, 'create');
    await fs.mkdir(dir);
    const file = path.join(dir, 'doc.json');
    const real = { open: fs.open, writeFile: fs.writeFile };
    const opened = [];
    for (const name of Object.keys(real)) {
      fs[name] = (target, ...rest) => {
        opened.push(String(target));
        return real[name](target, ...rest);
      };
    }
    try {
      await atomicCreateJSON(file, { a: 1 });
    } finally {
      Object.assign(fs, real);
    }
    assert.equal(opened.includes(file), false, 'a reader cannot catch it half-written');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
    await assert.rejects(atomicCreateJSON(file, { a: 2 }), error => error.code === 'EEXIST');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
    assert.deepEqual(await fs.readdir(dir), ['doc.json'], 'no temp file left behind');
  });

  it('atomicCreateJSON falls back to an exclusive create where hard links are not supported', async () => {
    const dir = path.join(ROOT, 'nolink');
    await fs.mkdir(dir);
    const file = path.join(dir, 'doc.json');
    const realLink = fs.link;
    fs.link = async () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    };
    try {
      await atomicCreateJSON(file, { a: 1 });
      await assert.rejects(atomicCreateJSON(file, { a: 2 }), error => error.code === 'EEXIST');
    } finally {
      fs.link = realLink;
    }
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
    assert.deepEqual(await fs.readdir(dir), ['doc.json'], 'no temp file left behind');
  });

  it('atomicCreateJSON takes an EEXIST for its own link (a retried NFS request) as success', async () => {
    const dir = path.join(ROOT, 'nfs-retry');
    await fs.mkdir(dir);
    const file = path.join(dir, 'doc.json');
    const realLink = fs.link;
    // The link is made, then the retransmitted request finds the name taken.
    fs.link = async (from, to) => {
      await realLink(from, to);
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    };
    try {
      await atomicCreateJSON(file, { a: 1 });
    } finally {
      fs.link = realLink;
    }
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1 });
    assert.deepEqual(await fs.readdir(dir), ['doc.json'], 'no temp file left behind');
  });

  it('leaves no temp file behind', async () => {
    const dir = path.join(ROOT, 'tmpcheck');
    await fs.mkdir(dir);
    await atomicWriteFile(path.join(dir, 'a.txt'), 'x');
    assert.deepEqual(await fs.readdir(dir), ['a.txt']);
  });
});

describe('renameWithRetry', () => {
  const NO_DELAYS = [0, 0, 0, 0, 0];
  const lockedError = code =>
    Object.assign(new Error(`${code}: operation not permitted`), { code });

  /** Runs `fn` with fs.rename failing `failures` times with `code` before renaming for real. */
  async function withLockedRename(code, failures, fn) {
    const realRename = fs.rename;
    let calls = 0;
    fs.rename = async (from, to) => {
      calls++;
      if (calls <= failures) throw lockedError(code);
      return realRename(from, to);
    };
    try {
      await fn();
    } finally {
      fs.rename = realRename;
    }
    return calls;
  }

  async function freshPair(name) {
    const dir = path.join(ROOT, name);
    await fs.mkdir(dir);
    const from = path.join(dir, 'from.json');
    const to = path.join(dir, 'to.json');
    await fs.writeFile(from, '{"new":true}');
    await fs.writeFile(to, '{"old":true}');
    return { dir, from, to };
  }

  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`retries a Windows ${code} while the target is locked, then replaces it`, async () => {
      const { from, to } = await freshPair(`retry-${code}`);
      const calls = await withLockedRename(code, 3, () =>
        renameWithRetry(from, to, { platform: 'win32', delays: NO_DELAYS })
      );
      assert.equal(calls, 4);
      assert.deepEqual(JSON.parse(await fs.readFile(to, 'utf8')), { new: true });
    });
  }

  it('gives up on Windows once the retries are spent', async () => {
    const { from, to } = await freshPair('retry-exhausted');
    const calls = await withLockedRename('EPERM', Infinity, () =>
      assert.rejects(renameWithRetry(from, to, { platform: 'win32', delays: [0, 0] }), /EPERM/)
    );
    assert.equal(calls, 3, 'the first attempt and one per delay');
    assert.deepEqual(JSON.parse(await fs.readFile(to, 'utf8')), { old: true });
  });

  it('does not retry an error that is not a lock (ENOENT)', async () => {
    const { from, to } = await freshPair('retry-enoent');
    const calls = await withLockedRename('ENOENT', 1, () =>
      assert.rejects(renameWithRetry(from, to, { platform: 'win32', delays: NO_DELAYS }), /ENOENT/)
    );
    assert.equal(calls, 1);
  });

  it('does not retry outside Windows, where EPERM is a real permission error', async () => {
    const { from, to } = await freshPair('retry-linux');
    const calls = await withLockedRename('EPERM', 1, () =>
      assert.rejects(renameWithRetry(from, to, { platform: 'linux', delays: NO_DELAYS }), /EPERM/)
    );
    assert.equal(calls, 1);
  });

  it('atomicWriteFile removes its temp file when the rename finally fails', async () => {
    const dir = path.join(ROOT, 'retry-cleanup');
    await fs.mkdir(dir);
    const file = path.join(dir, 'a.json');
    await fs.writeFile(file, 'old');
    await withLockedRename('EPERM', Infinity, () =>
      assert.rejects(atomicWriteFile(file, 'new'), /EPERM/)
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(dir), ['a.json']);
  });
});

describe('ChangeHistoryService snapshots', () => {
  it('keeps every snapshot saved within one millisecond', async () => {
    const realNow = Date.now;
    const RealDate = Date;
    const fixed = new RealDate('2026-01-01T00:00:00.000Z');
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        return args.length ? new RealDate(...args) : new RealDate(fixed);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          saveSnapshot({ resource: 'app', id: 'same-ms', before: { i }, after: { i }, admin: 'a' })
        )
      );
    } finally {
      globalThis.Date = RealDate;
      Date.now = realNow;
    }
    const snapshots = await listSnapshots('app', 'same-ms');
    assert.equal(snapshots.length, 10);
    assert.equal(new Set(snapshots.map(s => s.filename)).size, 10);
  });
});
