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
import { areAppIntegrationsEnabled } from '../integrationRegistry.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import {
  enableAssistantModelOnIFinderSetup,
  isIFinderConfigured
} from '../services/integrations/iAssistantModelActivation.js';

const APPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../defaults/apps');

const APPS = [
  { id: 'chat', enabled: true },
  { id: 'ifinder-search', enabled: true, requiredIntegrations: ['ifinder'] }
];

describe('areAppIntegrationsEnabled', () => {
  const app = { id: 'x', requiredIntegrations: ['ifinder'] };

  it('is true for an app that requires nothing', () => {
    assert.equal(areAppIntegrationsEnabled({ id: 'chat' }, {}), true);
  });

  it('follows platform.iFinder.enabled', () => {
    assert.equal(areAppIntegrationsEnabled(app, { iFinder: { enabled: true } }), true);
    assert.equal(areAppIntegrationsEnabled(app, { iFinder: { enabled: false } }), false);
    assert.equal(areAppIntegrationsEnabled(app, {}), false);
  });

  it('counts an unknown integration as off', () => {
    assert.equal(areAppIntegrationsEnabled({ requiredIntegrations: ['nope'] }, {}), false);
  });

  it('is validated in the app schema, and the shipped iFinder apps use it', async () => {
    for (const id of ['iassistant', 'ifinder-search']) {
      const app = JSON.parse(await fs.readFile(path.join(APPS_DIR, `${id}.json`), 'utf8'));
      assert.deepEqual(app.requiredIntegrations, ['ifinder']);
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

  function serve(platform) {
    mock.method(configCache, 'get', key => {
      if (key === 'config/apps.json') return { data: APPS, etag: '"apps-etag"' };
      if (key === 'config/platform.json') return { data: platform };
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

  it('still lists it for admins', () => {
    serve({ iFinder: { enabled: false } });
    assert.equal(configCache.getApps(true).data.length, 2);
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
