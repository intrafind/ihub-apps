// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V197: the Entra people search becomes the `entra` installation. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  entraInstanceFrom,
  migrateApp
} from '../migrations/V197__entra_directory_installed_integration.js';

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
    log: m => logs.push(m)
  };
}

const env = { AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 's3' };

describe('V197 Entra directory → installed integration', () => {
  it('declares its version', () => assert.equal(version, '197'));

  it('builds the installation from the environment', () => {
    const instance = entraInstanceFrom(env);
    assert.equal(instance.id, 'entra');
    assert.equal(instance.definition, 'com.intrafind/entra-directory');
    assert.equal(instance.enabled, true);
    assert.deepEqual(instance.values, { tenantId: 'tenant-1', clientId: 'client-1' });
    const bare = entraInstanceFrom({});
    assert.equal(bare.enabled, false);
    assert.deepEqual(bare.values, {});
    assert.equal(entraInstanceFrom({ ...env, AZURE_CLIENT_SECRET: '' }).enabled, false);
  });

  it('turns tool references into the binding', () => {
    assert.deepEqual(migrateApp({ id: 'a', tools: ['entraPeopleSearch', 'knowledge'] }), {
      id: 'a',
      tools: ['knowledge'],
      integrations: { entra: {} }
    });
    assert.deepEqual(
      migrateApp({
        id: 'b',
        tools: ['entraPeopleSearch_findUser', 'entraPeopleSearch_getUserManager']
      }),
      { id: 'b', integrations: { entra: { actions: ['findUser', 'getUserManager'] } } }
    );
    const untouched = { id: 'c', tools: ['knowledge'] };
    assert.equal(migrateApp(untouched), untouched);
  });

  it('creates the installation, removes the tool file and rewrites apps', async () => {
    const ctx = makeCtx({
      'config/integrations.json': { installed: [], security: { blockPrivateIps: true } },
      'tools/entraPeopleSearch.json': { id: 'entraPeopleSearch', script: 'entraPeopleSearch.js' },
      'tools/other.json': { id: 'other' },
      'apps/people.json': { id: 'people', tools: ['entraPeopleSearch'] },
      'apps/plain.json': { id: 'plain', tools: ['other'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx, env);
    const [instance] = ctx.files['config/integrations.json'].installed;
    assert.equal(instance.id, 'entra');
    assert.equal(instance.enabled, true);
    assert.ok(instance.installedAt);
    assert.equal('tools/entraPeopleSearch.json' in ctx.files, false);
    assert.equal('tools/other.json' in ctx.files, true);
    assert.deepEqual(ctx.files['apps/people.json'], { id: 'people', integrations: { entra: {} } });
    assert.deepEqual(ctx.files['apps/plain.json'].tools, ['other']);
  });

  it('is idempotent and works without integrations.json', async () => {
    const ctx = makeCtx({ 'apps/x.json': { id: 'x' } });
    await up(ctx, {});
    await up(ctx, {});
    const { installed } = ctx.files['config/integrations.json'];
    assert.equal(installed.length, 1);
    assert.equal(installed[0].enabled, false);
  });
});
