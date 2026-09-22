#!/usr/bin/env node

/**
 * Migration V123 specs — an existing webContentExtractor definition is routed
 * through `extractForTool` and stops offering `ignoreSSL` to the model, now
 * that the tool is offered automatically with web search.
 *
 * Run: node --test server/tests/migration-v123.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { up, precondition, version } from '../migrations/V123__web_page_reader_entry_point.js';

const SHIPPED = JSON.parse(
  await readFile(
    fileURLToPath(new URL('../defaults/tools/webContentExtractor.json', import.meta.url)),
    'utf-8'
  )
);

/** A webContentExtractor definition as an older release shipped it. */
function legacyTool(extra = {}) {
  return {
    id: 'webContentExtractor',
    name: { en: 'My Page Reader' },
    script: 'webContentExtractor.js',
    enabled: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxLength: { type: 'integer', default: 5000 },
        ignoreSSL: { type: 'boolean', default: true }
      },
      required: ['url', 'ignoreSSL']
    },
    ...extra
  };
}

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '123');
});

test('precondition holds only where a tool definition can exist', async () => {
  assert.equal(await precondition(fakeCtx({ 'tools/webContentExtractor.json': {} })), true);
  assert.equal(await precondition(fakeCtx({ 'config/tools.json': [] })), true);
  assert.equal(await precondition(fakeCtx({})), false);
});

test('a legacy definition gains the entry point and loses ignoreSSL, keeping admin edits', async () => {
  const ctx = fakeCtx({ 'tools/webContentExtractor.json': legacyTool() });
  await up(ctx);

  const tool = ctx.files['tools/webContentExtractor.json'];
  assert.equal(tool.method, 'extractForTool');
  assert.deepEqual(Object.keys(tool.parameters.properties), ['url', 'maxLength']);
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.equal(tool.enabled, false);
  assert.deepEqual(tool.name, { en: 'My Page Reader' });
  assert.equal(tool.parameters.properties.maxLength.default, 5000);
});

test('the shipped definition is left untouched', async () => {
  const ctx = fakeCtx({ 'tools/webContentExtractor.json': structuredClone(SHIPPED) });
  await up(ctx);
  assert.deepEqual(ctx.files['tools/webContentExtractor.json'], SHIPPED);
});

test('a definition pointed at another script is the admin’s to keep', async () => {
  const custom = legacyTool({ script: 'myReader.js' });
  const ctx = fakeCtx({ 'tools/webContentExtractor.json': structuredClone(custom) });
  await up(ctx);
  assert.deepEqual(ctx.files['tools/webContentExtractor.json'], custom);
});

test('the legacy config/tools.json entry is updated too', async () => {
  const other = { id: 'braveSearch', script: 'braveSearch.js' };
  const ctx = fakeCtx({ 'config/tools.json': [other, legacyTool()] });
  await up(ctx);

  const [brave, reader] = ctx.files['config/tools.json'];
  assert.deepEqual(brave, other);
  assert.equal(reader.method, 'extractForTool');
  assert.ok(!('ignoreSSL' in reader.parameters.properties));
});
