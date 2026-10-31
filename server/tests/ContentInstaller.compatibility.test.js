// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Versioning of marketplace integrations: an item this server version cannot
 * run is refused on install and update (`INCOMPATIBLE_IHUB_VERSION`), with the
 * catalog's `compatibility.ihub` or the short form `minVersion`; a definition
 * of an unknown format revision is refused (`UNSUPPORTED_DEFINITION_SCHEMA`);
 * release-note files travel as companions; and a note file of a catalog item
 * can be read without installing it, but only a path the catalog lists.
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
  files: {},
  items: [],
  installations: { installations: {} },
  fetches: []
};

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));
jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));
jest.unstable_mockModule('../utils/versionHelper.js', () => ({
  getAppVersion: () => '5.7.2'
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
      auth: { type: 'bearer', token: 'secret-token' },
      trustCode: false
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
  default: { instancesOf: () => [] }
}));
jest.unstable_mockModule('../services/integrations/protocols/openapi/OpenApiAdapter.js', () => ({
  invalidate: () => {}
}));
jest.unstable_mockModule('../services/integrations/protocols/index.js', () => ({
  notifyDefinitionsChanged: async () => {}
}));
jest.unstable_mockModule('../services/integrations/integrationTools.js', () => ({
  syncIntegrationScopeProviders: async () => []
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { default: contentInstaller, fetchIntegrationCompanion } =
  await import('../services/marketplace/ContentInstaller.js');
const { default: integrationRegistry } =
  await import('../services/integrations/definitions/IntegrationRegistry.js');

const FOLDER = 'org.example__service';
const definitionDir = () => path.join(state.rootDir, 'contents', 'integration-definitions', FOLDER);

const openApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Example', version: '1' },
  paths: {
    '/search': { get: { operationId: 'search', responses: { 200: { description: 'ok' } } } }
  }
};

const definition = version => ({
  id: 'org.example/service',
  version,
  name: { en: 'Example service' },
  protocol: { type: 'openapi', document: 'openapi.json', baseUrl: '{baseUrl}' },
  auth: { modes: ['none'] },
  install: [{ key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true }],
  actions: [{ name: 'search', operationId: 'search', sideEffect: 'read' }]
});

/** Publish a definition folder in the fake registry, with catalog item extras. */
const publish = (def, { item = {}, companions = ['README.md'], extraFiles = {} } = {}) => {
  state.items = [
    {
      type: 'integration',
      name: FOLDER,
      version: def.version,
      source: { type: 'relative', path: `integrations/${FOLDER}/integration.json`, companions },
      ...item
    }
  ];
  state.files = {
    [`integrations/${FOLDER}/integration.json`]: def,
    [`integrations/${FOLDER}/openapi.json`]: openApiDocument,
    [`integrations/${FOLDER}/README.md`]: '# Example',
    ...extraFiles
  };
};

const installedManifest = version => ({
  installations: {
    [`integration:${FOLDER}`]: {
      type: 'integration',
      itemId: FOLDER,
      registryId: 'reg',
      version,
      installedAt: '2026-01-01T00:00:00.000Z'
    }
  }
});

describe('ContentInstaller: integration versioning', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-install-compat-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.mkdir(path.join(state.rootDir, 'contents', 'integration-definitions'), {
      recursive: true
    });
    state.installations = { installations: {} };
    state.fetches = [];
    integrationRegistry.contentsDirOverride = path.join(
      state.rootDir,
      'contents',
      'integration-definitions'
    );
    integrationRegistry.shippedDir = path.join(state.rootDir, 'no-shipped');
    await integrationRegistry.reload();
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  test('installs a compatible definition and its release-note files', async () => {
    const def = {
      ...definition('1.1.0'),
      compatibility: { ihub: '>=5.7.0 <7' },
      releases: [
        {
          version: '1.1.0',
          date: '2026-11-02',
          summary: { en: 'Second' },
          notes: { features: 'releases/1.1.0/features.md' }
        },
        { version: '1.0.0', date: '2026-10-31', summary: { en: 'First' } }
      ]
    };
    publish(def, {
      item: { compatibility: { ihub: '>=5.7.0 <7' } },
      extraFiles: { [`integrations/${FOLDER}/releases/1.1.0/features.md`]: '# Second\n' }
    });
    const manifest = await contentInstaller.install('reg', 'integration', FOLDER, 'admin');
    expect(manifest.version).toBe('1.1.0');
    // The note file is fetched although the catalog did not list it as a companion.
    expect(
      await fs.readFile(path.join(definitionDir(), 'releases', '1.1.0', 'features.md'), 'utf8')
    ).toBe('# Second\n');
    expect(integrationRegistry.get('org.example/service').status).toBe('ok');
  });

  test('refuses an incompatible catalog item before fetching anything (install)', async () => {
    publish(definition('1.0.0'), { item: { compatibility: { ihub: '>=6.0.0' } } });
    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_IHUB_VERSION',
      message: expect.stringMatching(/needs iHub >=6\.0\.0, this server runs 5\.7\.2/),
      requires: '>=6.0.0',
      serverVersion: '5.7.2'
    });
    expect(state.fetches).toEqual([]);
    await expect(fs.access(definitionDir())).rejects.toThrow();
    expect(state.installations.installations[`integration:${FOLDER}`]).toBeUndefined();
  });

  test('reads the catalog short form minVersion as >=minVersion', async () => {
    publish(definition('1.0.0'), { item: { minVersion: '6.0' } });
    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_IHUB_VERSION',
      requires: '>=6.0.0'
    });
    publish(definition('1.0.0'), { item: { minVersion: '5.7' } });
    await expect(contentInstaller.install('reg', 'integration', FOLDER)).resolves.toMatchObject({
      version: '1.0.0'
    });
  });

  test('refuses a definition whose own compatibility the catalog item did not declare', async () => {
    publish({ ...definition('1.0.0'), compatibility: { ihub: '>=6.0.0' } });
    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_IHUB_VERSION'
    });
    await expect(fs.access(definitionDir())).rejects.toThrow();
  });

  test('refuses an incompatible update and keeps the installed version', async () => {
    publish(definition('1.0.0'));
    await contentInstaller.install('reg', 'integration', FOLDER);
    state.installations = installedManifest('1.0.0');
    publish(
      { ...definition('2.0.0'), compatibility: { ihub: '>=6.0.0' } },
      {
        item: { compatibility: { ihub: '>=6.0.0' } }
      }
    );
    await expect(contentInstaller.update('integration', FOLDER)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_IHUB_VERSION'
    });
    const onDisk = JSON.parse(
      await fs.readFile(path.join(definitionDir(), 'integration.json'), 'utf8')
    );
    expect(onDisk.version).toBe('1.0.0');
    expect(state.installations.installations[`integration:${FOLDER}`].version).toBe('1.0.0');
  });

  test('refuses a definition of an unknown schema revision on install and update', async () => {
    publish({ ...definition('1.0.0'), compatibility: { schema: 2 }, newField: true });
    await expect(contentInstaller.install('reg', 'integration', FOLDER)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DEFINITION_SCHEMA',
      revision: 2
    });
    await expect(fs.access(definitionDir())).rejects.toThrow();

    publish(definition('1.0.0'));
    await contentInstaller.install('reg', 'integration', FOLDER);
    state.installations = installedManifest('1.0.0');
    publish({ ...definition('1.1.0'), compatibility: { schema: 3 } });
    await expect(contentInstaller.update('integration', FOLDER)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DEFINITION_SCHEMA'
    });
    const onDisk = JSON.parse(
      await fs.readFile(path.join(definitionDir(), 'integration.json'), 'utf8')
    );
    expect(onDisk.version).toBe('1.0.0');
  });

  test('serves a listed note file of a catalog item with the registry credentials, nothing else', async () => {
    publish(definition('1.0.0'), {
      item: {
        releases: [
          {
            version: '1.0.0',
            date: '2026-10-31',
            summary: { en: 'First' },
            notes: { features: 'releases/1.0.0/features.md' }
          }
        ]
      },
      extraFiles: {
        [`integrations/${FOLDER}/releases/1.0.0/features.md`]: '# First\n',
        [`integrations/${FOLDER}/private.md`]: 'not listed'
      }
    });
    expect(await fetchIntegrationCompanion('reg', FOLDER, 'releases/1.0.0/features.md')).toBe(
      '# First\n'
    );
    expect(state.fetches.at(-1)).toMatchObject({
      url: `https://registry.example/integrations/${FOLDER}/releases/1.0.0/features.md`,
      headers: { Authorization: 'Bearer secret-token' }
    });
    expect(await fetchIntegrationCompanion('reg', FOLDER, 'README.md')).toBe('# Example');
    expect(await fetchIntegrationCompanion('reg', FOLDER, 'private.md')).toBeNull();
    expect(await fetchIntegrationCompanion('reg', FOLDER, 'openapi.json')).toBeNull();
    expect(await fetchIntegrationCompanion('reg', FOLDER, '../other/README.md')).toBeNull();
    expect(await fetchIntegrationCompanion('reg', FOLDER, 'releases/../../x.md')).toBeNull();
    await expect(fetchIntegrationCompanion('reg', 'unknown', 'README.md')).rejects.toThrow(
      /not found/
    );
  });
});
