// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V190 specs — the ZIP limits of the artifact store (#3055).
 *
 * The seeded values are the built-in defaults, so an upgrade changes nothing
 * on its own; an operator who already set one keeps it, zero included.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V190__add_artifact_zip_limits.js';
import { setDefault } from '../migrations/utils.js';

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is 190', () => {
  assert.equal(version, '190');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('adds the ZIP limits beside the existing artifact settings', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { artifacts: { enabled: true, maxBytes: 10485760, maxPerBatch: 8 } }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].artifacts, {
    enabled: true,
    maxBytes: 10485760,
    maxPerBatch: 8,
    maxZipFiles: 200,
    maxZipBytes: 104857600
  });
});

test('keeps values an operator already set, zero included', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { artifacts: { maxZipFiles: 0, maxZipBytes: 1024 } }
  });
  await up(ctx);
  const { artifacts } = ctx.files['config/platform.json'];
  assert.equal(artifacts.maxZipFiles, 0);
  assert.equal(artifacts.maxZipBytes, 1024);
});
