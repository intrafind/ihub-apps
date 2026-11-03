// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Versioning phase 3 (#3091) in the marketplace: a catalog item lists the
 * versions the registry still serves (`versions: [{ version, ref }]`), the
 * registry config sets a `channel` and per-item `pins`, and install, update
 * and the update badge honour them. A version other than the current one is
 * installed from its descriptor (`ref`, or `?version=` on the catalog URL).
 *
 * The real RegistryService and ContentInstaller run against a fake registry
 * (the request throttler is mocked) and a temporary contents folder.
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
  /** The fake registry's files, keyed by URL path and query below the host. */
  files: {},
  installations: { installations: {} },
  registries: [],
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
    getRegistries: () => ({ data: { registries: state.registries } }),
    refreshInstallationsCache: async () => {},
    refreshRegistriesCache: async () => {},
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    getPrompts: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] })
  }
}));
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url) => {
    state.fetches.push(url);
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

const { default: registryService, versionDescriptorUrl } =
  await import('../services/marketplace/RegistryService.js');
const { default: contentInstaller } = await import('../services/marketplace/ContentInstaller.js');
const { default: integrationRegistry } =
  await import('../services/integrations/definitions/IntegrationRegistry.js');
const { marketplaceTargetGuard } = await import('../services/marketplace/marketplaceFetch.js');

// The fake registry host resolves to a public address without DNS.
const realCheckTarget = marketplaceTargetGuard.checkTarget;
marketplaceTargetGuard.checkTarget = async () => ({ ok: true, addresses: ['93.184.216.34'] });
afterAll(() => {
  marketplaceTargetGuard.checkTarget = realCheckTarget;
});

const FOLDER = 'org.example__portal';
const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Portal', version: '1' },
  paths: {
    '/search': { get: { operationId: 'search', responses: { 200: { description: 'ok' } } } }
  }
};

function definition(version) {
  return {
    id: 'org.example/portal',
    version,
    name: { en: 'Portal' },
    protocol: { type: 'openapi', document: 'openapi.json', baseUrl: '{baseUrl}' },
    auth: { modes: ['none'] },
    install: [{ key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true }],
    actions: [{ name: 'search', operationId: 'search', sideEffect: 'read' }]
  };
}

/** The catalog item of a version, as the generator writes its descriptor. */
function versionItem(version, base) {
  return {
    type: 'integration',
    name: FOLDER,
    version,
    source: { type: 'relative', path: `${base}/integration.json`, companions: ['openapi.json'] }
  };
}

/** Publish the current version 2.0.0-rc.1 and the versions 1.4.0, 1.3.2, 1.3.0 as descriptors. */
async function publish() {
  const current = versionItem('2.0.0-rc.1', `integrations/${FOLDER}`);
  state.files = {
    [`integrations/${FOLDER}/integration.json`]: definition('2.0.0-rc.1'),
    [`integrations/${FOLDER}/openapi.json`]: OPENAPI
  };
  const versions = [];
  for (const version of ['1.4.0', '1.3.2', '1.3.0']) {
    const base = `versions/integrations/${FOLDER}/${version}`;
    state.files[`${base}/integration.json`] = definition(version);
    state.files[`${base}/openapi.json`] = OPENAPI;
    state.files[`versions/integrations/${FOLDER}/${version}.json`] = versionItem(version, base);
    versions.push({ version, ref: `versions/integrations/${FOLDER}/${version}.json` });
  }
  const item = { ...current, versions: [{ version: '2.0.0-rc.1' }, ...versions] };
  const cacheDir = path.join(state.rootDir, 'contents', '.registry-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(
    path.join(cacheDir, 'reg.json'),
    JSON.stringify({ registryId: 'reg', catalog: { items: [item] } })
  );
  return item;
}

function setRegistry(extra = {}) {
  state.registries = [
    {
      id: 'reg',
      name: 'Registry',
      source: 'https://registry.example/catalog.json',
      enabled: true,
      auth: { type: 'none' },
      ...extra
    }
  ];
}

const installedVersion = async () =>
  JSON.parse(
    await fs.readFile(
      path.join(state.rootDir, 'contents', 'integration-definitions', FOLDER, 'integration.json'),
      'utf8'
    )
  ).version;

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-marketplace-versions-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  state.installations = { installations: {} };
  state.fetches = [];
  setRegistry();
  await integrationRegistry.reload();
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('version descriptors', () => {
  test('fetches a listed version from its ref, and checks it is that version', async () => {
    const item = await publish();
    const registry = state.registries[0];
    const descriptor = await registryService.fetchItemVersion(registry, item, '1.3.2');
    expect(descriptor).toMatchObject({ version: '1.3.2', source: { type: 'relative' } });
    expect(state.fetches).toContain(
      `https://registry.example/versions/integrations/${FOLDER}/1.3.2.json`
    );
    await expect(registryService.fetchItemVersion(registry, item, '9.9.9')).rejects.toMatchObject({
      code: 'VERSION_NOT_LISTED'
    });
    state.files[`versions/integrations/${FOLDER}/1.3.0.json`] = versionItem('1.2.0', 'x');
    await expect(registryService.fetchItemVersion(registry, item, '1.3.0')).rejects.toMatchObject({
      code: 'VERSION_DESCRIPTOR_INVALID'
    });
  });

  test('without a ref the catalog URL is asked with type, name and version', () => {
    expect(
      versionDescriptorUrl(
        { type: 'integration', name: FOLDER },
        { version: '1.3.0' },
        { source: 'https://registry.example/catalog.json' }
      )
    ).toBe(`https://registry.example/catalog.json?type=integration&name=${FOLDER}&version=1.3.0`);
    expect(
      versionDescriptorUrl(
        { type: 'integration', name: FOLDER },
        { version: '1.3.0', ref: './versions/a.json' },
        { source: 'https://registry.example/' }
      )
    ).toBe('https://registry.example/versions/a.json');
  });
});

describe('install and update with channel and pin', () => {
  test('the stable channel installs the newest stable version from its descriptor', async () => {
    await publish();
    const manifest = await contentInstaller.install('reg', 'integration', FOLDER, 'admin');
    expect(manifest.version).toBe('1.4.0');
    expect(await installedVersion()).toBe('1.4.0');
  });

  test('a pin installs the newest version inside it, and refuses one outside it', async () => {
    await publish();
    setRegistry({ pins: { [`integration:${FOLDER}`]: '1.3.x' } });
    await expect(
      contentInstaller.install('reg', 'integration', FOLDER, 'admin', { version: '1.4.0' })
    ).rejects.toMatchObject({ code: 'VERSION_NOT_OFFERED' });
    const manifest = await contentInstaller.install('reg', 'integration', FOLDER, 'admin');
    expect(manifest.version).toBe('1.3.2');
    expect(await installedVersion()).toBe('1.3.2');
  });

  test('channel all offers the pre-release; a pin nothing passes offers nothing', async () => {
    await publish();
    setRegistry({ channel: 'all', pins: { [`integration:${FOLDER}`]: '>=3' } });
    await expect(
      contentInstaller.install('reg', 'integration', FOLDER, 'admin')
    ).rejects.toMatchObject({ code: 'NO_VERSION_OFFERED' });
    setRegistry({ channel: 'all' });
    const manifest = await contentInstaller.install('reg', 'integration', FOLDER, 'admin');
    expect(manifest.version).toBe('2.0.0-rc.1');
  });

  test('the update badge offers only versions inside the pin, and an update never goes back', async () => {
    await publish();
    state.installations.installations[`integration:${FOLDER}`] = {
      type: 'integration',
      itemId: FOLDER,
      registryId: 'reg',
      version: '1.3.0'
    };
    setRegistry({ pins: { [`integration:${FOLDER}`]: '1.3.x' } });
    let listed = await registryService.getAllItems({ type: 'integration' });
    expect(listed.items[0]).toMatchObject({
      installationStatus: 'update-available',
      offeredVersion: '1.3.2',
      pin: '1.3.x',
      channel: 'stable',
      availableVersions: ['1.3.2', '1.3.0']
    });
    setRegistry({ pins: { [`integration:${FOLDER}`]: '1.3.0' } });
    listed = await registryService.getAllItems({ type: 'integration' });
    expect(listed.items[0].installationStatus).toBe('installed');

    state.installations.installations[`integration:${FOLDER}`].version = '1.4.0';
    setRegistry({ pins: { [`integration:${FOLDER}`]: '1.3.x' } });
    await expect(contentInstaller.update('integration', FOLDER, 'admin')).rejects.toMatchObject({
      code: 'VERSION_NOT_NEWER'
    });
  });

  test('a registry update refuses a pin that is no semver range', async () => {
    const cacheDir = path.join(state.rootDir, 'contents', 'config');
    await fs.writeFile(
      path.join(cacheDir, 'registries.json'),
      JSON.stringify({ registries: state.registries })
    );
    await expect(
      registryService.updateRegistry('reg', { pins: { [`integration:${FOLDER}`]: 'latest' } })
    ).rejects.toThrow(/semver range/);
    const updated = await registryService.updateRegistry('reg', {
      channel: 'all',
      pins: { [`integration:${FOLDER}`]: '1.3.x' }
    });
    expect(updated).toMatchObject({ channel: 'all', pins: { [`integration:${FOLDER}`]: '1.3.x' } });
  });
});
