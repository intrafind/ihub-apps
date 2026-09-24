#!/usr/bin/env node

/**
 * Migration V127 specs — the iFinder `getContent` / `getMetadata` descriptions
 * and the ifinder-search app prompt gain the document-id guidance, but only
 * where an admin has not reworded them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  up,
  precondition,
  version,
  applyToolDefaults,
  applyAppPrompt,
  SUPERSEDED_TOOL_VALUES,
  SUPERSEDED_APP_PROMPT
} from '../migrations/V127__ifinder_document_id_guidance.js';

const DEFAULTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../defaults');

async function shipped(file) {
  return JSON.parse(await fs.readFile(path.join(DEFAULTS_DIR, file), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getAt(obj, p) {
  return p.reduce((node, key) => node?.[key], obj);
}

function setAt(obj, p, value) {
  getAt(obj, p.slice(0, -1))[p[p.length - 1]] = value;
}

/** The iFinder tool as an installation that predates this migration has it. */
async function installedTool() {
  const tool = await shipped('tools/iFinder.json');
  for (const { path: p, value } of SUPERSEDED_TOOL_VALUES) setAt(tool, p, clone(value));
  return tool;
}

/** The app as an installation that predates this migration has it. */
async function installedApp() {
  const app = await shipped('apps/ifinder-search.json');
  app.system = { ...SUPERSEDED_APP_PROMPT };
  return app;
}

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => clone(files[p]),
    readDefaultJson: shipped,
    writeJson: async (p, data) => {
      files[p] = data;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '127');
});

test('the shipped defaults differ from every superseded value', async () => {
  const tool = await shipped('tools/iFinder.json');
  for (const { path: p, value } of SUPERSEDED_TOOL_VALUES) {
    assert.notDeepEqual(getAt(tool, p), value, p.join('.'));
  }
  const app = await shipped('apps/ifinder-search.json');
  for (const [locale, text] of Object.entries(SUPERSEDED_APP_PROMPT)) {
    assert.notEqual(app.system[locale], text, locale);
    assert.match(app.system[locale], /iFinder_getMetadata/);
  }
});

test('precondition needs an iFinder tool config or the search app', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'tools/iFinder.json': {} })), true);
  assert.equal(await precondition(fakeCtx({ 'config/tools.json': [] })), true);
  assert.equal(await precondition(fakeCtx({ 'apps/ifinder-search.json': {} })), true);
});

test('an untouched tool config takes every refreshed value', async () => {
  const files = { 'tools/iFinder.json': await installedTool() };
  const ctx = fakeCtx(files);
  await up(ctx);

  assert.deepEqual(ctx.writes, ['tools/iFinder.json']);
  const current = await shipped('tools/iFinder.json');
  for (const { path: p } of SUPERSEDED_TOOL_VALUES) {
    assert.deepEqual(getAt(files['tools/iFinder.json'], p), getAt(current, p), p.join('.'));
  }
  const documentId =
    files['tools/iFinder.json'].functions.getMetadata.parameters.properties.documentId.description
      .en;
  assert.match(documentId, /Never a title, file name or link/);
  assert.ok(
    files[
      'tools/iFinder.json'
    ].functions.getMetadata.parameters.properties.returnFields.default.includes('creators')
  );
});

test('an admin-edited value is kept while the untouched ones are refreshed', async () => {
  const tool = await installedTool();
  tool.functions.getContent.description = { en: 'Our own wording', de: 'Eigene Formulierung' };
  // Translated into a further language: also an edit.
  tool.functions.getMetadata.description = {
    ...tool.functions.getMetadata.description,
    fr: 'Métadonnées'
  };
  const files = { 'tools/iFinder.json': tool };
  const ctx = fakeCtx(files);
  await up(ctx);

  const stored = files['tools/iFinder.json'];
  assert.equal(stored.functions.getContent.description.en, 'Our own wording');
  assert.equal(stored.functions.getMetadata.description.fr, 'Métadonnées');
  assert.match(
    stored.functions.getContent.parameters.properties.documentId.description.en,
    /Never a title/
  );
  assert.match(
    stored.functions.getMetadata.parameters.properties.documentId.description.de,
    /Nie ein Titel/
  );
});

test('a config that is already current is not rewritten', async () => {
  const files = {
    'tools/iFinder.json': await shipped('tools/iFinder.json'),
    'apps/ifinder-search.json': await shipped('apps/ifinder-search.json')
  };
  const ctx = fakeCtx(files);
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
});

test('applyToolDefaults skips paths the installed tool does not have', async () => {
  const tool = { id: 'iFinder', functions: { search: {} } };
  assert.deepEqual(applyToolDefaults(tool, await shipped('tools/iFinder.json')), []);
});

test('the legacy config/tools.json iFinder entry is refreshed in place', async () => {
  const files = {
    'config/tools.json': [{ id: 'braveSearch', functions: {} }, await installedTool()]
  };
  const ctx = fakeCtx(files);
  await up(ctx);

  assert.deepEqual(ctx.writes, ['config/tools.json']);
  const [other, iFinder] = files['config/tools.json'];
  assert.deepEqual(other, { id: 'braveSearch', functions: {} });
  assert.match(iFinder.functions.getContent.description.en, /`id` field of a hit/);
});

test('the app prompt is refreshed per locale, only where untouched', async () => {
  const app = await installedApp();
  app.system.de = 'Eigener Prompt';
  const files = { 'apps/ifinder-search.json': app };
  const ctx = fakeCtx(files);
  await up(ctx);

  assert.deepEqual(ctx.writes, ['apps/ifinder-search.json']);
  const current = await shipped('apps/ifinder-search.json');
  assert.equal(files['apps/ifinder-search.json'].system.en, current.system.en);
  assert.equal(files['apps/ifinder-search.json'].system.de, 'Eigener Prompt');
  // Everything but the prompt is left as it was.
  assert.equal(files['apps/ifinder-search.json'].enabled, app.enabled);
});

test('applyAppPrompt ignores an app without a localized prompt', async () => {
  const current = await shipped('apps/ifinder-search.json');
  assert.deepEqual(applyAppPrompt({ system: 'plain string' }, current), []);
  assert.deepEqual(applyAppPrompt({}, current), []);
});

test('tool and app are refreshed in one run', async () => {
  const files = {
    'tools/iFinder.json': await installedTool(),
    'apps/ifinder-search.json': await installedApp()
  };
  const ctx = fakeCtx(files);
  await up(ctx);
  assert.deepEqual(ctx.writes.sort(), ['apps/ifinder-search.json', 'tools/iFinder.json']);
  assert.match(files['apps/ifinder-search.json'].system.de, /Linkformat/);
});
