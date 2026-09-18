#!/usr/bin/env node

/**
 * Migration V112 specs — the Staan provider reaches existing installs.
 *
 * providers.json is an existing file, so a new entry has to be merged into it;
 * `tools/staanSearch.json` is not this migration's job, because
 * `copyDefaultConfiguration()` backfills files missing from `contents/` on every
 * boot. What is left to get right is the merge: it must not disturb the
 * providers already there, and it must not overwrite an admin who has since
 * edited, disabled or keyed the entry — a migration is written once and then
 * runs on every install, not just a pristine one. Re-adding the default entry
 * over a configured one would wipe a working API key.
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
} from '../migrations/V112__add_staan_websearch_provider.js';

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
    readJson: async rel =>
      fs
        .readFile(path.join(dir, rel), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

const BRAVE = {
  id: 'brave',
  name: { en: 'Brave Search' },
  enabled: true,
  category: 'websearch'
};

const QWANT = {
  id: 'qwant',
  name: { en: 'Qwant Search' },
  enabled: true,
  category: 'websearch',
  requiresApiKey: false
};

async function seed(dir, providers) {
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config/providers.json'),
    JSON.stringify(providers, null, 2),
    'utf8'
  );
}

async function scratch(name) {
  return fs.mkdtemp(path.join(baseDir, `${name}-`));
}

describe('V112 — Staan web search provider', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v112-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '112');
    assert.equal(description, 'Add the Staan (staan.ai) web search provider');
  });

  it('skips when there is no providers.json', async () => {
    const dir = await scratch('nofile');
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('runs when providers.json exists', async () => {
    const dir = await scratch('hasfile');
    await seed(dir, { providers: [BRAVE] });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('adds the staan provider next to the existing ones', async () => {
    const dir = await scratch('add');
    await seed(dir, { providers: [BRAVE, QWANT] });
    const ctx = makeCtx(dir);
    await up(ctx);

    const config = await ctx.readJson('config/providers.json');
    const staan = config.providers.find(p => p.id === 'staan');

    assert.ok(staan, 'staan provider was not added');
    assert.equal(staan.category, 'websearch');
    assert.equal(staan.enabled, true);
    // Staan is keyed, so the admin page must offer an API key field — which it
    // does for any provider that does not opt out with requiresApiKey: false.
    assert.equal(staan.requiresApiKey, undefined);
    // Existing providers are untouched.
    assert.deepEqual(
      config.providers.find(p => p.id === 'brave'),
      BRAVE
    );
    assert.deepEqual(
      config.providers.find(p => p.id === 'qwant'),
      QWANT
    );
  });

  it('is idempotent and never overwrites an admin-customised entry', async () => {
    const dir = await scratch('idempotent');
    await seed(dir, { providers: [BRAVE] });
    const ctx = makeCtx(dir);
    await up(ctx);

    // Simulate an admin entering a key and disabling Staan, then the migration
    // re-running. Re-adding the default entry here would wipe the key.
    const config = await ctx.readJson('config/providers.json');
    const staan = config.providers.find(p => p.id === 'staan');
    staan.enabled = false;
    staan.apiKey = 'encrypted:secret';
    await ctx.writeJson('config/providers.json', config);

    await up(ctx);

    const reread = await ctx.readJson('config/providers.json');
    const after = reread.providers.filter(p => p.id === 'staan');
    assert.equal(after.length, 1);
    assert.equal(after[0].enabled, false);
    assert.equal(after[0].apiKey, 'encrypted:secret');
  });

  it('warns instead of throwing when providers.json has no providers array', async () => {
    const dir = await scratch('malformed');
    await seed(dir, { notProviders: true });
    const ctx = makeCtx(dir);
    await up(ctx);

    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
  });

  it('leaves the tool definition to the defaults copy, not to this migration', async () => {
    // copyDefaultConfiguration() backfills any file missing from contents/ out
    // of server/defaults/ on every boot, so writing tools/staanSearch.json here
    // would only duplicate a definition that then drifts from the default.
    const dir = await scratch('notool');
    await seed(dir, { providers: [BRAVE] });
    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal(await ctx.fileExists('tools/staanSearch.json'), false);
  });
});
