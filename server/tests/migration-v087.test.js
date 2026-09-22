#!/usr/bin/env node

/**
 * Migration V087 specs — restoring tool-schema parameters lost to config drift.
 *
 * The real case: braveSearch.json in an existing install declares only
 * `query`, so resolveWebsearchTool's `props.extractContent.default = true`
 * writes to a property that does not exist and web search silently answers
 * from snippets instead of page content.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V087__restore_tool_schema_parameters.js';
import { mergeDefaults } from '../migrations/utils.js';

const SHIPPED_BRAVE = {
  id: 'braveSearch',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'shipped query description' },
      extractContent: { type: 'boolean', default: false },
      maxResults: { type: 'number', default: 10 },
      contentMaxLength: { type: 'number', default: 3000 }
    }
  }
};

function fakeCtx(files, defaults) {
  const logs = [];
  return {
    files,
    logs,
    listFiles: async dir =>
      Object.keys(files)
        .filter(p => p.startsWith(`${dir}/`))
        .map(p => p.slice(dir.length + 1)),
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
  assert.equal(version, '087');
});

test('a drifted braveSearch regains the parameters that drive content extraction', async () => {
  const ctx = fakeCtx(
    {
      'tools/braveSearch.json': {
        id: 'braveSearch',
        parameters: { type: 'object', properties: { query: { type: 'string' } } }
      }
    },
    { 'tools/braveSearch.json': SHIPPED_BRAVE }
  );

  await up(ctx);
  const props = ctx.files['tools/braveSearch.json'].parameters.properties;

  for (const key of ['query', 'extractContent', 'maxResults', 'contentMaxLength']) {
    assert.ok(props[key], `${key} present after migration`);
  }
  assert.ok(
    ctx.logs.some(l => l.includes('extractContent')),
    'and it reports what it restored'
  );
});

test("an admin's own values win over the shipped ones", async () => {
  const ctx = fakeCtx(
    {
      'tools/braveSearch.json': {
        id: 'braveSearch',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'MY OWN WORDING' },
            maxResults: { type: 'number', default: 3 }
          }
        }
      }
    },
    { 'tools/braveSearch.json': SHIPPED_BRAVE }
  );

  await up(ctx);
  const props = ctx.files['tools/braveSearch.json'].parameters.properties;

  assert.equal(props.query.description, 'MY OWN WORDING', 'custom description preserved');
  assert.equal(props.maxResults.default, 3, 'custom default preserved');
  assert.ok(props.extractContent, 'genuinely missing property still added');
});

test('an up-to-date schema is left byte-identical', async () => {
  const current = JSON.parse(JSON.stringify(SHIPPED_BRAVE));
  const ctx = fakeCtx(
    { 'tools/braveSearch.json': current },
    { 'tools/braveSearch.json': SHIPPED_BRAVE }
  );
  await up(ctx);
  assert.deepEqual(ctx.files['tools/braveSearch.json'], SHIPPED_BRAVE);
  assert.ok(
    ctx.logs.some(l => l.includes('already carry')),
    'and it says so'
  );
});

test('an admin-authored tool with no shipped counterpart is untouched', async () => {
  const mine = {
    id: 'myTool',
    parameters: { type: 'object', properties: { foo: { type: 'string' } } }
  };
  const ctx = fakeCtx({ 'tools/myTool.json': mine }, {});
  await up(ctx);
  assert.deepEqual(ctx.files['tools/myTool.json'], mine);
});

test('a tool config with no parameters block is skipped, not crashed on', async () => {
  const ctx = fakeCtx(
    { 'tools/braveSearch.json': { id: 'braveSearch' } },
    { 'tools/braveSearch.json': SHIPPED_BRAVE }
  );
  await up(ctx);
  assert.deepEqual(ctx.files['tools/braveSearch.json'], { id: 'braveSearch' });
});

test('precondition is false without tools, true with them', async () => {
  assert.equal(await precondition(fakeCtx({}, {})), false);
  assert.equal(await precondition(fakeCtx({ 'tools/braveSearch.json': {} }, {})), true);
});
