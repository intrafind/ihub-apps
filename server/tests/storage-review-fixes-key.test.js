// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests for the review of storage encryption: the master key.
 *
 * - security B1: a key file that exists and holds no key stops the start, is
 *   never overwritten, and no key that only lives in this process may seal;
 * - security N5: the id of a master key does not depend on its spelling;
 * - `storage:encrypt --dry-run` and `storage:check` create no key file.
 */
import { contentsDir, dataDir } from './support/scratchContents.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, beforeEach, after } from 'node:test';
import { fixedKeys, MASTER_KEY_A } from './support/blobTestSupport.js';

const { default: tokenStorage } = await import('../services/TokenStorageService.js');
const keyModule = await import('../crypto/KeyProvider.js');
const { checkMasterKey } = await import('../storage/localBlobBackend.js');
const { prepareStorageEncryption } = await import('../storage/atRest/prepare.js');
const { runStorageCheck } = await import('../storage/commands/storageCheck.js');

const keyFile = path.join(contentsDir, '.encryption-key');
const VALID = 'c3'.repeat(32);

async function resetKeyService() {
  tokenStorage.encryptionKey = null;
  tokenStorage.keySource = null;
  await fs.rm(keyFile, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
}

describe('an unusable key file (security B1)', () => {
  beforeEach(resetKeyService);
  after(resetKeyService);

  for (const [what, content] of [
    ['empty', ''],
    ['too short', 'abc'],
    ['in quotes', `"${VALID}"`],
    ['prefixed with a name', `TOKEN_ENCRYPTION_KEY=${VALID}`],
    ['truncated', VALID.slice(0, 63)]
  ]) {
    it(`stops the start and leaves a key file that is ${what} as it is`, async () => {
      await fs.writeFile(keyFile, content);
      await assert.rejects(tokenStorage.initializeEncryptionKey(), { code: 'MASTER_KEY_INVALID' });
      assert.equal(tokenStorage.encryptionKey, null, 'no key in memory');
      assert.equal(tokenStorage.keySource, null);
      assert.equal(await fs.readFile(keyFile, 'utf8'), content, 'the file is not overwritten');
      await assert.rejects(tokenStorage.assertKeyFileUsable(), { code: 'MASTER_KEY_INVALID' });
      // The storage start refuses as well: nothing is sealed under a fresh key.
      await assert.rejects(checkMasterKey(keyModule), { code: 'MASTER_KEY_INVALID' });
    });
  }

  it('stops the start when the key path is a directory', async () => {
    await fs.mkdir(keyFile);
    await assert.rejects(tokenStorage.initializeEncryptionKey(), { code: 'MASTER_KEY_INVALID' });
    assert.equal(tokenStorage.encryptionKey, null);
    assert.ok((await fs.stat(keyFile)).isDirectory());
  });

  it('reads a key with a trailing newline and upper-case digits', async () => {
    await fs.writeFile(keyFile, `${VALID.toUpperCase()}\n`);
    await tokenStorage.initializeEncryptionKey();
    assert.equal(tokenStorage.encryptionKey, VALID);
    assert.equal(tokenStorage.keySource, 'file');
    assert.match(await checkMasterKey(keyModule), /\(file\)/);
  });

  it('generates and saves a key only when there is no key file', async () => {
    await tokenStorage.initializeEncryptionKey();
    assert.equal(tokenStorage.keySource, 'generated');
    assert.equal((await fs.readFile(keyFile, 'utf8')).trim(), tokenStorage.encryptionKey);
  });

  it('accepts only a persisted or environment-supplied key for sealing', async () => {
    for (const source of [null, 'generated-unpersisted', 'somewhere-else']) {
      const error = await checkMasterKey(fixedKeys(keyModule, { source })).catch(e => e);
      assert.equal(error?.code, 'KEY_UNAVAILABLE', `source ${source}`);
      assert.equal(error.keyMissing, true);
    }
    for (const source of ['env', 'file', 'generated']) {
      assert.match(await checkMasterKey(fixedKeys(keyModule, { source })), new RegExp(source));
    }
  });
});

describe('commands that must change nothing create no key file', () => {
  beforeEach(resetKeyService);
  after(resetKeyService);

  const exists = file =>
    fs.stat(file).then(
      () => true,
      () => false
    );

  it('storage:encrypt --dry-run reports a missing key and writes nothing', async () => {
    await fs.mkdir(path.join(dataDir, 'blobs', 'chat-files'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'blobs', 'chat-files', 'f1'), 'plain');
    const result = await prepareStorageEncryption({
      platformConfig: { storage: { encryption: { enabled: true } } },
      env: {},
      dryRun: true,
      force: true
    });
    assert.equal(result.action, 'dry-run');
    assert.equal(result.masterKey, 'absent');
    assert.equal(result.report.blobs.plaintext, 1);
    assert.equal(await exists(keyFile), false, 'no key file');
    assert.equal(await exists(path.join(dataDir, '.at-rest.json')), false, 'no state record');
    assert.equal(await exists(path.join(dataDir, '.at-rest-keycheck')), false, 'no key check');
    assert.equal(tokenStorage.encryptionKey, null);
  });

  it('storage:check reports a missing key and creates none', async () => {
    const report = await runStorageCheck({
      platformConfig: { storage: { encryption: { enabled: true } } },
      env: {}
    });
    assert.equal(report.status, 'error');
    assert.equal(await exists(keyFile), false);
  });

  it('ensureMasterKey({ create: false }) leaves the key uninitialized', async () => {
    const master = await keyModule.ensureMasterKey({ create: false });
    assert.equal(master.initialized, false);
    assert.equal(await exists(keyFile), false);
  });
});

describe('the id of a master key (security N5)', () => {
  it('is the same for upper and lower case, as current and as previous key', async () => {
    const lower = new keyModule.LocalFileKeyProvider({
      readMasterKey: () => MASTER_KEY_A,
      readPreviousKey: () => null
    });
    const upper = new keyModule.LocalFileKeyProvider({
      readMasterKey: () => MASTER_KEY_A.toUpperCase(),
      readPreviousKey: () => null
    });
    const previous = new keyModule.LocalFileKeyProvider({
      readMasterKey: () => VALID,
      readPreviousKey: () => `${MASTER_KEY_A.toUpperCase()}\n`
    });
    const id = await lower.currentKeyId();
    assert.equal(await upper.currentKeyId(), id);
    assert.deepEqual(await previous.knownKeyIds(), [await previous.currentKeyId(), id]);
    // What the upper-case reader wraps, the lower-case reader unwraps by id.
    const dataKey = Buffer.alloc(32, 7);
    const wrapped = await upper.wrap(dataKey, 'aad');
    assert.equal(wrapped.keyId, id);
    assert.deepEqual(await lower.unwrap(wrapped.wrapped, wrapped.keyId, 'aad'), dataKey);
  });
});
