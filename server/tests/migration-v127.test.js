#!/usr/bin/env node

/**
 * Migration V127 specs — shipped prompt texts use {{date}}, not {{timezone}}
 * (issue #2508). Only a text that is still exactly the old shipped default is
 * rewritten; an admin's own wording is preserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  up,
  precondition,
  version,
  FRAGMENTS,
  refreshedText
} from '../migrations/V127__date_only_default_prompts.js';

const readShipped = async file =>
  JSON.parse(await readFile(new URL(`../defaults/${file}`, import.meta.url), 'utf8'));

/** The shipped default as it read before this release. */
function superseded(text) {
  let out = text;
  for (const { from, to } of FRAGMENTS) out = out.split(to).join(from);
  return out;
}

function fakeCtx(files, defaults) {
  const logs = [];
  const warnings = [];
  const writes = [];
  return {
    files,
    logs,
    warnings,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async p => JSON.parse(JSON.stringify(defaults[p])),
    writeJson: async (p, d) => {
      writes.push(p);
      files[p] = d;
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

async function shippedDefaults() {
  return {
    'config/platform.json': await readShipped('config/platform.json'),
    'apps/iassistant.json': await readShipped('apps/iassistant.json'),
    'apps/ifinder-search.json': await readShipped('apps/ifinder-search.json')
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '127');
});

test('no shipped default uses {{timezone}} or {{time}} any more', async () => {
  const defaults = await shippedDefaults();
  for (const [file, config] of Object.entries(defaults)) {
    const text = JSON.stringify(config);
    assert.equal(text.includes('{{timezone}}'), false, `${file} uses {{timezone}}`);
    assert.equal(text.includes('{{time}}'), false, `${file} uses {{time}}`);
  }
});

test('precondition requires at least one of the files', async () => {
  const defaults = await shippedDefaults();
  assert.equal(await precondition(fakeCtx({}, defaults)), false);
  assert.equal(
    await precondition(fakeCtx({ 'apps/iassistant.json': { id: 'iassistant' } }, defaults)),
    true
  );
});

test('untouched old defaults are rewritten in every file and locale', async () => {
  const defaults = await shippedDefaults();
  const platform = defaults['config/platform.json'];
  const iassistant = defaults['apps/iassistant.json'];
  const ifinder = defaults['apps/ifinder-search.json'];
  const files = {
    'config/platform.json': {
      ...platform,
      globalPromptVariables: {
        ...platform.globalPromptVariables,
        context: superseded(platform.globalPromptVariables.context)
      }
    },
    'apps/iassistant.json': {
      ...iassistant,
      iassistant: {
        ...iassistant.iassistant,
        extraContext: superseded(iassistant.iassistant.extraContext)
      }
    },
    'apps/ifinder-search.json': {
      ...ifinder,
      system: { en: superseded(ifinder.system.en), de: superseded(ifinder.system.de) }
    }
  };
  // The fixtures really are the old texts.
  assert.match(files['config/platform.json'].globalPromptVariables.context, /\{\{timezone\}\}/);
  assert.match(files['apps/ifinder-search.json'].system.de, /Zeitzone des Benutzers/);

  const ctx = fakeCtx(files, defaults);
  await up(ctx);

  assert.equal(
    files['config/platform.json'].globalPromptVariables.context,
    platform.globalPromptVariables.context
  );
  assert.equal(
    files['apps/iassistant.json'].iassistant.extraContext,
    iassistant.iassistant.extraContext
  );
  assert.equal(files['apps/ifinder-search.json'].system.en, ifinder.system.en);
  assert.equal(files['apps/ifinder-search.json'].system.de, ifinder.system.de);
  assert.deepEqual(ctx.writes.sort(), Object.keys(files).sort());
  assert.deepEqual(ctx.warnings, []);
});

test('a customized text is left alone and logged when it still uses {{timezone}}', async () => {
  const defaults = await shippedDefaults();
  const custom = "Acme policy applies. The user's timezone is {{timezone}}. Today is {{date}}.";
  const files = {
    'config/platform.json': { globalPromptVariables: { context: custom } }
  };
  const ctx = fakeCtx(files, defaults);
  await up(ctx);
  assert.equal(files['config/platform.json'].globalPromptVariables.context, custom);
  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /customized/);
});

test('a default edited elsewhere is not rewritten even though the old sentence is still in it', async () => {
  const defaults = await shippedDefaults();
  const edited = `${superseded(defaults['config/platform.json'].globalPromptVariables.context)} Be brief.`;
  assert.equal(
    refreshedText(edited, defaults['config/platform.json'].globalPromptVariables.context),
    null
  );
});

test('already migrated or non-string values are no-ops', async () => {
  const defaults = await shippedDefaults();
  const current = defaults['config/platform.json'].globalPromptVariables.context;
  assert.equal(refreshedText(current, current), null);
  assert.equal(refreshedText(undefined, current), null);
  assert.equal(refreshedText({ en: current }, current), null);

  const files = {
    'apps/ifinder-search.json': JSON.parse(JSON.stringify(defaults['apps/ifinder-search.json']))
  };
  const ctx = fakeCtx(files, defaults);
  await up(ctx);
  assert.deepEqual(ctx.writes, []);
  assert.deepEqual(ctx.warnings, []);
});
