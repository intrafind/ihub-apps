#!/usr/bin/env node

/**
 * Migration V122 specs — the shipped apps move from the old context tags and
 * the quoted "{{content}}" templates to the <content> blocks. A prompt is
 * replaced only while it is still exactly the one we shipped; the fixtures are
 * those shipped texts (the fields the migration touches) from before V122.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { up, precondition, version, SHIPPED } from '../migrations/V122__prompt_context_blocks.js';

const readJsonFile = url => JSON.parse(fs.readFileSync(url, 'utf8'));
const readDefault = file => readJsonFile(new URL(`../defaults/${file}`, import.meta.url));
const readShipped = file =>
  readJsonFile(new URL(`./fixtures/migration-v122/${file.slice('apps/'.length)}`, import.meta.url));
const getPath = (obj, dotPath) => dotPath.split('.').reduce((node, key) => node?.[key], obj);

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

const shippedInstall = () =>
  Object.fromEntries(Object.keys(SHIPPED).map(file => [file, readShipped(file)]));

test('version is the next unused number', () => {
  assert.equal(version, '122');
  const taken = fs
    .readdirSync(new URL('../migrations/', import.meta.url))
    .filter(f => f.startsWith('V122__'));
  assert.deepEqual(taken, ['V122__prompt_context_blocks.js']);
});

test('the new defaults no longer name the old tags', () => {
  for (const file of Object.keys(SHIPPED)) {
    const text = JSON.stringify(readDefault(file));
    for (const tag of ['<current_email>', '<pinned_emails>', '<current_meeting>', '<documents>']) {
      assert.ok(!text.includes(tag), `${file} still names ${tag}`);
    }
  }
});

test('precondition is false on an installation without the apps', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
});

test('moves every shipped prompt to the new default and adds the upload section', async () => {
  const ctx = fakeCtx(shippedInstall());
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  for (const [file, fields] of Object.entries(SHIPPED)) {
    const defaults = readDefault(file);
    for (const field of Object.keys(fields)) {
      assert.deepEqual(
        getPath(ctx.files[file], field),
        getPath(defaults, field),
        `${file} ${field}`
      );
    }
  }
  assert.equal(ctx.files['apps/translator.json'].upload.enabled, true);
  assert.equal(ctx.files['apps/summarizer.json'].upload.enabled, true);
});

test('a fresh installation, already on the new defaults, is not touched', async () => {
  const files = Object.fromEntries(Object.keys(SHIPPED).map(file => [file, readDefault(file)]));
  const ctx = fakeCtx(files);
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
});

test('leaves an admin-edited language and an existing upload section alone', async () => {
  const translator = readShipped('apps/translator.json');
  translator.prompt.en = 'My own: {{content}}';
  translator.upload = { enabled: false };
  const ctx = fakeCtx({ 'apps/translator.json': translator });
  await up(ctx);
  const app = ctx.files['apps/translator.json'];
  assert.equal(app.prompt.en, 'My own: {{content}}');
  assert.equal(app.prompt.de, readDefault('apps/translator.json').prompt.de);
  assert.deepEqual(app.upload, { enabled: false });
});

test('a second run writes nothing', async () => {
  const ctx = fakeCtx(shippedInstall());
  await up(ctx);
  const again = fakeCtx(ctx.files);
  await up(again);
  assert.deepEqual(again.writes, []);
});
