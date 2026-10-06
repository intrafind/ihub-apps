#!/usr/bin/env node

/**
 * Migration V140 specs — new web tool parameters reach upgrades.
 *
 * `webContentExtractor` gained `offset`, `braveSearch` and `qwantSearch` gained
 * `freshness` and `includeDomains`, `staanSearch` gained `freshness`.
 * `copyDefaultConfiguration()` only backfills whole files, so an install that
 * already has these tool files needs this migration, or the model never learns
 * the options exist.
 *
 * What has to be right: a property is added only when absent, everything an
 * admin changed is kept, a definition pointed at another script is left alone,
 * and both layouts (one file per tool, legacy `config/tools.json`) are handled.
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
  description,
  NEW_PARAMETERS
} from '../migrations/V140__web_tools_filters_and_page_offset.js';

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

function legacyTool(id, extraProperties = {}) {
  return {
    id,
    name: { en: `${id} (admin wording)` },
    script: `${id}.js`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: { en: 'The search query' } },
        ...extraProperties
      },
      required: ['query']
    }
  };
}

async function seed(dir, rel, data) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
}

async function scratch(name) {
  return fs.mkdtemp(path.join(baseDir, `${name}-`));
}

// V157 renamed the page reader's tool id (and its shipped file) from
// webContentExtractor to read_url. NEW_PARAMETERS still keys it by the
// migration-era id, so map it to the current shipped filename here.
const SHIPPED_FILE = { webContentExtractor: 'read_url' };

async function readDefault(id) {
  const file = SHIPPED_FILE[id] || id;
  return JSON.parse(
    await fs.readFile(new URL(`../defaults/tools/${file}.json`, import.meta.url), 'utf8')
  );
}

describe('V140 — web tool filters and page reader offset', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v140-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '140');
    assert.equal(description, 'web_tools_filters_and_page_offset');
  });

  it('skips an install that has none of the tool files', async () => {
    assert.equal(await precondition(makeCtx(await scratch('none'))), false);
  });

  it('adds the new parameters to each tool file, leaving the rest alone', async () => {
    const dir = await scratch('files');
    await seed(dir, 'tools/braveSearch.json', legacyTool('braveSearch'));
    await seed(dir, 'tools/qwantSearch.json', legacyTool('qwantSearch'));
    await seed(
      dir,
      'tools/staanSearch.json',
      legacyTool('staanSearch', { includeDomains: { type: 'array', items: { type: 'string' } } })
    );
    await seed(dir, 'tools/webContentExtractor.json', {
      ...legacyTool('webContentExtractor'),
      method: 'extractForTool'
    });
    const ctx = makeCtx(dir);
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const brave = await ctx.readJson('tools/braveSearch.json');
    assert.deepEqual(brave.parameters.properties.freshness.enum, ['day', 'week', 'month', 'year']);
    assert.equal(brave.parameters.properties.includeDomains.type, 'array');
    assert.equal(brave.name.en, 'braveSearch (admin wording)');
    assert.deepEqual(brave.parameters.required, ['query']);

    const qwant = await ctx.readJson('tools/qwantSearch.json');
    assert.ok(qwant.parameters.properties.freshness);
    assert.ok(qwant.parameters.properties.includeDomains);

    const staan = await ctx.readJson('tools/staanSearch.json');
    assert.ok(staan.parameters.properties.freshness);
    // Staan's own includeDomains is kept as it was.
    assert.deepEqual(staan.parameters.properties.includeDomains, {
      type: 'array',
      items: { type: 'string' }
    });

    const reader = await ctx.readJson('tools/webContentExtractor.json');
    assert.equal(reader.parameters.properties.offset.type, 'integer');
    assert.equal(reader.parameters.properties.offset.minimum, 0);
    assert.equal(reader.method, 'extractForTool');
  });

  it('never overwrites a parameter an admin already customised', async () => {
    const dir = await scratch('custom');
    await seed(
      dir,
      'tools/braveSearch.json',
      legacyTool('braveSearch', { freshness: { type: 'string', description: { en: 'Ours' } } })
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    const tool = await ctx.readJson('tools/braveSearch.json');
    assert.deepEqual(tool.parameters.properties.freshness, {
      type: 'string',
      description: { en: 'Ours' }
    });
    assert.ok(tool.parameters.properties.includeDomains);
  });

  it('leaves a definition pointed at another script alone', async () => {
    const dir = await scratch('other-script');
    const custom = { ...legacyTool('braveSearch'), script: 'myBrave.js' };
    await seed(dir, 'tools/braveSearch.json', custom);
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.deepEqual(await ctx.readJson('tools/braveSearch.json'), custom);
  });

  it('updates the legacy config/tools.json array', async () => {
    const dir = await scratch('legacy');
    await seed(dir, 'config/tools.json', [
      legacyTool('qwantSearch'),
      { ...legacyTool('webContentExtractor') },
      { id: 'unrelated', parameters: { properties: {} } }
    ]);
    const ctx = makeCtx(dir);
    await up(ctx);
    const tools = await ctx.readJson('config/tools.json');
    assert.ok(tools[0].parameters.properties.freshness);
    assert.ok(tools[1].parameters.properties.offset);
    assert.deepEqual(tools[2], { id: 'unrelated', parameters: { properties: {} } });
  });

  it('is idempotent', async () => {
    const dir = await scratch('idempotent');
    await seed(dir, 'tools/qwantSearch.json', legacyTool('qwantSearch'));
    const ctx = makeCtx(dir);
    await up(ctx);
    const once = await ctx.readJson('tools/qwantSearch.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('tools/qwantSearch.json'), once);
  });

  it('writes the parameters exactly as the shipped defaults declare them', async () => {
    for (const [id, additions] of Object.entries(NEW_PARAMETERS)) {
      const shipped = await readDefault(id);
      for (const [name, schema] of Object.entries(additions)) {
        assert.deepEqual(shipped.parameters.properties[name], schema, `${id}.${name}`);
      }
    }
  });
});
