#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V186 specs — the `update` settings get their defaults, and values
 * an admin already set are kept.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setDefault } from '../migrations/utils.js';
import { up, precondition, version, description } from '../migrations/V186__update_settings.js';

function makeCtx(files) {
  const logs = [];
  return {
    logs,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

describe('V186 update settings', () => {
  it('has a version and description', () => {
    assert.equal(version, '186');
    assert.ok(description);
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/platform.json': {} })), true);
  });

  it('adds the defaults', async () => {
    const ctx = makeCtx({ 'config/platform.json': { auth: { mode: 'local' } } });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].update, {
      allowUnsigned: false,
      trustedPublicKeys: [],
      maxUploadSizeMB: 1024
    });
    assert.deepEqual(ctx.files['config/platform.json'].auth, { mode: 'local' });
  });

  it('keeps what an admin set', async () => {
    const ctx = makeCtx({
      'config/platform.json': { update: { allowUnsigned: true, maxUploadSizeMB: 2048 } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].update, {
      allowUnsigned: true,
      maxUploadSizeMB: 2048,
      trustedPublicKeys: []
    });
  });
});
