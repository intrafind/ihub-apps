// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { up, version } from '../migrations/V220__ip_anonymization_string_mode.js';

function makeCtx(platform) {
  let stored = structuredClone(platform);
  const writes = [];
  return {
    writes,
    stored: () => stored,
    readJson: async () => structuredClone(stored),
    writeJson: async (_path, data) => {
      writes.push(data);
      stored = data;
    },
    log: () => {}
  };
}

describe('migration V220', () => {
  it('has version 220', () => assert.equal(version, '220'));

  it('turns false into off and true into mask in both sections', async () => {
    const ctx = makeCtx({ logging: { anonymizeIp: false }, audit: { anonymizeIp: true } });
    await up(ctx);
    assert.equal(ctx.stored().logging.anonymizeIp, 'off');
    assert.equal(ctx.stored().audit.anonymizeIp, 'mask');
  });

  it('leaves string modes and missing sections alone without writing', async () => {
    const ctx = makeCtx({ logging: { anonymizeIp: 'drop' }, audit: {} });
    await up(ctx);
    assert.equal(ctx.writes.length, 0);
    assert.equal(ctx.stored().logging.anonymizeIp, 'drop');
  });
});
