// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Env placeholders are resolved only in admin-authored config; user-written
 * data is cached verbatim, so a `${…}` in it reads back as written.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';
import { resolvesEnvVars } from '../utils/configOverrides.js';

const PLACEHOLDER = 'IHUB_TEST_PLACEHOLDER_3700';

describe('config cache env-var resolution', () => {
  before(() => {
    process.env[PLACEHOLDER] = 'resolved-value';
  });
  after(() => {
    delete process.env[PLACEHOLDER];
    for (const timer of configCache.refreshTimers.values()) clearTimeout(timer);
  });

  it('caches users.json verbatim, and loadUsers returns the placeholder', () => {
    const usersFile = localUsersFile({});
    const record = {
      id: 'u1',
      name: `\${${PLACEHOLDER}}`,
      email: `\${${PLACEHOLDER}}@example.com`
    };
    configCache.setCacheEntry('config/users.json', { users: { u1: record }, metadata: {} });

    assert.deepEqual(configCache.get('config/users.json').data.users.u1, record);
    assert.equal(loadUsers(usersFile).users.u1.name, `\${${PLACEHOLDER}}`);
  });

  it('keeps a promoted prompt and skill verbatim', () => {
    const prompt = { id: 'p1', prompt: { en: `Use \${${PLACEHOLDER}}` } };
    configCache.setCacheEntry('config/prompts.json', [prompt]);
    assert.deepEqual(configCache.get('config/prompts.json').data[0], prompt);
    configCache.setCacheEntry('skills', [{ name: 's1', description: `\${${PLACEHOLDER}}` }]);
    assert.equal(configCache.get('skills').data[0].description, `\${${PLACEHOLDER}}`);
  });

  it('caches other user and external data verbatim', () => {
    for (const key of [
      'config/oauth-clients.json',
      'config/eu-ai-act-conformity.json',
      'config/installations.json',
      'data/users.json'
    ]) {
      configCache.setCacheEntry(key, { name: `\${${PLACEHOLDER}}` });
      assert.equal(configCache.get(key).data.name, `\${${PLACEHOLDER}}`, key);
    }
  });

  it('still resolves placeholders in platform.json', () => {
    configCache.setCacheEntry('config/platform.json', { auth: { value: `\${${PLACEHOLDER}}` } });
    assert.equal(configCache.get('config/platform.json').data.auth.value, 'resolved-value');
  });

  it('resolves admin-authored config and locale overrides only', () => {
    assert.equal(resolvesEnvVars('config/models.json'), true);
    assert.equal(resolvesEnvVars('locales/de.json'), true);
    assert.equal(resolvesEnvVars('config/users.json'), false);
    assert.equal(resolvesEnvVars('config/prompts.json'), false);
    assert.equal(resolvesEnvVars('skills'), false);
    assert.equal(resolvesEnvVars('locales/../config/users.json'), false);
  });
});
