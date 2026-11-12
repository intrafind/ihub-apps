// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `updatePlatform` is the one way platform.json is changed. These tests run it
 * against a real file: parallel changes to different sections all land, secrets
 * are encrypted exactly as `writeJson` does (and never decrypted on the way
 * back), and the admin routes that used to build the file from the runtime cache
 * no longer revert fields or write resolved values onto disk.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const baseDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-platform-store-'));
const contentsDir = path.join(baseDir, 'contents');
process.env.CONTENTS_DIR = contentsDir;
fsSync.mkdirSync(path.join(contentsDir, 'config'), { recursive: true });

const { updatePlatform, SKIP } = await import('../utils/platformConfigStore.js');
const { default: configCache } = await import('../configCache.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { default: registerBrowserExtensionRoutes } =
  await import('../routes/admin/browserExtension.js');
const { default: registerNextcloudEmbedRoutes } = await import('../routes/admin/nextcloudEmbed.js');
const { default: registerCacheRoutes } = await import('../routes/admin/cache.js');
const { default: registerSslRoutes } = await import('../routes/admin/ssl.js');
const { default: registerCorsRoutes } = await import('../routes/admin/cors.js');

const FILE = path.join(contentsDir, 'config', 'platform.json');
const KEY = 'azure-subscription-key-plain';
const read = async () => JSON.parse(await fs.readFile(FILE, 'utf8'));
const write = data => fs.writeFile(FILE, JSON.stringify(data, null, 2));

/** Collect the handlers a route module registers, by method and path suffix. */
function routesOf(register) {
  const routes = [];
  const add =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: add('get'),
    post: add('post'),
    put: add('put'),
    delete: add('delete'),
    use() {}
  });
  return (method, suffix) => {
    const route = routes.find(r => r.method === method && r.routePath.endsWith(suffix));
    assert.ok(route, `${method} ${suffix} must be registered`);
    return async (body = {}) => {
      const out = { status: 200, body: undefined };
      const res = {
        status: code => ((out.status = code), res),
        end: () => res,
        json: payload => ((out.body = payload), res),
        setHeader: () => res
      };
      await route.handlers.at(-1)({ body, params: {}, query: {}, headers: {} }, res);
      return out;
    };
  };
}

before(async () => {
  await tokenStorageService.initializeEncryptionKey();
});
after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await write({ defaultLanguage: 'en', features: { a: true } });
});

describe('updatePlatform', () => {
  it('keeps every section of many parallel changes', async () => {
    const sections = Array.from({ length: 25 }, (_, i) => `section${i}`);
    await Promise.all(sections.map(name => updatePlatform({ [name]: { name } })));
    const stored = await read();
    for (const name of sections) assert.deepEqual(stored[name], { name }, `${name} was lost`);
    assert.equal(stored.defaultLanguage, 'en');
  });

  it('applies a function change to the stored file, and counts every increment', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        updatePlatform(draft => {
          draft.counter = (draft.counter || 0) + 1;
        })
      )
    );
    assert.equal((await read()).counter, 20);
  });

  it('writes nothing for SKIP and when the change throws', async () => {
    const before = await fs.readFile(FILE, 'utf8');
    const skipped = await updatePlatform(() => SKIP);
    assert.equal(skipped.written, false);
    await assert.rejects(
      updatePlatform(draft => {
        draft.half = 'done';
        throw new Error('rejected');
      }),
      /rejected/
    );
    assert.equal(await fs.readFile(FILE, 'utf8'), before);
  });

  it('fails on a missing file unless asked to create it', async () => {
    await fs.rm(FILE);
    await assert.rejects(updatePlatform({ a: 1 }), /missing/);
    await updatePlatform({ a: 1 }, { create: true });
    assert.deepEqual(await read(), { a: 1 });
  });

  it('refuses to replace a file it cannot parse', async () => {
    await fs.writeFile(FILE, '{ not json');
    await assert.rejects(updatePlatform({ a: 1 }));
    assert.equal(await fs.readFile(FILE, 'utf8'), '{ not json');
  });
});

describe('updatePlatform and secrets at rest', () => {
  it('encrypts a plain-text speech key, as writeJson does', async () => {
    await updatePlatform({ speech: { azure: { region: 'x', subscriptionKey: KEY } } });
    const raw = await fs.readFile(FILE, 'utf8');
    assert.ok(!raw.includes(KEY));
    assert.ok(tokenStorageService.isEncrypted((await read()).speech.azure.subscriptionKey));
  });

  it('leaves an already encrypted key byte for byte alone when another section changes', async () => {
    const encrypted = tokenStorageService.encryptString(KEY);
    await write({ speech: { azure: { subscriptionKey: encrypted } } });
    await updatePlatform({ cors: { origin: ['*'] } });
    assert.equal((await read()).speech.azure.subscriptionKey, encrypted);
  });

  it('keeps an environment placeholder as written', async () => {
    await updatePlatform({ speech: { azure: { subscriptionKey: '${AZURE_SPEECH_KEY}' } } });
    assert.equal((await read()).speech.azure.subscriptionKey, '${AZURE_SPEECH_KEY}');
  });

  it('encrypts a plain-text key that was left in the file by hand', async () => {
    await write({ speech: { azure: { subscriptionKey: KEY } } });
    await updatePlatform({ cors: {} });
    assert.ok(tokenStorageService.isEncrypted((await read()).speech.azure.subscriptionKey));
  });
});

describe('routes that used to save the config they read from the cache', () => {
  const stale = () => {
    // What this worker's cache still holds: values resolved from the environment,
    // the key decrypted, and none of what another worker saved since.
    configCache.setCacheEntry('config/platform.json', {
      defaultLanguage: 'en',
      features: { a: true },
      logging: { level: 'resolved-from-env' },
      speech: { azure: { subscriptionKey: KEY } }
    });
  };

  const onDisk = () => ({
    defaultLanguage: 'en',
    features: { a: true },
    logging: { level: '${LOG_LEVEL}' },
    speech: { azure: { subscriptionKey: tokenStorageService.encryptString(KEY) } },
    savedByAnotherWorker: { value: 42 }
  });

  for (const [name, register, suffix] of [
    ['browser extension', registerBrowserExtensionRoutes, '/browser-extension/_disable'],
    ['nextcloud embed', registerNextcloudEmbedRoutes, '/nextcloud-embed/_disable']
  ]) {
    it(`${name}: keeps another worker's save and does not write resolved values`, async () => {
      await write(onDisk());
      stale();
      const handler = routesOf(register)('post', suffix);
      await handler();
      const stored = await read();
      assert.deepEqual(stored.savedByAnotherWorker, { value: 42 }, 'another worker save reverted');
      assert.equal(stored.logging.level, '${LOG_LEVEL}', 'resolved env value baked onto disk');
      assert.ok(tokenStorageService.isEncrypted(stored.speech.azure.subscriptionKey));
      assert.ok(!(await fs.readFile(FILE, 'utf8')).includes(KEY));
    });
  }
});

describe('converted handlers', () => {
  it('two admins saving different sections at once both land', async () => {
    const saveSsl = routesOf(registerSslRoutes)('put', '/ssl/config');
    const saveCors = routesOf(registerCorsRoutes)('put', '/cors/config');
    await Promise.all([
      saveSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['example.org'] }),
      saveCors({
        origin: ['https://a.example'],
        credentials: true,
        maxAge: 60,
        methods: ['GET'],
        allowedHeaders: ['x-a']
      })
    ]);
    const stored = await read();
    assert.deepEqual(stored.ssl, {
      ignoreInvalidCertificates: true,
      domainWhitelist: ['example.org']
    });
    assert.deepEqual(stored.cors.origin, ['https://a.example']);
  });

  it('concurrent client refreshes each add one to the salt', async () => {
    const refresh = routesOf(registerCacheRoutes)('post', '/client/_refresh');
    await Promise.all(Array.from({ length: 10 }, () => refresh()));
    assert.equal((await read()).refreshSalt.salt, 10);
  });
});
