// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An app's integration bindings: users do not get the app while a required
 * installation (or, for a definition binding, every installation of the
 * definition) is off; `requiredIntegrations` is retired; and finishing the
 * iFinder setup enables the iAssistant model once.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import configCache from '../configCache.js';
import configStore from '../services/config/ConfigStore.js';
import {
  areAppIntegrationsEnabled,
  getIntegrationStatus,
  isDefinitionBinding,
  missingAppIntegrations
} from '../integrationRegistry.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import {
  enableAssistantModelOnIFinderSetup,
  isIFinderConfigured
} from '../services/integrations/iAssistantModelActivation.js';

const APPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../defaults/apps');

const APPS = [
  { id: 'chat', enabled: true },
  // Binds the built-in iFinder installation (V192).
  { id: 'ifinder-search', enabled: true, integrations: { ifinder: {} } },
  // Binds every installation of a definition (V198): offered while one is on.
  { id: 'people-directory', enabled: true, integrations: { 'com.intrafind/ldap-directory': {} } },
  // Binds an installed integration (#3061): offered only while it is installed and on.
  { id: 'open-data', enabled: true, integrations: { 'open-data-portal': {} } }
];

describe('areAppIntegrationsEnabled', () => {
  it('is true for an app that requires nothing', () => {
    assert.equal(areAppIntegrationsEnabled({ id: 'chat' }, {}), true);
  });

  it('stays available without the websearch installation unless web search is required', () => {
    // Web search is an enhancement for most apps: on by itself it never hides the app.
    const optional = { id: 'web', websearch: { enabled: true } };
    assert.equal(areAppIntegrationsEnabled(optional, { installedIntegrations: [] }), true);
    assert.deepEqual(
      missingAppIntegrations(optional, {
        installedIntegrations: [{ id: 'websearch', enabled: false }]
      }),
      []
    );
    const app = { id: 'web', websearch: { enabled: true, required: true } };
    assert.equal(areAppIntegrationsEnabled(app, { installedIntegrations: [] }), false);
    assert.equal(
      areAppIntegrationsEnabled(app, {
        installedIntegrations: [{ id: 'websearch', enabled: false }]
      }),
      false
    );
    assert.equal(
      areAppIntegrationsEnabled(app, { installedIntegrations: [{ id: 'websearch' }] }),
      true
    );
    assert.equal(
      areAppIntegrationsEnabled(
        { id: 'plain', websearch: { enabled: false } },
        { installedIntegrations: [] }
      ),
      true
    );
  });

  it('follows the ifinder installation', () => {
    const bound = { id: 'x', integrations: { ifinder: {} } };
    assert.equal(areAppIntegrationsEnabled(bound, {}), false);
    assert.equal(
      areAppIntegrationsEnabled(bound, {
        installedIntegrations: [{ id: 'ifinder', enabled: false }]
      }),
      false
    );
    assert.equal(
      areAppIntegrationsEnabled(bound, { installedIntegrations: [{ id: 'ifinder' }] }),
      true
    );
  });

  it('counts a definition binding as on with one enabled installation of it', () => {
    const app = { id: 'people', integrations: { 'com.intrafind/ldap-directory': {} } };
    const ldap = (id, enabled = true) => ({
      id,
      definition: 'com.intrafind/ldap-directory',
      enabled
    });
    assert.deepEqual(missingAppIntegrations(app, {}), ['com.intrafind/ldap-directory']);
    assert.deepEqual(
      missingAppIntegrations(app, { installedIntegrations: [ldap('corp', false)] }),
      ['com.intrafind/ldap-directory']
    );
    assert.deepEqual(
      missingAppIntegrations(app, {
        installedIntegrations: [ldap('corp', false), ldap('x500bund')]
      }),
      []
    );
    // An installation id wins over a definition id when both could match.
    assert.equal(
      isDefinitionBinding('com.intrafind/ldap-directory', {
        installedIntegrations: [ldap('corp')]
      }),
      true
    );
    assert.equal(isDefinitionBinding('corp', { installedIntegrations: [ldap('corp')] }), false);
    assert.equal(isDefinitionBinding('nope', { installedIntegrations: [ldap('corp')] }), false);
    // Optional definition bindings never hide the app.
    const optional = {
      id: 'p',
      integrations: { 'com.intrafind/ldap-directory': { required: false } }
    };
    assert.deepEqual(missingAppIntegrations(optional, {}), []);
  });

  it('reports every installation and every installed definition', () => {
    const status = getIntegrationStatus({
      installedIntegrations: [
        { id: 'ifinder', definition: 'com.intrafind/ifinder' },
        { id: 'iassistant', definition: 'com.intrafind/iassistant', enabled: false },
        { id: 'corp', definition: 'com.intrafind/ldap-directory', enabled: false },
        { id: 'x500bund', definition: 'com.intrafind/ldap-directory' }
      ]
    });
    assert.deepEqual(status, {
      'com.intrafind/ifinder': true,
      'com.intrafind/iassistant': false,
      'com.intrafind/ldap-directory': true,
      ifinder: true,
      iassistant: false,
      corp: false,
      x500bund: true
    });
  });

  it('requires every installation an app binds to exist and be enabled', () => {
    const bound = {
      id: 'open-data',
      integrations: { 'open-data-portal': { actions: ['search'] } }
    };
    assert.deepEqual(missingAppIntegrations(bound, {}), ['open-data-portal']);
    assert.deepEqual(
      missingAppIntegrations(bound, {
        installedIntegrations: [{ id: 'open-data-portal', enabled: false }]
      }),
      ['open-data-portal']
    );
    assert.deepEqual(
      missingAppIntegrations(bound, { installedIntegrations: [{ id: 'open-data-portal' }] }),
      []
    );
    assert.equal(
      areAppIntegrationsEnabled(bound, { installedIntegrations: [{ id: 'open-data-portal' }] }),
      true
    );
  });

  it('skips a binding marked optional and the connection it would pull in', () => {
    const optional = {
      id: 'assistant',
      integrations: { 'open-data-portal': { required: false }, ifinder: {} }
    };
    // Only the required binding counts; the optional one neither hides nor is listed.
    assert.deepEqual(missingAppIntegrations(optional, {}), ['ifinder']);
    assert.equal(
      areAppIntegrationsEnabled(optional, { installedIntegrations: [{ id: 'ifinder' }] }),
      true
    );
    // An optional iAssistant binding does not require the iFinder connection either.
    const assistant = { id: 'a', integrations: { iassistant: { actions: [], required: false } } };
    assert.deepEqual(missingAppIntegrations(assistant, {}), []);
    const requiredAssistant = { id: 'a', integrations: { iassistant: { actions: [] } } };
    assert.deepEqual(missingAppIntegrations(requiredAssistant, {}), ['iassistant', 'ifinder']);
  });

  it('accepts `required` on a binding and on web search', () => {
    const base = { name: { en: 'x' }, description: { en: 'x' }, color: '#4F46E5', icon: 'chat' };
    const parsed = appConfigSchema.safeParse({
      ...base,
      id: 'x',
      integrations: { 'open-data-portal': { required: false }, ifinder: { required: true } },
      websearch: { enabled: true, required: true }
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.integrations['open-data-portal'].required, false);
    assert.equal(parsed.data.websearch.required, true);
    // Absent means optional for web search and required for a binding.
    const defaults = appConfigSchema.safeParse({ ...base, id: 'y', websearch: { enabled: true } });
    assert.equal(defaults.data.websearch.required, false);
  });

  it('reports each binding once, in order', () => {
    const both = {
      id: 'y',
      integrations: { 'com.intrafind/ldap-directory': {}, ifinder: {} }
    };
    assert.deepEqual(missingAppIntegrations(both, {}), ['com.intrafind/ldap-directory', 'ifinder']);
    const scoped = {
      id: 'x',
      integrations: { ifinder: { defaultScope: 'contracts' }, iassistant: {} }
    };
    assert.deepEqual(missingAppIntegrations(scoped, {}), ['ifinder', 'iassistant']);
    assert.deepEqual(
      missingAppIntegrations(scoped, {
        installedIntegrations: [{ id: 'ifinder' }, { id: 'iassistant' }]
      }),
      []
    );
  });

  it('keeps an iAssistant app off while the iFinder installation it runs on is off', () => {
    const app = { id: 'iassistant', integrations: { iassistant: { actions: [] } } };
    // The iassistant installation is on, its connection (ifinder) is not.
    assert.deepEqual(
      missingAppIntegrations(app, {
        installedIntegrations: [{ id: 'iassistant' }, { id: 'ifinder', enabled: false }]
      }),
      ['ifinder']
    );
    assert.deepEqual(
      missingAppIntegrations(app, { installedIntegrations: [{ id: 'iassistant' }] }),
      ['ifinder']
    );
    assert.deepEqual(
      missingAppIntegrations(app, {
        installedIntegrations: [{ id: 'iassistant' }, { id: 'ifinder' }]
      }),
      []
    );
    // Both off: each is reported once.
    assert.deepEqual(missingAppIntegrations(app, {}), ['iassistant', 'ifinder']);
    // The connection the installation names is the one that has to be on.
    assert.deepEqual(
      missingAppIntegrations(app, {
        installedIntegrations: [
          { id: 'iassistant', values: { connection: 'ifinder-prod' } },
          { id: 'ifinder', enabled: false },
          { id: 'ifinder-prod' }
        ]
      }),
      []
    );
  });

  it('reports installed integrations by instance id', () => {
    const status = getIntegrationStatus({
      installedIntegrations: [{ id: 'open-data-portal' }, { id: 'archive', enabled: false }]
    });
    assert.equal(status['open-data-portal'], true);
    assert.equal(status.archive, false);
  });

  it('counts an unknown integration as off', () => {
    assert.equal(areAppIntegrationsEnabled({ integrations: { nope: {} } }, {}), false);
  });

  it('is validated in the app schema, and the shipped apps bind their integrations', async () => {
    const shipped = {
      iassistant: { integrations: { iassistant: { actions: [] } } },
      'ifinder-search': { integrations: { ifinder: { scopePicker: 'menu' } } },
      'people-directory': { integrations: { 'com.intrafind/ldap-directory': {} } },
      'ldap-browser': {
        integrations: {
          'com.intrafind/ldap-directory': {
            actions: ['browse_search', 'browse_read', 'browse_children']
          }
        }
      }
    };
    for (const [id, expected] of Object.entries(shipped)) {
      const app = JSON.parse(await fs.readFile(path.join(APPS_DIR, `${id}.json`), 'utf8'));
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(app[key], value);
      // The LDAP browser ships disabled (raw entries, admins only).
      assert.equal(app.enabled, id !== 'ldap-browser');
      assert.equal('requiredIntegrations' in app, false);
      assert.equal(
        (app.tools || []).some(t => String(t).startsWith('iFinder')),
        false,
        'iFinder tools come through the binding'
      );
      const parsed = appConfigSchema.safeParse(app);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    }
    // `requiredIntegrations` is retired (V198): a non-empty list is rejected.
    for (const id of ['ifindr', 'ifinder', 'peopleDirectories']) {
      assert.equal(
        appConfigSchema.safeParse({ id: 'x', requiredIntegrations: [id] }).success,
        false
      );
    }
    // A definition id (with its one "/") is a valid binding key.
    const base = { name: { en: 'x' }, description: { en: 'x' }, color: '#4F46E5', icon: 'chat' };
    const definitionBinding = appConfigSchema.safeParse({
      ...base,
      id: 'x',
      integrations: { 'com.intrafind/ldap-directory': { actions: ['search_people'] } }
    });
    assert.equal(definitionBinding.success, true, JSON.stringify(definitionBinding.error?.issues));
    assert.equal(
      appConfigSchema.safeParse({ ...base, id: 'x', integrations: { 'a/b/c': {} } }).success,
      false
    );
  });

  it('no longer ships the retired document actions app', async () => {
    await assert.rejects(fs.access(path.join(APPS_DIR, 'ifinder-document-actions.json')));
  });
});

describe('configCache.getApps with integration bindings', () => {
  beforeEach(() => mock.restoreAll());

  function serve(platform, _unused, installed = []) {
    mock.method(configCache, 'get', key => {
      if (key === 'config/apps.json') return { data: APPS, etag: '"apps-etag"' };
      if (key === 'config/platform.json') return { data: platform };
      if (key === 'config/integrations.json') return { data: { installed } };
      return null;
    });
    mock.method(configCache, 'getFeatures', () => ({}));
  }

  it('hides the app, with a new ETag, while the integration is off', () => {
    serve({}, undefined, [{ id: 'ifinder', enabled: false }]);
    const off = configCache.getApps();
    assert.deepEqual(
      off.data.map(a => a.id),
      ['chat']
    );
    serve({}, undefined, [{ id: 'ifinder' }]);
    const on = configCache.getApps();
    assert.deepEqual(
      on.data.map(a => a.id),
      ['chat', 'ifinder-search']
    );
    assert.notEqual(off.etag, on.etag);
  });

  it('hides an app whose bound installation is missing or disabled', () => {
    serve({ iFinder: { enabled: true } });
    assert.equal(
      configCache.getApps().data.some(a => a.id === 'open-data'),
      false
    );
    serve({ iFinder: { enabled: true } }, undefined, [{ id: 'open-data-portal', enabled: false }]);
    assert.equal(
      configCache.getApps().data.some(a => a.id === 'open-data'),
      false
    );
    serve({ iFinder: { enabled: true } }, undefined, [{ id: 'open-data-portal' }]);
    assert.equal(
      configCache.getApps().data.some(a => a.id === 'open-data'),
      true
    );
  });

  it('offers an app bound to a definition once one of its installations is on', () => {
    serve({}, undefined, [
      { id: 'corp', definition: 'com.intrafind/ldap-directory', enabled: false }
    ]);
    assert.equal(
      configCache.getApps().data.some(a => a.id === 'people-directory'),
      false
    );
    serve({}, undefined, [
      { id: 'corp', definition: 'com.intrafind/ldap-directory', enabled: false },
      { id: 'x500bund', definition: 'com.intrafind/ldap-directory' }
    ]);
    assert.equal(
      configCache.getApps().data.some(a => a.id === 'people-directory'),
      true
    );
  });

  it('still lists it for admins', () => {
    serve({}, undefined, [{ id: 'ifinder', enabled: false }]);
    assert.equal(configCache.getApps(true).data.length, APPS.length);
  });
});

describe('enableAssistantModelOnIFinderSetup', () => {
  const configured = { enabled: true, baseUrl: 'https://ifinder.example.com' };
  let writes;

  beforeEach(() => {
    mock.restoreAll();
    writes = [];
    mock.method(configStore, 'resolveIdToPath', async (_t, id) => `models/${id}.json`);
    mock.method(configStore, 'writeJson', async (p, d) => writes.push([p, d]));
    mock.method(configCache, 'refreshModelsCache', async () => {});
  });

  function serveModel(model) {
    mock.method(configCache, 'getModels', () => ({ data: model ? [model] : [], etag: null }));
  }

  it('needs the integration on and a base URL', () => {
    assert.equal(isIFinderConfigured(configured), true);
    assert.equal(isIFinderConfigured({ enabled: true, baseUrl: ' ' }), false);
    assert.equal(isIFinderConfigured({ enabled: false, baseUrl: 'https://x' }), false);
  });

  it('enables the disabled model when the setup completes', async () => {
    serveModel({ id: 'iassistant-conversation', enabled: false });
    assert.equal(await enableAssistantModelOnIFinderSetup({ enabled: false }, configured), true);
    assert.equal(writes[0][1].enabled, true);
  });

  it('does nothing on an unrelated save of an already configured integration', async () => {
    serveModel({ id: 'iassistant-conversation', enabled: false });
    assert.equal(await enableAssistantModelOnIFinderSetup(configured, configured), false);
    assert.equal(writes.length, 0);
  });

  it('does nothing while the setup is incomplete, or without the model', async () => {
    serveModel({ id: 'iassistant-conversation', enabled: false });
    assert.equal(
      await enableAssistantModelOnIFinderSetup({}, { enabled: true, baseUrl: '' }),
      false
    );
    serveModel(null);
    assert.equal(await enableAssistantModelOnIFinderSetup({}, configured), false);
    assert.equal(writes.length, 0);
  });
});
