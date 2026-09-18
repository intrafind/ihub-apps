#!/usr/bin/env node

/**
 * Migration V110 specs — the keyless Qwant provider reaches existing installs.
 *
 * providers.json is an existing file, so a new entry has to be merged into it;
 * `tools/qwantSearch.json` is not this migration's job, because
 * `copyDefaultConfiguration()` backfills files missing from `contents/` on every
 * boot. What is left to get right is the merge: the entry must carry
 * `requiresApiKey: false` (or the admin page labels a provider that needs no key
 * "Not Configured"), it must not disturb the providers already there, and it
 * must not overwrite an admin who has since edited or disabled it — a migration
 * is written once and then runs on every install, not just a pristine one.
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
} from '../migrations/V110__add_qwant_websearch_provider.js';

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

describe('V110 — Qwant web search provider', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v110-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '110');
    assert.equal(description, 'Add the keyless Qwant web search provider');
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

  it('adds the qwant provider next to the existing ones', async () => {
    const dir = await scratch('add');
    await seed(dir, { providers: [BRAVE] });
    const ctx = makeCtx(dir);
    await up(ctx);

    const config = await ctx.readJson('config/providers.json');
    const qwant = config.providers.find(p => p.id === 'qwant');

    assert.ok(qwant, 'qwant provider was not added');
    assert.equal(qwant.category, 'websearch');
    assert.equal(qwant.enabled, true);
    // Without this the admin page labels a provider that needs no key
    // "Not Configured", which reads as broken.
    assert.equal(qwant.requiresApiKey, false);
    // Existing providers are untouched.
    assert.deepEqual(
      config.providers.find(p => p.id === 'brave'),
      BRAVE
    );
  });

  it('is idempotent and never overwrites an admin-customised entry', async () => {
    const dir = await scratch('idempotent');
    await seed(dir, { providers: [BRAVE] });
    const ctx = makeCtx(dir);
    await up(ctx);

    // Simulate an admin disabling Qwant, then the migration re-running.
    const config = await ctx.readJson('config/providers.json');
    config.providers.find(p => p.id === 'qwant').enabled = false;
    await ctx.writeJson('config/providers.json', config);

    await up(ctx);

    const reread = await ctx.readJson('config/providers.json');
    assert.equal(reread.providers.filter(p => p.id === 'qwant').length, 1);
    assert.equal(reread.providers.find(p => p.id === 'qwant').enabled, false);
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
    // of server/defaults/ on every boot, so writing tools/qwantSearch.json here
    // would only duplicate a definition that then drifts from the default.
    const dir = await scratch('notool');
    await seed(dir, { providers: [BRAVE] });
    const ctx = makeCtx(dir);
    await up(ctx);

    assert.equal(await ctx.fileExists('tools/qwantSearch.json'), false);
  });
});
