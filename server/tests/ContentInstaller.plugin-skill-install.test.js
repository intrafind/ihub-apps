// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Installing a skill that a Claude Code plugin marketplace produced (a `url`
 * item on raw.githubusercontent.com):
 *
 *   - the registry's credentials go only to the registry's own host (or the
 *     GitHub pair for a GitHub registry), so a token for a mirror host never
 *     reaches GitHub;
 *   - a companion list that is empty is an answer — the catalog found no text
 *     companion — so the install does not list the repository again (which
 *     would bring the binary files back and cost a GitHub API call); only a
 *     catalog item without a list is discovered at install time.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports, run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import os from 'os';

const SKILL_URL = 'https://raw.githubusercontent.com/o/r/abc1234/skills/x/SKILL.md';
const SKILL_MD = '---\nname: x\ndescription: A plugin skill.\n---\n\n# X\n';

const state = {
  registry: { id: 'reg', source: '', auth: { type: 'bearer', token: 'secret' } },
  items: [],
  /** `{ url, headers }` of every fetch. */
  fetches: [],
  discovered: []
};

const discoverCompanions = jest.fn(async () => {
  state.discovered.push('called');
  return ['assets/logo.png'];
});

jest.unstable_mockModule('../pathUtils.js', () => ({ getRootDir: () => os.tmpdir() }));
jest.unstable_mockModule('../storage/bootstrap.js', () => ({ getStorage: () => null }));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getInstallations: () => ({ data: { installations: {} } }),
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    getPrompts: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] })
  }
}));
jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: {
    getRegistryWithAuth: async () => state.registry,
    getCachedCatalogAsync: async () => ({ catalog: { items: state.items } }),
    resolveItemUrl: item => item.source.url,
    discoverCompanions
  }
}));
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url, options) => {
    state.fetches.push({ url, headers: options?.headers || {} });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => SKILL_MD };
  }
}));

const { fetchItemContent } = await import('../services/marketplace/ContentInstaller.js');

describe('installing a plugin skill', () => {
  beforeEach(() => {
    state.fetches = [];
    state.discovered = [];
    discoverCompanions.mockClear();
    state.registry = { id: 'reg', source: '', auth: { type: 'bearer', token: 'secret' } };
    state.items = [
      {
        type: 'skill',
        name: 'x',
        version: '1.0.0',
        source: { type: 'url', url: SKILL_URL, companions: ['references/a.md'] }
      }
    ];
  });

  test("a mirror registry's token is not sent to GitHub", async () => {
    state.registry.source = 'https://mirror.example/marketplace.json';

    await fetchItemContent('reg', 'skill', 'x');

    expect(state.fetches.length).toBeGreaterThan(0);
    for (const { url, headers } of state.fetches) {
      expect(new URL(url).host).toBe('raw.githubusercontent.com');
      expect(headers.Authorization).toBeUndefined();
    }
  });

  test('a GitHub registry sends its token to the GitHub hosts', async () => {
    state.registry.source =
      'https://raw.githubusercontent.com/o/market/main/.claude-plugin/marketplace.json';

    await fetchItemContent('reg', 'skill', 'x');

    for (const { headers } of state.fetches) {
      expect(headers.Authorization).toBe('Bearer secret');
    }
  });

  test('an empty companion list is not listed again at install', async () => {
    state.registry.source = 'https://mirror.example/marketplace.json';
    state.items[0].source.companions = [];

    const { content } = await fetchItemContent('reg', 'skill', 'x');

    expect(discoverCompanions).not.toHaveBeenCalled();
    expect(content).toBe(SKILL_MD);
    expect(state.fetches).toHaveLength(1);
  });

  test('a catalog item without a companion list is still discovered', async () => {
    state.registry.source = 'https://mirror.example/marketplace.json';
    delete state.items[0].source.companions;

    await fetchItemContent('reg', 'skill', 'x');

    expect(discoverCompanions).toHaveBeenCalledTimes(1);
  });
});
