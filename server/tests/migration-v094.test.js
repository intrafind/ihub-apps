#!/usr/bin/env node

/**
 * Migration V094 specs — default iAssistant app and extraContext cleanup.
 *
 * Ships the new default `apps/iassistant.json` (disabled, no model selector,
 * templated extraContext) to installs that don't have the app yet, and
 * replaces the known hardcoded test extraContext ("My name is Daniel …") that
 * was configured before extraContext supported prompt variables. Deliberate
 * custom extraContext values on other installs are left untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { up, version } from '../migrations/V094__add_default_iassistant_app.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../defaults');

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
    },
    // Read the real shipped default so the specs validate what installs get.
    readDefaultJson: async p => JSON.parse(fs.readFileSync(path.join(defaultsDir, p), 'utf8')),
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

test('version is the next unused number', () => {
  assert.equal(version, '094');
});

test('the shipped default app is disabled, hides the model selector, and templates the user', async () => {
  const ctx = fakeCtx({});
  await up(ctx);
  const app = ctx.files['apps/iassistant.json'];

  assert.ok(app, 'default app was not seeded');
  assert.equal(app.enabled, false);
  assert.equal(app.disallowModelSelection, true);
  assert.equal(app.settings.model.enabled, false);
  assert.match(app.iassistant.extraContext, /\{\{user_name\}\}/);
  assert.match(app.iassistant.extraContext, /\{\{user_email\}\}/);
  assert.match(app.iassistant.extraContext, /\{\{date/);
});

test('an install without the app gets the default seeded', async () => {
  const ctx = fakeCtx({});
  await up(ctx);
  assert.equal(ctx.files['apps/iassistant.json'].id, 'iassistant');
});

test('the known hardcoded test extraContext is replaced with the templated default', async () => {
  const ctx = fakeCtx({
    'apps/iassistant.json': {
      id: 'iassistant',
      enabled: true,
      iassistant: {
        profileId: 'iassistant-basic',
        searchProfile: 'searchprofile-standard',
        extraContext: 'My name is Daniel and I work for IntraFind Software AG.'
      }
    }
  });

  await up(ctx);
  const app = ctx.files['apps/iassistant.json'];

  assert.match(app.iassistant.extraContext, /\{\{user_name\}\}/);
  assert.doesNotMatch(app.iassistant.extraContext, /Daniel/);
  // The rest of the admin's configuration is untouched.
  assert.equal(app.enabled, true);
  assert.equal(app.iassistant.profileId, 'iassistant-basic');
  assert.equal(app.iassistant.searchProfile, 'searchprofile-standard');
});

test('a deliberate custom extraContext is left alone', async () => {
  const custom = 'Answer strictly from the ACME knowledge base, in formal German.';
  const ctx = fakeCtx({
    'apps/iassistant.json': { id: 'iassistant', iassistant: { extraContext: custom } }
  });

  await up(ctx);
  assert.equal(ctx.files['apps/iassistant.json'].iassistant.extraContext, custom);
});

test('an already-templated extraContext is left alone', async () => {
  const templated = 'You are talking to {{user_name}}. My name is Daniel.';
  const ctx = fakeCtx({
    'apps/iassistant.json': { id: 'iassistant', iassistant: { extraContext: templated } }
  });

  await up(ctx);
  assert.equal(ctx.files['apps/iassistant.json'].iassistant.extraContext, templated);
});

test('an existing app without extraContext is not modified', async () => {
  const original = { id: 'iassistant', enabled: true, iassistant: { profileId: 'p-custom' } };
  const ctx = fakeCtx({ 'apps/iassistant.json': JSON.parse(JSON.stringify(original)) });

  await up(ctx);
  assert.deepEqual(ctx.files['apps/iassistant.json'], original);
});
