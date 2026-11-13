// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V250 specs — `projects.extraction.threads` folds into
 * `projects.ingest.concurrency`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, version } from '../migrations/V250__one_file_concurrency_setting.js';
import { setDefault, removeKey } from '../migrations/utils.js';

function fakeCtx(platform) {
  const files = { 'config/platform.json': platform };
  return {
    files,
    written: false,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    async writeJson(p, d) {
      files[p] = d;
      this.written = true;
    },
    setDefault,
    removeKey,
    log: () => {},
    warn: () => {}
  };
}

test('version is 250', () => {
  assert.equal(version, '250');
});

test('removes threads and carries a larger value over to ingest.concurrency', async () => {
  const ctx = fakeCtx({ projects: { extraction: { threads: 4, timeoutMs: 30000 } } });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].projects, {
    extraction: { timeoutMs: 30000 },
    ingest: { concurrency: 4 }
  });
});

test('keeps ingest.concurrency when it is already at least threads', async () => {
  for (const threads of [0, 1, 3]) {
    const ctx = fakeCtx({ projects: { extraction: { threads }, ingest: { concurrency: 3 } } });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].projects, {
      extraction: {},
      ingest: { concurrency: 3 }
    });
  }
});

test('writes nothing without extraction.threads', async () => {
  for (const platform of [{}, { projects: {} }, { projects: { extraction: { memoryMb: 512 } } }]) {
    const ctx = fakeCtx(platform);
    await up(ctx);
    assert.equal(ctx.written, false);
  }
});
