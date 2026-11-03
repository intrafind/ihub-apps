// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V213: an installation of a hosted MCP definition that moved to the
 * marketplace keeps its definition (written under contents, recorded as
 * installed from ihub-official); unused definitions are not written; an
 * existing folder is left alone; a second run changes nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  up,
  precondition,
  version,
  description,
  MOVED_DEFINITIONS
} from '../migrations/V213__mcp_definitions_to_marketplace.js';
import { validateIntegrationDefinition } from '../validators/integrationDefinitionSchema.js';

let contentsDir;
let logs;

function ctxFor() {
  const full = rel => path.join(contentsDir, rel);
  return {
    contentsDir,
    readJson: async rel => JSON.parse(await fs.readFile(full(rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(full(rel)), { recursive: true });
      await fs.writeFile(full(rel), JSON.stringify(data, null, 2));
    },
    fileExists: async rel =>
      fs
        .access(full(rel))
        .then(() => true)
        .catch(() => false),
    log: m => logs.push(m),
    warn: m => logs.push(`WARN ${m}`)
  };
}

async function seed(rel, data) {
  await fs.mkdir(path.dirname(path.join(contentsDir, rel)), { recursive: true });
  await fs.writeFile(path.join(contentsDir, rel), JSON.stringify(data));
}

const OFFICIAL = { registries: [{ id: 'ihub-official', enabled: true }] };

describe('V213 hosted MCP definitions → marketplace', () => {
  beforeEach(async () => {
    contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v213-'));
    logs = [];
  });
  afterEach(async () => {
    await fs.rm(contentsDir, { recursive: true, force: true });
  });

  it('declares its version', () => {
    assert.equal(version, '213');
    assert.equal(description, 'mcp_definitions_to_marketplace');
  });

  it('snapshots 29 valid definitions, none of them builtIn', () => {
    assert.equal(Object.keys(MOVED_DEFINITIONS).length, 29);
    for (const [folder, def] of Object.entries(MOVED_DEFINITIONS)) {
      assert.equal(def.id.replace('/', '__'), folder);
      assert.notEqual(def.builtIn, true, folder);
      assert.equal(def.releases[0].version, def.version, folder);
      const parsed = validateIntegrationDefinition(def);
      assert.ok(parsed.success, `${folder}: ${JSON.stringify(parsed.errors)}`);
    }
  });

  it('skips without an integrations file', async () => {
    assert.equal(await precondition(ctxFor()), false);
  });

  it('writes the used definitions and records them as installed from ihub-official', async () => {
    await seed('config/integrations.json', {
      installed: [
        { id: 'gh', definition: 'mcp/github' },
        { id: 'gh-2', definition: 'mcp/github' },
        { id: 'docs', definition: 'mcp/context7' }
      ]
    });
    await seed('config/registries.json', OFFICIAL);
    await seed('config/installations.json', { installations: {} });
    const ctx = ctxFor();
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const written = await ctx.readJson('integration-definitions/mcp__github/integration.json');
    assert.deepEqual(written, MOVED_DEFINITIONS.mcp__github);
    assert.equal(await ctx.fileExists('integration-definitions/mcp__linear'), false);
    assert.equal(await ctx.fileExists('integration-definitions/mcp__context7'), false);
    const manifest = await ctx.readJson('config/installations.json');
    assert.deepEqual(Object.keys(manifest.installations), ['integration:mcp__github']);
    assert.equal(manifest.installations['integration:mcp__github'].registryId, 'ihub-official');
    assert.equal(manifest.installations['integration:mcp__github'].version, '1.0.0');

    // A second run changes nothing.
    const before = await fs.readFile(path.join(contentsDir, 'config/installations.json'), 'utf8');
    await up(ctx);
    const after = await fs.readFile(path.join(contentsDir, 'config/installations.json'), 'utf8');
    assert.equal(after, before);
  });

  it('leaves an existing folder alone', async () => {
    await seed('config/integrations.json', { installed: [{ id: 's', definition: 'mcp/stripe' }] });
    await seed('config/registries.json', OFFICIAL);
    await seed('integration-definitions/mcp__stripe/integration.json', { id: 'mcp/stripe', x: 1 });
    await up(ctxFor());
    const kept = await ctxFor().readJson('integration-definitions/mcp__stripe/integration.json');
    assert.equal(kept.x, 1);
    assert.equal(await ctxFor().fileExists('config/installations.json'), false);
  });

  it('writes a local definition without a record when ihub-official is not configured', async () => {
    await seed('config/integrations.json', { installed: [{ id: 'l', definition: 'mcp/linear' }] });
    await up(ctxFor());
    assert.equal(
      await ctxFor().fileExists('integration-definitions/mcp__linear/integration.json'),
      true
    );
    assert.equal(await ctxFor().fileExists('config/installations.json'), false);
    assert.ok(logs.some(m => m.startsWith('WARN mcp/linear')));
  });
});
