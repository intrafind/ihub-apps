#!/usr/bin/env node

/**
 * Migration V115 specs — the braveSearch `language` parameter reaches upgrades.
 *
 * `copyDefaultConfiguration()` backfills whole files that are missing from
 * `contents/`; it does not merge new fields into a file that is already there.
 * So a new tool parameter needs a migration or existing installs keep the old
 * schema indefinitely — and a model calling `braveSearch` with `language` would
 * fail validation against it.
 *
 * What has to be right: add the property only when it is absent, and leave every
 * other part of a tool an admin may have edited alone.
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
} from '../migrations/V115__brave_search_language_parameter.js';

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

/** The braveSearch tool as it looked before this parameter existed. */
function legacyTool() {
  return {
    id: 'braveSearch',
    name: { en: 'Brave Web Search' },
    script: 'braveSearch.js',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: { en: 'The search query' } },
        maxResults: { type: 'integer', default: 10 }
      },
      required: ['query']
    }
  };
}

async function seed(dir, tool) {
  await fs.mkdir(path.join(dir, 'tools'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'tools/braveSearch.json'),
    JSON.stringify(tool, null, 2),
    'utf8'
  );
}

async function scratch(name) {
  return fs.mkdtemp(path.join(baseDir, `${name}-`));
}

describe('V115 — braveSearch language parameter', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v115-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '115');
    assert.equal(description, 'Add the language parameter to the braveSearch tool');
  });

  it('skips an install that has no braveSearch tool file', async () => {
    const dir = await scratch('nofile');
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('adds the parameter, localized, without disturbing the others', async () => {
    const dir = await scratch('add');
    await seed(dir, legacyTool());
    const ctx = makeCtx(dir);
    await up(ctx);

    const tool = await ctx.readJson('tools/braveSearch.json');
    const props = tool.parameters.properties;

    assert.equal(props.language.type, 'string');
    assert.ok(props.language.description.en);
    assert.ok(props.language.description.de);
    // The rest of the tool is untouched.
    assert.deepEqual(props.query, legacyTool().parameters.properties.query);
    assert.deepEqual(props.maxResults, legacyTool().parameters.properties.maxResults);
    assert.deepEqual(tool.parameters.required, ['query']);
    assert.equal(tool.script, 'braveSearch.js');
  });

  it('never overwrites a parameter an admin has already customised', async () => {
    const dir = await scratch('custom');
    const customised = legacyTool();
    customised.parameters.properties.language = {
      type: 'string',
      description: { en: 'Our own wording' }
    };
    await seed(dir, customised);
    const ctx = makeCtx(dir);
    await up(ctx);

    const tool = await ctx.readJson('tools/braveSearch.json');
    assert.equal(tool.parameters.properties.language.description.en, 'Our own wording');
  });

  it('is idempotent', async () => {
    const dir = await scratch('idempotent');
    await seed(dir, legacyTool());
    const ctx = makeCtx(dir);
    await up(ctx);
    const first = await ctx.readJson('tools/braveSearch.json');
    await up(ctx);
    const second = await ctx.readJson('tools/braveSearch.json');
    assert.deepEqual(second, first);
  });

  it('warns instead of throwing on a tool file with no parameters block', async () => {
    const dir = await scratch('malformed');
    await seed(dir, { id: 'braveSearch' });
    const ctx = makeCtx(dir);
    await up(ctx);

    assert.ok(ctx.logs.some(([level]) => level === 'warn'));
  });
});
