/**
 * Tests for server/utils/frontMatter.js — Markdown front matter is parsed as
 * YAML only — and for the two places that read front matter through it: the
 * skill loader (SKILL.md files on disk) and the marketplace item preview
 * (RegistryService.getItemDetail).
 *
 * Front matter that declares a non-YAML language must be rejected before any
 * parser for that language runs. Each such case carries a block that would set
 * `globalThis.__frontMatterSentinel` if it were ever evaluated, and the tests
 * assert the sentinel stays unset.
 *
 * The repo's source is native ESM, so mocks use `jest.unstable_mockModule` +
 * dynamic imports. Run with `NODE_OPTIONS=--experimental-vm-modules` (the
 * `test:marketplace` npm script does).
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
// eslint-disable-next-line no-restricted-syntax -- the cache test below inspects gray-matter's own result cache
import matter from 'gray-matter';

// TokenStorageService (imported by RegistryService) reads getRootDir() at
// module load, so it must point at a real directory before the imports below.
const state = { rootDir: os.tmpdir() };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

// The marketplace preview fetches the item's content over HTTP.
const throttledFetch = jest.fn();
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch,
  throttledRun: (_id, fn) => fn()
}));

const { parseFrontMatter, FrontMatterError } = await import('../utils/frontMatter.js');
const { loadSkillsMetadata, getSkillContent, validateSkillDirectory } =
  await import('../services/skillLoader.js');
const { default: registryService } = await import('../services/marketplace/RegistryService.js');
const { default: logger } = await import('../utils/logger.js');

const SENTINEL = '__frontMatterSentinel';

/** A block that sets the sentinel if evaluated as code. */
const SENTINEL_BLOCK = `globalThis.${SENTINEL} = true`;

/**
 * Markdown whose front matter declares `language` and holds the sentinel block.
 *
 * @param {string} language - Text written right after the opening `---`
 * @returns {string}
 */
function withLanguage(language) {
  return `---${language}\n${SENTINEL_BLOCK}\n---\n# Body\n`;
}

const YAML_SKILL = `---
name: yaml-skill
description: A skill with YAML front matter
metadata:
  author: tests
---
# YAML skill

Instructions.
`;

beforeEach(() => {
  delete globalThis[SENTINEL];
});

afterEach(() => {
  delete globalThis[SENTINEL];
  jest.restoreAllMocks();
});

describe('parseFrontMatter', () => {
  test('parses YAML front matter and returns the body after it', () => {
    const result = parseFrontMatter(YAML_SKILL);

    expect(result.data).toEqual({
      name: 'yaml-skill',
      description: 'A skill with YAML front matter',
      metadata: { author: 'tests' }
    });
    expect(result.content).toBe('# YAML skill\n\nInstructions.\n');
  });

  test.each(['yaml', 'yml', 'YAML', ' yaml '])(
    'accepts front matter declared as "%s"',
    language => {
      const result = parseFrontMatter(`---${language}\ntitle: Hello\n---\nText`);

      expect(result.data).toEqual({ title: 'Hello' });
      expect(result.content).toBe('Text');
    }
  );

  test('returns content without front matter unchanged, with empty data', () => {
    expect(parseFrontMatter('# Just Markdown\n')).toEqual({
      data: {},
      content: '# Just Markdown\n'
    });
    expect(parseFrontMatter('')).toEqual({ data: {}, content: '' });
  });

  test('returns empty data for an empty YAML block', () => {
    expect(parseFrontMatter('---\n---\nBody')).toEqual({ data: {}, content: 'Body' });
  });

  test('parses YAML front matter after a byte-order mark', () => {
    const result = parseFrontMatter('﻿---\ntitle: Hello\n---\nText');

    expect(result.data).toEqual({ title: 'Hello' });
  });

  test.each([
    'js',
    'javascript',
    'JS',
    'JavaScript',
    'coffee',
    'coffeescript',
    'cson',
    'json',
    'toml'
  ])('rejects front matter in a non-YAML language: "%s"', language => {
    expect(() => parseFrontMatter(withLanguage(language))).toThrow(FrontMatterError);
    expect(globalThis[SENTINEL]).toBeUndefined();
  });

  test('rejects front matter in an unknown language', () => {
    expect(() => parseFrontMatter(withLanguage('ini'))).toThrow(FrontMatterError);
    expect(globalThis[SENTINEL]).toBeUndefined();
  });

  test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'rejects a language name that matches an Object.prototype member: "%s"',
    language => {
      expect(() => parseFrontMatter(withLanguage(language))).toThrow(FrontMatterError);
      expect(globalThis[SENTINEL]).toBeUndefined();
    }
  );

  test('rejects a non-YAML language after a byte-order mark', () => {
    expect(() => parseFrontMatter(`﻿${withLanguage('js')}`)).toThrow(FrontMatterError);
    expect(globalThis[SENTINEL]).toBeUndefined();
  });

  test('rejects a non-YAML language even when its block is empty', () => {
    expect(() => parseFrontMatter('---json\n---\nBody')).toThrow(FrontMatterError);
  });

  test('reports the declared language and a stable code on the error', () => {
    let caught;
    try {
      parseFrontMatter(withLanguage('JavaScript'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FrontMatterError);
    expect(caught.code).toBe('FRONT_MATTER_LANGUAGE_NOT_ALLOWED');
    expect(caught.language).toBe('JavaScript');
    expect(caught.message).toContain('only YAML front matter is accepted');
  });

  test('rejects YAML tags that construct JavaScript values', () => {
    const content = `---\nvalue: !!js/function "function () { ${SENTINEL_BLOCK}; }"\n---\nBody`;

    expect(() => parseFrontMatter(content)).toThrow(/unknown tag/);
    expect(globalThis[SENTINEL]).toBeUndefined();
  });

  test('does not return results from gray-matter’s content cache', () => {
    const content = '---\ntitle: Parsed\n---\nBody';
    // Seed gray-matter's cache for this exact content; a call that consulted
    // the cache would return this entry instead of parsing.
    matter.cache[content] = { data: { title: 'Cached' }, content: 'Cached body' };

    try {
      expect(parseFrontMatter(content)).toEqual({ data: { title: 'Parsed' }, content: 'Body' });
    } finally {
      matter.clearCache();
    }
  });

  test('does not add entries to gray-matter’s content cache', () => {
    matter.clearCache();

    parseFrontMatter('---\ntitle: Hello\n---\nText');

    expect(Object.keys(matter.cache)).toHaveLength(0);
  });

  test('throws a TypeError for non-string input', () => {
    expect(() => parseFrontMatter(Buffer.from('---\na: 1\n---\n'))).toThrow(TypeError);
    expect(() => parseFrontMatter(undefined)).toThrow(TypeError);
  });
});

describe('skillLoader front matter handling', () => {
  let skillsDir;

  /**
   * Create `<skillsDir>/<name>/SKILL.md`.
   *
   * @param {string} name - Skill directory name
   * @param {string} content - SKILL.md content
   * @returns {Promise<string>} The skill directory
   */
  async function writeSkill(name, content) {
    const dir = path.join(skillsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
    return dir;
  }

  beforeEach(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-front-matter-skills-'));
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
  });

  test('loads a skill with YAML front matter', async () => {
    await writeSkill('yaml-skill', YAML_SKILL);

    const skills = await loadSkillsMetadata(skillsDir);

    expect([...skills.keys()]).toEqual(['yaml-skill']);
    expect(skills.get('yaml-skill')).toMatchObject({
      description: 'A skill with YAML front matter',
      metadata: { author: 'tests' }
    });
  });

  test('skips a skill whose front matter is not YAML and keeps loading the others', async () => {
    await writeSkill('yaml-skill', YAML_SKILL);
    await writeSkill('js-skill', withLanguage('js'));

    const skills = await loadSkillsMetadata(skillsDir);

    expect([...skills.keys()]).toEqual(['yaml-skill']);
    expect(globalThis[SENTINEL]).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to parse SKILL.md',
      expect.objectContaining({
        filePath: path.join(skillsDir, 'js-skill', 'SKILL.md'),
        error: expect.any(FrontMatterError)
      })
    );
  });

  test('returns no content for a skill whose front matter is not YAML', async () => {
    await writeSkill('js-skill', withLanguage('javascript'));

    expect(await getSkillContent('js-skill', skillsDir)).toBeNull();
    expect(globalThis[SENTINEL]).toBeUndefined();
  });

  test('reports a skill directory with non-YAML front matter as invalid', async () => {
    const dir = await writeSkill('coffee-skill', withLanguage('coffee'));

    const result = await validateSkillDirectory(dir);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Failed to parse SKILL.md');
    expect(globalThis[SENTINEL]).toBeUndefined();
  });
});

describe('RegistryService item preview front matter handling', () => {
  const REGISTRY = {
    id: 'reg',
    name: 'Test Registry',
    source: 'https://registry.example/catalog.json',
    auth: { type: 'none' }
  };
  const ITEM = {
    type: 'skill',
    name: 'demo',
    source: { type: 'url', url: 'https://registry.example/skills/demo/SKILL.md' }
  };

  /** Minimal ConfigCache double with one registry and nothing installed. */
  const configCache = {
    getInstallations: () => ({ data: { installations: {} } }),
    getRegistries: () => ({ data: { registries: [REGISTRY] } }),
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    getPrompts: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] })
  };

  /**
   * Serve `content` as the item's SKILL.md and load the item detail.
   *
   * @param {string} content - Raw SKILL.md text returned by the registry
   * @returns {Promise<object>} The item detail
   */
  async function getDetailFor(content) {
    throttledFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => content
    });
    return registryService.getItemDetail('reg', 'skill', 'demo');
  }

  beforeEach(() => {
    throttledFetch.mockReset();
    jest.spyOn(registryService, '_getConfigCache').mockResolvedValue(configCache);
    jest
      .spyOn(registryService, 'getCachedCatalogAsync')
      .mockResolvedValue({ catalog: { items: [ITEM] } });
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  test('splits YAML front matter from the preview body', async () => {
    const detail = await getDetailFor('---\nname: demo\ndescription: Demo skill\n---\n# Demo\n');

    expect(detail.contentPreview).toEqual({
      body: '# Demo',
      frontmatter: { name: 'demo', description: 'Demo skill' }
    });
  });

  test('keeps a preview with non-YAML front matter as plain text', async () => {
    const content = withLanguage('js');

    const detail = await getDetailFor(content);

    expect(detail.name).toBe('demo');
    expect(detail.contentPreview).toBe(content);
    expect(globalThis[SENTINEL]).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not parse content preview frontmatter, showing it as plain text',
      expect.objectContaining({ error: expect.any(FrontMatterError) })
    );
  });
});
