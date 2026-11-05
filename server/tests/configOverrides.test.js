// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIhubEnvOverrides,
  envOverridePath,
  ENV_VAR_SKIP_PATHS_BY_KEY
} from '../utils/configOverrides.js';
import { decryptIfEncrypted, decryptPlatformSecrets } from '../utils/configSecrets.js';
import tokenStorageService from '../services/TokenStorageService.js';

describe('envOverridePath', () => {
  it('turns the segments after the prefix into camelCase path parts', () => {
    assert.deepEqual(envOverridePath('IHUB_PLATFORM__AUTH__MODE', 'IHUB_PLATFORM__'), [
      'auth',
      'mode'
    ]);
    assert.deepEqual(envOverridePath('IHUB_PLATFORM__DEFAULT_LANGUAGE', 'IHUB_PLATFORM__'), [
      'defaultLanguage'
    ]);
  });

  it('rejects other prefixes, an empty remainder and empty segments', () => {
    assert.equal(envOverridePath('IHUB_UI__THEME', 'IHUB_PLATFORM__'), null);
    assert.equal(envOverridePath('IHUB_PLATFORM__', 'IHUB_PLATFORM__'), null);
    assert.equal(envOverridePath('IHUB_PLATFORM__A____B', 'IHUB_PLATFORM__'), null);
  });
});

describe('applyIhubEnvOverrides', () => {
  const touched = [];
  const setEnv = (key, value) => {
    touched.push(key);
    process.env[key] = value;
  };
  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
  });

  it('applies typed overrides to platform.json and ui.json only', () => {
    setEnv('IHUB_PLATFORM__RATE_LIMIT__DEFAULT__LIMIT', '200');
    setEnv('IHUB_UI__THEME__PRIMARY_COLOR', '#ff0000');
    const platform = applyIhubEnvOverrides('config/platform.json', { rateLimit: {} });
    assert.equal(platform.rateLimit.default.limit, 200);
    assert.equal(platform.theme, undefined);
    const ui = applyIhubEnvOverrides('config/ui.json', {});
    assert.equal(ui.theme.primaryColor, '#ff0000');
    const apps = applyIhubEnvOverrides('config/apps.json', {});
    assert.deepEqual(apps, {});
  });

  it('leaves arrays alone', () => {
    setEnv('IHUB_PLATFORM__X', '1');
    assert.deepEqual(applyIhubEnvOverrides('config/platform.json', []), []);
  });

  it('keeps the iFinder JWT subject template out of env substitution', () => {
    assert.deepEqual(ENV_VAR_SKIP_PATHS_BY_KEY['config/integrations.json'], [
      'installed[].values.jwtSubjectField'
    ]);
  });
});

describe('configSecrets', () => {
  const originalKey = tokenStorageService.encryptionKey;
  before(() => {
    tokenStorageService.encryptionKey = 'a'.repeat(64);
  });
  after(() => {
    tokenStorageService.encryptionKey = originalKey;
  });

  it('passes plaintext and non-strings through', () => {
    assert.equal(decryptIfEncrypted('plain'), 'plain');
    assert.equal(decryptIfEncrypted(undefined), undefined);
  });

  it('decrypts the speech key of platform.json and nothing else', () => {
    const encrypted = tokenStorageService.encryptString('speech-secret');
    const platform = decryptPlatformSecrets({
      speech: { azure: { subscriptionKey: encrypted, region: 'westeurope' } }
    });
    assert.equal(platform.speech.azure.subscriptionKey, 'speech-secret');
    assert.equal(platform.speech.azure.region, 'westeurope');
    assert.deepEqual(decryptPlatformSecrets({}), {});
  });
});
