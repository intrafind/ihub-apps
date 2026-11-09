#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V234 specs — `ntlmAuth.type` is removed, whatever it held, and
 * the rest of the NTLM block is left as the admin set it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeKey } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V234__remove_ntlm_auth_type.js';

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

describe('V234 remove ntlmAuth.type', () => {
  it('has a version and description', () => {
    assert.equal(version, '234');
    assert.ok(description);
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [PLATFORM]: {} })), true);
  });

  it('removes "negotiate" and warns that sign-in now uses NTLM', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        ntlmAuth: {
          enabled: true,
          type: 'negotiate',
          domain: 'EXAMPLE',
          domainController: 'ldaps://dc.example.com:636'
        }
      }
    });
    await up(ctx);

    assert.deepEqual(ctx.files[PLATFORM].ntlmAuth, {
      enabled: true,
      domain: 'EXAMPLE',
      domainController: 'ldaps://dc.example.com:636'
    });
    assert.equal(ctx.logs[0][0], 'warn');
  });

  it('removes "ntlm" as well', async () => {
    const ctx = makeCtx({ [PLATFORM]: { ntlmAuth: { enabled: false, type: 'ntlm' } } });
    await up(ctx);

    assert.deepEqual(ctx.files[PLATFORM].ntlmAuth, { enabled: false });
    assert.equal(ctx.logs[0][0], 'info');
  });

  it('leaves platform.json untouched when there is no type', async () => {
    const ctx = makeCtx({ [PLATFORM]: { auth: { mode: 'local' } } });
    await up(ctx);

    assert.equal(ctx.writes, 0);
    assert.deepEqual(ctx.files[PLATFORM], { auth: { mode: 'local' } });
  });
});
