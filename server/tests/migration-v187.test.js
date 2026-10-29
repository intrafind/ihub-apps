#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V187 specs — the iAssistant search-profile keys are renamed to what
 * they now control, keeping the values an admin chose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setDefault, removeKey, renameKey } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V187__iassistant_search_profile_access.js';

function makeCtx(files, defaults = {}) {
  const logs = [];
  return {
    logs,
    files,
    fileExists: async rel => rel in files,
    readDefaultJson: async rel => {
      if (!(rel in defaults)) throw new Error(`no default ${rel}`);
      return structuredClone(defaults[rel]);
    },
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = data;
    },
    setDefault,
    removeKey,
    renameKey,
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const PLATFORM = 'config/platform.json';
const TOOL = 'tools/iFinder.json';

const OLD_EN =
  'List the iFinder search profiles this user can reach, derived from the iAssistants the deployment exposes plus the configured default profile. Use it when a question names a corpus ("the legal documents") rather than a profile id. A deployment without iAssistants reports only the configured default — that is the upstream API’s limit, not an error.';

const SHIPPED_TOOL = {
  functions: { listProfiles: { description: { en: 'new en', de: 'new de' } } }
};

describe('V187 iAssistant search profile access', () => {
  it('has a version and description', () => {
    assert.equal(version, '187');
    assert.ok(description);
  });

  it('only runs when platform.json or the iFinder tool exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [PLATFORM]: {} })), true);
    assert.equal(await precondition(makeCtx({ [TOOL]: {} })), true);
  });

  it('renames the shipped keys', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        iAssistant: {
          defaultProfileId: '',
          defaultSearchProfile: 'searchprofile-standard',
          resolveSearchProfileFromProfile: true,
          profileCacheTtlMs: 60000,
          groundedOnly: false
        }
      }
    });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].iAssistant, {
      defaultProfileId: '',
      defaultSearchProfile: 'searchprofile-standard',
      verifySearchProfileAccess: true,
      searchProfileCacheTtlMs: 60000,
      groundedOnly: false
    });
  });

  it('keeps a switched-off lookup switched off', async () => {
    const ctx = makeCtx({
      [PLATFORM]: { iAssistant: { resolveSearchProfileFromProfile: false } }
    });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].iAssistant, { verifySearchProfileAccess: false });
  });

  it('adds the default when neither key exists', async () => {
    const ctx = makeCtx({ [PLATFORM]: { iAssistant: { groundedOnly: true } } });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].iAssistant, {
      groundedOnly: true,
      verifySearchProfileAccess: true
    });
  });

  it('keeps the new keys and drops the old ones when both exist', async () => {
    const ctx = makeCtx({
      [PLATFORM]: {
        iAssistant: {
          resolveSearchProfileFromProfile: true,
          verifySearchProfileAccess: false,
          profileCacheTtlMs: 1,
          searchProfileCacheTtlMs: 2
        }
      }
    });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].iAssistant, {
      verifySearchProfileAccess: false,
      searchProfileCacheTtlMs: 2
    });
  });

  it('leaves a platform without an iAssistant block alone', async () => {
    const ctx = makeCtx({ [PLATFORM]: { auth: { mode: 'local' } } });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM], { auth: { mode: 'local' } });
  });

  it('replaces the shipped listProfiles description and keeps an edited one', async () => {
    const ctx = makeCtx(
      {
        [TOOL]: {
          functions: {
            search: { description: { en: 'search' } },
            listProfiles: { description: { en: OLD_EN, de: 'Vom Admin angepasst.' } }
          }
        }
      },
      { [TOOL]: SHIPPED_TOOL }
    );
    await up(ctx);
    assert.deepEqual(ctx.files[TOOL].functions.listProfiles.description, {
      en: 'new en',
      de: 'Vom Admin angepasst.'
    });
    assert.deepEqual(ctx.files[TOOL].functions.search, { description: { en: 'search' } });
  });

  it('leaves an iFinder tool without listProfiles alone', async () => {
    const tool = { functions: { search: { description: { en: 'search' } } } };
    const ctx = makeCtx({ [TOOL]: tool }, { [TOOL]: SHIPPED_TOOL });
    await up(ctx);
    assert.deepEqual(ctx.files[TOOL], tool);
  });

  it('writes out the iFinder application whose profile list is read', async () => {
    const ctx = makeCtx({ [PLATFORM]: { iFinder: { enabled: true } } });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM].iFinder, {
      enabled: true,
      searchProfileApplication: 'ifinder'
    });
  });

  it('keeps an iFinder application an admin chose', async () => {
    const ctx = makeCtx({
      [PLATFORM]: { iFinder: { searchProfileApplication: 'rag' }, iAssistant: {} }
    });
    await up(ctx);
    assert.equal(ctx.files[PLATFORM].iFinder.searchProfileApplication, 'rag');
  });
});
