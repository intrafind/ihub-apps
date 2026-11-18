// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V258 specs — the switch of the library kit for HTML artifacts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V258__add_artifact_library_kit.js';
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

test('version is 258', () => {
  assert.equal(version, '258');
});

test('precondition is false when platform.json does not exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('turns the kit on beside the existing artifact settings', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { artifacts: { enabled: true, scriptHosts: [] } }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].artifacts, {
    enabled: true,
    scriptHosts: [],
    libraryKit: { enabled: true }
  });
});

test('adds the block when there are no artifact settings yet', async () => {
  const ctx = fakeCtx({ 'config/platform.json': {} });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].artifacts, { libraryKit: { enabled: true } });
});

test('keeps a switch an installation already turned off', async () => {
  const ctx = fakeCtx({
    'config/platform.json': { artifacts: { libraryKit: { enabled: false } } }
  });
  await up(ctx);
  assert.equal(ctx.files['config/platform.json'].artifacts.libraryKit.enabled, false);
});
