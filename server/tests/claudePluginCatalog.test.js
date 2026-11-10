// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Claude Code plugin marketplaces as registries: a `marketplace.json` with a
 * `plugins` array becomes one skill catalog item per SKILL.md the plugins ship.
 *
 * The plugin entries below have the shapes of Anthropic's
 * `knowledge-work-plugins` and `claude-plugins-official` (relative source,
 * nested relative source, `git-subdir`, `url`, `command`, a `skills` field).
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports, run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import os from 'os';

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => os.tmpdir()
}));

const throttledFetch = jest.fn();
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch,
  throttledRun: (_id, fn) => fn()
}));

const { default: registryService } = await import('../services/marketplace/RegistryService.js');
const { buildPluginSkillItems, resolvePluginRoot, findSkillDirs, findCompanions, indexTree } =
  await import('../services/marketplace/claudePluginCatalog.js');

const OWN = { owner: 'anthropics', repo: 'knowledge-work-plugins', ref: 'main' };

const blob = p => ({ path: p, type: 'blob' });

/** The file trees of the repositories, by `owner/repo@ref`. */
const TREES = {
  'anthropics/knowledge-work-plugins@main': [
    blob('productivity/skills/memory-management/SKILL.md'),
    blob('productivity/skills/memory-management/references/format.md'),
    blob('productivity/skills/memory-management/assets/logo.png'),
    blob('productivity/skills/task-management/SKILL.md'),
    blob('productivity/commands/start.md'),
    blob('partner-built/slack/skills/slack-messaging/SKILL.md'),
    blob('partner-built/slack/skills/slack-messaging/scripts/post.py'),
    blob('commands-only/commands/run.md')
  ],
  'Noibu/ai-plugin@9fa2eddc3a86937b7956dedfaab32fac6cabf868': [
    blob('src/skills/triage/SKILL.md'),
    blob('src/skills/triage/references/a.md'),
    blob('other/skills/ignored/SKILL.md')
  ],
  'tavily-ai/skills@778122e5f9c680f541eeceda5a5b36405eb7980c': [
    blob('SKILL.md'),
    blob('references/api.md'),
    blob('commands/x.md'),
    blob('skills/search/SKILL.md')
  ],
  'coursera/skills@ac28fd6ebf8584e3ee196159bd6d4514fa07de0f': [
    blob('skills/learn-with-coursera/SKILL.md'),
    blob('skills/learn-with-coursera/data.json'),
    blob('skills/other/SKILL.md')
  ]
};

const plugins = [
  { name: 'productivity', source: './productivity', description: 'Tasks and memory' },
  {
    name: 'slack-by-salesforce',
    source: './partner-built/slack',
    description: 'Slack',
    category: 'communication'
  },
  { name: 'commands-only', source: './commands-only', description: 'No skills' },
  {
    name: 'noibu',
    description: 'Ecommerce',
    source: {
      source: 'git-subdir',
      url: 'https://github.com/Noibu/ai-plugin.git',
      path: 'src',
      ref: 'main',
      sha: '9fa2eddc3a86937b7956dedfaab32fac6cabf868'
    }
  },
  {
    name: 'tavily',
    description: 'Search',
    version: '2.1.0',
    source: {
      source: 'url',
      url: 'https://github.com/tavily-ai/skills.git',
      sha: '778122e5f9c680f541eeceda5a5b36405eb7980c'
    }
  },
  {
    name: 'learn-with-coursera',
    description: 'Learn',
    strict: false,
    skills: ['./learn-with-coursera'],
    source: {
      source: 'git-subdir',
      url: 'https://github.com/coursera/skills.git',
      path: 'skills',
      ref: 'main',
      sha: 'ac28fd6ebf8584e3ee196159bd6d4514fa07de0f'
    }
  },
  { name: 'xcode', source: { source: 'command', command: 'xcrun agent plugin path' } },
  { name: 'gitlab-plugin', source: { source: 'url', url: 'https://gitlab.com/o/r.git' } },
  { name: 'escape', source: './../outside' }
];

const makeLogger = () => ({ warn: jest.fn(), info: jest.fn() });

const fetchTree = jest.fn(async (owner, repo, ref) => {
  const tree = TREES[`${owner}/${repo}@${ref}`];
  if (!tree) throw new Error('GitHub tree API: HTTP 404');
  return tree;
});

beforeEach(() => {
  fetchTree.mockClear();
  throttledFetch.mockReset();
});

describe('resolvePluginRoot', () => {
  test('relative source belongs to the marketplace repository', () => {
    expect(resolvePluginRoot({ source: './plugins/a/' }, OWN)).toEqual({
      ...OWN,
      dir: 'plugins/a'
    });
    expect(resolvePluginRoot({ source: './' }, OWN)).toEqual({ ...OWN, dir: '' });
  });

  test('a relative source needs a GitHub marketplace', () => {
    expect(resolvePluginRoot({ source: './a' }, null).skip).toMatch(/GitHub/);
  });

  test('a path that leaves the repository is refused', () => {
    expect(resolvePluginRoot({ source: './../x' }, OWN).skip).toMatch(/unsafe/);
    expect(
      resolvePluginRoot(
        { source: { source: 'git-subdir', url: 'https://github.com/o/r', path: '../x' } },
        OWN
      ).skip
    ).toMatch(/unsafe/);
  });

  test('github, url and git-subdir sources; the commit pins over the ref', () => {
    expect(
      resolvePluginRoot({ source: { source: 'github', repo: 'o/r', ref: 'v1' } }, OWN)
    ).toEqual({ owner: 'o', repo: 'r', ref: 'v1', dir: '' });
    expect(
      resolvePluginRoot(
        { source: { source: 'url', url: 'https://github.com/o/r.git', ref: 'v1', sha: 'abc' } },
        OWN
      )
    ).toEqual({ owner: 'o', repo: 'r', ref: 'abc', dir: '' });
    expect(
      resolvePluginRoot(
        { source: { source: 'git-subdir', url: 'https://github.com/o/r', path: 'p' } },
        OWN
      )
    ).toEqual({ owner: 'o', repo: 'r', ref: 'HEAD', dir: 'p' });
  });

  test('other source types and hosts are skipped', () => {
    expect(resolvePluginRoot({ source: { source: 'npm', package: 'x' } }, OWN).skip).toMatch(/npm/);
    expect(
      resolvePluginRoot({ source: { source: 'url', url: 'https://gitlab.com/o/r.git' } }, OWN).skip
    ).toMatch(/not on GitHub/);
    expect(resolvePluginRoot({}, OWN).skip).toBeTruthy();
  });
});

describe('findSkillDirs / findCompanions', () => {
  const { skillDirs, blobs } = indexTree(
    TREES['tavily-ai/skills@778122e5f9c680f541eeceda5a5b36405eb7980c']
  );

  test('root skill plus the default skills folder', () => {
    expect(findSkillDirs({}, '', skillDirs)).toEqual(['', 'skills/search']);
  });

  test('a root skill keeps only its conventional subfolders, never other skills or commands', () => {
    expect(findCompanions(blobs, '', skillDirs, { rootSkill: true }).companions).toEqual([
      'references/api.md'
    ]);
  });

  test('custom `skills` paths are relative to the plugin root and may not escape it', () => {
    const { skillDirs: dirs } = indexTree(
      TREES['coursera/skills@ac28fd6ebf8584e3ee196159bd6d4514fa07de0f']
    );
    expect(findSkillDirs({ skills: ['./learn-with-coursera', '../x'] }, 'skills', dirs)).toEqual([
      'skills/learn-with-coursera'
    ]);
  });

  test('binary files are not companions', () => {
    const { skillDirs: dirs, blobs: files } = indexTree(
      TREES['anthropics/knowledge-work-plugins@main']
    );
    expect(
      findCompanions(files, 'productivity/skills/memory-management', dirs, { rootSkill: false })
        .companions
    ).toEqual(['references/format.md']);
  });
});

describe('buildPluginSkillItems', () => {
  const run = (list = plugins, logger = makeLogger()) =>
    buildPluginSkillItems({
      plugins: list,
      owner: { name: 'Anthropic' },
      ownRepo: OWN,
      fetchTree,
      logger
    }).then(items => ({ items, logger }));

  test('one skill item per SKILL.md, with raw URLs at the pinned revision', async () => {
    const { items } = await run();
    const byName = Object.fromEntries(items.map(i => [i.name, i]));

    expect(Object.keys(byName).sort()).toEqual([
      'learn-with-coursera-learn-with-coursera',
      'noibu-triage',
      'productivity-memory-management',
      'productivity-task-management',
      'slack-by-salesforce-slack-messaging',
      'tavily',
      'tavily-search'
    ]);

    expect(byName['productivity-memory-management'].source).toEqual({
      type: 'url',
      url: 'https://raw.githubusercontent.com/anthropics/knowledge-work-plugins/main/productivity/skills/memory-management/SKILL.md',
      companions: ['references/format.md'],
      rawBase: 'https://raw.githubusercontent.com/anthropics/knowledge-work-plugins/main'
    });
    expect(byName['noibu-triage'].source.url).toBe(
      'https://raw.githubusercontent.com/Noibu/ai-plugin/9fa2eddc3a86937b7956dedfaab32fac6cabf868/src/skills/triage/SKILL.md'
    );
    expect(byName['noibu-triage'].source.companions).toEqual(['references/a.md']);
    // The folder `other/` is outside the plugin's `path`.
    expect(Object.keys(byName)).not.toContain('noibu-ignored');
  });

  test('item fields', async () => {
    const { items } = await run();
    const slack = items.find(i => i.name === 'slack-by-salesforce-slack-messaging');
    expect(slack).toMatchObject({
      type: 'skill',
      displayName: { en: 'Slack Messaging' },
      description: { en: 'Slack' },
      author: 'Anthropic',
      category: 'Communication',
      tags: ['slack-by-salesforce'],
      version: undefined
    });
    // The commit is the version of a plugin without one; a declared version wins.
    expect(items.find(i => i.name === 'noibu-triage').version).toBe('9fa2edd');
    expect(items.find(i => i.name === 'tavily').version).toBe('2.1.0');
    // The root skill carries the plugin's own name.
    expect(items.find(i => i.name === 'tavily').source.url).toMatch(/\/778122e[^/]*\/SKILL\.md$/);
  });

  test('every repository and revision is listed once', async () => {
    await run([
      { name: 'a', source: './productivity' },
      { name: 'b', source: './partner-built/slack' }
    ]);
    expect(fetchTree).toHaveBeenCalledTimes(1);
  });

  test('plugins that cannot be read are skipped and logged, not fatal', async () => {
    const { items, logger } = await run();
    expect(items.some(i => i.name.startsWith('xcode'))).toBe(false);
    const [message, context] = logger.warn.mock.calls.find(([m]) => /not imported/.test(m));
    expect(message).toMatch(/plugin\(s\) of the marketplace were not imported/);
    const reasons = Object.fromEntries(context.skipped.map(s => [s.plugin, s.reason]));
    expect(reasons.xcode).toMatch(/command/);
    expect(reasons['gitlab-plugin']).toMatch(/GitHub/);
    expect(reasons.escape).toMatch(/unsafe/);
  });

  test('a repository that cannot be read leaves its plugins out', async () => {
    const { items } = await run([
      { name: 'productivity', source: './productivity' },
      { name: 'gone', source: { source: 'github', repo: 'nobody/gone' } }
    ]);
    expect(items.map(i => i.name)).toEqual([
      'productivity-memory-management',
      'productivity-task-management'
    ]);
  });

  test('stops asking GitHub after a rate limit', async () => {
    const limited = jest.fn(async (owner, repo) => {
      if (repo === 'a') throw new Error('GitHub tree API: HTTP 403');
      return [];
    });
    const logger = makeLogger();
    await buildPluginSkillItems({
      plugins: Array.from({ length: 12 }, (_, i) => ({
        name: `p${i}`,
        source: { source: 'github', repo: `o/${i === 0 ? 'a' : `r${i}`}` }
      })),
      ownRepo: null,
      fetchTree: limited,
      logger
    });
    // Four at a time: the first batch is already in flight, the rest is not asked.
    expect(limited.mock.calls.length).toBeLessThan(12);
  });

  test("the marketplace's own repository failing is an error", async () => {
    await expect(
      buildPluginSkillItems({
        plugins: [{ name: 'a', source: './a' }],
        ownRepo: { owner: 'x', repo: 'missing', ref: 'main' },
        fetchTree,
        logger: makeLogger()
      })
    ).rejects.toThrow(/404/);
  });

  test('a skill name that is not a folder name is left out', async () => {
    const items = await buildPluginSkillItems({
      plugins: [{ name: 'p', source: './p' }],
      ownRepo: OWN,
      fetchTree: async () => [blob('p/skills/bad name/SKILL.md'), blob('p/skills/ok/SKILL.md')],
      logger: makeLogger()
    });
    expect(items.map(i => i.name)).toEqual(['p-ok']);
  });
});

describe('fetchCatalog of a plugin marketplace', () => {
  const MARKETPLACE =
    'https://raw.githubusercontent.com/anthropics/knowledge-work-plugins/refs/heads/main/.claude-plugin/marketplace.json';
  const REGISTRY = {
    id: 'anthropic',
    name: 'Anthropic',
    source: MARKETPLACE,
    auth: { type: 'none' }
  };

  const json = body => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  test('reads the marketplace and the trees, and validates as a catalog', async () => {
    const urls = [];
    throttledFetch.mockImplementation(async (_id, url) => {
      urls.push(url);
      if (url === MARKETPLACE) {
        return json({ name: 'knowledge-work-plugins', owner: { name: 'Anthropic' }, plugins });
      }
      const match = url.match(
        /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^?]+)\?recursive=1$/
      );
      const tree = match && TREES[`${match[1]}/${match[2]}@${match[3]}`];
      if (!tree) {
        return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null } };
      }
      return json({ tree });
    });

    const catalog = await registryService.fetchCatalog(REGISTRY);

    expect(catalog.name).toBe('knowledge-work-plugins');
    expect(catalog.items.map(i => i.name)).toContain('productivity-memory-management');
    expect(catalog.items.every(i => i.type === 'skill')).toBe(true);
    // The marketplace's own tree is read at the branch of the URL.
    expect(urls).toContain(
      'https://api.github.com/repos/anthropics/knowledge-work-plugins/git/trees/main?recursive=1'
    );
  });

  test('the registry token goes to GitHub only when the registry is on GitHub', async () => {
    const seen = [];
    throttledFetch.mockImplementation(async (_id, url, options) => {
      seen.push({ url, headers: options.headers });
      if (url.startsWith('https://mirror.example/')) {
        return json({
          plugins: [{ name: 'x', source: { source: 'github', repo: 'o/r' } }]
        });
      }
      return json({ tree: [] });
    });
    const auth = { type: 'bearer', token: 'secret' };

    await registryService.fetchCatalog({
      id: 'mirror',
      source: 'https://mirror.example/marketplace.json',
      auth
    });
    const mirrorTree = seen.find(c => c.url.includes('api.github.com'));
    expect(mirrorTree.headers.Authorization).toBeUndefined();

    seen.length = 0;
    throttledFetch.mockImplementation(async (_id, url, options) => {
      seen.push({ url, headers: options.headers });
      if (url.endsWith('marketplace.json')) {
        return json({ plugins: [{ name: 'x', source: { source: 'github', repo: 'o/r' } }] });
      }
      return json({ tree: [] });
    });
    await registryService.fetchCatalog({ ...REGISTRY, auth });
    const githubTree = seen.find(c => c.url.includes('api.github.com'));
    expect(githubTree.headers.Authorization).toBe('Bearer secret');
  });
});
