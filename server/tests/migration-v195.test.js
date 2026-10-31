// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V195: the web search provider keys and tool files become the `websearch` installation. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  websearchFrom,
  migrateAppSearchTools
} from '../migrations/V195__web_search_installed_integration.js';

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

const providers = [
  { id: 'openai', name: 'OpenAI', apiKey: 'enc:openai' },
  { id: 'brave', name: 'Brave Search', category: 'websearch', enabled: true, apiKey: 'enc:brave' },
  { id: 'staan', name: 'Staan Search', category: 'websearch', enabled: true },
  { id: 'qwant', name: 'Qwant Search', category: 'websearch', enabled: true, requiresApiKey: false }
];

describe('V195 web search → installed integration', () => {
  it('declares its version', () => assert.equal(version, '195'));

  it('builds the installation and a credential per configured key', () => {
    const { instance, credentials } = websearchFrom(
      providers.filter(p => p.category === 'websearch')
    );
    assert.equal(instance.id, 'websearch');
    assert.equal(instance.definition, 'com.intrafind/web-search');
    assert.equal(instance.enabled, true);
    assert.equal(instance.values.defaultProvider, 'auto');
    assert.equal(instance.values.braveCredentialRef, 'integration-websearch-brave');
    assert.equal(instance.values.staanCredentialRef, undefined);
    assert.equal(credentials.length, 1);
    assert.deepEqual(credentials[0], {
      id: 'integration-websearch-brave',
      type: 'secret',
      name: 'Web search: Brave Search API key',
      description: 'Managed by the installed integration "websearch"',
      value: 'enc:brave'
    });
  });

  it('keeps an existing installation and only adds what is missing', () => {
    const existing = {
      id: 'websearch',
      definition: 'com.intrafind/web-search',
      enabled: false,
      values: { defaultProvider: 'qwant' },
      allowedGroups: ['staff']
    };
    const { instance, credentials } = websearchFrom(
      providers.filter(p => p.category === 'websearch'),
      existing
    );
    assert.equal(instance.enabled, false);
    assert.equal(instance.values.defaultProvider, 'qwant');
    assert.deepEqual(instance.allowedGroups, ['staff']);
    assert.equal(credentials.length, 1);
  });

  it('moves the keys, removes the provider entries and tool files, and cleans app tool references', async () => {
    const ctx = makeCtx({
      'config/providers.json': { providers: structuredClone(providers) },
      'config/integrations.json': { installed: [] },
      'config/credentials.json': { credentials: {} },
      'tools/braveSearch.json': { id: 'braveSearch' },
      'tools/read_url.json': { id: 'read_url' },
      'tools/jira.json': { id: 'jira' },
      'apps/chat.json': {
        id: 'chat',
        tools: ['braveSearch', 'read_url'],
        websearch: { enabled: true }
      },
      'apps/plain.json': { id: 'plain', tools: ['jira'] },
      'apps/reader.json': { id: 'reader', tools: ['read_url'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const integrations = ctx.files['config/integrations.json'];
    assert.equal(integrations.installed[0].id, 'websearch');
    assert.ok(integrations.installed[0].installedAt);
    assert.equal(
      ctx.files['config/credentials.json'].credentials['integration-websearch-brave'].value,
      'enc:brave'
    );
    assert.deepEqual(
      ctx.files['config/providers.json'].providers.map(p => p.id),
      ['openai']
    );
    assert.equal('tools/braveSearch.json' in ctx.files, false);
    assert.equal('tools/read_url.json' in ctx.files, false);
    assert.equal('tools/jira.json' in ctx.files, true);
    // The search tool reference goes (web search is already on); the page
    // reader reference stays, the tool loader serves it from the installation.
    assert.deepEqual(ctx.files['apps/chat.json'], {
      id: 'chat',
      tools: ['read_url'],
      websearch: { enabled: true }
    });
    assert.deepEqual(ctx.files['apps/plain.json'].tools, ['jira']);
    assert.deepEqual(ctx.files['apps/reader.json'], { id: 'reader', tools: ['read_url'] });
    assert.ok(
      ctx.logs.some(m => m.includes('apps/chat.json') && m.includes('websearch already enabled')),
      ctx.logs.join('\n')
    );
  });

  it('turns on app.websearch for an app that had web search only through a search tool reference', async () => {
    const ctx = makeCtx({
      'config/integrations.json': {
        installed: [
          {
            id: 'websearch',
            definition: 'com.intrafind/web-search',
            enabled: true,
            values: { defaultProvider: 'staan' }
          }
        ]
      },
      // The deep-researcher example's shape: no `websearch`, Brave in `tools`.
      'apps/deep-researcher.json': {
        id: 'deep-researcher',
        tools: ['researchPlanner', 'deepResearch', 'braveSearch']
      },
      // Several engines listed: the installation's default engine wins.
      'apps/multi.json': {
        id: 'multi',
        tools: ['qwantSearch', 'staanSearch'],
        websearch: { enabled: false, maxResults: 3 }
      },
      // Several engines listed, none of them the installation's default: the first listed wins.
      'apps/both.json': { id: 'both', tools: ['qwantSearch', 'braveSearch', 'read_url'] }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['apps/deep-researcher.json'], {
      id: 'deep-researcher',
      tools: ['researchPlanner', 'deepResearch'],
      websearch: { enabled: true, enabledByDefault: true, provider: 'brave' }
    });
    assert.deepEqual(ctx.files['apps/multi.json'], {
      id: 'multi',
      websearch: { enabled: true, enabledByDefault: true, provider: 'staan', maxResults: 3 }
    });
    assert.deepEqual(ctx.files['apps/both.json'], {
      id: 'both',
      tools: ['read_url'],
      websearch: { enabled: true, enabledByDefault: true, provider: 'qwant' }
    });
    assert.ok(
      ctx.logs.some(m => m.includes('apps/deep-researcher.json') && m.includes('provider "brave"')),
      ctx.logs.join('\n')
    );
  });

  it('migrateAppSearchTools: the first listed engine when the installation has no default', () => {
    const { app, provider } = migrateAppSearchTools(
      { id: 'a', tools: ['qwantSearch', 'braveSearch'] },
      'auto'
    );
    assert.equal(provider, 'qwant');
    assert.equal(app.websearch.provider, 'qwant');
    assert.equal(app.tools, undefined);
    assert.equal(migrateAppSearchTools({ id: 'a', tools: ['jira', 'read_url'] }), null);
    assert.equal(migrateAppSearchTools({ id: 'a' }), null);
  });

  it('is idempotent', async () => {
    const ctx = makeCtx({
      'config/providers.json': { providers: structuredClone(providers) },
      'config/integrations.json': { installed: [] },
      'config/credentials.json': { credentials: {} }
    });
    await up(ctx);
    await up(ctx);
    assert.equal(ctx.files['config/integrations.json'].installed.length, 1);
    assert.equal(Object.keys(ctx.files['config/credentials.json'].credentials).length, 1);
  });

  it('creates the installation on a fresh contents directory without provider entries', async () => {
    const ctx = makeCtx({
      'config/providers.json': { providers: [{ id: 'openai' }] },
      'apps/chat.json': { id: 'chat' }
    });
    await up(ctx);
    assert.equal(ctx.files['config/integrations.json'].installed[0].id, 'websearch');
    assert.equal('config/credentials.json' in ctx.files, false);
  });
});
