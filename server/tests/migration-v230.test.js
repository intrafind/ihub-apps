#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V230 specs — workflow nodes, agent profiles and group grants stop
 * listing tools: bindings, platform tools and the web search switch replace
 * `tools`; unmapped references are reported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateDocument,
  migrateGroups,
  precondition,
  up,
  version
} from '../migrations/V230__tools_to_integrations_everywhere.js';

const INSTALLED = [
  { id: 'ihub', definition: 'com.intrafind/ihub' },
  { id: 'ifinder', definition: 'com.intrafind/ifinder' },
  { id: 'brave', definition: 'com.intrafind/brave-search' },
  { id: 'drawio', definition: 'mcp/drawio' }
];

function fakeCtx(files) {
  const logs = [];
  const warnings = [];
  return {
    files,
    logs,
    warnings,
    fileExists: async p => p in files || Object.keys(files).some(name => name.startsWith(`${p}/`)),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, data) => {
      files[p] = data;
    },
    listFiles: async dir =>
      Object.keys(files)
        .filter(name => name.startsWith(`${dir}/`) && !name.slice(dir.length + 1).includes('/'))
        .map(name => name.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

test('version', () => {
  assert.equal(version, '230');
});

test('a node splits its tools into bindings, platform tools and web search', () => {
  const workflow = {
    id: 'w',
    nodes: [
      {
        id: 'a',
        type: 'agent',
        config: { tools: ['braveSearch', 'read_url', 'webSearch', 'iFinder_search', 'evidence'] }
      }
    ]
  };
  const { changed, unmapped } = migrateDocument(workflow, INSTALLED);
  const config = workflow.nodes[0].config;
  assert.equal(changed, true);
  assert.deepEqual(unmapped, []);
  assert.equal('tools' in config, false);
  assert.deepEqual(config.integrations, {
    brave: { actions: ['search'] },
    ifinder: { actions: ['search'] }
  });
  assert.deepEqual(config.systemTools, ['read_url', 'evidence']);
  assert.equal(config.webSearch, true);
});

test('a planner task template and a profile’s embedded workflow are rewritten too', () => {
  const profile = {
    id: 'p',
    tools: ['drawio'],
    workflow: {
      definition: {
        nodes: [{ id: 'planner', config: { taskTemplate: { tools: ['braveSearch', 'read_url'] } } }]
      }
    }
  };
  const { changed } = migrateDocument(profile, INSTALLED);
  assert.equal(changed, true);
  assert.deepEqual(profile.integrations, { drawio: {} });
  assert.equal('tools' in profile, false);
  const template = profile.workflow.definition.nodes[0].config.taskTemplate;
  assert.deepEqual(template.integrations, { brave: { actions: ['search'] } });
  assert.deepEqual(template.systemTools, ['read_url']);
});

test('an empty tools list is removed and references that map nowhere are reported', () => {
  const empty = { nodes: [{ config: { tools: [] } }] };
  assert.equal(migrateDocument(empty, INSTALLED).changed, true);
  assert.equal('tools' in empty.nodes[0].config, false);
  const odd = { nodes: [{ config: { tools: ['nobody_knows', 'ask_user'] } }] };
  const { unmapped } = migrateDocument(odd, INSTALLED);
  assert.deepEqual(unmapped, ['nobody_knows']);
  assert.deepEqual(odd.nodes[0].config.integrations, { ihub: { actions: ['ask_user'] } });
});

test('a document without tools is untouched', () => {
  const doc = { nodes: [{ config: { integrations: { drawio: {} } } }] };
  assert.equal(migrateDocument(doc, INSTALLED).changed, false);
});

test('groups lose permissions.tools; no entry becomes an integration grant, each is reported', () => {
  const groups = {
    groups: {
      power: {
        permissions: { tools: ['iFinder', 'braveSearch', 'bogus', '*'], integrations: ['jira'] }
      },
      open: { permissions: { tools: ['iFinder'], integrations: ['*'] } },
      plain: { permissions: { apps: ['*'] } }
    }
  };
  const { changed, dropped } = migrateGroups(groups, INSTALLED);
  assert.equal(changed, true);
  // The group may use what it could use before, nothing more.
  assert.deepEqual(groups.groups.power.permissions.integrations, ['jira']);
  assert.deepEqual(groups.groups.open.permissions.integrations, ['*']);
  assert.equal('tools' in groups.groups.power.permissions, false);
  assert.deepEqual(dropped, [
    { group: 'power', ref: 'iFinder', installation: 'ifinder' },
    { group: 'power', ref: 'braveSearch', installation: 'brave' },
    { group: 'power', ref: 'bogus' },
    { group: 'power', ref: '*', all: true },
    { group: 'open', ref: 'iFinder', installation: 'ifinder' }
  ]);
  assert.equal('integrations' in groups.groups.plain.permissions, false);
});

test('a group without an integrations list does not gain one', () => {
  const groups = { groups: { g: { permissions: { tools: ['jira'] } } } };
  migrateGroups(groups, INSTALLED);
  assert.equal('integrations' in groups.groups.g.permissions, false);
});

test('loop bodies kept inline are rewritten too', () => {
  const doc = {
    id: 'w',
    nodes: [
      {
        id: 'loop',
        type: 'loop',
        config: {
          body: [
            { id: 'inner', type: 'prompt', config: { tools: ['iFinder_search', 'webSearch'] } },
            {
              id: 'deeper',
              type: 'loop',
              config: { body: [{ id: 'x', config: { tools: ['read_url'] } }] }
            }
          ]
        }
      }
    ]
  };
  const { changed, unmapped } = migrateDocument(doc, INSTALLED);
  assert.equal(changed, true);
  assert.deepEqual(unmapped, []);
  const [inner, deeper] = doc.nodes[0].config.body;
  assert.equal('tools' in inner.config, false);
  assert.equal(inner.config.webSearch, true);
  assert.deepEqual(inner.config.integrations.ifinder.actions, ['search']);
  assert.deepEqual(deeper.config.body[0].config.systemTools, ['read_url']);
});

test('up rewrites workflows, profiles and groups and reports leftover tool files', async () => {
  const ctx = fakeCtx({
    'config/integrations.json': { installed: INSTALLED },
    'workflows/w.json': { id: 'w', nodes: [{ id: 'n', config: { tools: ['webSearch'] } }] },
    'agents/profiles/p.json': { id: 'p', tools: ['bogus'] },
    'config/groups.json': { groups: { g: { permissions: { tools: ['drawio'] } } } },
    'tools/custom.json': { id: 'custom' }
  });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.equal(ctx.files['workflows/w.json'].nodes[0].config.webSearch, true);
  assert.equal('tools' in ctx.files['agents/profiles/p.json'], false);
  assert.equal('integrations' in ctx.files['config/groups.json'].groups.g.permissions, false);
  assert.equal(ctx.warnings.length, 3);
  assert.ok(ctx.warnings.some(w => /agents\/profiles\/p\.json.*"bogus"/.test(w)));
  assert.ok(ctx.warnings.some(w => /group "g".*"drawio"/.test(w)));
  assert.ok(ctx.warnings.some(w => /tools\/custom\.json/.test(w)));
});

test('a disabled read_url tool file keeps the page reader off through the platform setting', async () => {
  const ctx = fakeCtx({
    'config/integrations.json': { installed: INSTALLED },
    'config/platform.json': { defaultLanguage: 'en', webSearch: { other: 1 } },
    'tools/read_url.json': { id: 'read_url', enabled: false }
  });
  await up(ctx);
  assert.deepEqual(ctx.files['config/platform.json'].webSearch, { other: 1, pageReader: false });
  assert.equal(ctx.files['config/platform.json'].defaultLanguage, 'en');
});

test('an enabled or missing read_url tool file leaves the platform setting alone', async () => {
  const ctx = fakeCtx({
    'config/integrations.json': { installed: INSTALLED },
    'config/platform.json': { defaultLanguage: 'en' },
    'tools/read_url.json': { id: 'read_url' }
  });
  await up(ctx);
  assert.equal('webSearch' in ctx.files['config/platform.json'], false);
});
