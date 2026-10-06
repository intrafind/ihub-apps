#!/usr/bin/env node

/**
 * Migration V157 specs — the web page reader tool id `webContentExtractor` is
 * renamed to `read_url`: the tool definition (id + file), and every reference
 * to it in app, workflow and agent tool lists. The implementation file
 * (`webContentExtractor.js`) and the display name are untouched.
 *
 * Run: node --test server/tests/migration-v157.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  up,
  precondition,
  version
} from '../migrations/V157__rename_web_page_reader_tool_to_read_url.js';

const SHIPPED = JSON.parse(
  await readFile(
    fileURLToPath(new URL('../defaults/tools/read_url.json', import.meta.url)),
    'utf-8'
  )
);

/** A key/value map of `contents/` files that supports listFiles + deleteFile. */
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
    deleteFile: async p => {
      delete files[p];
    },
    listFiles: async (dir, pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`);
      return Object.keys(files)
        .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => p.slice(dir.length + 1))
        .filter(name => regex.test(name));
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '157');
});

test('precondition holds only where a config file can hold the tool', async () => {
  assert.equal(await precondition(fakeCtx({ 'tools/webContentExtractor.json': {} })), true);
  assert.equal(await precondition(fakeCtx({ 'apps/chat.json': {} })), true);
  assert.equal(await precondition(fakeCtx({ 'config/tools.json': [] })), true);
  assert.equal(await precondition(fakeCtx({})), false);
});

test('the shipped default already uses the new id', () => {
  assert.equal(SHIPPED.id, 'read_url');
  assert.equal(SHIPPED.script, 'webContentExtractor.js');
});

test('an existing definition becomes read_url.json, keeping admin edits, old file gone', async () => {
  // performInitialSetup copies the fresh default in before migrations run, so
  // both files exist on an upgrade; the admin's own file (enabled: false) wins.
  const ctx = fakeCtx({
    'tools/webContentExtractor.json': {
      id: 'webContentExtractor',
      name: { en: 'My Page Reader' },
      script: 'webContentExtractor.js',
      enabled: false
    },
    'tools/read_url.json': structuredClone(SHIPPED)
  });
  await up(ctx);

  assert.equal('tools/webContentExtractor.json' in ctx.files, false);
  const tool = ctx.files['tools/read_url.json'];
  assert.equal(tool.id, 'read_url');
  assert.equal(tool.enabled, false);
  assert.deepEqual(tool.name, { en: 'My Page Reader' });
  assert.equal(tool.script, 'webContentExtractor.js');
});

test('the id is renamed in app, workflow and agent tool lists', async () => {
  const ctx = fakeCtx({
    'apps/chat.json': { id: 'chat', tools: ['braveSearch', 'webContentExtractor'] },
    'workflows/agent.json': {
      id: 'agent',
      nodes: [{ id: 'n1', config: { tools: ['braveSearch', 'webContentExtractor'] } }]
    },
    'agents/researcher.json': { id: 'researcher', tools: ['webContentExtractor'] }
  });
  await up(ctx);

  assert.deepEqual(ctx.files['apps/chat.json'].tools, ['braveSearch', 'read_url']);
  assert.deepEqual(ctx.files['workflows/agent.json'].nodes[0].config.tools, [
    'braveSearch',
    'read_url'
  ]);
  assert.deepEqual(ctx.files['agents/researcher.json'].tools, ['read_url']);
});

test('the id is renamed where a prompt names it, keeping the surrounding prose', async () => {
  const ctx = fakeCtx({
    'apps/chat.json': {
      id: 'chat',
      system: {
        en: 'Use the webContentExtractor tool to open URLs.',
        de: 'Nutze webContentExtractor.'
      },
      tools: ['webContentExtractor']
    }
  });
  await up(ctx);
  assert.equal(ctx.files['apps/chat.json'].system.en, 'Use the read_url tool to open URLs.');
  assert.equal(ctx.files['apps/chat.json'].system.de, 'Nutze read_url.');
  assert.deepEqual(ctx.files['apps/chat.json'].tools, ['read_url']);
});

test('a longer id and the implementation file name are left alone', async () => {
  const ctx = fakeCtx({
    'apps/chat.json': {
      id: 'chat',
      system: { en: 'See server/tools/webContentExtractor.js for details.' },
      tools: ['webContentExtractorPro']
    }
  });
  await up(ctx);
  assert.equal(
    ctx.files['apps/chat.json'].system.en,
    'See server/tools/webContentExtractor.js for details.'
  );
  assert.deepEqual(ctx.files['apps/chat.json'].tools, ['webContentExtractorPro']);
});

test('a read_url collision fails the migration and changes nothing', async () => {
  // An admin already has a custom tool named read_url (a different script), with
  // the old page reader still present. The migration must fail rather than
  // half-rename (the runtime knows the reader only by the new id), and it must
  // leave every file untouched so the retry on the next start is clean.
  const custom = { id: 'read_url', name: { en: 'My URL tool' }, script: 'myUrlTool.js' };
  const reader = { id: 'webContentExtractor', script: 'webContentExtractor.js' };
  const app = { id: 'chat', tools: ['braveSearch', 'webContentExtractor'] };
  const ctx = fakeCtx({
    'tools/read_url.json': structuredClone(custom),
    'tools/webContentExtractor.json': structuredClone(reader),
    'apps/chat.json': structuredClone(app)
  });
  await assert.rejects(up(ctx), /read_url/);
  assert.deepEqual(ctx.files['tools/read_url.json'], custom);
  assert.deepEqual(ctx.files['tools/webContentExtractor.json'], reader);
  assert.deepEqual(ctx.files['apps/chat.json'], app);
});

test('the legacy config/tools.json entry is renamed too', async () => {
  const ctx = fakeCtx({
    'config/tools.json': [
      { id: 'braveSearch', script: 'braveSearch.js' },
      { id: 'webContentExtractor', script: 'webContentExtractor.js' }
    ]
  });
  await up(ctx);
  const ids = ctx.files['config/tools.json'].map(t => t.id);
  assert.deepEqual(ids, ['braveSearch', 'read_url']);
});

test('running twice is a no-op', async () => {
  const ctx = fakeCtx({
    'tools/webContentExtractor.json': {
      id: 'webContentExtractor',
      script: 'webContentExtractor.js'
    },
    'apps/chat.json': { id: 'chat', tools: ['webContentExtractor'] }
  });
  await up(ctx);
  const afterFirst = structuredClone(ctx.files);
  await up(ctx);
  assert.deepEqual(ctx.files, afterFirst);
  assert.equal(ctx.files['tools/read_url.json'].id, 'read_url');
  assert.deepEqual(ctx.files['apps/chat.json'].tools, ['read_url']);
});
