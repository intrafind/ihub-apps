#!/usr/bin/env node

/**
 * Migration V088 specs — default cap on provider-run web searches per call.
 *
 * Anthropic bills every native web search; before this cap one research
 * prompt could fan out into an unbounded number of searches. Existing apps
 * with a `websearch` block get `maxSearches: 5` written out (Anthropic's own
 * example value), apps without web search are untouched, and an admin's own
 * value always wins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V088__add_websearch_max_searches.js';
import { setDefault } from '../migrations/utils.js';

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    listFiles: async dir =>
      Object.keys(files)
        .filter(p => p.startsWith(`${dir}/`))
        .map(p => p.slice(dir.length + 1)),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
      writes.push(p);
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '088');
});

test('precondition only runs when apps exist', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'apps/a.json': { id: 'a' } })), true);
});

test('apps with web search get the default cap, others are left alone', async () => {
  const ctx = fakeCtx({
    'apps/search.json': { id: 'search', websearch: { enabled: true, useNativeSearch: true } },
    'apps/plain.json': { id: 'plain' },
    'apps/custom.json': { id: 'custom', websearch: { enabled: true, maxSearches: 12 } }
  });

  await up(ctx);

  assert.equal(ctx.files['apps/search.json'].websearch.maxSearches, 5);
  assert.equal(ctx.files['apps/plain.json'].websearch, undefined);
  assert.equal(ctx.files['apps/custom.json'].websearch.maxSearches, 12);
  assert.deepEqual(ctx.writes, ['apps/search.json']);
});

test('is idempotent', async () => {
  const ctx = fakeCtx({
    'apps/search.json': { id: 'search', websearch: { enabled: true } }
  });
  await up(ctx);
  await up(ctx);
  assert.deepEqual(ctx.writes, ['apps/search.json']);
  assert.equal(ctx.files['apps/search.json'].websearch.maxSearches, 5);
});
