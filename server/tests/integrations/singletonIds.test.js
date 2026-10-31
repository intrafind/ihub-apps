// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../../configCache.js';
import { InstalledIntegrationService } from '../../services/integrations/InstalledIntegrationService.js';
import {
  getIFinderConfig,
  getIAssistantConfig,
  installedInstance,
  IFINDER_DEFINITION_ID
} from '../../services/integrations/ifinderConfig.js';
import iFinderService from '../../services/integrations/iFinderService.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import connector from '../../services/integrations/protocols/native/connectors/ifinder/index.js';

/**
 * A built-in's fixed instance id (`ifinder`, `iassistant`) belongs to that
 * built-in: no other definition may be installed under it, and the iFinder
 * and iAssistant settings are read only from an installation of their own
 * definition. The iFinder connection also feeds iAssistant and the exchanged
 * tokens, so a change to it resets those caches too.
 */

const singleton = {
  definition: {
    id: 'com.intrafind/ifinder',
    singleton: { instanceId: 'ifinder' },
    protocol: { type: 'native' }
  }
};
const portal = {
  definition: { id: 'org.ckan/portal', protocol: { type: 'openapi' }, install: [], actions: [] }
};
const fakeRegistry = {
  list: () => [singleton, portal],
  get: id => [singleton, portal].find(e => e.definition.id === id) || null,
  ensureLoaded: async () => {}
};

const originalGetIntegrations = configCache.getIntegrations;
afterEach(() => {
  configCache.getIntegrations = originalGetIntegrations;
  iFinderService.resetConfig();
  iAssistantService.resetConfig();
});

describe('built-in instance ids', () => {
  it('refuses another definition under an id a singleton claims', async () => {
    const service = new InstalledIntegrationService({ registry: fakeRegistry });
    await assert.rejects(
      service._prepare({ id: 'ifinder', definition: 'org.ckan/portal', enabled: true, values: {} }),
      error =>
        error.code === 'INVALID_ID' && /reserved for com\.intrafind\/ifinder/.test(error.message)
    );
  });

  it('reads the iFinder and iAssistant settings only from their own definition', () => {
    configCache.getIntegrations = () => ({
      data: {
        installed: [
          {
            id: 'ifinder',
            definition: 'org.ckan/portal',
            enabled: true,
            values: { baseUrl: 'https://elsewhere.example' }
          },
          { id: 'iassistant', definition: 'org.ckan/portal', enabled: true, values: {} }
        ]
      }
    });
    assert.equal(installedInstance('ifinder', IFINDER_DEFINITION_ID), null);
    assert.ok(installedInstance('ifinder'), 'without a definition id the lookup is by id only');
    assert.notEqual(getIFinderConfig().baseUrl, 'https://elsewhere.example');
    assert.equal(getIFinderConfig().enabled, false);
    assert.equal(getIAssistantConfig().enabled, false);
  });
});

describe('the iFinder connection', () => {
  it('resets the iAssistant settings when it changes', async () => {
    iAssistantService.config = { baseUrl: 'https://stale.example', enabled: true };
    connector.invalidate();
    assert.equal(iAssistantService.config, null, 'invalidate resets iAssistant');
    iAssistantService.config = { baseUrl: 'https://stale.example', enabled: true };
    await connector.onChanged({ before: null, after: null });
    assert.equal(iAssistantService.config, null, 'onChanged resets iAssistant');
  });
});
