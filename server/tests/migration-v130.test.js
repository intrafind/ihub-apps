#!/usr/bin/env node

/**
 * Migration V130 specs — seeding the per-server MCP Apps toggle.
 *
 * Every configured MCP server gets `apps.enabled: true` unless an admin set a
 * value already; nothing else in mcpServers.json changes.
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
} from '../migrations/V130__mcp_apps_server_toggle.js';
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
  const dir = await fs.mkdtemp(path.join(baseDir, 'v130-'));
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
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v130-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V130 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '130');
    assert.equal(description, 'mcp_apps_server_toggle');
  });

  it('only runs when mcpServers.json exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
    const { ctx: withFile } = await seed({ servers: [] });
    assert.equal(await precondition(withFile), true);
  });
});

describe('V130 seeds apps.enabled', () => {
  it('enables MCP Apps on every server that has no value', async () => {
    const { ctx } = await seed({
      servers: [server('drawio'), server('excalidraw', { toolPrefix: 'ex__' })],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(
      config.servers.map(s => s.apps),
      [{ enabled: true }, { enabled: true }]
    );
    // Siblings are untouched.
    assert.equal(config.servers[1].toolPrefix, 'ex__');
    assert.deepEqual(config.security, { blockPrivateIps: true, allowedHosts: [] });
  });

  it('keeps a value an admin already set', async () => {
    const { ctx } = await seed({ servers: [server('a', { apps: { enabled: false } })] });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(config.servers[0].apps, { enabled: false });
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
