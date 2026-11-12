// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V246 specs — `provenance.recordUser` defaults to "none".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V246__add_provenance_record_user.js';
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

test('version is 246', () => {
  assert.equal(version, '246');
});

test('precondition needs platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'config/platform.json': {} })), true);
});

test('adds recordUser "none" beside the existing provenance settings', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { provenance: { retentionDays: 30 } } });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].provenance, {
    retentionDays: 30,
    recordUser: 'none'
  });
});

test('keeps a mode an installation already set', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { provenance: { recordUser: 'identified' } } });
  await up(ctx);
  assert.equal(ctx.files['config/platform.json'].provenance.recordUser, 'identified');
});
