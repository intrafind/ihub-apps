#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V229 specs — an app's `tools` become bindings under `integrations`;
 * a tool that maps to no installation is reported, not silently dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateApp,
  precondition,
  resolveReference,
  up,
  version
} from '../migrations/V229__app_tools_to_integration_bindings.js';

const INSTALLED = [
  { id: 'ihub', definition: 'com.intrafind/ihub' },
  { id: 'ifinder', definition: 'com.intrafind/ifinder' },
  { id: 'jira', definition: 'com.intrafind/jira' },
  { id: 'brave', definition: 'com.intrafind/brave-search' },
  { id: 'drawio', definition: 'mcp/drawio' },
  { id: 'langdock', definition: 'com.intrafind/a2a-agent' },
  { id: 'hr-directory', definition: 'com.intrafind/ldap-directory' }
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
        .filter(name => name.startsWith(`${dir}/`))
        .map(name => name.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

test('version', () => {
  assert.equal(version, '229');
});

test('iHub tools become actions of the ihub binding', () => {
  const { app, unmapped } = migrateApp(
    { id: 'a', tools: ['ask_user', 'schedule_task'] },
    INSTALLED
  );
  assert.deepEqual(app.integrations, {
    ihub: { actions: ['ask_user', 'schedule_task'], required: false }
  });
  assert.equal('tools' in app, false);
  assert.deepEqual(unmapped, []);
});

test('a base id binds the installation with every action', () => {
  const { app } = migrateApp({ id: 'a', tools: ['iFinder', 'jira'] }, INSTALLED);
  assert.deepEqual(app.integrations, { ifinder: { required: false }, jira: { required: false } });
});

test('kept tool ids of one installation become its action list', () => {
  const { app } = migrateApp(
    { id: 'a', tools: ['iFinder_search', 'iFinder_getContent'] },
    INSTALLED
  );
  assert.deepEqual(app.integrations, {
    ifinder: { actions: ['search', 'getContent'], required: false }
  });
});

test('a web search engine tool id binds the engine with its search action', () => {
  const { app } = migrateApp({ id: 'a', tools: ['braveSearch'] }, INSTALLED);
  assert.deepEqual(app.integrations, { brave: { actions: ['search'], required: false } });
});

test('installation ids, MCP tools, A2A agents and directories bind their installation', () => {
  const { app } = migrateApp(
    { id: 'a', tools: ['drawio', 'a2a__langdock', 'hr-directory__search_people'] },
    INSTALLED
  );
  assert.deepEqual(app.integrations, {
    drawio: { required: false },
    langdock: { required: false },
    'hr-directory': { actions: ['search_people'], required: false }
  });
});

test('references that map to no installation are reported and removed', () => {
  const { app, unmapped } = migrateApp(
    { id: 'a', tools: ['read_url', 'write_memory', 'ask_user'] },
    INSTALLED
  );
  assert.deepEqual(unmapped, ['read_url', 'write_memory']);
  assert.deepEqual(app.integrations, { ihub: { actions: ['ask_user'], required: false } });
  assert.equal('tools' in app, false);
});

test('an existing binding keeps its settings; a binding without a list keeps every action', () => {
  const { app } = migrateApp(
    {
      id: 'a',
      tools: ['iFinder_search', 'jira_getTicket'],
      integrations: {
        ifinder: { actions: ['getContent'], enabledByDefault: false },
        jira: {}
      }
    },
    INSTALLED
  );
  assert.deepEqual(app.integrations.ifinder, {
    actions: ['getContent', 'search'],
    enabledByDefault: false
  });
  assert.deepEqual(app.integrations.jira, {});
});

test('a binding the migration adds is optional; an existing one keeps its own `required`', () => {
  const { app } = migrateApp(
    {
      id: 'a',
      tools: ['jira_getTicket', 'iFinder_search'],
      integrations: { ifinder: { required: true } }
    },
    INSTALLED
  );
  assert.equal(app.integrations.jira.required, false);
  assert.equal(app.integrations.ifinder.required, true);
});

test('Entra tool ids map to the entra installation', () => {
  const installed = [...INSTALLED, { id: 'entra', definition: 'com.intrafind/entra-directory' }];
  assert.deepEqual(resolveReference('entraPeopleSearch', installed), {
    instanceId: 'entra',
    actions: 'all'
  });
  assert.deepEqual(resolveReference('entraPeopleSearch_findUser', installed), {
    instanceId: 'entra',
    actions: ['findUser']
  });
  assert.equal(resolveReference('entraPeopleSearch_nope', installed), null);
});

test('an empty tools list is removed and nothing is bound', () => {
  const { app, unmapped } = migrateApp({ id: 'a', tools: [] }, INSTALLED);
  assert.equal('tools' in app, false);
  assert.equal('integrations' in app, false);
  assert.deepEqual(unmapped, []);
});

test('tools leaves overriddenFields of an inheriting app', () => {
  const { app } = migrateApp(
    { id: 'a', tools: [], overriddenFields: ['system', 'tools'] },
    INSTALLED
  );
  assert.deepEqual(app.overriddenFields, ['system']);
});

test('an app without tools is untouched', () => {
  const original = { id: 'a', integrations: { jira: {} } };
  const { app } = migrateApp(original, INSTALLED);
  assert.equal(app, original);
});

test('the longest installation id owns a prefixed tool', () => {
  const installed = [{ id: 'a' }, { id: 'a-b' }];
  assert.deepEqual(resolveReference('a-b__x', installed), { instanceId: 'a-b', actions: ['x'] });
});

test('up rewrites the app files and warns about the unmapped tools', async () => {
  const ctx = fakeCtx({
    'config/integrations.json': { installed: INSTALLED },
    'apps/one.json': { id: 'one', tools: ['ask_user', 'read_url'] },
    'apps/two.json': { id: 'two', integrations: { jira: {} } }
  });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.deepEqual(ctx.files['apps/one.json'], {
    id: 'one',
    integrations: { ihub: { actions: ['ask_user'], required: false } }
  });
  assert.deepEqual(ctx.files['apps/two.json'], { id: 'two', integrations: { jira: {} } });
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /apps\/one\.json.*"read_url"/);
});

test('up without installed integrations reports every reference', async () => {
  const ctx = fakeCtx({ 'apps/one.json': { id: 'one', tools: ['ask_user'] } });
  await up(ctx);
  assert.equal('tools' in ctx.files['apps/one.json'], false);
  assert.equal(ctx.warnings.length, 1);
});
