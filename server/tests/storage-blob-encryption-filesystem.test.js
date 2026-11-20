// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `storage.encryption.enabled` on the filesystem blob store, as the storage
 * registry composes it from `platform.json`:
 * - off (the default of an existing installation): blob files are the bytes,
 *   exactly as before;
 * - on: blob files are envelopes. Blobs from before are still read by the
 *   process that prepares the data directory (the start-up step), which
 *   encrypts them in place; every other start is refused until that is done;
 * - off again: nothing is lost.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-fs-encryption-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
const storage = await import('../storage/index.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { beginAtRestPreparation, endAtRestPreparation } =
  await import('../storage/atRest/policy.js');
const { prepareStorageEncryption } = await import('../storage/atRest/prepare.js');
const { readAtRestState } = await import('../storage/atRest/state.js');

const platformConfig = encryption => ({
  storage: { provider: 'filesystem', filesystem: { baseDir, fenceSweepIntervalMs: 0 }, encryption }
});

const baseDir = path.join(scratch, 'data');
const blobFile = (ns, key) => path.join(baseDir, 'blobs', ns, key);
const LONG = Buffer.from('an upload from before encryption was switched on. '.repeat(30));

const start = encryption =>
  storage.initializeStorage({
    env: {},
    platformConfig: {
      storage: {
        provider: 'filesystem',
        filesystem: { baseDir, fenceSweepIntervalMs: 0 },
        ...(encryption === undefined ? {} : { encryption })
      }
    }
  });

afterEach(async () => {
  endAtRestPreparation();
  await storage.shutdownStorage();
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('filesystem blob store and storage.encryption.enabled', () => {
  it('off by default: blob files are the bytes and no key is needed', async () => {
    const provider = await start(undefined);
    assert.equal(provider.name, 'filesystem');
    assert.equal(provider.blobBackend, 'default');
    assert.equal(provider.blobBackendHandle.describe().encryption.scope, 'none');
    assert.equal(tokenStorageService.encryptionKey, null, 'the master key was not loaded');

    const ref = await provider.blobs.put('chat-files', 'chat__a__old.txt', LONG);
    assert.equal(ref.bytes, LONG.length);
    await provider.blobs.put('artifacts', 'chat__a__art', 'tiny');
    assert.ok((await fs.readFile(blobFile('chat-files', 'chat__a__old.txt'))).equals(LONG));
    assert.deepEqual((await provider.blobs.list('chat-files')).items, [
      { key: 'chat__a__old.txt', bytes: LONG.length }
    ]);
    assert.equal(fsSync.existsSync(blobFile('_ihub', 'keycheck')), false);
    assert.equal((await provider.healthCheck()).status, 'ok');
    assert.equal(typeof provider.baseDir, 'string');
  });

  it('on with blobs from before: a start that did not convert them is refused', async () => {
    await assert.rejects(start({ enabled: true }), { code: 'ENCRYPTION_NOT_CONVERTED' });
  });

  it('on, while the data directory is prepared: new blobs are envelopes, blobs from before are still read', async () => {
    // What a configuration migration sees: it runs before the conversion.
    beginAtRestPreparation();
    const provider = await start({ enabled: true });
    assert.equal(provider.blobBackendHandle.describe().encryption.scope, 'all');
    assert.equal(fsSync.existsSync(blobFile('_ihub', 'keycheck')), true);

    await provider.blobs.put('chat-files', 'chat__a__new.txt', LONG);
    const stored = await fs.readFile(blobFile('chat-files', 'chat__a__new.txt'));
    assert.equal(stored.toString('ascii', 0, 4), 'IHB1');
    assert.equal(stored.includes(LONG.subarray(0, 40)), false);

    assert.ok((await provider.blobs.get('chat-files', 'chat__a__old.txt')).data.equals(LONG));
    assert.ok((await provider.blobs.get('chat-files', 'chat__a__new.txt')).data.equals(LONG));
    assert.deepEqual((await provider.blobs.list('chat-files')).items, [
      { key: 'chat__a__new.txt', bytes: LONG.length },
      { key: 'chat__a__old.txt', bytes: LONG.length }
    ]);
    const health = await provider.healthCheck();
    assert.equal(health.status, 'ok');
    assert.equal(health.details.blobs.provider, 'default');
  });

  it('encrypts the blobs from before in place, once', async () => {
    beginAtRestPreparation();
    const provider = await start({ enabled: true });
    const first = await storage.encryptExistingBlobs(provider.blobs);
    assert.deepEqual([first.encrypted, first.alreadyEncrypted, first.failed], [2, 1, 0]);
    assert.equal(first.remaining, 0);
    for (const [ns, key] of [
      ['chat-files', 'chat__a__old.txt'],
      ['artifacts', 'chat__a__art']
    ]) {
      const stored = await fs.readFile(blobFile(ns, key));
      assert.equal(stored.toString('ascii', 0, 4), 'IHB1', `${ns}/${key}`);
    }
    assert.ok((await provider.blobs.get('chat-files', 'chat__a__old.txt')).data.equals(LONG));
    assert.equal((await provider.blobs.get('artifacts', 'chat__a__art')).data.toString(), 'tiny');
    const second = await storage.encryptExistingBlobs(provider.blobs);
    assert.deepEqual([second.encrypted, second.alreadyEncrypted], [0, 3]);
  });

  it('the start-up step records the conversion; from then on a plaintext blob is refused', async () => {
    const result = await prepareStorageEncryption({
      platformConfig: platformConfig({ enabled: true }),
      env: {}
    });
    assert.equal(result.action, 'converted');
    assert.deepEqual((await readAtRestState(baseDir)).facets, {
      blobs: 1,
      documents: 1,
      logs: 1,
      files: 1
    });

    const provider = await start({ enabled: true });
    assert.equal(provider.blobs.acceptsPlaintext, false);
    assert.ok((await provider.blobs.get('chat-files', 'chat__a__old.txt')).data.equals(LONG));
    await fs.writeFile(blobFile('chat-files', 'chat__a__planted.txt'), LONG);
    await assert.rejects(provider.blobs.get('chat-files', 'chat__a__planted.txt'), {
      code: 'CORRUPT_BLOB'
    });
    await fs.rm(blobFile('chat-files', 'chat__a__planted.txt'));
  });

  it('off again: encrypted blobs are still decrypted, new ones are plaintext', async () => {
    const provider = await start({ enabled: false });
    assert.ok((await provider.blobs.get('chat-files', 'chat__a__new.txt')).data.equals(LONG));
    await provider.blobs.put('chat-files', 'chat__a__plain.txt', LONG);
    assert.ok((await fs.readFile(blobFile('chat-files', 'chat__a__plain.txt'))).equals(LONG));
    assert.deepEqual(
      (await provider.blobs.list('chat-files')).items.map(item => item.bytes),
      [LONG.length, LONG.length, LONG.length]
    );
  });

  it('on with another master key: the server does not start', async () => {
    const original = tokenStorageService.encryptionKey;
    tokenStorageService.encryptionKey = 'c3'.repeat(32);
    try {
      // The start-up step checks the key before it converts anything.
      await assert.rejects(
        prepareStorageEncryption({ platformConfig: platformConfig({ enabled: true }), env: {} }),
        { code: 'KEY_UNAVAILABLE' }
      );
    } finally {
      tokenStorageService.encryptionKey = original;
    }
  });
});
