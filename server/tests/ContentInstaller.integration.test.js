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
  instances: []
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
    getRegistryWithAuth: async () => ({ id: 'reg', auth: { type: 'none' } }),
    getCachedCatalogAsync: async () => ({ catalog: { items: state.items } }),
    resolveItemUrl: item => `https://registry.example/${item.source.path}`
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url) => {
    const relative = url.replace('https://registry.example/', '');
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
