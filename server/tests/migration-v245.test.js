// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V245 specs — the CDN hosts HTML artifacts may load scripts from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V245__add_artifact_script_hosts.js';
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

test('version is 245', () => {
  assert.equal(version, '245');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('adds the default CDN hosts beside the existing artifact settings', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { artifacts: { enabled: true, maxBytes: 1 } } });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].artifacts, {
    enabled: true,
    maxBytes: 1,
    scriptHosts: ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com']
  });
});

test('keeps a list an installation already set, the empty one included', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { artifacts: { scriptHosts: [] } } });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].artifacts.scriptHosts, []);
});
