#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V231 specs — the stored app generator prompt loses the invalid
 * `actions` example block and the `tools` answer field, and gains the fields
 * the wizard applies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  migratePrompt,
  precondition,
  up,
  version
} from '../migrations/V231__app_generator_without_tools.js';

const OLD_TEXT = `Example:\n\`\`\`json\n{\n  "id": "x",\n  "variables": [],\n  "actions": [\n    {\n      "id": "draft",\n      "label": { "en": "Draft" }\n    }\n  ],\n  "allowEmptyContent": true\n}\n\`\`\`\nRules.`;

const oldPrompt = () => ({
  id: 'app-generator',
  prompt: { en: OLD_TEXT, de: OLD_TEXT },
  outputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, tools: { type: 'array' } },
    required: ['id', 'tools']
  }
});

test('version', () => assert.equal(version, '231'));

test('the example loses its actions block and keeps the rest', () => {
  const prompt = oldPrompt();
  assert.equal(migratePrompt(prompt), true);
  for (const lang of ['en', 'de']) {
    assert.doesNotMatch(prompt.prompt[lang], /"actions"/);
    assert.match(prompt.prompt[lang], /"variables": \[\],\n {2}"allowEmptyContent": true/);
    assert.match(prompt.prompt[lang], /Rules\./);
  }
});

test('the answer schema drops tools and gains the wizard fields', () => {
  const prompt = oldPrompt();
  migratePrompt(prompt);
  assert.equal('tools' in prompt.outputSchema.properties, false);
  assert.deepEqual(prompt.outputSchema.required, ['id']);
  for (const name of ['color', 'icon', 'prompt', 'variables', 'websearch']) {
    assert.ok(prompt.outputSchema.properties[name], name);
  }
});

test('it is idempotent, and a prompt that is already current is untouched', () => {
  const prompt = oldPrompt();
  migratePrompt(prompt);
  assert.equal(migratePrompt(prompt), false);
});

test('the shipped prompt needs no migration and its example is a valid app', () => {
  const shipped = JSON.parse(
    fs.readFileSync(new URL('../defaults/prompts/app-generator.json', import.meta.url), 'utf8')
  );
  assert.equal(migratePrompt(structuredClone(shipped)), false);
  for (const text of Object.values(shipped.prompt)) assert.doesNotMatch(text, /"actions"/);
});

test('up writes the migrated file only when something changed', async () => {
  const files = { 'prompts/app-generator.json': oldPrompt() };
  const ctx = {
    fileExists: async p => p in files,
    readJson: async p => structuredClone(files[p]),
    writeJson: async (p, data) => {
      files[p] = data;
    },
    log: () => {}
  };
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.doesNotMatch(files['prompts/app-generator.json'].prompt.en, /"actions"/);
  assert.equal(await precondition({ fileExists: async () => false }), false);
});
