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

const { atomicWriteFile, atomicWriteJSON } = await import('../utils/atomicWrite.js');
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
