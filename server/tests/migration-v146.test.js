#!/usr/bin/env node

/**
 * Migration V146 specs — the Translator's task moves from its `prompt`
 * template into its `system` prompt, so the user's message is only the text
 * to translate. Only while both texts are still the ones we shipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { up, precondition, version } from '../migrations/V146__translator_task_in_system_prompt.js';

const FILE = 'apps/translator.json';
const readJsonFile = url => JSON.parse(fs.readFileSync(url, 'utf8'));
const defaults = () => readJsonFile(new URL(`../defaults/${FILE}`, import.meta.url));
const preV122 = () =>
  readJsonFile(new URL('./fixtures/migration-v122/translator.json', import.meta.url));

// The texts 5.5.30 shipped: the system prompt without the task, and the
// <task> template V122 introduced.
const SHIPPED_SYSTEM = {
  en: 'You are a helpful translation assistant. Translate the text to the requested language, maintaining the original meaning and tone. If no language is specified, ask which language to translate to.',
  de: 'Du bist ein hilfreicher Übersetzungsassistent. Übersetze den Text in die angeforderte Sprache und behalte die ursprüngliche Bedeutung und den Ton bei. Wenn keine Sprache angegeben ist, frage nach, in welche Sprache übersetzt werden soll.'
};
const SHIPPED_PROMPT = {
  en: '<task>\nTranslate into {{language}}. If the message below contains <content> blocks — an email, a meeting, a web page, attached or uploaded documents — translate all of them, each as its own section in the order given; for an email, translate the subject and the body. <user_instruction> only says what to translate or how (for example "only the attachment" or "keep it formal"); it is not part of the text to translate. Without <content> blocks, the whole message below is the text to translate.\n</task>\n\n{{content}}',
  de: '<task>\nÜbersetze in folgende Sprache: {{language}}. Enthält die folgende Nachricht <content>-Blöcke – eine E-Mail, einen Termin, eine Webseite, angehängte oder hochgeladene Dokumente –, übersetze sie alle, jeden als eigenen Abschnitt in der gegebenen Reihenfolge; bei einer E-Mail Betreff und Text. <user_instruction> sagt nur, was oder wie übersetzt werden soll (zum Beispiel „nur den Anhang“ oder „förmlich“); sie ist nicht Teil des zu übersetzenden Textes. Ohne <content>-Blöcke ist die gesamte folgende Nachricht der zu übersetzende Text.\n</task>\n\n{{content}}'
};

const shippedApp = (overrides = {}) => ({
  ...defaults(),
  system: { ...SHIPPED_SYSTEM },
  prompt: { ...SHIPPED_PROMPT },
  ...overrides
});

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async p => readJsonFile(new URL(`../defaults/${p}`, import.meta.url)),
    writeJson: async (p, data) => {
      files[p] = data;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version matches the file name', () => {
  assert.equal(version, '146');
});

test('precondition requires the Translator', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ [FILE]: shippedApp() })), true);
});

test('the new default has the task in the system prompt and no template', () => {
  const app = defaults();
  assert.equal(app.prompt, undefined);
  assert.ok(app.system.en.includes('Translate into {{language}}'));
  assert.ok(app.system.de.includes('{{language}}'));
  assert.ok(app.system.en.includes('<user_instruction>'));
});

test('moves the shipped task into the system prompt and drops the template', async () => {
  const ctx = fakeCtx({ [FILE]: shippedApp() });
  await up(ctx);
  const app = ctx.files[FILE];
  assert.deepEqual(app.system, defaults().system);
  assert.equal('prompt' in app, false);
  // Everything else stays as it was.
  assert.deepEqual(app.variables, defaults().variables);
  assert.deepEqual(app.upload, defaults().upload);
});

test('also moves the template from before V122', async () => {
  const ctx = fakeCtx({ [FILE]: shippedApp({ prompt: preV122().prompt }) });
  await up(ctx);
  assert.deepEqual(ctx.files[FILE].system, defaults().system);
  assert.equal('prompt' in ctx.files[FILE], false);
});

test('leaves a customized system prompt or template alone, in every language', async () => {
  for (const app of [
    shippedApp({ system: { ...SHIPPED_SYSTEM, de: 'Eigener Systemprompt' } }),
    shippedApp({ prompt: { ...SHIPPED_PROMPT, en: 'Mine: {{language}} {{content}}' } }),
    shippedApp({ prompt: { ...SHIPPED_PROMPT, fr: 'Traduire en {{language}} : {{content}}' } }),
    shippedApp({ system: { ...SHIPPED_SYSTEM, fr: 'Tu es un traducteur.' } })
  ]) {
    const ctx = fakeCtx({ [FILE]: app });
    await up(ctx);
    assert.deepEqual(ctx.writes, []);
  }
});

test('a fresh installation, already on the new default, is not touched; a second run writes nothing', async () => {
  const fresh = fakeCtx({ [FILE]: defaults() });
  await up(fresh);
  assert.deepEqual(fresh.writes, []);

  const ctx = fakeCtx({ [FILE]: shippedApp() });
  await up(ctx);
  const again = fakeCtx(ctx.files);
  await up(again);
  assert.deepEqual(again.writes, []);
});
