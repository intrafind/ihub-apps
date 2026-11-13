// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V250 specs — `projects.ingest.concurrency` and
 * `projects.extraction.threads` are removed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, version } from '../migrations/V250__remove_file_concurrency_settings.js';
import { removeKey } from '../migrations/utils.js';

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
    removeKey,
    log: () => {},
    warn: () => {}
  };
}

test('version is 250', () => {
  assert.equal(version, '250');
});

test('removes both settings and keeps the rest of their blocks', async () => {
  const ctx = fakeCtx({
    projects: {
      ingest: { concurrency: 4, fetchConcurrency: 16 },
      extraction: { threads: 2, timeoutMs: 30000 }
    }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].projects, {
    ingest: { fetchConcurrency: 16 },
    extraction: { timeoutMs: 30000 }
  });
});

test('removes either one alone', async () => {
  const a = fakeCtx({ projects: { ingest: { concurrency: 2 } } });
  await up(a);
  assert.deepEqual(a.files['config/platform.json'].projects, { ingest: {} });
  const b = fakeCtx({ projects: { extraction: { threads: 0 } } });
  await up(b);
  assert.deepEqual(b.files['config/platform.json'].projects, { extraction: {} });
});

test('writes nothing when neither is set', async () => {
  for (const platform of [
    {},
    { projects: {} },
    { projects: { ingest: { fetchConcurrency: 8 } } }
  ]) {
    const ctx = fakeCtx(platform);
    await up(ctx);
    assert.equal(ctx.written, false);
  }
});
