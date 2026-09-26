#!/usr/bin/env node

/**
 * Migration V135 specs — seeding the per-server MCP file input limit.
 *
 * Every configured MCP server gets `fileInputs.maxFileSizeMB: 20` unless an
 * admin set a value already; nothing else in mcpServers.json changes.
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
} from '../migrations/V135__mcp_file_input_limit.js';
import { setDefault } from '../migrations/utils.js';

let baseDir;

/** A migration context over a scratch contents directory. */
function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    setDefault,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

/** Write a scratch contents dir holding this mcpServers config (null = none). */
async function seed(mcpServers) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v135-'));
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

const server = (id, extra = {}) => ({
  id,
  name: { en: id },
  transport: { type: 'streamableHttp', url: `https://${id}.example.com/mcp` },
  ...extra
});

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v135-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V135 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '135');
    assert.equal(description, 'mcp_file_input_limit');
  });

  it('only runs when mcpServers.json exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
    const { ctx: withFile } = await seed({ servers: [] });
    assert.equal(await precondition(withFile), true);
  });
});

describe('V135 seeds fileInputs.maxFileSizeMB', () => {
  it('sets the 20 MB default on every server that has no value', async () => {
    const { ctx } = await seed({
      servers: [
        server('drawio', { apps: { enabled: true } }),
        server('files', { toolPrefix: 'f__', timeoutMs: 60000 })
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(
      config.servers.map(s => s.fileInputs),
      [{ maxFileSizeMB: 20 }, { maxFileSizeMB: 20 }]
    );
    // Siblings are untouched.
    assert.deepEqual(config.servers[0].apps, { enabled: true });
    assert.equal(config.servers[1].toolPrefix, 'f__');
    assert.equal(config.servers[1].timeoutMs, 60000);
    assert.deepEqual(config.security, { blockPrivateIps: true, allowedHosts: [] });
  });

  it('keeps a value an admin already set', async () => {
    const { ctx } = await seed({ servers: [server('a', { fileInputs: { maxFileSizeMB: 5 } })] });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(config.servers[0].fileInputs, { maxFileSizeMB: 5 });
  });

  it('tolerates a file without a servers array', async () => {
    const { ctx } = await seed({ security: { blockPrivateIps: true } });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(config, { security: { blockPrivateIps: true } });
  });

  it('is idempotent', async () => {
    const { ctx } = await seed({ servers: [server('a')] });
    await up(ctx);
    const first = await ctx.readJson('config/mcpServers.json');
    await up(ctx);
    const second = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(second, first);
  });
});
