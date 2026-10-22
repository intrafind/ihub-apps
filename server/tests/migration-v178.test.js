// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V178 — the temporary chat retention default (#2947).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  description,
  precondition,
  up,
  version
} from '../migrations/V178__temporary_chat_retention.js';
import { setDefault } from '../migrations/utils.js';

function makeCtx(files) {
  const logs = [];
  return {
    logs,
    files,
    fileExists: async rel => Object.hasOwn(files, rel),
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

describe('V178 temporary chat retention', () => {
  it('is versioned and described', () => {
    assert.equal(version, '178');
    assert.equal(description, 'temporary_chat_retention');
  });

  it('only runs where there is a platform config', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/platform.json': {} })), true);
  });

  it('adds the 24 hour default next to the other chat settings', async () => {
    const ctx = makeCtx({
      'config/platform.json': { chats: { enabled: true, retentionDays: 30 } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].chats, {
      enabled: true,
      retentionDays: 30,
      temporaryRetentionHours: 24
    });
  });

  it('keeps a value an admin already set', async () => {
    const ctx = makeCtx({ 'config/platform.json': { chats: { temporaryRetentionHours: 2 } } });
    await up(ctx);
    assert.equal(ctx.files['config/platform.json'].chats.temporaryRetentionHours, 2);
  });
});
