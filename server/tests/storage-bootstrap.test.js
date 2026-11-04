// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The storage provider is mandatory: a bootstrap that cannot bring it up fails
 * with a clear error instead of leaving the server to run without persistence.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StorageBootstrapError,
  bootstrapStorage,
  getStorage,
  isStorageReady,
  requireStorage,
  shutdownStorageBootstrap
} from '../storage/bootstrap.js';

afterEach(async () => {
  await shutdownStorageBootstrap();
});

describe('storage bootstrap', () => {
  it('has no provider before it has run, and says so when one is required', () => {
    assert.equal(getStorage(), null);
    assert.equal(isStorageReady(), false);
    assert.throws(
      () => requireStorage(),
      error => error instanceof StorageBootstrapError && /mandatory/.test(error.message)
    );
  });

  it('brings the filesystem provider up with no configuration beyond a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-bootstrap-'));
    try {
      const provider = await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir: dir, flushIntervalMs: 25 } }
      });
      assert.equal(getStorage(), provider);
      assert.equal(requireStorage(), provider);
      assert.equal(isStorageReady(), true);
      assert.equal(await bootstrapStorage({}), provider, 'a second call returns the same provider');
    } finally {
      await shutdownStorageBootstrap();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects with a StorageBootstrapError that names the setting to check', async () => {
    await assert.rejects(
      () => bootstrapStorage({ storage: { provider: 'no-such-provider' } }),
      error => {
        assert.ok(error instanceof StorageBootstrapError);
        assert.equal(error.code, 'STORAGE_BOOTSTRAP_FAILED');
        assert.match(error.message, /no-such-provider/);
        assert.match(error.message, /platform\.json/);
        assert.ok(error.cause, 'the underlying failure is kept');
        return true;
      }
    );
    assert.equal(getStorage(), null, 'a failed bootstrap leaves no provider behind');
    assert.throws(() => requireStorage(), StorageBootstrapError);
  });

  it('does not remember a failure: a corrected configuration can start', async () => {
    await assert.rejects(() => bootstrapStorage({ storage: { provider: 'no-such-provider' } }));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-bootstrap-retry-'));
    try {
      const provider = await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir: dir, flushIntervalMs: 25 } }
      });
      assert.equal(requireStorage(), provider);
    } finally {
      await shutdownStorageBootstrap();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
