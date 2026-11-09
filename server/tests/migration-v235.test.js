#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V235 specs — the NTLM settings express-ntlm never read are
 * removed, the settings that do something are kept, and an admin who had
 * domain controller credentials is told where groups really come from.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeKey } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V235__remove_dead_ntlm_settings.js';

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

const KEPT = {
  enabled: true,
  domain: 'EXAMPLE',
  domainController: 'ldaps://dc.example.com:636',
  debug: false,
  defaultGroups: ['users'],
  sessionTimeoutMinutes: 480,
  generateJwtToken: true,
  tlsOptions: { rejectUnauthorized: false }
};

describe('V235 remove dead NTLM settings', () => {
  it('has a version and description', () => {
    assert.equal(version, '235');
    assert.ok(description);
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [PLATFORM]: {} })), true);
  });

  it('removes the unused settings and keeps the rest of the block', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        ntlmAuth: {
          ...KEPT,
          getUserInfo: true,
          getGroups: true,
          domainControllerUser: 'CN=svc,DC=example,DC=com',
          domainControllerPasswordRef: 'ntlm',
          domainControllerPassword: 'leftover'
        }
      }
    });
    await up(ctx);

    assert.deepEqual(ctx.files[PLATFORM].ntlmAuth, KEPT);
  });

  it('warns, naming the stored credential, when credentials were set without a group lookup', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        ntlmAuth: { ...KEPT, domainControllerUser: 'svc', domainControllerPasswordRef: 'ntlm' }
      }
    });
    await up(ctx);

    const warnings = ctx.logs.filter(([level]) => level === 'warn');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][1], /ldapGroupLookupProvider/);
    assert.match(warnings[0][1], /"ntlm"/);
  });

  it('does not warn when an LDAP group lookup is already configured', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        ntlmAuth: { ...KEPT, ldapGroupLookupProvider: 'corp', domainControllerUser: 'svc' }
      }
    });
    await up(ctx);

    assert.equal(ctx.files[PLATFORM].ntlmAuth.ldapGroupLookupProvider, 'corp');
    assert.equal('domainControllerUser' in ctx.files[PLATFORM].ntlmAuth, false);
    assert.equal(ctx.logs.filter(([level]) => level === 'warn').length, 0);
  });

  it('does not warn when only the flags were set', async () => {
    const ctx = makeCtx({ [PLATFORM]: { ntlmAuth: { ...KEPT, getGroups: true } } });
    await up(ctx);

    assert.deepEqual(ctx.files[PLATFORM].ntlmAuth, KEPT);
    assert.equal(ctx.logs.filter(([level]) => level === 'warn').length, 0);
  });

  it('leaves platform.json untouched when there is nothing to remove', async () => {
    const noBlock = makeCtx({ [PLATFORM]: { auth: { mode: 'local' } } });
    await up(noBlock);
    assert.equal(noBlock.writes, 0);

    const clean = makeCtx({ [PLATFORM]: { ntlmAuth: { ...KEPT } } });
    await up(clean);
    assert.equal(clean.writes, 0);
    assert.deepEqual(clean.files[PLATFORM].ntlmAuth, KEPT);
  });
});
