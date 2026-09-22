#!/usr/bin/env node

/**
 * Migration V121 specs — shipped Translator / Summarizer templates move to the
 * prompt context blocks and get a document upload; the Outlook reply app
 * learns about <documents>. Admin-edited prompts stay as they are.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  up,
  precondition,
  version,
  TEMPLATES,
  OUTLOOK_REPLY_REPLACEMENTS
} from '../migrations/V121__prompt_context_blocks.js';

const readDefault = file =>
  JSON.parse(fs.readFileSync(new URL(`../defaults/${file}`, import.meta.url), 'utf8'));

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async p => readDefault(p),
    writeJson: async (p, d) => {
      files[p] = d;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const oldApp = file => ({ id: file, prompt: { ...TEMPLATES[file].old } });

test('version is the next unused number', () => {
  assert.equal(version, '121');
  const taken = fs
    .readdirSync(new URL('../migrations/', import.meta.url))
    .filter(f => f.startsWith('V121__'));
  assert.deepEqual(taken, ['V121__prompt_context_blocks.js']);
});

test('the new templates are what the shipped defaults carry', () => {
  for (const [file, { new: next }] of Object.entries(TEMPLATES)) {
    assert.deepEqual(readDefault(file).prompt, next, file);
  }
  const reply = readDefault('apps/outlook-reply.json').system;
  for (const [from, to] of OUTLOOK_REPLY_REPLACEMENTS) {
    assert.ok(!Object.values(reply).some(s => s.includes(from)) || to.includes(from));
    assert.ok(
      Object.values(reply).some(s => s.includes(to)),
      to.slice(0, 40)
    );
  }
});

test('precondition is false on an installation without the apps', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
});

test('rewrites the shipped templates and adds the upload block', async () => {
  const ctx = fakeCtx({
    'apps/translator.json': oldApp('apps/translator.json'),
    'apps/summarizer.json': oldApp('apps/summarizer.json')
  });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  for (const file of Object.keys(TEMPLATES)) {
    assert.deepEqual(ctx.files[file].prompt, TEMPLATES[file].new);
    assert.equal(ctx.files[file].upload.enabled, true);
    assert.ok(ctx.files[file].prompt.en.includes('{{content}}'));
  }
});

test('leaves admin-edited prompts and an existing upload section alone', async () => {
  const custom = {
    id: 'translator',
    prompt: { en: 'My own: {{content}}', de: TEMPLATES['apps/translator.json'].old.de },
    upload: { enabled: false }
  };
  const ctx = fakeCtx({ 'apps/translator.json': custom });
  await up(ctx);
  const app = ctx.files['apps/translator.json'];
  assert.equal(app.prompt.en, 'My own: {{content}}');
  assert.equal(app.prompt.de, TEMPLATES['apps/translator.json'].new.de);
  assert.deepEqual(app.upload, { enabled: false });
});

test('tells the reply app about <documents>, once', async () => {
  const [[fromEn], [fromDe]] = OUTLOOK_REPLY_REPLACEMENTS;
  const ctx = fakeCtx({
    'apps/outlook-reply.json': {
      id: 'outlook-reply',
      system: { en: `Blocks:\n${fromEn}\nEnd.`, de: `Blöcke:\n${fromDe}\nEnde.` }
    }
  });
  await up(ctx);
  const { system } = ctx.files['apps/outlook-reply.json'];
  assert.ok(system.en.includes('<documents>'));
  assert.ok(system.de.includes('<documents>'));

  const again = fakeCtx({ 'apps/outlook-reply.json': ctx.files['apps/outlook-reply.json'] });
  await up(again);
  assert.deepEqual(again.writes, []);
});

test('a second run writes nothing', async () => {
  const ctx = fakeCtx({ 'apps/summarizer.json': oldApp('apps/summarizer.json') });
  await up(ctx);
  const again = fakeCtx({ 'apps/summarizer.json': ctx.files['apps/summarizer.json'] });
  await up(again);
  assert.deepEqual(again.writes, []);
});
