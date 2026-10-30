// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V194: remote A2A agents move from a2aAgents.json into the installed integrations. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  instanceFrom,
  migrateApp,
  authModeOf
} from '../migrations/V194__a2a_agents_installed_integrations.js';

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
    deleteFile: async rel => {
      delete files[rel];
    },
    listFiles: async (dir, pattern) =>
      Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(pattern.replace('*', '')))
        .map(rel => rel.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const langdock = {
  id: 'langdock',
  name: { en: 'Langdock' },
  enabled: true,
  cardUrl: 'https://agents.example/.well-known/agent-card.json',
  auth: { type: 'apiKey', headerName: 'X-Key', valueRef: 'langdock-key' },
  allowedSkills: ['ask'],
  timeoutMs: 120000
};

describe('V194 a2a agents → installed integrations', () => {
  it('declares its version', () => assert.equal(version, '194'));

  it('maps auth blocks to sign-in modes', () => {
    assert.equal(authModeOf({ type: 'none' }), 'none');
    assert.equal(authModeOf({ type: 'apiKey', valueRef: 'x' }), 'service-account');
    assert.equal(authModeOf({ type: 'bearer', tokenRef: 'x' }), 'service-account');
    assert.equal(authModeOf({ type: 'oauth', tokenUrl: 'u' }), 'oauth-client');
  });

  it('turns an agent into an installation of the shipped definition', () => {
    const inst = instanceFrom(langdock);
    assert.equal(inst.definition, 'com.intrafind/a2a-agent');
    assert.equal(inst.values.cardUrl, langdock.cardUrl);
    assert.equal(inst.values.authKind, 'apiKey');
    assert.equal(inst.values.headerName, 'X-Key');
    assert.equal(inst.values.timeoutMs, 120000);
    assert.equal(inst.values.streaming, undefined);
    assert.equal(inst.auth.mode, 'service-account');
    assert.equal(inst.auth.credentialRef, 'langdock-key');
    assert.deepEqual(inst.actions.enabled, ['ask']);
    assert.deepEqual(inst.label, { en: 'Langdock' });
  });

  it('carries OAuth client credentials over', () => {
    const inst = instanceFrom({
      id: 'crm',
      cardUrl: 'https://crm.example/.well-known/agent-card.json',
      auth: {
        type: 'oauth',
        tokenUrl: 'https://idp/token',
        clientId: 'c',
        clientSecretRef: 's',
        scope: 'a'
      }
    });
    assert.equal(inst.auth.mode, 'oauth-client');
    assert.equal(inst.auth.credentialRef, 's');
    assert.equal(inst.values.oauthTokenUrl, 'https://idp/token');
    assert.equal(inst.values.oauthClientId, 'c');
    assert.equal(inst.values.oauthScope, 'a');
    assert.deepEqual(inst.actions.enabled, ['*']);
  });

  it('rewrites agent references in apps to bindings', () => {
    const one = migrateApp({ id: 'a', tools: ['langdock', 'braveSearch'] }, ['langdock']);
    assert.deepEqual(one.app.tools, ['braveSearch']);
    assert.deepEqual(one.app.integrations, { langdock: {} });
    const two = migrateApp({ id: 'b', tools: ['a2a__langdock', 'a2a__langdock__ask'] }, [
      'langdock'
    ]);
    assert.deepEqual(two.app.integrations, { langdock: {} });
    assert.equal(two.app.tools, undefined);
    assert.equal(migrateApp({ id: 'c', tools: ['jira'] }, ['langdock']).changed, false);
  });

  it('moves the agents, merges security, rewrites apps and removes the file', async () => {
    const ctx = makeCtx({
      'config/a2aAgents.json': {
        agents: [langdock],
        security: { blockPrivateIps: true, allowedHosts: ['agents.internal'] }
      },
      'config/integrations.json': {
        installed: [],
        security: { blockPrivateIps: true, allowedHosts: [] }
      },
      'apps/helper.json': { id: 'helper', tools: ['a2a__langdock'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const integrations = ctx.files['config/integrations.json'];
    assert.deepEqual(
      integrations.installed.map(i => i.id),
      ['langdock']
    );
    assert.deepEqual(integrations.security.allowedHosts, ['agents.internal']);
    assert.deepEqual(ctx.files['apps/helper.json'].integrations, { langdock: {} });
    assert.equal('config/a2aAgents.json' in ctx.files, false);
    await up(ctx);
    assert.equal(ctx.files['config/integrations.json'].installed.length, 1);
  });
});
