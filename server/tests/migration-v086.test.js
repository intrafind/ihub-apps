#!/usr/bin/env node

/**
 * Migration V086 specs — cleaning up the web search tools V025 left behind.
 *
 * Exercised through a fake migration context so the real contents/ is never
 * touched. The stale prompt below is the text installs actually carried: it
 * instructs the model to call three tools, none of which exist any more.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V086__cleanup_removed_websearch_tools.js';

const STALE_EN =
  'You are a helpful AI assistant with access to enhanced web search tools.\n\n' +
  "1. If the user's message contains a URL, use the webContentExtractor tool to load its content.\n" +
  '2. Use the enhancedWebSearch, google_search or web_search tool to search for additional relevant information.\n' +
  '3. Always cite your sources with URLs.';

const STALE_DE = 'Nutze das enhancedWebSearch, google_search oder web_search Tool für die Suche.';

/** In-memory migration context mirroring the real ctx surface V086 uses. */
function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    listFiles: async dir =>
      Object.keys(files)
        .filter(p => p.startsWith(`${dir}/`))
        .map(p => p.slice(dir.length + 1)),
    fileExists: async p => Object.prototype.hasOwnProperty.call(files, p),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, data) => {
      files[p] = data;
    },
    deleteFile: async p => {
      delete files[p];
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '086');
});

test('dead tool configs are deleted and the implemented ones are kept', async () => {
  const ctx = fakeCtx({
    'tools/enhancedWebSearch.json': { id: 'enhancedWebSearch', script: 'enhancedWebSearch.js' },
    'tools/webSearch.json': { id: 'webSearch' },
    'tools/googleSearch.json': { id: 'googleSearch' },
    'tools/tavilySearch.json': { id: 'tavilySearch' },
    'tools/braveSearch.json': { id: 'braveSearch', script: 'braveSearch.js' },
    'tools/webContentExtractor.json': {
      id: 'webContentExtractor',
      script: 'webContentExtractor.js'
    },
    'apps/chat.json': { id: 'chat', system: { en: 'You are helpful.' } }
  });

  await up(ctx);

  assert.equal(ctx.files['tools/enhancedWebSearch.json'], undefined);
  assert.equal(ctx.files['tools/webSearch.json'], undefined);
  assert.equal(ctx.files['tools/googleSearch.json'], undefined);
  assert.equal(ctx.files['tools/tavilySearch.json'], undefined);
  assert.ok(ctx.files['tools/braveSearch.json'], 'braveSearch has a script and stays');
  assert.ok(ctx.files['tools/webContentExtractor.json'], 'webContentExtractor stays');
});

test('a prompt naming the removed tools is rewritten, collapsing the alternation', async () => {
  const ctx = fakeCtx({
    'apps/web-chat.json': { id: 'web-chat', system: { en: STALE_EN, de: STALE_DE } }
  });

  await up(ctx);
  const system = ctx.files['apps/web-chat.json'].system;

  for (const dead of ['enhancedWebSearch', 'google_search', 'web_search']) {
    assert.ok(!system.en.includes(dead), `${dead} is gone from the English prompt`);
    assert.ok(!system.de.includes(dead), `${dead} is gone from the German prompt`);
  }
  assert.ok(
    system.en.includes('Use the web search tool to search'),
    `three names collapse into one phrase — got: ${system.en}`
  );
  assert.ok(system.de.includes('Websuche'), `German gets a German phrase — got: ${system.de}`);
  assert.ok(
    system.en.includes('webContentExtractor'),
    'webContentExtractor still exists, so its mention is left alone'
  );
  assert.ok(system.en.includes('Always cite your sources'), 'surrounding wording is preserved');
});

test('apps that never named a removed tool are left byte-identical', async () => {
  const untouched = {
    id: 'chat',
    system: { en: 'You are a helpful assistant.', de: 'Du bist hilfreich.' },
    prompt: { en: 'Summarize: {{content}}' }
  };
  const ctx = fakeCtx({ 'apps/chat.json': untouched });
  await up(ctx);
  assert.deepEqual(ctx.files['apps/chat.json'], untouched);
  assert.ok(
    ctx.logs.some(l => l.includes('No app prompts referenced')),
    'and it says so'
  );
});

test('plain-string and localized prompt fields are both handled', async () => {
  const ctx = fakeCtx({
    'apps/legacy.json': {
      id: 'legacy',
      system: 'Use the enhancedWebSearch tool.',
      greeting: { en: 'I can use webSearch for you.' }
    }
  });
  await up(ctx);
  const app = ctx.files['apps/legacy.json'];
  assert.equal(app.system, 'Use the web search tool.');
  assert.equal(app.greeting.en, 'I can use web search for you.');
});

test('precondition is false without apps, true with them', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'apps/chat.json': { id: 'chat' } })), true);
});
