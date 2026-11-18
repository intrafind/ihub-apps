// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Reviewing the files of a marketplace skill before installing it
 * (`listSkillFiles`, `fetchSkillFile`):
 *
 *   - the list is `SKILL.md` first, then the companions the catalog lists (or,
 *     for a catalog item without a list, the ones found in the repository);
 *   - a file is served only when `SKILL.md` or listed, so the endpoint is no
 *     proxy for other URLs; a path that climbs out of the folder is refused;
 *   - the registry's credentials go only to the registry's own host, as for an
 *     install; a file over 512 KB or a binary one is refused with a typed error.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports, run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import os from 'os';

const SKILL_URL = 'https://raw.githubusercontent.com/o/r/abc1234/skills/x/SKILL.md';
const SKILL_MD = '---\nname: x\ndescription: A skill.\n---\n\n# X\n';

const state = {
  registry: { id: 'reg', source: '', auth: { type: 'bearer', token: 'secret' } },
  items: [],
  /** Body per URL; a missing URL answers 404. */
  files: {},
  /** `{ url, headers }` of every fetch. */
  fetches: []
};

const discoverCompanions = jest.fn(async () => ['references/found.md']);

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
    const body = state.files[url];
    if (body === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { fetchSkillFile, listSkillFiles } =
  await import('../services/marketplace/ContentInstaller.js');

const DIR = 'https://raw.githubusercontent.com/o/r/abc1234/skills/x';

describe('reviewing the files of a marketplace skill', () => {
  beforeEach(() => {
    discoverCompanions.mockClear();
    state.fetches = [];
    state.registry = { id: 'reg', source: '', auth: { type: 'bearer', token: 'secret' } };
    state.items = [
      {
        type: 'skill',
        name: 'x',
        version: '1.0.0',
        source: {
          type: 'url',
          url: SKILL_URL,
          companions: ['references/a.md', 'scripts/run.py']
        }
      }
    ];
    state.files = {
      [SKILL_URL]: SKILL_MD,
      [`${DIR}/references/a.md`]: '# A\n',
      [`${DIR}/scripts/run.py`]: 'print("hi")\n',
      [`${DIR}/secret.md`]: 'not listed'
    };
  });

  describe('listSkillFiles', () => {
    test('SKILL.md comes first, then the companions the catalog lists', async () => {
      expect(await listSkillFiles('reg', state.items[0])).toEqual([
        'SKILL.md',
        'references/a.md',
        'scripts/run.py'
      ]);
      expect(discoverCompanions).not.toHaveBeenCalled();
    });

    test('an empty list is an answer: only SKILL.md, nothing is discovered', async () => {
      state.items[0].source.companions = [];
      expect(await listSkillFiles('reg', state.items[0])).toEqual(['SKILL.md']);
      expect(discoverCompanions).not.toHaveBeenCalled();
    });

    test('a catalog item without a list is looked up in the repository, as an install does', async () => {
      delete state.items[0].source.companions;
      expect(await listSkillFiles('reg', state.items[0])).toEqual([
        'SKILL.md',
        'references/found.md'
      ]);
      expect(discoverCompanions).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchSkillFile', () => {
    test('serves SKILL.md and a listed file as text', async () => {
      expect(await fetchSkillFile('reg', 'x', 'SKILL.md')).toBe(SKILL_MD);
      expect(await fetchSkillFile('reg', 'x', 'references/a.md')).toBe('# A\n');
      expect(await fetchSkillFile('reg', 'x', 'scripts/run.py')).toBe('print("hi")\n');
    });

    test('a file the catalog does not list is not served, nor fetched', async () => {
      expect(await fetchSkillFile('reg', 'x', 'secret.md')).toBeNull();
      expect(state.fetches.map(f => f.url)).not.toContain(`${DIR}/secret.md`);
    });

    test.each([
      '../other/SKILL.md',
      'references/../../x.md',
      '/etc/passwd',
      'references//a.md',
      './references/a.md',
      'references\\a.md',
      'references/a.md?x=1',
      'references/a.md#top',
      'references/a\u0000.md',
      ''
    ])('refuses the path %j', async relativePath => {
      expect(await fetchSkillFile('reg', 'x', relativePath)).toBeNull();
      expect(state.fetches).toHaveLength(0);
    });

    test('a listed file that is gone is null; an unknown skill is NOT_FOUND', async () => {
      state.items[0].source.companions.push('references/gone.md');
      expect(await fetchSkillFile('reg', 'x', 'references/gone.md')).toBeNull();
      await expect(fetchSkillFile('reg', 'unknown', 'SKILL.md')).rejects.toMatchObject({
        code: 'NOT_FOUND'
      });
    });

    test("a mirror registry's token is not sent to GitHub; a GitHub registry sends it", async () => {
      state.registry.source = 'https://mirror.example/marketplace.json';
      await fetchSkillFile('reg', 'x', 'references/a.md');
      expect(state.fetches.at(-1).headers.Authorization).toBeUndefined();

      state.registry.source =
        'https://raw.githubusercontent.com/o/market/main/.claude-plugin/marketplace.json';
      await fetchSkillFile('reg', 'x', 'references/a.md');
      expect(state.fetches.at(-1).headers.Authorization).toBe('Bearer secret');
    });

    test('a file name with a space is fetched percent-encoded', async () => {
      state.items[0].source.companions = ['references/the guide.md'];
      state.files[`${DIR}/references/the%20guide.md`] = '# Guide\n';
      expect(await fetchSkillFile('reg', 'x', 'references/the guide.md')).toBe('# Guide\n');
    });

    test('a file over 512 KB and a binary file are refused with a typed error', async () => {
      state.items[0].source.companions = ['assets/big.txt', 'assets/blob.dat'];
      state.files[`${DIR}/assets/big.txt`] = 'a'.repeat(512 * 1024 + 1);
      state.files[`${DIR}/assets/blob.dat`] = 'abc\u0000def';
      await expect(fetchSkillFile('reg', 'x', 'assets/big.txt')).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE'
      });
      await expect(fetchSkillFile('reg', 'x', 'assets/blob.dat')).rejects.toMatchObject({
        code: 'UNSUPPORTED_MEDIA_TYPE'
      });
    });

    test('a JSON companion that looks like a GitHub wrapper is left as it is', async () => {
      const json = JSON.stringify({ content: 'aGk=', encoding: 'base64' });
      state.items[0].source.companions = ['assets/data.json'];
      state.files[`${DIR}/assets/data.json`] = json;
      expect(await fetchSkillFile('reg', 'x', 'assets/data.json')).toBe(json);
    });
  });
});
