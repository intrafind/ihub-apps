// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The environment of a new installation becomes its configuration the way the
 * migrations V075, V192, V197, V204 and V050/V193 made it, now that a fresh
 * install runs no migration. The expected installations are what those
 * migrations, and the ones after them, wrote on a fresh install with the same
 * variables set.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFirstStartEnvironment,
  importEnvironmentOnFirstStart
} from '../utils/firstStartEnvironment.js';
import { copyDefaultConfiguration } from '../utils/setupUtils.js';

const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');
const NOW = '2026-01-01T00:00:00.000Z';
const BASE = {
  definitionVersion: '1.0.0',
  auth: { mode: 'none' },
  actions: { enabled: ['*'], disabled: [], overrides: {} },
  installedAt: NOW,
  updatedAt: NOW
};

async function readDefault(rel) {
  return JSON.parse(await fs.readFile(path.join(DEFAULTS_DIR, rel), 'utf8'));
}

async function freshConfig() {
  return {
    platform: await readDefault('config/platform.json'),
    integrations: await readDefault('config/integrations.json')
  };
}

const byId = (config, id) => config.integrations.installed.find(entry => entry.id === id);

describe('applyFirstStartEnvironment', () => {
  it('changes nothing without the variables', async () => {
    const config = await freshConfig();
    const before = structuredClone(config);
    const changed = applyFirstStartEnvironment(config, {}, NOW);
    assert.deepEqual(changed, { platform: false, integrations: false, applied: [] });
    assert.deepEqual(config, before);
  });

  it('the defaults ship the setup wizard as not done, and a disabled Entra installation', async () => {
    const config = await freshConfig();
    assert.equal(config.platform.setup.configured, false);
    assert.equal(byId(config, 'entra').enabled, false);
  });

  it('marks the setup as done when a provider key is set (V075)', async () => {
    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
      'MISTRAL_API_KEY'
    ]) {
      const config = await freshConfig();
      const changed = applyFirstStartEnvironment(config, { [name]: 'key' }, NOW);
      assert.equal(config.platform.setup.configured, true, name);
      assert.equal(changed.platform, true);
    }
    const config = await freshConfig();
    applyFirstStartEnvironment(config, { OPENAI_API_KEY: '  ' }, NOW);
    assert.equal(config.platform.setup.configured, false, 'a blank key is no key');
  });

  it('installs iFinder and iAssistant from IHUB_PLATFORM__I_FINDER__* / __I_ASSISTANT__* (V192)', async () => {
    const config = await freshConfig();
    applyFirstStartEnvironment(
      config,
      {
        IHUB_PLATFORM__I_FINDER__ENABLED: 'true',
        IHUB_PLATFORM__I_FINDER__BASE_URL: 'https://ifinder.example',
        IHUB_PLATFORM__I_FINDER__AUTH_MODE: 'jwt',
        IHUB_PLATFORM__I_FINDER__TOKEN_EXCHANGE__OIDC_PROVIDER: 'keycloak',
        IHUB_PLATFORM__I_ASSISTANT__DEFAULT_PROFILE_ID: 'prof1'
      },
      NOW
    );
    assert.deepEqual(byId(config, 'ifinder'), {
      id: 'ifinder',
      definition: 'com.intrafind/ifinder',
      enabled: true,
      values: {
        baseUrl: 'https://ifinder.example',
        authMode: 'jwt',
        tokenExchangeProvider: 'keycloak'
      },
      ...BASE
    });
    assert.deepEqual(byId(config, 'iassistant'), {
      id: 'iassistant',
      definition: 'com.intrafind/iassistant',
      enabled: true,
      values: { connection: 'ifinder', defaultProfileId: 'prof1' },
      ...BASE
    });
  });

  it('installs both, disabled, when only iAssistant variables are set', async () => {
    const config = await freshConfig();
    applyFirstStartEnvironment(config, { IHUB_PLATFORM__I_ASSISTANT__GROUNDED_ONLY: 'true' }, NOW);
    assert.equal(byId(config, 'ifinder').enabled, false);
    assert.deepEqual(byId(config, 'iassistant').values, {
      connection: 'ifinder',
      groundedOnly: true
    });
  });

  it('enables Entra only when tenant, client and secret are all set (V197)', async () => {
    const all = await freshConfig();
    applyFirstStartEnvironment(
      all,
      { AZURE_TENANT_ID: 'tid', AZURE_CLIENT_ID: 'cid', AZURE_CLIENT_SECRET: 'secret' },
      NOW
    );
    assert.equal(byId(all, 'entra').enabled, true);
    assert.deepEqual(byId(all, 'entra').values, { tenantId: 'tid', clientId: 'cid' });

    const partial = await freshConfig();
    applyFirstStartEnvironment(partial, { AZURE_TENANT_ID: 'tid', AZURE_CLIENT_ID: 'cid' }, NOW);
    assert.equal(byId(partial, 'entra').enabled, false);
    assert.deepEqual(byId(partial, 'entra').values, { tenantId: 'tid', clientId: 'cid' });
  });

  it('installs Brave when its key is set; STAAN is installed already (V204)', async () => {
    const config = await freshConfig();
    applyFirstStartEnvironment(config, { BRAVE_SEARCH_API_KEY: 'bk', STAAN_API_KEY: 'sk' }, NOW);
    assert.deepEqual(byId(config, 'brave'), {
      id: 'brave',
      definition: 'com.intrafind/brave-search',
      enabled: true,
      values: {},
      ...BASE
    });
    assert.equal(byId(config, 'staan').enabled, true);
    assert.equal(config.integrations.installed.filter(entry => entry.id === 'staan').length, 1);
  });

  it('installs the MCP server named by MCP_SERVER_URL (V050, V193)', async () => {
    const config = await freshConfig();
    applyFirstStartEnvironment(config, { MCP_SERVER_URL: 'https://mcp.example/mcp' }, NOW);
    assert.deepEqual(byId(config, 'legacy-mcp-server'), {
      id: 'legacy-mcp-server',
      definition: 'com.intrafind/mcp-server',
      enabled: true,
      values: { transport: 'streamableHttp', url: 'https://mcp.example/mcp' },
      label: { en: 'Legacy MCP Server (promoted from MCP_SERVER_URL)' },
      ...BASE
    });
  });
});

describe('importEnvironmentOnFirstStart', () => {
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-first-start-'));
    await copyDefaultConfiguration({ defaultsPath: DEFAULTS_DIR, contentsPath: tmp });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes only the files the environment changes', async () => {
    const platformFile = path.join(tmp, 'config', 'platform.json');
    const integrationsFile = path.join(tmp, 'config', 'integrations.json');
    const platformBefore = await fs.readFile(platformFile, 'utf8');

    const applied = await importEnvironmentOnFirstStart({
      contentsPath: tmp,
      env: { BRAVE_SEARCH_API_KEY: 'bk' }
    });
    assert.deepEqual(applied, ['BRAVE_SEARCH_API_KEY → installation "brave"']);
    assert.equal(await fs.readFile(platformFile, 'utf8'), platformBefore);
    const integrations = JSON.parse(await fs.readFile(integrationsFile, 'utf8'));
    assert.ok(integrations.installed.some(entry => entry.id === 'brave'));
  });
});
