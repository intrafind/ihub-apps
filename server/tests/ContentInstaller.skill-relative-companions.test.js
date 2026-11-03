// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A skill whose catalog source is a path relative to the registry — the shape
 * of every skill in an offline copy of a marketplace, where the skills that
 * the official catalog links to on GitHub are copied next to the catalog —
 * installs its companion files. They are fetched from the folder of the
 * SKILL.md, on the registry's own host, and written below the skill's
 * directory.
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
  items: [],
  installations: { installations: {} },
  /** Every URL the installer fetched. */
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
    refreshModelsCache: async () => {},
    refreshSkillsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: {
    getRegistryWithAuth: async () => ({
      id: 'reg',
      source: 'https://registry.example/catalog.json',
      auth: { type: 'none' }
    }),
    getCachedCatalogAsync: async () => ({ catalog: { items: state.items } }),
    resolveItemUrl: item => `https://registry.example/${item.source.path}`
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url) => {
    state.fetches.push(url);
    const body = state.files[url.replace(/^https?:\/\/[^/]+\//, '')];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => body };
  }
}));

const { default: contentInstaller, fetchItemContent } =
  await import('../services/marketplace/ContentInstaller.js');

const SKILL_MD =
  '---\nname: offline-skill\ndescription: A skill with companions.\n---\n\n# Skill\n';

describe('ContentInstaller: skill with a relative source and companions', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-install-skill-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    state.installations = { installations: {} };
    state.fetches = [];
    state.items = [
      {
        type: 'skill',
        name: 'offline-skill',
        version: '1.0.0',
        source: {
          type: 'relative',
          path: 'skills/offline-skill/SKILL.md',
          companions: ['references/guide.md', 'references/deep/more.md']
        }
      }
    ];
    state.files = {
      'skills/offline-skill/SKILL.md': SKILL_MD,
      'skills/offline-skill/references/guide.md': '# Guide',
      'skills/offline-skill/references/deep/more.md': '# More'
    };
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test('fetches the companions next to the SKILL.md and writes them into the skill', async () => {
    const { content } = await fetchItemContent('reg', 'skill', 'offline-skill');

    expect(content).toEqual({
      files: {
        'SKILL.md': SKILL_MD,
        'references/guide.md': '# Guide',
        'references/deep/more.md': '# More'
      }
    });
    expect(state.fetches.sort()).toEqual([
      'https://registry.example/skills/offline-skill/SKILL.md',
      'https://registry.example/skills/offline-skill/references/deep/more.md',
      'https://registry.example/skills/offline-skill/references/guide.md'
    ]);
  });

  test('installs the skill with its companion files on disk', async () => {
    await contentInstaller.install('reg', 'skill', 'offline-skill', 'admin');

    const dir = path.join(state.rootDir, 'contents', 'skills', 'offline-skill');
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(await fs.readFile(path.join(dir, 'references', 'guide.md'), 'utf8')).toBe('# Guide');
    expect(await fs.readFile(path.join(dir, 'references', 'deep', 'more.md'), 'utf8')).toBe(
      '# More'
    );
  });

  test('a skill without companions is still the bare SKILL.md', async () => {
    delete state.items[0].source.companions;

    const { content } = await fetchItemContent('reg', 'skill', 'offline-skill');

    expect(content).toBe(SKILL_MD);
  });
});
