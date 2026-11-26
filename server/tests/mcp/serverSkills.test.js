// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import { McpServerConnection } from '../../services/mcp/McpServerConnection.js';
import {
  approveInstallationSkill,
  clearServerSkillCache,
  entryDigest,
  listInstallationSkills,
  loadServerSkill,
  parseServerSkillId,
  readInstallationSkillFile,
  revokeInstallationSkill,
  serverSkillId,
  usableServerSkills
} from '../../services/mcp/mcpSkills.js';

/**
 * Skills of a connected MCP server (MCP Skills extension) through iHub's own
 * connection, on both protocol eras: listed for the admin, approved against
 * the files the server serves, loaded for a chat — and refused once the
 * server serves something else than was approved.
 */

const SKILL_MD = `---
name: deploy
description: How to deploy a billing project safely
---
Check the plan with the checklist, then call deploy_project.
`;

/** The server's skill files; a test changes them to play a server that changed. */
let files;
function resetFiles() {
  files = {
    deploy: { 'SKILL.md': SKILL_MD, 'references/CHECKLIST.md': '1. Plan\n2. Deploy\n' },
    // Two skills by one name: iHub cannot tell which one an approval means.
    report: { 'SKILL.md': '---\nname: report\ndescription: Monthly report\n---\nA\n' },
    'archive/report': { 'SKILL.md': '---\nname: report\ndescription: Old report\n---\nB\n' }
  };
}

/** A SkillSource over `files`, built on every request so a change shows at once. */
function skillSource() {
  const build = async () => {
    const built = [];
    for (const [path, texts] of Object.entries(files)) {
      try {
        const entry = await skillEntry(path, texts, { baseUri: 'skill://' });
        built.push({ entry, texts });
      } catch {
        // A skill the SDK refuses to describe is not served.
      }
    }
    return built;
  };
  const fileOf = async uri => {
    for (const { entry, texts } of await build()) {
      const root = entry.uri.slice(0, -'SKILL.md'.length);
      if (!uri.startsWith(root)) continue;
      const text = texts[uri.slice(root.length)];
      if (text !== undefined) return { text, mimeType: 'text/markdown' };
    }
    return undefined;
  };
  return {
    async list() {
      return { skills: (await build()).map(skill => skill.entry) };
    },
    async get(uri) {
      return (await build()).find(skill => skill.entry.uri === uri)?.entry;
    },
    read: fileOf
  };
}

const built = [];
function buildServer() {
  const server = new McpServer({ name: 'billing', version: '1.0.0' });
  built.push(server);
  new SkillsExtension({ source: skillSource() }).attach(server);
  return server;
}

let httpServer;
let baseUrl;
beforeAll(async () => {
  const modern = toNodeHandler(createMcpHandler(buildServer, { legacy: 'reject' }));
  const sessions = new Map();
  httpServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    if (req.url === '/modern') return modern(req, res, parsed);
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId && sessions.get(sessionId);
    if (!transport) {
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => sessions.set(id, transport)
      });
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, parsed);
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});
afterAll(
  () =>
    new Promise(resolve => {
      Promise.allSettled(built.map(server => server.close())).then(() => {
        httpServer.closeAllConnections();
        httpServer.close(resolve);
      });
    })
);

const admin = { id: 'admin', groups: ['admins'] };
const user = { id: 'alice', groups: ['users'] };
const app = { id: 'billing-assistant', skillSettings: { enabled: true } };

/** iHub around one installation `billing` and its connection. */
function harness(path) {
  const conn = new McpServerConnection(
    {
      id: 'billing',
      name: 'Billing',
      transport: { type: 'streamableHttp', url: `${baseUrl}${path}` },
      timeoutMs: 5000
    },
    { blockPrivateIps: false, allowedHosts: [] }
  );
  let instance = { id: 'billing', label: 'Billing', enabled: true };
  const deps = {
    manager: {
      hasServer: id => id === 'billing',
      withUserConnection: (_id, _user, operation) => operation(conn)
    },
    installations: {
      get: id => (id === 'billing' ? instance : null),
      setSkillApproval: async (_id, name, approval) => {
        const approved = { ...(instance.skills?.approved || {}) };
        if (approval) approved[name] = approval;
        else delete approved[name];
        instance = { ...instance, skills: { approved } };
        return instance;
      }
    },
    boundInstanceIds: () => ['billing'],
    userMayUse: () => true
  };
  return { conn, deps, instance: () => instance };
}

/** Approve a skill as an admin does: list it, then approve what was listed. */
async function approve(h, name) {
  const { items } = await listInstallationSkills('billing', admin, h.deps);
  const item = items.find(entry => entry.name === name);
  return approveInstallationSkill('billing', name, admin, h.deps, { digest: item?.digest });
}

describe.each([
  ['2026-07-28', '/modern'],
  ['2025-era session', '/legacy']
])('skills of an MCP server (%s)', (_label, path) => {
  let h;
  beforeEach(() => {
    resetFiles();
    clearServerSkillCache();
    h = harness(path);
  });

  it('lists the skills for the admin, with what cannot be approved and why', async () => {
    try {
      const { items } = await listInstallationSkills('billing', admin, h.deps);
      const deploy = items.find(item => item.name === 'deploy');
      expect(deploy).toMatchObject({
        status: 'available',
        description: 'How to deploy a billing project safely',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'SKILL.md' }),
          expect.objectContaining({ path: 'references/CHECKLIST.md' })
        ])
      });
      const reports = items.filter(item => item.name === 'report');
      expect(reports).toHaveLength(2);
      for (const report of reports) {
        expect(report).toMatchObject({ status: 'not_approvable', reason: 'duplicate_name' });
      }
      await expect(approve(h, 'report')).rejects.toMatchObject({ code: 'SKILL_NOT_APPROVABLE' });
    } finally {
      await h.conn.disconnect();
    }
  });

  it('approves a skill, which a chat then loads under the installation’s name', async () => {
    try {
      const item = await approve(h, 'deploy');
      expect(item).toMatchObject({ name: 'deploy', status: 'approved', approvedBy: 'admin' });
      expect(h.instance().skills.approved.deploy.resources).toHaveLength(2);

      const [usable] = await usableServerSkills({ app, user, deps: h.deps });
      expect(usable).toMatchObject({ id: 'billing:deploy', serverName: 'Billing' });

      const skill = await loadServerSkill('billing:deploy', { app, user, deps: h.deps });
      expect(skill).toMatchObject({
        name: 'billing:deploy',
        displayName: 'deploy',
        resources: ['references/CHECKLIST.md']
      });
      expect(skill.body).toContain('Check the plan with the checklist');
      expect(skill.body).not.toContain('description:');
      expect(await skill.readFile('references/CHECKLIST.md')).toBe('1. Plan\n2. Deploy\n');
      expect(await skill.readFile('references/OTHER.md')).toBeNull();
    } finally {
      await h.conn.disconnect();
    }
  });

  it('refuses a skill the server changed since it was approved, until it is approved again', async () => {
    try {
      await approve(h, 'deploy');
      // Loaded once: its files are cached.
      expect(await loadServerSkill('billing:deploy', { app, user, deps: h.deps })).not.toBeNull();

      files.deploy['references/CHECKLIST.md'] = '1. Deploy\n';
      const { items } = await listInstallationSkills('billing', admin, h.deps);
      expect(items.find(item => item.name === 'deploy').status).toBe('changed');
      // The connection's listing is reused for a minute; a reconnect asks anew.
      await h.conn.disconnect();
      expect(await loadServerSkill('billing:deploy', { app, user, deps: h.deps })).toBeNull();

      await approve(h, 'deploy');
      const again = await loadServerSkill('billing:deploy', { app, user, deps: h.deps });
      expect(await again.readFile('references/CHECKLIST.md')).toBe('1. Deploy\n');
    } finally {
      await h.conn.disconnect();
    }
  });

  it('approves only what the admin reviewed: a skill changed since the listing is refused', async () => {
    try {
      const { items } = await listInstallationSkills('billing', admin, h.deps);
      const reviewed = items.find(item => item.name === 'deploy').digest;
      files.deploy['references/CHECKLIST.md'] = '1. Something else\n';
      await expect(
        approveInstallationSkill('billing', 'deploy', admin, h.deps, { digest: reviewed })
      ).rejects.toMatchObject({ code: 'SKILL_LISTING_CHANGED' });
      expect(h.instance().skills).toBeUndefined();
    } finally {
      await h.conn.disconnect();
    }
  });

  it('lets the admin read a file before approving', async () => {
    try {
      const skillMd = await readInstallationSkillFile(
        'billing',
        'deploy',
        'SKILL.md',
        admin,
        h.deps
      );
      expect(skillMd).toMatchObject({ path: 'SKILL.md' });
      expect(skillMd.text).toContain('name: deploy');
      expect(
        await readInstallationSkillFile(
          'billing',
          'deploy',
          'references/CHECKLIST.md',
          admin,
          h.deps
        )
      ).toMatchObject({ text: '1. Plan\n2. Deploy\n' });
      await expect(
        readInstallationSkillFile('billing', 'deploy', '../secret', admin, h.deps)
      ).rejects.toMatchObject({ code: 'SERVER_SKILL_NOT_FOUND' });
    } finally {
      await h.conn.disconnect();
    }
  });

  it('never answers one connection’s read from another’s cache', async () => {
    const other = harness(path);
    try {
      await approve(h, 'deploy');
      const first = await loadServerSkill('billing:deploy', { app, user, deps: h.deps });
      expect(await first.readFile('references/CHECKLIST.md')).toBe('1. Plan\n2. Deploy\n');
      // The second user's connection reads for itself: a server that refuses
      // them the file is not bypassed by the first user's cached copy.
      other.deps.installations = h.deps.installations;
      other.conn.readSkillFile = async () => {
        throw new Error('not for you');
      };
      const second = await loadServerSkill('billing:deploy', { app, user, deps: other.deps });
      expect(second).toBeNull();
    } finally {
      await h.conn.disconnect();
      await other.conn.disconnect();
    }
  });

  it('withdraws an approval; an approved skill the server dropped shows as missing', async () => {
    try {
      await approve(h, 'deploy');
      delete files.deploy;
      const { items } = await listInstallationSkills('billing', admin, h.deps);
      expect(items.find(item => item.name === 'deploy').status).toBe('missing');

      await revokeInstallationSkill('billing', 'deploy', h.deps);
      expect(await usableServerSkills({ app, user, deps: h.deps })).toEqual([]);
      await expect(revokeInstallationSkill('billing', 'deploy', h.deps)).rejects.toMatchObject({
        code: 'SERVER_SKILL_NOT_FOUND'
      });
    } finally {
      await h.conn.disconnect();
    }
  });
});

describe('server skill ids and access', () => {
  it('names a server skill by installation and skill', () => {
    expect(serverSkillId('billing', 'deploy')).toBe('billing:deploy');
    expect(parseServerSkillId('billing:deploy')).toEqual({ instanceId: 'billing', name: 'deploy' });
    for (const id of ['deploy', 'billing:', ':deploy', 'a:b:c', 'billing:Bad', 'usk_1']) {
      expect(parseServerSkillId(id)).toBeNull();
    }
  });

  it('binds an approval to the whole entry, not to the order of its files', () => {
    const entry = {
      uri: 'skill://deploy/SKILL.md',
      frontmatter: { name: 'deploy', description: 'x' },
      resources: [
        { uri: 'skill://deploy/a', digest: `sha256:${'a'.repeat(64)}`, size: 1 },
        { uri: 'skill://deploy/b', digest: `sha256:${'b'.repeat(64)}`, size: 2 }
      ]
    };
    const reordered = { ...entry, resources: [...entry.resources].reverse() };
    expect(entryDigest(reordered)).toBe(entryDigest(entry));
    expect(
      entryDigest({ ...entry, frontmatter: { ...entry.frontmatter, 'allowed-tools': 'x' } })
    ).not.toBe(entryDigest(entry));
  });

  it('offers nothing to an agent node, a disabled installation or a user it is not granted to', async () => {
    const approval = {
      uri: 'skill://deploy/SKILL.md',
      frontmatter: { name: 'deploy', description: 'Deploy' },
      resources: [{ uri: 'skill://deploy/SKILL.md', digest: `sha256:${'a'.repeat(64)}`, size: 1 }],
      approvedAt: '2026-11-26T00:00:00.000Z'
    };
    const deps = instance => ({
      manager: { hasServer: () => true },
      installations: { get: () => instance },
      boundInstanceIds: () => ['billing'],
      userMayUse: (_instance, who) => who.id === 'alice'
    });
    const approved = { id: 'billing', enabled: true, skills: { approved: { deploy: approval } } };
    expect(await usableServerSkills({ app, user, deps: deps(approved) })).toHaveLength(1);
    expect(
      await usableServerSkills({ app: { ...app, _skillIds: [] }, user, deps: deps(approved) })
    ).toEqual([]);
    expect(
      await usableServerSkills({ app, user, deps: deps({ ...approved, enabled: false }) })
    ).toEqual([]);
    expect(
      await usableServerSkills({ app, user: { id: 'bob', groups: [] }, deps: deps(approved) })
    ).toEqual([]);
  });
});
