// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The runtime cache holds the Azure Speech subscription key decrypted, and
 * several admin routes (enable / disable of the Office add-in, the browser
 * extension and the Nextcloud embed, the CORS, SSL and logging pages, ...)
 * build the `platform.json` they save from that cache. Every save of the file
 * must put the key back in encrypted, not write it in plain text.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-platform-secrets-'));
const contentsDir = path.join(baseDir, 'contents');
process.env.CONTENTS_DIR = contentsDir;
fsSync.mkdirSync(path.join(contentsDir, 'config'), { recursive: true });

const { encryptPlatformSecrets, decryptPlatformSecrets } =
  await import('../utils/configSecrets.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { default: configCache } = await import('../configCache.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { default: registerBrowserExtensionRoutes } =
  await import('../routes/admin/browserExtension.js');

const PLATFORM_FILE = path.join(contentsDir, 'config', 'platform.json');
const KEY = 'azure-subscription-key-plain';
const withKey = key => ({
  defaultLanguage: 'en',
  speech: { azure: { region: 'x', subscriptionKey: key } }
});
const stored = async () => JSON.parse(await fs.readFile(PLATFORM_FILE, 'utf8'));

before(async () => {
  await tokenStorageService.initializeEncryptionKey();
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('encryptPlatformSecrets', () => {
  it('encrypts a plain-text key without changing its argument', async () => {
    const input = withKey(KEY);
    const output = await encryptPlatformSecrets(input);
    assert.ok(tokenStorageService.isEncrypted(output.speech.azure.subscriptionKey));
    assert.equal(input.speech.azure.subscriptionKey, KEY, 'the argument is not modified');
    assert.equal(output.speech.azure.region, 'x');
    assert.equal(decryptPlatformSecrets(output).speech.azure.subscriptionKey, KEY);
  });

  it('leaves a placeholder, an encrypted key and a file without one alone', async () => {
    const placeholder = withKey('${AZURE_SPEECH_KEY}');
    assert.equal(await encryptPlatformSecrets(placeholder), placeholder);

    const encrypted = withKey(tokenStorageService.encryptString(KEY));
    assert.equal(await encryptPlatformSecrets(encrypted), encrypted, 'idempotent');

    for (const plain of [{}, { speech: {} }, withKey(''), null]) {
      assert.equal(await encryptPlatformSecrets(plain), plain);
    }
  });
});

describe('saving platform.json', () => {
  it('stores the key encrypted, whatever the caller passes', async () => {
    await configStore.writeJson('config/platform.json', withKey(KEY));
    const onDisk = await stored();
    assert.ok(tokenStorageService.isEncrypted(onDisk.speech.azure.subscriptionKey));
    assert.ok(!(await fs.readFile(PLATFORM_FILE, 'utf8')).includes(KEY));
  });

  it('does not touch any other file', async () => {
    await configStore.writeJson('config/other.json', withKey(KEY));
    const other = JSON.parse(
      await fs.readFile(path.join(contentsDir, 'config', 'other.json'), 'utf8')
    );
    assert.equal(other.speech.azure.subscriptionKey, KEY);
  });

  it('keeps the key encrypted when a route saves the config it read from the cache', async () => {
    // What the server holds at run time: the key decrypted.
    const encrypted = tokenStorageService.encryptString(KEY);
    await fs.writeFile(PLATFORM_FILE, JSON.stringify(withKey(encrypted)));
    configCache.setCacheEntry('config/platform.json', withKey(KEY));

    const routes = [];
    registerBrowserExtensionRoutes({
      get: () => {},
      post: (routePath, ...handlers) => routes.push({ routePath, handlers }),
      put: () => {},
      delete: () => {},
      use: () => {}
    });
    const disable = routes.find(route => route.routePath.endsWith('/browser-extension/_disable'));
    assert.ok(disable, '_disable must be registered');
    const res = { status: () => res, end: () => res, json: () => res };
    await disable.handlers.at(-1)({ body: {}, params: {}, query: {} }, res);

    const onDisk = await stored();
    assert.equal(onDisk.browserExtension.enabled, false, 'the route did save');
    assert.ok(tokenStorageService.isEncrypted(onDisk.speech.azure.subscriptionKey));
    assert.ok(!(await fs.readFile(PLATFORM_FILE, 'utf8')).includes(KEY));
  });
});
