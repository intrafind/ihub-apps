#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V188 specs — the iFinder auth mode and token exchange settings get
 * their defaults, and values an admin already set are kept.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setDefault } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V188__add_ifinder_auth_mode.js';

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

const DEFAULT_EXCHANGE = {
  oidcProvider: '',
  grantType: 'tokenExchange',
  audience: '',
  scopeMap: { fa_index_read: '', fa_iassistant: '', fi_smartcollections: '' },
  extraScopes: []
};

describe('V188 iFinder auth mode', () => {
  it('has a version and description', () => {
    assert.equal(version, '188');
    assert.ok(description);
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/platform.json': {} })), true);
  });

  it('adds the defaults to an existing iFinder section', async () => {
    const ctx = makeCtx({
      'config/platform.json': { iFinder: { enabled: true, baseUrl: 'https://f' } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].iFinder, {
      enabled: true,
      baseUrl: 'https://f',
      authMode: 'ihubSigned',
      tokenExchange: DEFAULT_EXCHANGE
    });
  });

  it('keeps what an admin set', async () => {
    const ctx = makeCtx({
      'config/platform.json': {
        iFinder: {
          authMode: 'oidcTokenExchange',
          tokenExchange: { oidcProvider: 'zitadel', scopeMap: { fa_index_read: 'x' } }
        }
      }
    });
    await up(ctx);
    const { iFinder } = ctx.files['config/platform.json'];
    assert.equal(iFinder.authMode, 'oidcTokenExchange');
    assert.equal(iFinder.tokenExchange.oidcProvider, 'zitadel');
    assert.deepEqual(iFinder.tokenExchange.scopeMap, { fa_index_read: 'x' });
    assert.equal(iFinder.tokenExchange.grantType, 'tokenExchange');
  });

  it('does not create an iFinder section', async () => {
    const ctx = makeCtx({ 'config/platform.json': { auth: { mode: 'local' } } });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'], { auth: { mode: 'local' } });
  });
});
