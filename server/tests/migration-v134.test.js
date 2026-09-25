#!/usr/bin/env node

/**
 * Migration V134 specs — an empty MCP tool prefix is removed, so the server's
 * tools get the default `<id>__` prefix (a prefix an admin typed stays), and
 * app references to single MCP tools become references to their server.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description
} from '../migrations/V134__mcp_server_tool_refs.js';

let baseDir;

async function writeJson(dir, rel, data) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
}

/** A migration context over a scratch contents directory. */
function makeCtx(dir) {
  const logs = [];
  let writes = 0;
  return {
    logs,
    get writes() {
      return writes;
    },
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    listFiles: async (rel, pattern) => {
      const ext = pattern.replace('*', '');
      const entries = await fs.readdir(path.join(dir, rel)).catch(() => []);
      return entries.filter(name => name.endsWith(ext));
    },
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes++;
      await writeJson(dir, rel, data);
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/**
 * A scratch contents dir holding this mcpServers config (null = none), these
 * apps (`{ file: appJson }`) and these configured tools (by id).
 */
async function seed(mcpServers, { apps = {}, tools = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v134-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (mcpServers !== null) await writeJson(dir, 'config/mcpServers.json', mcpServers);
  for (const [file, app] of Object.entries(apps)) await writeJson(dir, `apps/${file}`, app);
  for (const id of tools) await writeJson(dir, `tools/${id}.json`, { id });
  return { dir, ctx: makeCtx(dir) };
}

const readServers = async dir =>
  JSON.parse(await fs.readFile(path.join(dir, 'config/mcpServers.json'), 'utf8')).servers;
const readApp = async (dir, file) =>
  JSON.parse(await fs.readFile(path.join(dir, `apps/${file}`), 'utf8'));

const server = (id, extra = {}) => ({
  id,
  name: { en: id },
  transport: { type: 'streamableHttp', url: `https://${id}.example/mcp` },
  ...extra
});

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v134-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V134 mcp_server_tool_refs', () => {
  it('declares its version and description', () => {
    assert.equal(version, '134');
    assert.equal(description, 'mcp_server_tool_refs');
  });

  it('skips an installation without mcpServers.json', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });

  it('removes an empty or blank prefix and keeps a typed one', async () => {
    const { dir, ctx } = await seed({
      servers: [
        server('drawio', { toolPrefix: '' }),
        server('excalidraw', { toolPrefix: '  ' }),
        server('github', { toolPrefix: 'gh_' }),
        server('jira')
      ]
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const servers = await readServers(dir);
    assert.equal('toolPrefix' in servers[0], false);
    assert.equal('toolPrefix' in servers[1], false);
    assert.equal(servers[2].toolPrefix, 'gh_');
    assert.equal('toolPrefix' in servers[3], false);
    // Nothing else about a server changes.
    assert.deepEqual(servers[0].transport, server('drawio').transport);
  });

  it('writes nothing when there is nothing to change', async () => {
    const { ctx } = await seed({ servers: [server('github', { toolPrefix: 'gh_' })] });
    await up(ctx);
    assert.equal(ctx.writes, 0);
  });

  it('tolerates a file without a servers array', async () => {
    const { ctx } = await seed({ security: { blockPrivateIps: true } });
    await up(ctx);
    assert.equal(ctx.writes, 0);
  });

  it('replaces prefixed single MCP tool references with the server id', async () => {
    const { dir, ctx } = await seed(
      { servers: [server('drawio'), server('github', { toolPrefix: 'gh_' })] },
      {
        apps: {
          'diagrams.json': {
            id: 'diagrams',
            tools: ['drawio__create_diagram', 'drawio__search_shapes', 'braveSearch']
          },
          'code.json': { id: 'code', tools: ['gh_search_repos', 'drawio'] }
        },
        tools: ['braveSearch']
      }
    );
    await up(ctx);
    assert.deepEqual((await readApp(dir, 'diagrams.json')).tools, ['drawio', 'braveSearch']);
    assert.deepEqual((await readApp(dir, 'code.json')).tools, ['github', 'drawio']);
  });

  it('ties a bare name to a formerly unprefixed server only through its allowlist', async () => {
    const { dir, ctx } = await seed(
      {
        servers: [
          server('drawio', { toolPrefix: '', allowedTools: ['create_diagram', 'search_shapes'] }),
          server('excalidraw', { toolPrefix: '' })
        ]
      },
      {
        apps: {
          'diagrams.json': {
            id: 'diagrams',
            tools: ['drawio', 'create_diagram', 'search_shapes', 'read_me', 'iFinder_search']
          }
        },
        tools: ['iFinder']
      }
    );
    await up(ctx);
    // `read_me` could belong to excalidraw (allowlist "*") or be anything else,
    // so it is left alone and reported. Configured tools are never touched.
    assert.deepEqual((await readApp(dir, 'diagrams.json')).tools, [
      'drawio',
      'read_me',
      'iFinder_search'
    ]);
    const warnings = ctx.logs.filter(([level]) => level === 'warn').map(([, m]) => m);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('read_me'));
    assert.ok(!warnings[0].includes('iFinder_search'));
  });

  it('leaves apps without MCP tool references unchanged', async () => {
    const original = { id: 'chat', tools: ['braveSearch', 'workflow_x', 'source_docs'] };
    const { dir, ctx } = await seed(
      { servers: [server('drawio')] },
      { apps: { 'chat.json': original }, tools: ['braveSearch'] }
    );
    await up(ctx);
    assert.deepEqual(await readApp(dir, 'chat.json'), original);
    assert.equal(ctx.writes, 0);
  });
});
