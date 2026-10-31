// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `requiredIntegrations` on an app: users do not get it while the integration
 * is off; and finishing the iFinder setup enables the iAssistant model once.
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
  isIntegrationEnabled,
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
  { id: 'ifinder-search', enabled: true, requiredIntegrations: ['ifinder'] },
  { id: 'people-directory', enabled: true, requiredIntegrations: ['peopleDirectories'] },
  // Binds an installed integration (#3061): offered only while it is installed and on.
  { id: 'open-data', enabled: true, integrations: { 'open-data-portal': {} } }
];

describe('areAppIntegrationsEnabled', () => {
  const app = { id: 'x', requiredIntegrations: ['ifinder'] };

  it('is true for an app that requires nothing', () => {
    assert.equal(areAppIntegrationsEnabled({ id: 'chat' }, {}), true);
  });

  it('follows platform.iFinder.enabled', () => {
    assert.equal(
      areAppIntegrationsEnabled(app, { platform: { iFinder: { enabled: true } } }),
      true
    );
    assert.equal(
      areAppIntegrationsEnabled(app, { platform: { iFinder: { enabled: false } } }),
      false
    );
    assert.equal(areAppIntegrationsEnabled(app, {}), false);
  });

  it('counts people directories as on with one enabled directory', () => {
    const on = id => isIntegrationEnabled('peopleDirectories', { peopleDirectories: id });
    assert.equal(on({ directories: [{ id: 'a' }] }), true);
    assert.equal(on({ directories: [{ id: 'a', enabled: false }, { id: 'b' }] }), true);
    assert.equal(on({ directories: [{ id: 'a', enabled: false }] }), false);
    assert.equal(on({ directories: [] }), false);
    assert.equal(on(undefined), false);
  });

  it('reports every integration', () => {
    assert.deepEqual(getIntegrationStatus({}), { ifinder: false, peopleDirectories: false });
    assert.deepEqual(
      getIntegrationStatus({
        platform: { iFinder: { enabled: true } },
        peopleDirectories: { directories: [{ id: 'a' }] }
      }),
      { ifinder: true, peopleDirectories: true }
    );
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

  it('treats the ifinder and iassistant bindings as the iFinder connection', () => {
    const scoped = {
      id: 'x',
      integrations: { ifinder: { defaultScope: 'contracts' }, iassistant: {} }
    };
    assert.deepEqual(
      missingAppIntegrations(scoped, { platform: { iFinder: { enabled: false } } }),
      ['ifinder', 'iassistant']
    );
    assert.deepEqual(
      missingAppIntegrations(scoped, { platform: { iFinder: { enabled: true } } }),
      []
    );
    // A requirement and a binding of the same thing are reported once.
    const both = { id: 'y', requiredIntegrations: ['ifinder'], integrations: { ifinder: {} } };
    assert.deepEqual(missingAppIntegrations(both, {}), ['ifinder']);
  });

  it('reports installed integrations by instance id', () => {
    const status = getIntegrationStatus({
      platform: { iFinder: { enabled: true } },
      installedIntegrations: [{ id: 'open-data-portal' }, { id: 'archive', enabled: false }]
    });
    assert.equal(status.ifinder, true);
    assert.equal(status['open-data-portal'], true);
    assert.equal(status.archive, false);
  });

  it('counts an unknown integration as off', () => {
    assert.equal(areAppIntegrationsEnabled({ requiredIntegrations: ['nope'] }, {}), false);
  });

  it('is validated in the app schema, and the shipped iFinder apps use it', async () => {
    const shipped = {
      iassistant: 'ifinder',
      'ifinder-search': 'ifinder',
      'people-directory': 'peopleDirectories'
    };
    for (const [id, integration] of Object.entries(shipped)) {
      const app = JSON.parse(await fs.readFile(path.join(APPS_DIR, `${id}.json`), 'utf8'));
      assert.deepEqual(app.requiredIntegrations, [integration]);
      assert.equal(app.enabled, true);
      const parsed = appConfigSchema.safeParse(app);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
      const typo = appConfigSchema.safeParse({ ...app, requiredIntegrations: ['ifindr'] });
      assert.equal(typo.success, false);
    }
  });

  it('no longer ships the retired document actions app', async () => {
    await assert.rejects(fs.access(path.join(APPS_DIR, 'ifinder-document-actions.json')));
  });
});

describe('configCache.getApps with requiredIntegrations', () => {
  beforeEach(() => mock.restoreAll());

  function serve(platform, peopleDirectories = { directories: [] }, installed = []) {
    mock.method(configCache, 'get', key => {
      if (key === 'config/apps.json') return { data: APPS, etag: '"apps-etag"' };
      if (key === 'config/platform.json') return { data: platform };
      if (key === 'config/peopleDirectories.json') return { data: peopleDirectories };
      if (key === 'config/integrations.json') return { data: { installed } };
      return null;
    });
    mock.method(configCache, 'getFeatures', () => ({}));
  }

  it('hides the app, with a new ETag, while the integration is off', () => {
    serve({ iFinder: { enabled: false } });
    const off = configCache.getApps();
    assert.deepEqual(
      off.data.map(a => a.id),
      ['chat']
    );
    serve({ iFinder: { enabled: true } });
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

  it('still lists it for admins', () => {
    serve({ iFinder: { enabled: false } });
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
