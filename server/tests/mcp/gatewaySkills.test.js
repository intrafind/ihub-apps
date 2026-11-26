// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

/**
 * iHub's skills over the MCP Skills extension (`skills/list`, `skill://` files).
 *
 * Driven through the SDK's own `SkillsClient`, which checks every file it reads
 * against the size, SHA-256 digest and frontmatter the listing published: a
 * served byte that differs from the manifest fails these tests.
 */

const skills = [
  { name: 'ifinder-search', description: 'Search iFinder', enabled: true },
  { name: 'secret-skill', description: 'Only for admins', enabled: true },
  { name: 'switched-off', description: 'Disabled', enabled: false }
];

const files = {
  'ifinder-search': {
    'SKILL.md':
      '---\nname: ifinder-search\ndescription: Search iFinder\nallowed-tools: iFinder_search\n---\n# Raw body\n<!-- if-skill: other -->\n',
    'references/query-cookbook.md': '# Cookbook\n\nUse `AND`.\n'
  },
  'secret-skill': {
    'SKILL.md': '---\nname: secret-skill\ndescription: Only for admins\n---\n# Secret\n'
  }
};

jest.unstable_mockModule('../../configCache.js', () => ({
  __esModule: true,
  default: { getSkills: () => ({ data: skills }) }
}));

jest.unstable_mockModule('../../services/skillLoader.js', () => ({
  __esModule: true,
  // The loader resolves a system skill's body; the gateway serves that body.
  getSkillContent: async name =>
    files[name]
      ? {
          body: name === 'ifinder-search' ? '# Resolved body\n' : '# Secret\n',
          references: Object.keys(files[name]).filter(p => p.startsWith('references/')),
          scripts: [],
          // A binary asset is neither listed nor served.
          assets: name === 'ifinder-search' ? ['assets/logo.png'] : []
        }
      : null,
  getSkillResource: async (name, path) => files[name]?.[path] ?? null,
  validateSkillName: () => ({ valid: true })
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
}));

const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { SkillsClient } = await import('@modelcontextprotocol/client/ext/skills');
const { attachGatewaySkills, servedSkillMarkdown } =
  await import('../../services/mcp/gatewaySkills.js');

const userWith = granted => ({ id: 'u1', permissions: { skills: new Set(granted) } });

async function connect(user) {
  const server = new McpServer(
    { name: 'test', version: '0.0.0' },
    { capabilities: { resources: { listChanged: false } } }
  );
  attachGatewaySkills(server, { user });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, skillsClient: new SkillsClient(client) };
}

describe('servedSkillMarkdown', () => {
  it('keeps the frontmatter byte for byte and puts the resolved body after it', () => {
    expect(servedSkillMarkdown('---\nname: a\ndescription: b\n---\nraw', 'resolved')).toBe(
      '---\nname: a\ndescription: b\n---\nresolved'
    );
  });

  it('refuses a file without frontmatter', () => {
    expect(servedSkillMarkdown('# no frontmatter', 'body')).toBeNull();
    expect(servedSkillMarkdown(null, 'body')).toBeNull();
  });
});

describe('MCP Skills extension on the gateway', () => {
  let session;

  beforeEach(async () => {
    session = await connect(userWith(['ifinder-search']));
  });

  it('declares the extension and lists only the skills the caller may use', async () => {
    expect(session.client.getServerCapabilities()?.extensions).toHaveProperty([
      'io.modelcontextprotocol/skills'
    ]);
    const { skills: entries } = await session.skillsClient.list();
    expect(entries.map(entry => entry.uri)).toEqual(['skill://ifinder-search/SKILL.md']);
    expect(entries[0].frontmatter).toEqual({
      name: 'ifinder-search',
      description: 'Search iFinder',
      'allowed-tools': 'iFinder_search'
    });
    // SKILL.md and the text reference; the binary asset is not served.
    expect(entries[0].resources.map(resource => resource.uri)).toEqual(
      expect.arrayContaining([
        'skill://ifinder-search/SKILL.md',
        'skill://ifinder-search/references/query-cookbook.md'
      ])
    );
    expect(entries[0].resources).toHaveLength(2);
  });

  it('serves SKILL.md and its files so that they verify against the manifest', async () => {
    const { skills: entries } = await session.skillsClient.list();
    const manifest = await session.skillsClient.read(entries[0]);
    expect(manifest.verified).toBe(true);
    expect(manifest.body).toBe('# Resolved body\n');
    const reference = await session.skillsClient.read(entries[0], 'references/query-cookbook.md');
    expect(reference.verified).toBe(true);
    expect(reference.text).toBe('# Cookbook\n\nUse `AND`.\n');
  });

  it('answers skills/get for a visible skill and refuses another one', async () => {
    const { skill } = await session.skillsClient.get('skill://ifinder-search/SKILL.md');
    expect(skill.frontmatter.name).toBe('ifinder-search');
    await expect(session.skillsClient.get('skill://secret-skill/SKILL.md')).rejects.toThrow();
    await expect(
      session.client.readResource({ uri: 'skill://secret-skill/SKILL.md' })
    ).rejects.toThrow();
  });

  it('serves nothing to a caller whose groups grant no skill', async () => {
    const empty = await connect(userWith([]));
    const { skills: entries } = await empty.skillsClient.list();
    expect(entries).toEqual([]);
  });

  it('leaves out a disabled skill even with a wildcard grant', async () => {
    const all = await connect(userWith(['*']));
    const { skills: entries } = await all.skillsClient.list();
    expect(entries.map(entry => entry.frontmatter.name).sort()).toEqual([
      'ifinder-search',
      'secret-skill'
    ]);
  });
});
