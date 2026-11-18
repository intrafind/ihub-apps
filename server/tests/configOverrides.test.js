// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIhubEnvOverrides,
  envOverridePath,
  ENV_VAR_SKIP_PATHS_BY_KEY,
  overrideValueForLog
} from '../utils/configOverrides.js';
import logger from '../utils/logger.js';
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

describe('IHUB env override logging', () => {
  const touched = [];
  const lines = [];
  let originalInfo;
  before(() => {
    originalInfo = logger.info;
    logger.info = message => {
      lines.push(String(message));
    };
  });
  after(() => {
    logger.info = originalInfo;
  });
  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
    lines.splice(0);
  });
  const setEnv = (key, value) => {
    touched.push(key);
    process.env[key] = value;
  };

  it('logs the path of a secret override but never its value', () => {
    setEnv('IHUB_PLATFORM__LOCAL_AUTH__JWT_SECRET', 'super-secret-value-123');
    const platform = applyIhubEnvOverrides('config/platform.json', {});
    assert.equal(platform.localAuth.jwtSecret, 'super-secret-value-123', 'still applied');
    const line = lines.find(l => l.includes('IHUB_PLATFORM__LOCAL_AUTH__JWT_SECRET'));
    assert.ok(line, 'the override is logged');
    assert.ok(line.includes('localAuth.jwtSecret'), 'with its path');
    assert.ok(!line.includes('super-secret-value-123'), 'without its value');
    assert.ok(line.includes('[redacted]'));
  });

  it('masks credential-like keys inside a JSON override value', () => {
    setEnv(
      'IHUB_PLATFORM__OIDC_AUTH__PROVIDERS',
      '[{"name":"corp","clientSecret":"s3cr3t-abcdef"}]'
    );
    applyIhubEnvOverrides('config/platform.json', {});
    const line = lines.find(l => l.includes('oidcAuth.providers'));
    assert.ok(line);
    assert.ok(!line.includes('s3cr3t-abcdef'));
    assert.ok(line.includes('corp'), 'non-secret fields stay readable');
  });

  it('keeps ordinary values readable', () => {
    setEnv('IHUB_PLATFORM__AUTH__MODE', 'local');
    applyIhubEnvOverrides('config/platform.json', {});
    assert.ok(lines.some(l => l.includes('auth.mode = "local"')));
    assert.equal(overrideValueForLog(['rateLimit', 'default', 'limit'], 200), '200');
    assert.equal(overrideValueForLog(['defaultLanguage'], 'de'), '"de"');
  });

  it('masks keys platform.json names *Key, at the leaf and inside objects', () => {
    assert.equal(overrideValueForLog(['speech', 'azure', 'subscriptionKey'], 'k'), '[redacted]');
    assert.equal(overrideValueForLog(['jira', 'clientSecret'], 'x'), '[redacted]');
    assert.equal(
      overrideValueForLog(['speech'], { azure: { subscriptionKey: 'abc', region: 'eu' } }),
      '{"azure":{"subscriptionKey":"[redacted]","region":"eu"}}'
    );
  });

  it('masks the password in a proxy URL override', () => {
    setEnv('IHUB_PLATFORM__PROXY__HTTPS', 'http://user:S3cret-proxy@proxy.example:3128');
    const platform = applyIhubEnvOverrides('config/platform.json', {});
    assert.equal(platform.proxy.https, 'http://user:S3cret-proxy@proxy.example:3128', 'applied');
    const line = lines.find(l => l.includes('proxy.https'));
    assert.ok(line);
    assert.ok(!line.includes('S3cret-proxy'), 'without the password');
    assert.ok(!line.includes('user:'), 'without the user info');
    assert.ok(line.includes('proxy.example:3128'), 'the host stays readable');
  });

  it('masks credentials in URLs inside a JSON proxy override', () => {
    setEnv(
      'IHUB_PLATFORM__PROXY',
      '{"enabled":true,"http":"http://u:Pw-http@p:8080","https":"https://p:8443/?token=Tk-123"}'
    );
    applyIhubEnvOverrides('config/platform.json', {});
    const line = lines.find(l => l.includes('→ proxy ='));
    assert.ok(line);
    assert.ok(!line.includes('Pw-http'));
    assert.ok(!line.includes('Tk-123'));
    assert.ok(line.includes('"enabled":true'));
  });

  it('masks every header value, whatever the header is called', () => {
    setEnv(
      'IHUB_PLATFORM__TELEMETRY__EXPORTERS__OTLP__HEADERS',
      '{"x-honeycomb-team":"HKEY-123","x-honeycomb-dataset":"prod"}'
    );
    applyIhubEnvOverrides('config/platform.json', {});
    const line = lines.find(l => l.includes('telemetry.exporters.otlp.headers'));
    assert.ok(line);
    assert.ok(!line.includes('HKEY-123'));
    assert.ok(line.includes('x-honeycomb-team'), 'header names stay readable');
    assert.equal(
      overrideValueForLog(['telemetry', 'exporters', 'otlp'], { headers: { 'x-team': 'v' } }),
      '{"headers":{"x-team":"[redacted]"}}'
    );
    assert.equal(overrideValueForLog(['otlp', 'headers', 'xHoneycombTeam'], 'v'), '[redacted]');
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
