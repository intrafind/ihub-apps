#!/usr/bin/env node

/**
 * Migration V109 specs — the iFinder search description gains a pointer to the
 * ifinder-search skill, but only where an admin has not reworded it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V109__ifinder_search_skill_pointer.js';

const SUPERSEDED = {
  en: 'Search documents in iFinder using the IntraFind query syntax (Lucene plus NEAR/, MODE/, THES/, ENTITY/ and other operators). Field-qualified terms (title:budget, creators:"DOE, John") search the analyzed field; exact-value matching, faceting and sorting need the `.keyword` variant of a text field. Call iFinder_getFields first when unsure which name a field takes.',
  de: 'Dokumente in iFinder mit der IntraFind-Syntax suchen (Lucene plus die Operatoren NEAR/, MODE/, THES/, ENTITY/ und weitere). Feldbezogene Terme (title:budget, creators:"DOE, John") durchsuchen das analysierte Feld; exakte Werte, Facetten und Sortierung benötigen die `.keyword`-Variante eines Textfelds. Bei Unsicherheit zuerst iFinder_getFields aufrufen.'
};

const SHIPPED = {
  en: 'Search documents in iFinder using the IntraFind query syntax (Lucene plus NEAR/, MODE/, THES/, ENTITY/ and other operators). Field-qualified terms (title:budget, creators:"DOE, John") search the analyzed field; exact-value matching, faceting and sorting need the `.keyword` variant of a text field. Call iFinder_getFields first when unsure which name a field takes. The `ifinder-search` skill — MCP resource `ihub://skill/ifinder-search`, with its references as resources of their own — carries the full query syntax, the discovery loop and the fixes for a search that returns nothing or the wrong thing.',
  de: 'Dokumente in iFinder mit der IntraFind-Syntax suchen (Lucene plus die Operatoren NEAR/, MODE/, THES/, ENTITY/ und weitere). Feldbezogene Terme (title:budget, creators:"DOE, John") durchsuchen das analysierte Feld; exakte Werte, Facetten und Sortierung benötigen die `.keyword`-Variante eines Textfelds. Bei Unsicherheit zuerst iFinder_getFields aufrufen. Das Skill `ifinder-search` — MCP-Ressource `ihub://skill/ifinder-search`, dessen Referenzdateien eigene Ressourcen sind — enthält die vollständige Query-Syntax, den Discovery-Loop und die Korrekturen für Suchen, die nichts oder das Falsche liefern.'
};

function fakeCtx(files, defaults = { 'tools/iFinder.json': shippedTool() }) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async p => {
      if (!(p in defaults)) throw new Error(`no default: ${p}`);
      return JSON.parse(JSON.stringify(defaults[p]));
    },
    writeJson: async (p, data) => {
      files[p] = data;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

function shippedTool() {
  return { id: 'iFinder', functions: { search: { description: { ...SHIPPED } } } };
}

function installedTool(description = { ...SUPERSEDED }) {
  return { id: 'iFinder', functions: { search: { description } } };
}

test('version is the next unused number', () => {
  assert.equal(version, '109');
});

test('precondition is false without an iFinder tool config', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'tools/iFinder.json': installedTool() })), true);
});

test('an untouched description is refreshed in every language', async () => {
  const ctx = fakeCtx({ 'tools/iFinder.json': installedTool() });
  await up(ctx);

  const stored = ctx.files['tools/iFinder.json'].functions.search.description;
  assert.equal(stored.en, SHIPPED.en);
  assert.equal(stored.de, SHIPPED.de);
  assert.ok(stored.en.includes('ihub://skill/ifinder-search'));
  assert.deepEqual(ctx.writes, ['tools/iFinder.json']);
});

test('an admin-reworded description is left alone', async () => {
  const mine = { en: 'Our own wording', de: 'Unsere eigene Formulierung' };
  const ctx = fakeCtx({ 'tools/iFinder.json': installedTool(mine) });
  await up(ctx);

  assert.deepEqual(ctx.files['tools/iFinder.json'].functions.search.description, mine);
  assert.deepEqual(ctx.writes, []);
});

test('a description reworded in only one language is left alone', async () => {
  const partly = { en: SUPERSEDED.en, de: 'Unsere eigene Formulierung' };
  const ctx = fakeCtx({ 'tools/iFinder.json': installedTool(partly) });
  await up(ctx);

  assert.deepEqual(ctx.files['tools/iFinder.json'].functions.search.description, partly);
  assert.deepEqual(ctx.writes, []);
});

test('an extra language an admin added counts as edited', async () => {
  const translated = { ...SUPERSEDED, fr: 'Rechercher des documents' };
  const ctx = fakeCtx({ 'tools/iFinder.json': installedTool(translated) });
  await up(ctx);

  assert.deepEqual(ctx.files['tools/iFinder.json'].functions.search.description, translated);
  assert.deepEqual(ctx.writes, []);
});

test('the legacy aggregate tools.json layout is covered too', async () => {
  const ctx = fakeCtx({ 'config/tools.json': [{ id: 'other' }, installedTool()] });
  await up(ctx);

  const iFinder = ctx.files['config/tools.json'].find(t => t.id === 'iFinder');
  assert.equal(iFinder.functions.search.description.en, SHIPPED.en);
  assert.deepEqual(ctx.writes, ['config/tools.json']);
});

test('running twice writes only once', async () => {
  const ctx = fakeCtx({ 'tools/iFinder.json': installedTool() });
  await up(ctx);
  await up(ctx);

  assert.deepEqual(ctx.writes, ['tools/iFinder.json']);
});
