#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V176 specs — setup.disabled flag in platform.json.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V176__add_setup_disabled_flag.js';
import { setDefault } from '../migrations/utils.js';

function fakeCtx(files) {
  return {
    files,
    fileExists: async p => Object.prototype.hasOwnProperty.call(files, p),
    readJson: async p => structuredClone(files[p]),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    setDefault,
    log: () => {}
  };
}

test('version is 176', () => {
  assert.equal(version, '176');
});

test('adds setup.disabled = false and keeps setup.configured', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { setup: { configured: true } } });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].setup, { configured: true, disabled: false });
});

test('does not overwrite an existing disabled flag', async () => {
  const ctx = fakeCtx({ 'config/platform.json': { setup: { disabled: true } } });
  await up(ctx);
  assert.equal(ctx.files['config/platform.json'].setup.disabled, true);
});

test('is skipped without a platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
});
