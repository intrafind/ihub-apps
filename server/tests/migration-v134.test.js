#!/usr/bin/env node

/**
 * Migration V134 specs — an empty MCP tool prefix is removed, so the server's
 * tools get the default `<id>__` prefix; a prefix an admin typed stays.
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
} from '../migrations/V134__mcp_empty_tool_prefix.js';

let baseDir;

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
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      writes++;
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a scratch contents dir holding this mcpServers config (null = none). */
async function seed(mcpServers) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v134-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  if (mcpServers !== null) {
    await fs.writeFile(
      path.join(dir, 'config/mcpServers.json'),
      JSON.stringify(mcpServers, null, 2),
      'utf8'
    );
  }
  return { dir, ctx: makeCtx(dir) };
}

const read = dir => fs.readFile(path.join(dir, 'config/mcpServers.json'), 'utf8').then(JSON.parse);

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

describe('V134 mcp_empty_tool_prefix', () => {
  it('declares its version and description', () => {
    assert.equal(version, '134');
    assert.equal(description, 'mcp_empty_tool_prefix');
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

    const { servers } = await read(dir);
    assert.equal('toolPrefix' in servers[0], false);
    assert.equal('toolPrefix' in servers[1], false);
    assert.equal(servers[2].toolPrefix, 'gh_');
    assert.equal('toolPrefix' in servers[3], false);
    // Nothing else about a server changes.
    assert.deepEqual(servers[0].transport, server('drawio').transport);
  });

  it('writes nothing when no server has an empty prefix', async () => {
    const { ctx } = await seed({ servers: [server('github', { toolPrefix: 'gh_' })] });
    await up(ctx);
    assert.equal(ctx.writes, 0);
  });

  it('tolerates a file without a servers array', async () => {
    const { ctx } = await seed({ security: { blockPrivateIps: true } });
    await up(ctx);
    assert.equal(ctx.writes, 0);
  });
});
