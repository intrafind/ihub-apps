import { jest, describe, it, expect, beforeAll } from '@jest/globals';

/**
 * Skill sub-resources on the MCP gateway.
 *
 * A SKILL.md that says "see references/query-cookbook.md" is a dead end for an
 * external caller unless the bundled file is reachable too — `read_skill_resource`
 * wraps filesystem access and is deliberately kept out of the gateway. These
 * tests cover the two halves of the replacement: the files a skill bundles are
 * enumerated as resources of their own, and a read resolves only paths the
 * loader itself reported.
 */

const getSkillContentMock = jest.fn();
const getSkillResourceMock = jest.fn();

const skill = {
  name: 'ifinder-search',
  description: 'Search an IntraFind iFinder enterprise index',
  enabled: true
};

jest.unstable_mockModule('../../configCache.js', () => ({
  __esModule: true,
  default: {
    getSkills: () => ({ data: [skill] }),
    getSources: () => ({ data: [] }),
    getApps: () => ({ data: [] }),
    getPlatform: () => ({ defaultLanguage: 'en' })
  }
}));

jest.unstable_mockModule('../../services/skillLoader.js', () => ({
  __esModule: true,
  getSkillContent: (...args) => getSkillContentMock(...args),
  getSkillResource: (...args) => getSkillResourceMock(...args),
  validateSkillName: name => ({ valid: /^[a-z0-9-]+$/.test(name) })
}));

jest.unstable_mockModule('../../services/mcp/permissions.js', () => ({
  __esModule: true,
  getVisibleSourceIds: async () => new Set()
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
}));

let listMcpResources;
let readMcpResource;

beforeAll(async () => {
  ({ listMcpResources, readMcpResource } = await import('../../services/mcp/resourceAdapter.js'));
  getSkillContentMock.mockResolvedValue({
    body: '# Searching iFinder',
    references: ['references/query-cookbook.md', 'references/field-reference.md'],
    scripts: [],
    assets: ['assets/logo.png', 'assets/templates']
  });
});

const user = { id: 'u1' };
const expose = { resources: true };

describe('skill sub-resources', () => {
  it('lists the skill itself and every file it bundles', async () => {
    const resources = await listMcpResources({ user, platform: {}, expose });
    const uris = resources.map(r => r.uri);

    expect(uris).toContain('ihub://skill/ifinder-search');
    expect(uris).toContain('ihub://skill/ifinder-search/references/query-cookbook.md');
    expect(uris).toContain('ihub://skill/ifinder-search/references/field-reference.md');
  });

  it('leaves out binary assets and subdirectories', async () => {
    // The loader reads a resource as UTF-8: a PNG would arrive corrupted and a
    // directory is not readable at all, so neither is advertised.
    const resources = await listMcpResources({ user, platform: {}, expose });
    const uris = resources.map(r => r.uri);

    expect(uris).not.toContain('ihub://skill/ifinder-search/assets/logo.png');
    expect(uris).not.toContain('ihub://skill/ifinder-search/assets/templates');
  });

  it('refuses to read a binary asset', async () => {
    getSkillResourceMock.mockClear();

    await expect(
      readMcpResource('ihub://skill/ifinder-search/assets/logo.png', { user, platform: {} })
    ).rejects.toThrow(/Skill resource not found/);
    expect(getSkillResourceMock).not.toHaveBeenCalled();
  });

  it('reads a bundled reference', async () => {
    getSkillResourceMock.mockResolvedValueOnce('## Worked queries');

    const result = await readMcpResource(
      'ihub://skill/ifinder-search/references/query-cookbook.md',
      { user, platform: {} }
    );

    expect(result.contents[0].text).toBe('## Worked queries');
    expect(result.contents[0].mimeType).toBe('text/markdown');
    // The path handed to the loader is the enumerated entry, not the raw URI.
    expect(getSkillResourceMock).toHaveBeenCalledWith(
      'ifinder-search',
      'references/query-cookbook.md'
    );
  });

  it('still reads the SKILL.md body when no path is given', async () => {
    const result = await readMcpResource('ihub://skill/ifinder-search', { user, platform: {} });
    expect(result.contents[0].text).toBe('# Searching iFinder');
  });

  it('refuses a path the skill does not bundle', async () => {
    getSkillResourceMock.mockClear();

    await expect(
      readMcpResource('ihub://skill/ifinder-search/references/secrets.md', { user, platform: {} })
    ).rejects.toThrow(/Skill resource not found/);
    // Never reaches the filesystem: membership in the enumerated list is what
    // certifies the path, exactly as the source branch certifies a source id.
    expect(getSkillResourceMock).not.toHaveBeenCalled();
  });

  it('refuses a traversal path', async () => {
    getSkillResourceMock.mockClear();

    await expect(
      readMcpResource('ihub://skill/ifinder-search/..%2F..%2Fetc%2Fpasswd', {
        user,
        platform: {}
      })
    ).rejects.toThrow(/Skill resource not found/);
    expect(getSkillResourceMock).not.toHaveBeenCalled();
  });
});
