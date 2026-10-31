// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Marketplace items of type `integration`: a definition folder is fetched
 * with its companions, validated, written through the integration registry,
 * and refused when the folder name and the definition id disagree or when
 * an installed instance still uses the definition.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports, run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const state = {
  rootDir: os.tmpdir(),
  /** The fake registry's files, keyed by URL path below the registry root. */
  files: {},
  /** Catalog item descriptors served by the fake registry. */
  items: [],
  installations: { installations: {} },
  /** What the fake InstalledIntegrationService reports as instances. */
  instances: [],
  /** The registry's credentials (`getRegistryWithAuth`). */
  auth: { type: 'none' },
  /** Whether the registry may deliver code (`trustCode`). */
  trustCode: false,
  /** Every fetch the installer made: `{ url, headers }`. */
  fetches: []
};

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getInstallations: () => ({ data: state.installations }),
    refreshInstallationsCache: async () => {},
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    getPrompts: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] }),
    refreshAppsCache: async () => {},
    refreshModelsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: {
    getRegistryWithAuth: async () => ({
      id: 'reg',
      source: 'https://registry.example/catalog.json',
      auth: state.auth,
      trustCode: state.trustCode
    }),
    getCachedCatalogAsync: async () => ({ catalog: { items: state.items } }),
    resolveItemUrl: item => `https://registry.example/${item.source.path}`
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url, options = {}) => {
    state.fetches.push({ url, headers: options.headers || {} });
    const relative = url.replace(/^https?:\/\/[^/]+\//, '');
    const body = state.files[relative];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    return {
      ok: true,
      status: 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
  }
}));

jest.unstable_mockModule('../services/integrations/InstalledIntegrationService.js', () => ({
  default: {
    instancesOf: () => state.instances
  }
}));

/** Per-instance cache invalidations the installer requested. */
const invalidated = [];
jest.unstable_mockModule('../services/integrations/protocols/openapi/OpenApiAdapter.js', () => ({
  invalidate: instanceId => invalidated.push(instanceId)
}));

/** The definition changes the installer told the protocol adapters about. */
const adapterNotifications = [];
jest.unstable_mockModule('../services/integrations/protocols/index.js', () => ({
  notifyDefinitionsChanged: async context => {
    adapterNotifications.push(context);
  }
}));

/** How often the installer asked for the scope providers to be re-registered. */
let scopeProviderSyncs = 0;
jest.unstable_mockModule('../services/integrations/integrationTools.js', () => ({
  syncIntegrationScopeProviders: async () => {
    scopeProviderSyncs += 1;
    return [];
  }
}));

const { default: contentInstaller } = await import('../services/marketplace/ContentInstaller.js');
const { default: integrationRegistry } =
  await import('../services/integrations/definitions/IntegrationRegistry.js');

const FOLDER = 'org.example__service';
const definitionDir = () => path.join(state.rootDir, 'contents', 'integration-definitions', FOLDER);

const openApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Example', version: '1' },
  paths: {
    '/search': {
      get: {
        operationId: 'search',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } }
      }
    }
  }
};

const definition = {
  id: 'org.example/service',
  version: '1.0.0',
  name: { en: 'Example service' },
  description: { en: 'An example' },
  icon: 'icon.svg',
  protocol: { type: 'openapi', document: 'openapi.json', baseUrl: '{baseUrl}' },
  auth: { modes: ['none'] },
  install: [{ key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true }],
  actions: [
    {
      name: 'search',
      operationId: 'search',
      title: { en: 'Search' },
      description: { en: 'Searches' },
      sideEffect: 'read'
    }
  ]
};

/** Publish a definition folder in the fake registry. */
const publish = (def, { companions = ['README.md'], extraFiles = {} } = {}) => {
  state.items = [
    {
      type: 'integration',
      name: FOLDER,
      version: def.version,
      source: { type: 'relative', path: `integrations/${FOLDER}/integration.json`, companions }
    }
  ];
  state.files = {
    [`integrations/${FOLDER}/integration.json`]: def,
    [`integrations/${FOLDER}/openapi.json`]: openApiDocument,
    [`integrations/${FOLDER}/icon.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    [`integrations/${FOLDER}/README.md`]: '# Example',
    ...extraFiles
  };
};

describe('ContentInstaller: integration definitions', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-install-integration-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    state.installations = { installations: {} };
    state.instances = [];
    state.items = [];
    state.files = {};
    state.auth = { type: 'none' };
    state.trustCode = false;
    state.fetches = [];
    invalidated.length = 0;
    adapterNotifications.length = 0;
    scopeProviderSyncs = 0;
    // The registry singleton keeps the previous test's entries in memory.
    await integrationRegistry.reload();
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test('installs the definition with its listed and referenced companions', async () => {
    publish(definition);

    const manifest = await contentInstaller.install('reg', 'integration', FOLDER, 'admin');

    expect(manifest).toMatchObject({ type: 'integration', itemId: FOLDER, version: '1.0.0' });
    const written = await fs.readdir(definitionDir());
    expect(written.sort()).toEqual(['README.md', 'icon.svg', 'integration.json', 'openapi.json']);
    expect(
      JSON.parse(await fs.readFile(path.join(definitionDir(), 'integration.json'), 'utf8'))
    ).toEqual(definition);
    const entry = integrationRegistry.get('org.example/service');
    expect(entry).toMatchObject({ source: 'installed' });
    expect(entry.document.paths['/search'].get.operationId).toBe('search');
  });

  test('sends the registry credentials only to the hosts the registry lives on', async () => {
    publish(definition, { companions: ['README.md'] });
    state.auth = { type: 'bearer', token: 'secret' };
    // The catalog names another host as the folder's raw base.
    state.items[0].source.rawBase = `https://files.elsewhere.example/integrations/${FOLDER}`;

    await contentInstaller.install('reg', 'integration', FOLDER, 'admin');

    const byUrl = Object.fromEntries(state.fetches.map(f => [f.url, f.headers]));
    expect(byUrl[`https://registry.example/integrations/${FOLDER}/integration.json`]).toMatchObject(
      { Authorization: 'Bearer secret' }
    );
    for (const name of ['README.md', 'openapi.json', 'icon.svg']) {
      const headers = byUrl[`https://files.elsewhere.example/integrations/${FOLDER}/${name}`];
      expect(headers).toBeDefined();
      expect(headers.Authorization).toBeUndefined();
    }
  });

  const connectorSource = `export default { id: 'org.example/script', actions: { ping: { parameters: { type: 'object', properties: {} }, run: async () => 'pong' } } };\n`;
  const scriptDefinition = {
    ...definition,
    id: 'org.example/script',
    protocol: { type: 'script', module: 'connector.js' },
    install: [],
    actions: []
  };
  const SCRIPT_FOLDER = 'org.example__script';
  const publishScript = integrity => {
    state.items = [
      {
        type: 'integration',
        name: SCRIPT_FOLDER,
        version: '1.0.0',
        source: {
          type: 'relative',
          path: `integrations/${SCRIPT_FOLDER}/integration.json`,
          companions: ['connector.js'],
          ...(integrity ? { integrity } : {})
        }
      }
    ];
    state.files = {
      [`integrations/${SCRIPT_FOLDER}/integration.json`]: scriptDefinition,
      [`integrations/${SCRIPT_FOLDER}/connector.js`]: connectorSource,
      [`integrations/${SCRIPT_FOLDER}/icon.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>'
    };
  };
  const sha256 = text =>
    `sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}`;

  test('refuses an integration with code from a registry that is not trusted for code', async () => {
    publishScript({ 'connector.js': sha256(connectorSource) });
    await expect(
      contentInstaller.install('reg', 'integration', SCRIPT_FOLDER, 'admin')
    ).rejects.toMatchObject({ code: 'CODE_NOT_TRUSTED' });
  });

  test('refuses code without a hash, and a hash that does not match', async () => {
    state.trustCode = true;
    publishScript();
    await expect(
      contentInstaller.install('reg', 'integration', SCRIPT_FOLDER, 'admin')
    ).rejects.toMatchObject({ code: 'CODE_INTEGRITY_REQUIRED' });
    publishScript({ 'connector.js': sha256('something else') });
    await expect(
      contentInstaller.install('reg', 'integration', SCRIPT_FOLDER, 'admin')
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });

  test('installs code from a trusted registry when the hash matches', async () => {
    state.trustCode = true;
    publishScript({ 'connector.js': sha256(connectorSource) });
    const manifest = await contentInstaller.install('reg', 'integration', SCRIPT_FOLDER, 'admin');
    expect(manifest).toMatchObject({ type: 'integration', itemId: SCRIPT_FOLDER });
    const written = await fs.readdir(
      path.join(state.rootDir, 'contents', 'integration-definitions', SCRIPT_FOLDER)
    );
    expect(written.sort()).toEqual(['connector.js', 'icon.svg', 'integration.json']);
    expect(integrationRegistry.get('org.example/script')).toMatchObject({ source: 'installed' });
  });

  test('never sends the registry credentials over plain http, even to the registry host', async () => {
    publish(definition, { companions: ['README.md'] });
    state.auth = { type: 'bearer', token: 'secret' };
    state.items[0].source.rawBase = `http://registry.example/integrations/${FOLDER}`;

    await contentInstaller.install('reg', 'integration', FOLDER, 'admin');

    const byUrl = Object.fromEntries(state.fetches.map(f => [f.url, f.headers]));
    for (const name of ['README.md', 'openapi.json', 'icon.svg']) {
      const headers = byUrl[`http://registry.example/integrations/${FOLDER}/${name}`];
      expect(headers).toBeDefined();
      expect(headers.Authorization).toBeUndefined();
    }
  });

  test('re-installing a definition drops the cached schemas of its installations, tells the protocol adapters and re-registers their scope providers', async () => {
    publish(definition);
    state.instances = [{ id: 'service-prod' }, { id: 'service-test' }];

    await contentInstaller.install('reg', 'integration', FOLDER, 'admin');

    expect(invalidated).toEqual(['service-prod', 'service-test']);
    // The MCP adapter rebuilds the client manager from here; a changed
    // endpoint would otherwise be served only after a restart.
    expect(adapterNotifications).toEqual([{ definitionIds: ['org.example/service'] }]);
    expect(scopeProviderSyncs).toBe(1);
  });

  test('rejects a definition that fails the schema', async () => {
    publish({ ...definition, actions: [{ ...definition.actions[0], operationId: undefined }] });

    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toThrow(
      /Content validation failed/
    );
    await expect(fs.access(definitionDir())).rejects.toThrow();
  });

  test('rejects a definition whose id does not match the folder name', async () => {
    publish({ ...definition, id: 'org.example/other' });

    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toThrow(
      /definition id 'org.example\/other' does not match the catalog name 'org.example__service'/
    );
  });

  test('fails when a referenced companion cannot be fetched', async () => {
    publish(definition);
    delete state.files[`integrations/${FOLDER}/openapi.json`];

    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toThrow(
      /Companion file 'openapi.json' could not be fetched \(HTTP 404\)/
    );
  });

  test('refuses to uninstall while an installed instance uses the definition', async () => {
    publish(definition);
    await contentInstaller.install('reg', 'integration', FOLDER, 'admin');
    state.instances = [{ id: 'service-prod' }];

    await expect(contentInstaller.uninstall('integration', FOLDER)).rejects.toMatchObject({
      code: 'INTEGRATION_IN_USE'
    });
    await expect(fs.access(definitionDir())).resolves.toBeUndefined();
  });

  test('uninstall removes the folder and the registry entry', async () => {
    publish(definition);
    await contentInstaller.install('reg', 'integration', FOLDER, 'admin');

    await contentInstaller.uninstall('integration', FOLDER);

    await expect(fs.access(definitionDir())).rejects.toThrow();
    expect(integrationRegistry.get('org.example/service')).toBeNull();
  });
});
