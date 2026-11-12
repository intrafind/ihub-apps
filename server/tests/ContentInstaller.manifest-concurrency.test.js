// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The installations manifest under concurrent changes.
 *
 * An install fetches from the network and writes content between reading the
 * manifest and recording the result. Writing back the stale snapshot erased the
 * entries another worker (or an admin action) recorded in the meantime, leaving
 * their files on disk with nothing tracking them. The cache below serves a copy
 * that only changes when the installer asks for a refresh, like another worker's
 * stale cache.
 *
 * Native ESM: run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const state = {
  rootDir: os.tmpdir(),
  /** Catalog item content served by the fake registry, keyed by `type:name`. */
  content: {},
  /** Absolute item URLs (`source.type: "url"`) the catalog names, keyed by `type:name`. */
  itemUrls: {},
  /** Every URL the installer fetched. */
  fetched: [],
  /** What the fake ConfigCache reports as loaded, per type. */
  loaded: { apps: [], models: [], prompts: [], workflows: [], skills: [] },
  installations: { installations: {} },
  beforeFetchResolves: null
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
    refreshInstallationsCache: async () => {
      try {
        state.installations = JSON.parse(
          await fs.readFile(path.join(state.rootDir, 'contents/config/installations.json'), 'utf8')
        );
      } catch {
        /* none yet */
      }
    },
    getApps: () => ({ data: state.loaded.apps }),
    getModels: () => ({ data: state.loaded.models }),
    getPrompts: () => ({ data: state.loaded.prompts }),
    getWorkflows: () => ({ data: state.loaded.workflows }),
    getSkills: () => ({ data: state.loaded.skills }),
    refreshAppsCache: async () => {},
    refreshModelsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: {
    // The items live on the registry's own host, which the fetch guard admits.
    getRegistryWithAuth: async () => ({
      id: 'reg',
      source: 'https://registry.example/catalog.json',
      auth: { type: 'none' }
    }),
    getCachedCatalogAsync: async () => ({
      catalog: {
        items: Object.keys(state.content).map(key => {
          const [type, name] = key.split(':');
          const source = state.itemUrls[key]
            ? { type: 'url', url: state.itemUrls[key] }
            : { type: 'relative', path: key };
          return { type, name, version: '1.0.0', source };
        })
      }
    }),
    resolveItemUrl: item =>
      item.source?.type === 'url'
        ? item.source.url
        : `https://registry.example/${item.type}/${item.name}`
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url) => {
    state.fetched.push(url);
    const [type, name] = url.split('/').slice(-2);
    await state.beforeFetchResolves?.(type, name);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(state.content[`${type}:${name}`])
    };
  }
}));

const { default: contentInstaller } = await import('../services/marketplace/ContentInstaller.js');
const { MARKETPLACE_TARGET_BLOCKED } = await import('../services/marketplace/marketplaceFetch.js');

const contentsPath = rel => path.join(state.rootDir, 'contents', rel);
const readContents = async rel => JSON.parse(await fs.readFile(contentsPath(rel), 'utf8'));
const writeContents = async (rel, data) => {
  await fs.mkdir(path.dirname(contentsPath(rel)), { recursive: true });
  await fs.writeFile(contentsPath(rel), JSON.stringify(data, null, 2));
};

const { default: configStore } = await import('../services/config/ConfigStore.js');
const { removeMarketplaceInstallation } = await import('../utils/installationCleanup.js');

const readManifest = async () =>
  JSON.parse(await fs.readFile(contentsPath('config/installations.json'), 'utf8')).installations;

const appNamed = id => ({
  id,
  name: { en: id },
  description: { en: 'An app' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { en: 'You help.' }
});

const entry = (type, itemId) => ({
  type,
  itemId,
  registryId: 'reg',
  version: '1.0.0',
  installedAt: '2026-01-01T00:00:00.000Z'
});

describe('installations manifest under concurrent changes', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-install-concurrent-'));
    for (const dir of ['config', 'apps']) await fs.mkdir(contentsPath(dir), { recursive: true });
    state.content = {};
    state.itemUrls = {};
    state.fetched = [];
    state.loaded = { apps: [], models: [], prompts: [], workflows: [], skills: [] };
    state.installations = { installations: {} };
    state.beforeFetchResolves = null;
  });

  afterEach(async () => {
    state.beforeFetchResolves = null;
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test('an install keeps an entry another worker recorded while it was fetching', async () => {
    state.content['app:first-app'] = appNamed('first-app');
    // Another worker finishes its own install during this one's network fetch.
    state.beforeFetchResolves = async () => {
      await configStore.updateJson('config/installations.json', current => ({
        installations: {
          ...(current?.installations || {}),
          'app:other-app': entry('app', 'other-app')
        }
      }));
    };

    await contentInstaller.install('reg', 'app', 'first-app', 'admin');

    expect(Object.keys(await readManifest()).sort()).toEqual(['app:first-app', 'app:other-app']);
  });

  test('two installs started together are both recorded', async () => {
    state.content['app:one-app'] = appNamed('one-app');
    state.content['app:two-app'] = appNamed('two-app');

    await Promise.all([
      contentInstaller.install('reg', 'app', 'one-app', 'admin'),
      contentInstaller.install('reg', 'app', 'two-app', 'admin')
    ]);

    expect(Object.keys(await readManifest()).sort()).toEqual(['app:one-app', 'app:two-app']);
  });

  test('of two installs of the same item only one is recorded, the other is refused', async () => {
    state.content['app:same-app'] = appNamed('same-app');

    const results = await Promise.allSettled([
      contentInstaller.install('reg', 'app', 'same-app', 'a'),
      contentInstaller.install('reg', 'app', 'same-app', 'b')
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(Object.keys(await readManifest())).toEqual(['app:same-app']);
  });

  test('an uninstall keeps an entry recorded while it was running', async () => {
    state.content['app:gone-app'] = appNamed('gone-app');
    await contentInstaller.install('reg', 'app', 'gone-app', 'admin');
    // A stale cache: another worker's entry is not in this worker's snapshot.
    await configStore.updateJson('config/installations.json', current => ({
      installations: { ...current.installations, 'app:late-app': entry('app', 'late-app') }
    }));

    await contentInstaller.uninstall('app', 'gone-app');

    expect(Object.keys(await readManifest())).toEqual(['app:late-app']);
  });

  test('cleanup after an admin delete keeps entries it never saw', async () => {
    await configStore.updateJson('config/installations.json', () => ({
      installations: { 'app:deleted-app': entry('app', 'deleted-app') }
    }));
    await fs.writeFile(
      contentsPath('config/installations.json'),
      JSON.stringify({
        installations: {
          'app:deleted-app': entry('app', 'deleted-app'),
          'app:newer-app': entry('app', 'newer-app')
        }
      })
    );
    state.installations = { installations: { 'app:deleted-app': entry('app', 'deleted-app') } };

    await removeMarketplaceInstallation('app', 'deleted-app');

    expect(Object.keys(await readManifest())).toEqual(['app:newer-app']);
  });
});
