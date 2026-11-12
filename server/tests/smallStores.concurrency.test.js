// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The usage-tracking pepper and stored user tokens.
 *
 * - Two workers starting cold each wrote their own pepper, so one user got a
 *   different fingerprint on each; the exclusive publish makes the first one win
 *   and the other adopt it. An empty file (an older version's half write) is
 *   replaced rather than used as an empty pepper.
 * - A user's refresh token is stored with an atomic write at mode 0600.
 *
 * Two module instances (`?worker=a`, `?worker=b`) stand in for two workers.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-small-stores-')));
fsSync.mkdirSync(path.join(ROOT, 'contents'), { recursive: true });
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const workerA = await import('../services/UserFingerprint.js?worker=a');
const workerB = await import('../services/UserFingerprint.js?worker=b');
const { default: tokenStorage } = await import('../services/TokenStorageService.js');

after(() => fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('usage pepper', () => {
  it('gives every worker that starts at the same time the same fingerprint', async () => {
    const [a, b] = await Promise.all([
      workerA.fingerprint('user-1'),
      workerB.fingerprint('user-1')
    ]);
    assert.equal(a, b);
    const onDisk = await fs.readFile(path.join(ROOT, 'contents', '.usage-pepper'), 'utf8');
    assert.match(onDisk, /^[0-9a-f]{64}$/);
  });

  it('replaces an empty pepper file instead of using an empty pepper', async () => {
    const file = path.join(ROOT, 'contents', '.usage-pepper');
    await fs.writeFile(file, '');
    const fresh = await import('../services/UserFingerprint.js?worker=c');
    await fresh.fingerprint('user-1');
    assert.match(await fs.readFile(file, 'utf8'), /^[0-9a-f]{64}$/);
  });
});

describe('stored user tokens', () => {
  it('writes the token file whole and readable by the server user only', async () => {
    await tokenStorage.initializeEncryptionKey();
    await tokenStorage.storeUserTokens(
      'u1',
      'svc',
      { accessToken: 'a', refreshToken: 'r' },
      'prov'
    );
    const dir = path.join(ROOT, 'contents', 'integrations', 'svc');
    const files = await fs.readdir(dir);
    assert.equal(files.filter(f => f.startsWith('.tmp_')).length, 0);
    assert.equal(files.length, 1);
    const stat = await fs.stat(path.join(dir, files[0]));
    assert.equal(stat.mode & 0o777, 0o600);
    JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
  });
});
