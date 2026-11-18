#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V257 specs — `ntlmAuth.generateJwtToken` is removed, the other NTLM
 * settings stay, and an admin who had it off is told what changed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeKey } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V257__remove_ntlm_generate_jwt_token.js';

const PLATFORM = 'config/platform.json';

function makeCtx(files) {
  const logs = [];
  let writes = 0;
  return {
    logs,
    files,
    get writes() {
      return writes;
    },
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes++;
      files[rel] = data;
    },
    removeKey,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

describe('V257 remove ntlmAuth.generateJwtToken', () => {
  it('has its version and description', () => {
    assert.equal(version, '257');
    assert.equal(description, 'remove_ntlm_generate_jwt_token');
  });

  it('runs only when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [PLATFORM]: {} })), true);
  });

  it('removes the setting and keeps the others', async () => {
    const ctx = makeCtx({
      [PLATFORM]: { ntlmAuth: { enabled: true, domain: 'MUC', generateJwtToken: true } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].ntlmAuth, { enabled: true, domain: 'MUC' });
    assert.equal(ctx.writes, 1);
    assert.equal(ctx.logs.filter(([level]) => level === 'warn').length, 0);
  });

  it('warns when the setting was off', async () => {
    const ctx = makeCtx({ [PLATFORM]: { ntlmAuth: { enabled: true, generateJwtToken: false } } });
    await up(ctx);
    assert.equal('generateJwtToken' in ctx.files[PLATFORM].ntlmAuth, false);
    assert.equal(ctx.logs.filter(([level]) => level === 'warn').length, 1);
  });

  it('writes nothing when the setting is absent', async () => {
    const ctx = makeCtx({ [PLATFORM]: { ntlmAuth: { enabled: true } } });
    await up(ctx);
    assert.equal(ctx.writes, 0);
  });
});
