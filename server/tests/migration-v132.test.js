#!/usr/bin/env node

/**
 * Migration V132 specs — the draw.io and Excalidraw MCP App servers the two
 * example apps use are added to mcpServers.json, disabled, unless an admin
 * already uses those server ids.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  up,
  precondition,
  version,
  description,
  EXAMPLE_SERVER_IDS
} from '../migrations/V132__mcp_apps_example_servers.js';
import { addIfMissing } from '../migrations/utils.js';
import { mcpServersFileSchema } from '../validators/mcpServerConfigSchema.js';

const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults');

let baseDir;

/** A migration context over a scratch contents directory and the real defaults. */
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
    readDefaultJson: async rel =>
      JSON.parse(await fs.readFile(path.join(DEFAULTS_DIR, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    addIfMissing,
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed(mcpServers) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'v132-'));
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

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-v132-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V132 identity', () => {
  it('is numbered and described as its file name says', () => {
    assert.equal(version, '132');
    assert.equal(description, 'mcp_apps_example_servers');
  });

  it('only runs when mcpServers.json exists', async () => {
    const { ctx } = await seed(null);
    assert.equal(await precondition(ctx), false);
  });
});

describe('V132 adds the example servers', () => {
  it('adds draw.io and Excalidraw, disabled, and the result is a valid config', async () => {
    const own = {
      id: 'github',
      name: 'GitHub',
      transport: { type: 'sse', url: 'https://x.example/sse' }
    };
    const { ctx } = await seed({ servers: [own], security: { blockPrivateIps: true } });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(
      config.servers.map(s => s.id),
      ['github', ...EXAMPLE_SERVER_IDS]
    );
    for (const server of config.servers.slice(1)) {
      assert.equal(server.enabled, false);
      assert.equal(server.apps.enabled, true);
      assert.equal(server.transport.type, 'streamableHttp');
    }
    assert.equal(config.servers[1].transport.url, 'https://mcp.draw.io/mcp');
    assert.equal(config.servers[2].transport.url, 'https://mcp.excalidraw.com/mcp');
    assert.ok(mcpServersFileSchema.safeParse(config).success);
  });

  it('leaves a server id an admin already uses alone', async () => {
    const mine = {
      id: 'drawio',
      name: 'My draw.io',
      enabled: true,
      transport: { type: 'streamableHttp', url: 'https://drawio.internal/mcp' }
    };
    const { ctx } = await seed({ servers: [mine] });
    await up(ctx);
    const config = await ctx.readJson('config/mcpServers.json');
    assert.deepEqual(config.servers[0], mine);
    assert.deepEqual(
      config.servers.map(s => s.id),
      ['drawio', 'excalidraw']
    );
  });

  it('is idempotent', async () => {
    const { ctx } = await seed({ servers: [] });
    await up(ctx);
    const first = await ctx.readJson('config/mcpServers.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/mcpServers.json'), first);
  });
});
