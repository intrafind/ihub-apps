#!/usr/bin/env node

/**
 * Migration V124 specs — rewording the shipped web-chat prompt for multi-step
 * research (issue #2484). Only a locale whose prompt is still exactly the old
 * shipped default is rewritten; an admin's own wording is preserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  up,
  precondition,
  version,
  PROMPT_UPDATES
} from '../migrations/V124__web_chat_multi_step_research.js';

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      writes.push(p);
      files[p] = d;
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const webChat = system => ({
  'apps/web-chat.json': { id: 'web-chat', enabled: true, websearch: { enabled: true }, system }
});

test('version is the next unused number', () => {
  assert.equal(version, '124');
});

test('precondition requires the web-chat app', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx(webChat({}))), true);
});

test('the new prompts match the shipped defaults', async () => {
  const shipped = JSON.parse(
    await readFile(new URL('../defaults/apps/web-chat.json', import.meta.url), 'utf8')
  );
  assert.equal(shipped.system.en, PROMPT_UPDATES.en.to);
  assert.equal(shipped.system.de, PROMPT_UPDATES.de.to);
  assert.notEqual(PROMPT_UPDATES.en.from, PROMPT_UPDATES.en.to);
  assert.notEqual(PROMPT_UPDATES.de.from, PROMPT_UPDATES.de.to);
});

test('an unchanged default prompt is rewritten in every locale', async () => {
  const ctx = fakeCtx(webChat({ en: PROMPT_UPDATES.en.from, de: PROMPT_UPDATES.de.from }));

  await up(ctx);
  const app = ctx.files['apps/web-chat.json'];

  assert.equal(app.system.en, PROMPT_UPDATES.en.to);
  assert.equal(app.system.de, PROMPT_UPDATES.de.to);
  assert.deepEqual(app.websearch, { enabled: true });
  assert.ok(ctx.logs.some(l => l.includes('en, de')));
});

test('an edited locale is preserved while the unchanged one is updated', async () => {
  const custom = 'Mein eigener Prompt.';
  const ctx = fakeCtx(webChat({ en: PROMPT_UPDATES.en.from, de: custom, fr: 'Bonjour' }));

  await up(ctx);
  const { system } = ctx.files['apps/web-chat.json'];

  assert.equal(system.en, PROMPT_UPDATES.en.to);
  assert.equal(system.de, custom);
  assert.equal(system.fr, 'Bonjour');
});

test('a fully customized prompt is not written at all', async () => {
  const ctx = fakeCtx(webChat({ en: 'Custom.', de: 'Eigen.' }));
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
});

test('re-running is a no-op', async () => {
  const ctx = fakeCtx(webChat({ en: PROMPT_UPDATES.en.to, de: PROMPT_UPDATES.de.to }));
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
});

test('a missing or plain-string system prompt is left alone', async () => {
  for (const system of [undefined, 'plain string']) {
    const ctx = fakeCtx(webChat(system));
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  }
});
