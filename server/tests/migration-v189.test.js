#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V189 specs — the iFinder search profile settings get their
 * defaults, and the profile an installation searched before is kept.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setDefault } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V189__ifinder_search_profile_settings.js';

function makeCtx(files) {
  const logs = [];
  return {
    logs,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

describe('V189 iFinder search profile settings', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.IFINDER_SEARCH_PROFILE;
    delete process.env.IFINDER_SEARCH_PROFILE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.IFINDER_SEARCH_PROFILE;
    else process.env.IFINDER_SEARCH_PROFILE = savedEnv;
  });

  it('has a version and description', () => {
    assert.equal(version, '189');
    assert.ok(description);
  });

  it('only runs when platform.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/platform.json': {} })), true);
  });

  it('adds the code default and the new settings to an iFinder section without them', async () => {
    const ctx = makeCtx({
      'config/platform.json': { iFinder: { enabled: true, baseUrl: 'https://f' } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].iFinder, {
      enabled: true,
      baseUrl: 'https://f',
      defaultSearchProfile: 'searchprofile-standard',
      allowedSearchProfiles: [],
      allowUserSearchProfileChange: true
    });
  });

  it('keeps the profile an admin configured', async () => {
    const ctx = makeCtx({
      'config/platform.json': {
        iFinder: {
          defaultSearchProfile: 'contracts',
          allowedSearchProfiles: ['contracts', 'hr'],
          allowUserSearchProfileChange: false
        }
      }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].iFinder, {
      defaultSearchProfile: 'contracts',
      allowedSearchProfiles: ['contracts', 'hr'],
      allowUserSearchProfileChange: false
    });
  });

  it('leaves the default profile out while IFINDER_SEARCH_PROFILE names one', async () => {
    process.env.IFINDER_SEARCH_PROFILE = 'from-env';
    const ctx = makeCtx({ 'config/platform.json': { iFinder: { enabled: true } } });
    await up(ctx);
    const iFinder = ctx.files['config/platform.json'].iFinder;
    assert.equal(Object.hasOwn(iFinder, 'defaultSearchProfile'), false);
    assert.deepEqual(iFinder.allowedSearchProfiles, []);
    assert.equal(iFinder.allowUserSearchProfileChange, true);
  });

  it('leaves the iAssistant settings alone', async () => {
    const iAssistant = { defaultSearchProfile: 'kb', verifySearchProfileAccess: false };
    const ctx = makeCtx({ 'config/platform.json': { iFinder: {}, iAssistant } });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'].iAssistant, iAssistant);
  });

  it('does nothing without an iFinder section', async () => {
    const ctx = makeCtx({ 'config/platform.json': { defaultLanguage: 'en' } });
    await up(ctx);
    assert.deepEqual(ctx.files['config/platform.json'], { defaultLanguage: 'en' });
  });

  it('adds the inline picker to the shipped iFinder Search app', async () => {
    const ctx = makeCtx({
      'config/platform.json': {},
      'apps/ifinder-search.json': { id: 'ifinder-search', tools: ['iFinder_search'] }
    });
    await up(ctx);
    assert.deepEqual(ctx.files['apps/ifinder-search.json'].integrations, {
      ifinder: { scopePicker: 'inline' }
    });
  });

  it('keeps the picker placement an admin chose for the iFinder Search app', async () => {
    const app = { id: 'ifinder-search', integrations: { ifinder: { scopePicker: 'hidden' } } };
    const ctx = makeCtx({ 'config/platform.json': {}, 'apps/ifinder-search.json': app });
    await up(ctx);
    assert.deepEqual(ctx.files['apps/ifinder-search.json'], app);
  });
});
