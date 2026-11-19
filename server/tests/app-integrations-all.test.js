// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "All integrations" (`app.integrations["*"]`, shared/appWildcards.js): binds
 * every installation that gives the model tools, the ones installed later
 * included, as the weakest binding; `exclude` leaves some out; it never hides
 * an app.
 *
 * Run: node --test server/tests/app-integrations-all.test.js
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import installedIntegrationService from '../services/integrations/InstalledIntegrationService.js';
import { publishDefinitionTypes } from '../services/integrations/integrationTypes.js';
import {
  appBindingFor,
  bindingKeyFor,
  boundInstanceIds,
  getIntegrationToolsForApp,
  isBoundToolEnabled
} from '../services/integrations/integrationTools.js';
import { missingAppIntegrations } from '../integrationRegistry.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { appCandidateRefs } from '../services/integrations/appIntegrationRefs.js';

const INSTALLED = [
  { id: 'drawio', definition: 'mcp/drawio', enabled: true },
  { id: 'jira', definition: 'com.intrafind/jira', enabled: true },
  { id: 'ifinder', definition: 'com.intrafind/ifinder', enabled: true },
  { id: 'x500', definition: 'com.intrafind/ldap-directory', enabled: true },
  { id: 'nextcloud', definition: 'com.intrafind/nextcloud', enabled: true },
  { id: 'searxng', definition: 'com.example/searxng', enabled: true },
  { id: 'brave', definition: 'com.intrafind/brave-search', enabled: true },
  { id: 'iassistant', definition: 'com.intrafind/iassistant', enabled: true },
  { id: 'off', definition: 'mcp/off', enabled: false }
];

const byId = new Map(INSTALLED.map(instance => [instance.id, instance]));
const user = { id: 'u1', permissions: { integrations: new Set(['*']) } };

/** A tool of an installation, as `discoverIntegrationTools` builds it. */
const toolOf = (instanceId, action = 'run') => ({
  id: `${instanceId}__${action}`,
  _integration: { instanceId, action }
});

before(() => {
  mock.method(installedIntegrationService, 'list', () => INSTALLED);
  mock.method(installedIntegrationService, 'get', id => byId.get(id) || null);
  publishDefinitionTypes([
    { definition: { id: 'com.intrafind/ldap-directory', type: 'people-directory' } },
    { definition: { id: 'com.intrafind/nextcloud', type: 'storage' } },
    { definition: { id: 'com.example/searxng', type: 'web-search' } }
  ]);
});

after(() => {
  mock.restoreAll();
  publishDefinitionTypes([]);
});

describe('bindingKeyFor with "*"', () => {
  const app = { integrations: { '*': {} } };

  it('binds every installation that gives the model tools', () => {
    for (const id of ['drawio', 'jira', 'ifinder', 'x500']) {
      assert.equal(bindingKeyFor(app, byId.get(id)), '*', id);
    }
  });

  it('leaves out storage, web search engines and iAssistant', () => {
    for (const id of ['nextcloud', 'searxng', 'brave', 'iassistant']) {
      assert.equal(bindingKeyFor(app, byId.get(id)), null, id);
    }
  });

  it('is the weakest binding', () => {
    const narrowed = {
      integrations: {
        '*': { enabledByDefault: false },
        jira: { actions: ['search'] },
        'type:people-directory': { required: false }
      }
    };
    assert.equal(bindingKeyFor(narrowed, byId.get('jira')), 'jira');
    assert.deepEqual(appBindingFor(narrowed, byId.get('jira')), { actions: ['search'] });
    assert.equal(bindingKeyFor(narrowed, byId.get('x500')), 'type:people-directory');
    assert.deepEqual(appBindingFor(narrowed, byId.get('drawio')), { enabledByDefault: false });
  });

  it('honours exclude by installation id, definition id and type key', () => {
    const excluding = (...exclude) => ({ integrations: { '*': { exclude } } });
    assert.equal(bindingKeyFor(excluding('jira'), byId.get('jira')), null);
    assert.equal(bindingKeyFor(excluding('mcp/drawio'), byId.get('drawio')), null);
    assert.equal(bindingKeyFor(excluding('type:people-directory'), byId.get('x500')), null);
    assert.equal(bindingKeyFor(excluding('jira'), byId.get('drawio')), '*');
    // A binding of its own wins over the exclusion.
    const own = { integrations: { '*': { exclude: ['jira'] }, jira: {} } };
    assert.equal(bindingKeyFor(own, byId.get('jira')), 'jira');
  });

  it('lists the installations it binds', () => {
    assert.deepEqual(boundInstanceIds(app).sort(), ['drawio', 'ifinder', 'jira', 'off', 'x500']);
  });
});

describe('the tools of an app with "*"', () => {
  const tools = ['drawio', 'jira', 'brave', 'off', 'iassistant'].map(id => toolOf(id));

  it('offers the tools of every enabled, granted installation it covers', () => {
    const app = { integrations: { '*': { exclude: ['jira'] } } };
    assert.deepEqual(
      getIntegrationToolsForApp(app, tools, { user }).map(tool => tool.id),
      ['drawio__run']
    );
    const nobody = { id: 'u2', permissions: { integrations: new Set() } };
    assert.deepEqual(getIntegrationToolsForApp(app, tools, { user: nobody }), []);
  });

  it('is one tool reference a chat can switch, and single installations stay switchable', () => {
    const app = { integrations: { '*': {} } };
    assert.deepEqual(appCandidateRefs(app), ['*']);
    assert.equal(isBoundToolEnabled(app, toolOf('drawio'), ['*']), true);
    // The chat switched "*" off and kept drawio by its own reference.
    assert.equal(isBoundToolEnabled(app, toolOf('drawio'), ['drawio']), true);
    assert.equal(isBoundToolEnabled(app, toolOf('jira'), ['drawio']), false);
  });
});

describe('"*" never hides an app', () => {
  it('is not a required binding', () => {
    const context = { installedIntegrations: [] };
    assert.deepEqual(missingAppIntegrations({ integrations: { '*': {} } }, context), []);
  });
});

describe('the app schema', () => {
  const base = {
    id: 'x',
    name: { en: 'x' },
    description: { en: 'x' },
    color: '#4F46E5',
    icon: 'chat'
  };
  const parse = integrations => appConfigSchema.safeParse({ ...base, integrations });

  it('accepts "*" with its settings', () => {
    const parsed = parse({
      '*': { enabledByDefault: false, alwaysLoaded: true, exclude: ['jira', 'type:storage'] },
      jira: { actions: ['search'] }
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(parsed.data.integrations['*'].exclude, ['jira', 'type:storage']);
  });

  it('refuses settings "*" cannot have', () => {
    for (const binding of [{ actions: [] }, { required: true }, { defaultScope: 'x' }]) {
      const parsed = parse({ '*': binding });
      assert.equal(parsed.success, false, JSON.stringify(binding));
    }
  });

  it('refuses exclude elsewhere and a malformed excluded key', () => {
    assert.equal(parse({ jira: { exclude: ['x'] } }).success, false);
    assert.equal(parse({ '*': { exclude: ['not a key'] } }).success, false);
  });

  it('still refuses other malformed keys', () => {
    assert.equal(parse({ '**': {} }).success, false);
    assert.equal(parse({ 'a b': {} }).success, false);
  });
});
