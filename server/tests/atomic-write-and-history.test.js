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

const { atomicCreateJSON, atomicWriteFile, atomicWriteJSON, writeInDirectory } =
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

  it('leaves no temp file behind', async () => {
    const dir = path.join(ROOT, 'tmpcheck');
    await fs.mkdir(dir);
    await atomicWriteFile(path.join(dir, 'a.txt'), 'x');
    assert.deepEqual(await fs.readdir(dir), ['a.txt']);
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
