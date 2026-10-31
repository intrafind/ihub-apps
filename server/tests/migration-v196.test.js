// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V196: `platform.jira` and the Jira tool references become the `jira` installation. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  jiraInstanceFrom,
  migrateApp
} from '../migrations/V196__jira_installed_integration.js';

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
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(pattern.replaceAll('*', '')))
        .map(rel => rel.slice(dir.length + 1)),
    log: m => logs.push(m)
  };
}

const platformJira = {
  enabled: true,
  baseUrl: 'https://acme.atlassian.net',
  clientId: 'abc123',
  clientSecretRef: 'jira-client-secret',
  redirectUri: 'https://ihub.acme.com/api/integrations/jira/callback'
};

describe('V196 Jira → installed integration', () => {
  it('declares its version', () => assert.equal(version, '196'));

  it('builds the installation from platform.jira', () => {
    const instance = jiraInstanceFrom(platformJira);
    assert.equal(instance.id, 'jira');
    assert.equal(instance.definition, 'com.intrafind/jira');
    assert.equal(instance.enabled, true);
    assert.deepEqual(instance.values, {
      clientId: 'abc123',
      clientSecretRef: 'jira-client-secret',
      redirectUri: 'https://ihub.acme.com/api/integrations/jira/callback',
      siteUrl: 'https://acme.atlassian.net'
    });
    assert.deepEqual(instance.auth, { mode: 'oauth-user' });
  });

  it('keeps an unconfigured or disabled block disabled', () => {
    assert.equal(jiraInstanceFrom({ enabled: true, clientId: 'x' }).enabled, false);
    assert.equal(jiraInstanceFrom({ ...platformJira, enabled: false }).enabled, false);
    assert.deepEqual(jiraInstanceFrom({}).values, {});
  });

  it('turns tool references into the binding', () => {
    assert.deepEqual(migrateApp({ id: 'a', tools: ['jira', 'knowledge'] }), {
      id: 'a',
      tools: ['knowledge'],
      integrations: { jira: {} }
    });
    assert.deepEqual(migrateApp({ id: 'b', tools: ['jira_searchTickets', 'jira_getTicket'] }), {
      id: 'b',
      integrations: { jira: { actions: ['searchTickets', 'getTicket'] } }
    });
    const untouched = { id: 'c', tools: ['knowledge'] };
    assert.equal(migrateApp(untouched), untouched);
    assert.equal(migrateApp({ id: 'd' }).tools, undefined);
  });

  it('merges with an existing binding', () => {
    const app = {
      id: 'e',
      tools: ['jira_addComment'],
      integrations: { jira: { actions: ['searchTickets'] } }
    };
    assert.deepEqual(migrateApp(app).integrations.jira.actions, ['searchTickets', 'addComment']);
  });

  it('moves the platform block, removes the tool file and rewrites apps', async () => {
    const ctx = makeCtx({
      'config/platform.json': { auth: { mode: 'local' }, jira: structuredClone(platformJira) },
      'config/integrations.json': { installed: [], security: { blockPrivateIps: true } },
      'tools/jira.json': { id: 'jira', script: 'jira.js', functions: {} },
      'tools/other.json': { id: 'other', script: 'other.js' },
      'apps/support.json': { id: 'support', tools: ['jira'] },
      'apps/plain.json': { id: 'plain', tools: ['other'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    assert.equal('jira' in ctx.files['config/platform.json'], false);
    assert.equal(ctx.files['config/platform.json'].auth.mode, 'local');
    const [instance] = ctx.files['config/integrations.json'].installed;
    assert.equal(instance.id, 'jira');
    assert.equal(instance.enabled, true);
    assert.ok(instance.installedAt);
    assert.equal('tools/jira.json' in ctx.files, false);
    assert.equal('tools/other.json' in ctx.files, true);
    assert.deepEqual(ctx.files['apps/support.json'], { id: 'support', integrations: { jira: {} } });
    assert.deepEqual(ctx.files['apps/plain.json'].tools, ['other']);
  });

  it('is idempotent and leaves a platform without Jira alone', async () => {
    const ctx = makeCtx({
      'config/platform.json': { jira: structuredClone(platformJira) },
      'config/integrations.json': { installed: [] }
    });
    await up(ctx);
    await up(ctx);
    assert.equal(ctx.files['config/integrations.json'].installed.length, 1);
    const plain = makeCtx({ 'config/platform.json': { auth: {} } });
    await up(plain);
    assert.equal('config/integrations.json' in plain.files, false);
  });
});
