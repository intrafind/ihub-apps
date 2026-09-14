#!/usr/bin/env node

/**
 * Migration V101 specs — the iFinder discovery functions and the search
 * parameters that were implemented but never declared.
 *
 * The real case: an installation upgraded from an earlier release keeps the
 * `tools/iFinder.json` it was set up with, so `iFinder_search` over MCP offers
 * no `filter`, `sort`, `returnFacets` or `from`, and there is no way to ask the
 * deployment which fields exist or which of them need `.keyword`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { up, precondition, version } from '../migrations/V101__ifinder_discovery_functions.js';
import { mergeDefaults } from '../migrations/utils.js';

const SHIPPED_IFINDER = JSON.parse(
  await readFile(fileURLToPath(new URL('../defaults/tools/iFinder.json', import.meta.url)), 'utf-8')
);

/** An iFinder tool config as an older release shipped it. */
function legacyIFinderTool() {
  return {
    id: 'iFinder',
    script: 'iFinder.js',
    functions: {
      search: {
        description: 'Search for documents in the iFinder system',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxResults: { type: 'integer', default: 10 },
            searchProfile: { type: 'string' },
            returnFields: { type: 'array', items: { type: 'string' } }
          },
          required: ['query']
        }
      },
      getContent: { parameters: { type: 'object', properties: {} } },
      getMetadata: { parameters: { type: 'object', properties: {} } }
    }
  };
}

function fakeCtx(files, defaults = { 'tools/iFinder.json': SHIPPED_IFINDER }) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    readDefaultJson: async p => {
      if (!(p in defaults)) throw new Error(`no default for ${p}`);
      return JSON.parse(JSON.stringify(defaults[p]));
    },
    mergeDefaults,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '101');
});

test('precondition holds only where an iFinder tool config can exist', async () => {
  assert.equal(await precondition(fakeCtx({ 'tools/iFinder.json': legacyIFinderTool() })), true);
  assert.equal(await precondition(fakeCtx({ 'config/tools.json': [] })), true);
  assert.equal(await precondition(fakeCtx({})), false);
});

test('a drifted install gains the discovery functions and the search parameters', async () => {
  const ctx = fakeCtx({ 'tools/iFinder.json': legacyIFinderTool() });

  await up(ctx);

  const tool = ctx.files['tools/iFinder.json'];
  assert.deepEqual(Object.keys(tool.functions).sort(), [
    'getContent',
    'getFacetValues',
    'getFields',
    'getMetadata',
    'listProfiles',
    'search'
  ]);

  const props = tool.functions.search.parameters.properties;
  for (const param of ['filter', 'sort', 'returnFacets', 'from']) {
    assert.ok(props[param], `search.${param} should be declared`);
  }
  // The pre-existing parameters are untouched.
  assert.equal(props.maxResults.default, 10);
  assert.deepEqual(tool.functions.search.parameters.required, ['query']);

  // `getFacetValues` is the one that carries the `.keyword` guidance a caller
  // needs to pick a valid facet id.
  assert.match(tool.functions.getFacetValues.parameters.properties.facet.description.en, /keyword/);
});

test('an admin-customised entry keeps its own values', async () => {
  const tool = legacyIFinderTool();
  tool.functions.search.parameters.properties.filter = {
    type: 'array',
    description: 'our own filter wording'
  };
  tool.functions.getFields = { description: 'admin-authored getFields' };

  const ctx = fakeCtx({ 'tools/iFinder.json': tool });
  await up(ctx);

  const result = ctx.files['tools/iFinder.json'];
  assert.equal(
    result.functions.search.parameters.properties.filter.description,
    'our own filter wording'
  );
  assert.equal(result.functions.getFields.description, 'admin-authored getFields');
  // The ones that were genuinely absent still arrive.
  assert.ok(result.functions.getFacetValues);
  assert.ok(result.functions.search.parameters.properties.sort);
});

test('running twice changes nothing the second time', async () => {
  const ctx = fakeCtx({ 'tools/iFinder.json': legacyIFinderTool() });
  await up(ctx);
  const afterFirst = JSON.stringify(ctx.files['tools/iFinder.json']);

  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['tools/iFinder.json']), afterFirst);
  assert.ok(ctx.logs.some(l => /already carries/.test(l)));
});

test('the legacy aggregate layout is patched too', async () => {
  const ctx = fakeCtx({
    'config/tools.json': [{ id: 'braveSearch' }, legacyIFinderTool()]
  });

  await up(ctx);

  const iFinder = ctx.files['config/tools.json'].find(t => t.id === 'iFinder');
  assert.ok(iFinder.functions.getFields);
  assert.ok(iFinder.functions.search.parameters.properties.returnFacets);
});

test('an install without an iFinder entry is left alone', async () => {
  const ctx = fakeCtx({ 'config/tools.json': [{ id: 'braveSearch' }] });
  await up(ctx);
  assert.deepEqual(ctx.files['config/tools.json'], [{ id: 'braveSearch' }]);
});

test('a missing shipped default is reported, not thrown', async () => {
  const ctx = fakeCtx({ 'tools/iFinder.json': legacyIFinderTool() }, {});
  await up(ctx);
  assert.ok(ctx.logs.some(l => /Shipped iFinder tool default not found/.test(l)));
  assert.equal(ctx.files['tools/iFinder.json'].functions.getFields, undefined);
});
