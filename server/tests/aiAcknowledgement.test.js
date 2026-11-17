// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-use acknowledgement (#3326): the versioning rule, the 428 guard, the user
 * and admin routes, the guest cookie, the CSV and concurrent writes.
 *
 * Native-ESM jest. users.json and platform.json live in one in-memory "store";
 * the acknowledgement documents in a real filesystem storage provider over a
 * scratch directory. A second provider over the same directory is "another
 * worker" (or pod): it shares nothing with the first but the files.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest, describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';

// `versions` stands in for the file's inode/mtime/size: bumped by every write.
const store = { files: {}, audits: [], versions: {} };
const bump = p => {
  store.versions[p] = (store.versions[p] ?? 0) + 1;
};

const clone = value => (value === undefined ? undefined : structuredClone(value));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => {
  let queue = Promise.resolve();
  return {
    default: {
      readJson: async p => clone(store.files[p]) ?? null,
      readJsonStrict: async p => clone(store.files[p]) ?? null,
      probeJson: async p => (store.files[p] ? `v${store.versions[p] ?? 0}` : null),
      writeJson: async (p, data) => {
        store.files[p] = clone(data);
        bump(p);
      },
      // Sequential compare-and-set: the mutation sees the latest body.
      updateJson: (p, mutate) => {
        const run = queue.then(async () => {
          const current = clone(store.files[p]) ?? null;
          const next = await mutate(current);
          if (next === undefined) return { data: current, written: false };
          store.files[p] = clone(next);
          bump(p);
          return { data: clone(next), written: true };
        });
        queue = run.catch(() => {});
        return run;
      }
    }
  };
});

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => store.files['config/platform.json'] || {},
    get: key => (store.files[key] ? { data: store.files[key] } : null),
    getEuAiActConformity: () =>
      store.files['config/eu-ai-act-conformity.json'] || { version: 1, enabled: true, history: [] },
    setCacheEntry: (key, data) => {
      store.files[key] = data;
    },
    refreshCacheEntry: () => Promise.resolve()
  }
}));
jest.unstable_mockModule('../configSync.js', () => ({ announceConfigChange: () => undefined }));
jest.unstable_mockModule('../utils/tokenService.js', () => ({
  resolveJwtSecret: () => 'test-secret'
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => store.audits.push(entry)
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    if (req.headers['x-admin'] === '1') return next();
    const { ServiceError } = req.app.locals;
    return next(new ServiceError('FORBIDDEN', 'admin only'));
  }
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));

// The storage provider the code under test sees; `useWorker` swaps it.
const storage = { current: null, providers: [], dir: null };
jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  StorageBootstrapError: class StorageBootstrapError extends Error {},
  bootstrapStorage: async () => storage.current,
  getStorage: () => storage.current,
  requireStorage: () => storage.current,
  isStorageReady: () => storage.current !== null,
  shutdownStorageBootstrap: async () => undefined,
  readFacet: (provider, facet) => provider?.[facet] || null
}));

/** A provider over the shared scratch directory: one "worker". */
async function openWorker() {
  const provider = new FilesystemStorageProvider({ baseDir: storage.dir, flushIntervalMs: 25 });
  await provider.initialize();
  storage.providers.push(provider);
  return provider;
}

/** An empty store and one worker on it. */
async function freshStore() {
  storage.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-ai-ack-'));
  storage.current = await openWorker();
  return storage.current;
}

afterAll(async () => {
  for (const provider of storage.providers) await provider.shutdown().catch(() => {});
});

const service = await import('../services/aiAcknowledgement/aiAcknowledgementService.js');
const guest = await import('../services/aiAcknowledgement/guestAcknowledgement.js');
const { aiAcknowledgementRequired } = await import('../middleware/aiAcknowledgementRequired.js');
const { default: registerUserRoutes } = await import('../routes/aiAcknowledgementRoutes.js');
const { default: registerAdminRoutes } = await import('../routes/admin/aiAcknowledgements.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');
const { loadUsersFresh, updateUsersFile } = await import('../utils/userManager.js');
const { getAiAcknowledgementRepository, AI_ACKNOWLEDGEMENTS_NAMESPACE, acknowledgementKey } =
  await import('../services/aiAcknowledgement/AiAcknowledgementRepository.js');
const { setGuestId, guestOwnerId } = await import('../services/chat/chatOwner.js');
const ackCache = await import('../services/aiAcknowledgement/acknowledgementCache.js');
const { mergeSettingsForSave, describeSettingsChange } = service;

const USERS = 'config/users.json';
const PLATFORM = 'config/platform.json';
const GUEST_ID = 'a'.repeat(64);

const repo = () => getAiAcknowledgementRepository();
/** The stored entries of a user, or undefined without a document. */
const entriesOf = async id => (await repo().get(id))?.aiAcknowledgements;

const BOB_ENTRY = { version: 1, textHash: 'sha256:aa', acknowledgedAt: '2026-01-01T00:00:00.000Z' };

async function seed({ settings = {}, users, acknowledgements = { bob: [BOB_ENTRY] } } = {}) {
  await freshStore();
  ackCache.resetAcknowledgementCacheForTests();
  store.audits = [];
  store.files[PLATFORM] = {
    aiAcknowledgement: {
      enabled: true,
      enforce: true,
      requiredVersion: 1,
      resetAt: null,
      text: { en: 'Use AI responsibly.', de: 'KI verantwortungsvoll nutzen.' },
      policyUrl: '',
      ...settings
    }
  };
  store.files[USERS] = {
    users: users ?? {
      alice: { username: 'alice', name: 'Alice', authMethods: ['local'], active: true },
      bob: { username: 'bob', authMethods: ['oidc'] },
      '=evil': { username: '=cmd', name: '=HYPERLINK("x")', authMethods: ['local'] }
    },
    metadata: { version: '2.0.0' }
  };
  for (const [id, entries] of Object.entries(acknowledgements)) {
    for (const entry of entries) await repo().record(id, entry);
  }
}

function buildApp({ chat = true } = {}) {
  const app = express();
  app.locals.ServiceError = ServiceError;
  app.use(express.json());
  // A plain cookie reader: this throwaway app has no sessions, so it needs no cookie middleware.
  app.use((req, res, next) => {
    req.cookies = Object.fromEntries(
      String(req.headers.cookie || '')
        .split(';')
        .map(part => part.trim().split(/=(.*)/s))
        .filter(([name]) => name)
        .map(([name, value]) => [name, value ?? ''])
    );
    next();
  });
  app.use((req, res, next) => {
    const raw = req.headers['x-user'];
    if (raw === 'guest') {
      req.user = { id: 'anonymous', groups: ['anonymous'] };
      setGuestId(req.user, GUEST_ID);
    } else if (raw) {
      req.user = JSON.parse(raw);
    }
    next();
  });
  registerUserRoutes(app);
  registerAdminRoutes(app);
  if (chat) {
    const sideEffect = jest.fn();
    app.post('/api/apps/:appId/chat/:chatId', aiAcknowledgementRequired, (req, res) => {
      sideEffect();
      res.status(200).json({ ok: true });
    });
    app.locals.sideEffect = sideEffect;
  }
  app.use(errorHandler);
  return app;
}

const asUser = id => JSON.stringify({ id, groups: ['users'] });

describe('service rules', () => {
  beforeEach(() => seed());

  test('valid means a version at or above the required one', () => {
    const settings = service.getSettings();
    const user = { aiAcknowledgements: [{ version: 2 }] };
    expect(service.isAcknowledged(user, { ...settings, requiredVersion: 2 })).toBe(true);
    expect(service.isAcknowledged(user, { ...settings, requiredVersion: 3 })).toBe(false);
    expect(service.statusOfUser(user, { requiredVersion: 3 })).toBe('outdated');
    expect(service.statusOfUser({}, { requiredVersion: 1 })).toBe('never');
    expect(service.statusOfUser(user, { requiredVersion: 1 })).toBe('acknowledged');
  });

  test('an entry from before resetAt does not count, even if it came back', () => {
    const user = {
      aiAcknowledgements: [{ version: 1, acknowledgedAt: '2026-01-01T00:00:00.000Z' }]
    };
    const base = { requiredVersion: 1 };
    expect(service.isAcknowledged(user, { ...base, resetAt: null })).toBe(true);
    expect(service.isAcknowledged(user, { ...base, resetAt: '2026-02-01T00:00:00.000Z' })).toBe(
      false
    );
    expect(service.isAcknowledged(user, { ...base, resetAt: '2025-12-01T00:00:00.000Z' })).toBe(
      true
    );
    // A fresh confirmation after the reset counts again.
    const again = {
      aiAcknowledgements: [{ version: 1, acknowledgedAt: '2026-03-01T00:00:00.000Z' }]
    };
    expect(service.isAcknowledged(again, { ...base, resetAt: '2026-02-01T00:00:00.000Z' })).toBe(
      true
    );
  });

  test('hash is stable, prefixed and differs per text', () => {
    const a = service.textHash('hello');
    expect(a).toBe(service.textHash('hello'));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(service.textHash('hello!')).not.toBe(a);
  });

  test('text resolves per language with fallbacks and a built-in default', () => {
    const settings = service.getSettings();
    expect(service.resolveText(settings, 'de').language).toBe('de');
    expect(service.resolveText(settings, 'fr', 'de').language).toBe('de');
    expect(service.resolveText({ text: {} }, 'de').text).toBe(service.FALLBACK_TEXT.de);
    // A language that names an inherited property is no language at all.
    expect(service.resolveText({ text: {} }, 'constructor').language).toBe('en');
    expect(service.resolveText({ text: { en: 'E' } }, 'toString').text).toBe('E');
    // The built-in text follows the platform language before English.
    expect(service.resolveText({ text: {} }, 'fr', 'de')).toEqual({
      text: service.FALLBACK_TEXT.de,
      language: 'de'
    });
    expect(service.resolveText({ text: { en: '  ' } }, 'xx').language).toBe('en');
  });

  test('policy URLs: http(s) and site-relative only', () => {
    for (const ok of ['', 'https://a.example/p', 'http://a.example', '/policy'])
      expect(service.isSafePolicyUrl(ok)).toBe(true);
    for (const bad of ['javascript:alert(1)', '//evil.example', 'data:text/html,x', 'ftp://x'])
      expect(service.isSafePolicyUrl(bad)).toBe(false);
  });

  test('machine principals are exempt, people are not', () => {
    expect(service.isMachinePrincipal({ isOAuthClient: true })).toBe(true);
    expect(service.isMachinePrincipal({ isPersonalApiKey: true })).toBe(true);
    expect(service.isMachinePrincipal({ clientId: 'c' })).toBe(true);
    expect(service.isMachinePrincipal({ isAgent: true })).toBe(true);
    expect(service.isMachinePrincipal({ id: 'alice' })).toBe(false);
  });

  test('summary and CSV rows follow the status filter; formulas are neutralised', async () => {
    expect(await service.summary()).toMatchObject({ acknowledged: 1, pending: 2, total: 3 });
    expect((await service.buildCsvRows('acknowledged')).map(r => r[0])).toEqual(['bob']);
    expect((await service.buildCsvRows('pending')).map(r => r[0])).toEqual(['alice', '=evil']);
    expect(await service.buildCsvRows(undefined)).toHaveLength(3);
    const { buildCsv } = await import('../utils/csv.js');
    const csv = buildCsv([...service.CSV_HEADERS], await service.buildCsvRows('pending'));
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/(^|,)=cmd/m);
    expect(csv.split('\n')[0]).not.toContain('email');
  });

  test('settings save keeps the server-owned fields and validates the rest', () => {
    const stored = {
      enabled: true,
      requiredVersion: 5,
      resetAt: '2026-02-02T00:00:00.000Z',
      text: {}
    };
    const merged = mergeSettingsForSave(
      { enabled: false, requiredVersion: 1, resetAt: null, policyUrl: 'https://x.example' },
      stored
    );
    expect(merged.requiredVersion).toBe(5);
    expect(merged.resetAt).toBe('2026-02-02T00:00:00.000Z');
    expect(merged.enabled).toBe(false);
    expect(merged.policyUrl).toBe('https://x.example');
    expect(mergeSettingsForSave(undefined, stored)).toBe(stored);
    expect(() => mergeSettingsForSave({ policyUrl: 'javascript:alert(1)' }, stored)).toThrow(
      /policyUrl/
    );
    expect(() => mergeSettingsForSave({ text: { en: 5 } }, stored)).toThrow(/text/);
    expect(() => mergeSettingsForSave({ enabled: 'yes' }, stored)).toThrow(/enabled/);
  });

  test('settings change description lists keys and text hashes', () => {
    const before = { text: { en: 'a' }, enforce: true };
    expect(describeSettingsChange(before, { ...before })).toBeNull();
    const change = describeSettingsChange(before, { text: { en: 'b' }, enforce: false });
    expect(change.changed.sort()).toEqual(['enforce', 'text']);
    expect(change.textHashes.en).toBe(service.textHash('b'));
  });
});

describe('guest cookie', () => {
  const settings = { requiredVersion: 1, resetAt: null };
  const subject = `guest:${GUEST_ID}`;

  test('a signed cookie verifies; tampering, another guest and old versions do not', () => {
    const issued = Date.now() - 1000;
    const value = guest.signAcknowledgement(subject, 1, issued);
    // A valid cookie answers with its issue time.
    expect(guest.verifyAcknowledgement(value, subject, settings)).toBe(issued);
    expect(guest.verifyAcknowledgement(value + 'x', subject, settings)).toBeNull();
    expect(guest.verifyAcknowledgement(value, `guest:${'b'.repeat(64)}`, settings)).toBeNull();
    expect(
      guest.verifyAcknowledgement(value, subject, { ...settings, requiredVersion: 2 })
    ).toBeNull();
    expect(guest.verifyAcknowledgement('garbage', subject, settings)).toBeNull();
    expect(guest.verifyAcknowledgement(undefined, subject, settings)).toBeNull();
  });

  test('a cookie issued before resetAt stops counting', () => {
    const issued = Date.now() - 60_000;
    const value = guest.signAcknowledgement(subject, 1, issued);
    const resetAt = new Date(Date.now() - 1000).toISOString();
    expect(guest.verifyAcknowledgement(value, subject, { ...settings, resetAt })).toBeNull();
    expect(
      guest.verifyAcknowledgement(value, subject, {
        ...settings,
        resetAt: new Date(issued - 1000).toISOString()
      })
    ).toBe(issued);
  });
});

describe('428 guard', () => {
  beforeEach(() => seed());

  const post = (app, user, cookie) => {
    const req = request(app).post('/api/apps/x/chat/c1').send({});
    if (user) req.set('x-user', user);
    if (cookie) req.set('Cookie', cookie);
    return req;
  };

  test('refuses an unacknowledged user with problem+json before any side effect', async () => {
    const app = buildApp();
    const res = await post(app, asUser('alice'));
    expect(res.status).toBe(428);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('AI_ACKNOWLEDGEMENT_REQUIRED');
    expect(res.body.status).toBe(428);
    expect(app.locals.sideEffect).not.toHaveBeenCalled();
  });

  test('lets an acknowledged user through', async () => {
    const app = buildApp();
    expect((await post(app, asUser('bob'))).status).toBe(200);
    expect(app.locals.sideEffect).toHaveBeenCalledTimes(1);
  });

  test('an outdated acknowledgement is refused after the version is raised', async () => {
    store.files[PLATFORM].aiAcknowledgement.requiredVersion = 2;
    expect((await post(buildApp(), asUser('bob'))).status).toBe(428);
  });

  test('feature off or enforcement off never refuses', async () => {
    store.files[PLATFORM].aiAcknowledgement.enabled = false;
    expect((await post(buildApp(), asUser('alice'))).status).toBe(200);
    store.files[PLATFORM].aiAcknowledgement.enabled = true;
    store.files[PLATFORM].aiAcknowledgement.enforce = false;
    expect((await post(buildApp(), asUser('alice'))).status).toBe(200);
  });

  test('machine principals are exempt', async () => {
    const app = buildApp();
    for (const flag of ['isOAuthClient', 'isPersonalApiKey', 'isAgent']) {
      const res = await post(app, JSON.stringify({ id: 'svc', [flag]: true }));
      expect(res.status).toBe(200);
    }
    expect((await post(app, JSON.stringify({ id: 'svc', clientId: 'c' }))).status).toBe(200);
  });

  test('a confirmation on another worker is seen by the guard here, without a cookie', async () => {
    const workerA = storage.current;
    const workerB = await openWorker();
    const appA = buildApp();
    const appB = buildApp();
    expect((await post(appA, asUser('alice'))).status).toBe(428);

    storage.current = workerB;
    const hash = service.textHash('Use AI responsibly.');
    const confirm = await request(appB)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: hash, language: 'en' });
    expect(confirm.status).toBe(201);

    // Back on worker A, with no cookie: the shared store decides.
    storage.current = workerA;
    expect((await post(appA, asUser('alice'))).status).toBe(200);
  });

  test('the guard and GET /me never read users.json', async () => {
    const { default: configStore } = await import('../services/config/ConfigStore.js');
    const strict = jest.spyOn(configStore, 'readJsonStrict');
    const plain = jest.spyOn(configStore, 'readJson');
    try {
      const app = buildApp();
      expect((await post(app, asUser('alice'))).status).toBe(428);
      expect((await post(app, asUser('bob'))).status).toBe(200);
      await request(app).get('/api/eu-ai-act/acknowledgements/me').set('x-user', asUser('alice'));
      expect(strict).not.toHaveBeenCalled();
      expect(plain).not.toHaveBeenCalled();
    } finally {
      strict.mockRestore();
      plain.mockRestore();
    }
  });

  describe('signed cookie of a user whose document says "not yet"', () => {
    const cookieFor = (id, issuedAt, version = 1) =>
      `${guest.ACK_COOKIE}=${guest.signAcknowledgement(`user:${id}`, version, issuedAt)}`;
    const admin = req => req.set('x-admin', '1');

    test('passes, and is bound to its user', async () => {
      const app = buildApp();
      expect((await post(app, asUser('alice'), cookieFor('alice'))).status).toBe(200);
      expect((await post(app, asUser('=evil'), cookieFor('alice'))).status).toBe(428);
    });

    test('a per-user removal revokes an older cookie on every worker; a newer one passes', async () => {
      const app = buildApp();
      const before = cookieFor('bob', Date.now() - 5000);
      expect((await post(app, asUser('bob'), before)).status).toBe(200);
      const workerA = storage.current;
      storage.current = await openWorker();
      expect(
        (await admin(request(buildApp()).delete('/api/admin/eu-ai-act/users/bob/acknowledgements')))
          .status
      ).toBe(204);
      storage.current = workerA;
      expect(typeof (await repo().get('bob')).aiAcknowledgementsClearedAt).toBe('string');
      expect(await entriesOf('bob')).toEqual([]);
      expect((await post(app, asUser('bob'), before)).status).toBe(428);
      expect((await post(app, asUser('bob'), cookieFor('bob', Date.now() + 1000))).status).toBe(
        200
      );
    });

    test('"Remove all" revokes every user cookie and entry with one settings write', async () => {
      const app = buildApp();
      const cookie = cookieFor('alice', Date.now() - 5000);
      expect((await post(app, asUser('alice'), cookie)).status).toBe(200);
      expect((await post(app, asUser('bob'))).status).toBe(200);
      expect(
        (await admin(request(buildApp()).delete('/api/admin/eu-ai-act/acknowledgements'))).status
      ).toBe(204);
      expect((await post(app, asUser('alice'), cookie)).status).toBe(428);
      expect((await post(app, asUser('bob'))).status).toBe(428);
    });

    test('after a version bump the old cookie is refused', async () => {
      const app = buildApp();
      const v1 = cookieFor('alice');
      expect((await post(app, asUser('alice'), v1)).status).toBe(200);
      store.files[PLATFORM].aiAcknowledgement.requiredVersion = 2;
      expect((await post(app, asUser('alice'), v1)).status).toBe(428);
      expect((await post(app, asUser('alice'), cookieFor('alice', Date.now(), 2))).status).toBe(
        200
      );
    });

    test('a store that cannot be read leaves the cookie as the proof', async () => {
      const app = buildApp();
      const spy = jest.spyOn(storage.current.documents, 'get').mockRejectedValue(new Error('down'));
      try {
        expect((await post(app, asUser('bob'))).status).toBe(428);
        expect((await post(app, asUser('bob'), cookieFor('bob'))).status).toBe(200);
        // That cookie-only yes is not remembered: the store may say it was revoked.
        expect(ackCache.isRememberedAcknowledged('bob', service.getSettings())).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  test('guests: no cookie refused; valid cookie passes; wrong guest refused', async () => {
    const app = buildApp();
    expect((await post(app, 'guest')).status).toBe(428);
    const good = guest.signAcknowledgement(`guest:${GUEST_ID}`, 1);
    expect((await post(app, 'guest', `${guest.ACK_COOKIE}=${good}`)).status).toBe(200);
    const other = guest.signAcknowledgement(`guest:${'c'.repeat(64)}`, 1);
    expect((await post(app, 'guest', `${guest.ACK_COOKIE}=${other}`)).status).toBe(428);
  });
});

describe('per-worker acknowledgement cache', () => {
  beforeEach(() => seed());

  const post = (app, user) => request(app).post('/api/apps/x/chat/c1').set('x-user', user).send({});
  const countReads = () => jest.spyOn(storage.current.documents, 'get');

  test('a positive result is remembered: the second request reads nothing', async () => {
    const app = buildApp();
    const reads = countReads();
    try {
      expect((await post(app, asUser('bob'))).status).toBe(200);
      expect((await post(app, asUser('bob'))).status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  test('"not yet" is never remembered: a confirmation written elsewhere counts at once', async () => {
    const app = buildApp();
    expect((await post(app, asUser('alice'))).status).toBe(428);
    // Written straight to the store, as another pod would, bypassing this worker's cache.
    await repo().record('alice', { ...BOB_ENTRY });
    expect((await post(app, asUser('alice'))).status).toBe(200);
  });

  test('POST /me remembers the confirmation right away', async () => {
    const app = buildApp();
    const confirm = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: service.textHash('Use AI responsibly.'), language: 'en' });
    expect(confirm.status).toBe(201);
    const reads = countReads();
    try {
      expect((await post(app, asUser('alice'))).status).toBe(200);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });

  test('a version bump or "Remove all" invalidates remembered entries at once', async () => {
    const app = buildApp();
    expect((await post(app, asUser('bob'))).status).toBe(200);
    store.files[PLATFORM].aiAcknowledgement.requiredVersion = 2;
    expect((await post(app, asUser('bob'))).status).toBe(428);

    store.files[PLATFORM].aiAcknowledgement.requiredVersion = 1;
    expect((await post(app, asUser('bob'))).status).toBe(200);
    store.files[PLATFORM].aiAcknowledgement.resetAt = new Date(Date.now() + 1000).toISOString();
    expect((await post(app, asUser('bob'))).status).toBe(428);
  });

  test('an entry expires after the TTL and the store is asked again', async () => {
    const app = buildApp();
    const realNow = Date.now;
    expect((await post(app, asUser('bob'))).status).toBe(200);
    // Removed behind this worker's back (another pod): still remembered...
    await storage.current.documents.delete(
      AI_ACKNOWLEDGEMENTS_NAMESPACE,
      acknowledgementKey('bob')
    );
    expect((await post(app, asUser('bob'))).status).toBe(200);
    // ...until the TTL has passed.
    Date.now = () => realNow() + ackCache.ACKNOWLEDGEMENT_CACHE_TTL_MS + 1;
    try {
      expect((await post(app, asUser('bob'))).status).toBe(428);
    } finally {
      Date.now = realNow;
    }
  });

  test('per-user removal forgets the user on this worker at once', async () => {
    const app = buildApp();
    expect((await post(app, asUser('bob'))).status).toBe(200);
    expect(
      (
        await request(app)
          .delete('/api/admin/eu-ai-act/users/bob/acknowledgements')
          .set('x-admin', '1')
      ).status
    ).toBe(204);
    expect((await post(app, asUser('bob'))).status).toBe(428);
  });

  test('the bus message from another worker forgets the user', () => {
    const settings = { requiredVersion: 1, resetAt: null };
    ackCache.rememberAcknowledged('bob', settings);
    expect(ackCache.isRememberedAcknowledged('bob', settings)).toBe(true);
    ackCache.onForgetMessage({ userId: 'bob' });
    expect(ackCache.isRememberedAcknowledged('bob', settings)).toBe(false);
  });
});

describe('user routes', () => {
  beforeEach(() => seed());

  test('GET returns the notice, hash and status; never cached', async () => {
    const res = await request(buildApp())
      .get('/api/eu-ai-act/acknowledgements/me?language=de')
      .set('x-user', asUser('alice'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      enabled: true,
      enforce: true,
      acknowledged: false,
      requiredVersion: 1,
      language: 'de',
      text: 'KI verantwortungsvoll nutzen.'
    });
    expect(res.body.textHash).toBe(service.textHash('KI verantwortungsvoll nutzen.'));
    expect(res.body.history).toEqual([]);
  });

  test('GET shows the current entries as history', async () => {
    const res = await request(buildApp())
      .get('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('bob'));
    expect(res.body.acknowledged).toBe(true);
    expect(res.body.history).toEqual([BOB_ENTRY]);
  });

  test('GET with the feature off carries no text', async () => {
    store.files[PLATFORM].aiAcknowledgement.enabled = false;
    const res = await request(buildApp())
      .get('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'));
    expect(res.body).toEqual({
      enabled: false,
      enforce: false,
      acknowledged: true,
      requiredVersion: 1
    });
  });

  test('POST records once: 201 with Location, then 200 without a second audit entry', async () => {
    const app = buildApp();
    const notice = await request(app)
      .get('/api/eu-ai-act/acknowledgements/me?language=en')
      .set('x-user', asUser('alice'));
    const body = { version: 1, textHash: notice.body.textHash, language: 'en' };
    const first = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send(body);
    expect(first.status).toBe(201);
    expect(first.headers.location).toMatch(/\/api\/eu-ai-act\/acknowledgements\/me$/);
    expect(first.body).toMatchObject({ version: 1, textHash: body.textHash, language: 'en' });
    expect(await entriesOf('alice')).toHaveLength(1);
    expect(store.files[USERS].users.alice.aiAcknowledgements).toBeUndefined();
    const second = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send(body);
    expect(second.status).toBe(200);
    expect(await entriesOf('alice')).toHaveLength(1);
    const creates = store.audits.filter(
      a => a.resource === 'aiAcknowledgement' && a.action === 'create'
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].resourceId).toBe('alice');
    expect(creates[0].details).toMatchObject({
      version: 1,
      subject: 'user',
      textHash: body.textHash
    });
    // Now the guard lets alice through.
    expect(
      (await request(app).post('/api/apps/x/chat/y').set('x-user', asUser('alice')).send({})).status
    ).toBe(200);
  });

  test('POST: a changed text or version answers 409 with the required version', async () => {
    const app = buildApp();
    const wrongHash = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: 'sha256:stale', language: 'en' });
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body.details).toMatchObject({ requiredVersion: 1 });
    const hash = service.textHash('Use AI responsibly.');
    const wrongVersion = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 7, textHash: hash, language: 'en' });
    expect(wrongVersion.status).toBe(409);
    expect(await repo().get('alice')).toBeNull();
  });

  test('POST with the feature off answers 403 FEATURE_DISABLED; a bad body 400', async () => {
    const app = buildApp();
    const bad = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 'x' });
    expect(bad.status).toBe(400);
    store.files[PLATFORM].aiAcknowledgement.enabled = false;
    const off = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: 'sha256:x' });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');
  });

  test('a guest confirms with a cookie and an audit entry keyed by the owner hash', async () => {
    const app = buildApp();
    const hash = service.textHash('Use AI responsibly.');
    const res = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', 'guest')
      .send({ version: 1, textHash: hash, language: 'en' });
    expect(res.status).toBe(201);
    const setCookie = res.headers['set-cookie'].join(';');
    expect(setCookie).toContain(`${guest.ACK_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    const [audit] = store.audits;
    expect(audit.resourceId).toBe(guestOwnerId(GUEST_ID));
    expect(JSON.stringify({ ...audit, req: undefined })).not.toContain(GUEST_ID);
    expect(audit.details.subject).toBe('guest');
    // With the cookie the guest passes and a repeat adds no audit entry.
    const cookie = setCookie.split(';')[0];
    expect(
      (
        await request(app)
          .post('/api/apps/x/chat/y')
          .set('x-user', 'guest')
          .set('Cookie', cookie)
          .send({})
      ).status
    ).toBe(200);
    const repeat = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', 'guest')
      .set('Cookie', cookie)
      .send({ version: 1, textHash: hash, language: 'en' });
    expect(repeat.status).toBe(200);
    expect(store.audits).toHaveLength(1);
  });
});

describe('first-party delegated clients (Outlook, extension, Nextcloud)', () => {
  const OFFICE = 'office-client';
  const EXTENSION = 'extension-client';
  const NEXTCLOUD = 'nextcloud-client';
  const delegated = clientId => ({
    id: 'alice',
    groups: ['users'],
    isOAuthAuthCode: true,
    clientId
  });
  const post = (app, user) =>
    request(app).post('/api/apps/x/chat/c1').set('x-user', JSON.stringify(user)).send({});

  beforeEach(async () => {
    await seed();
    store.files[PLATFORM].officeIntegration = { oauthClientId: OFFICE };
    store.files[PLATFORM].browserExtension = { oauthClientId: EXTENSION };
    store.files[PLATFORM].nextcloudEmbed = { oauthClientId: NEXTCLOUD };
  });

  test('the three first-party clients count as people, whatever else holds a client id', () => {
    for (const clientId of [OFFICE, EXTENSION, NEXTCLOUD]) {
      expect(service.isMachinePrincipal(delegated(clientId))).toBe(false);
    }
    expect(service.firstPartyClientKind(OFFICE)).toBe('office');
    expect(service.firstPartyClientKind(EXTENSION)).toBe('extension');
    expect(service.firstPartyClientKind(NEXTCLOUD)).toBe('nextcloud');
  });

  test('every other principal type stays exempt', () => {
    // Another delegated client (a Copilot-style agent, an integrator).
    expect(service.isMachinePrincipal(delegated('someone-else'))).toBe(true);
    // The same client id without a user behind it (client credentials, or any flag set).
    expect(service.isMachinePrincipal({ clientId: OFFICE })).toBe(true);
    expect(service.isMachinePrincipal({ isOAuthClient: true, clientId: OFFICE })).toBe(true);
    expect(service.isMachinePrincipal({ ...delegated(OFFICE), isOAuthClient: true })).toBe(true);
    expect(service.isMachinePrincipal({ ...delegated(OFFICE), isPersonalApiKey: true })).toBe(true);
    expect(service.isMachinePrincipal({ ...delegated(OFFICE), isAgent: true })).toBe(true);
    // A cookie session has no client id: a person.
    expect(service.isMachinePrincipal({ id: 'alice' })).toBe(false);
    expect(service.isMachinePrincipal(undefined)).toBe(false);
  });

  test('an unset or empty client id in platform.json gates nothing', () => {
    store.files[PLATFORM].officeIntegration = { oauthClientId: '' };
    delete store.files[PLATFORM].browserExtension;
    expect(service.firstPartyClientKind('')).toBeNull();
    expect(service.firstPartyClientKind(undefined)).toBeNull();
    expect(service.isMachinePrincipal(delegated('anything'))).toBe(true);
    expect(service.isMachinePrincipal(delegated(''))).toBe(false);
  });

  test('an unconfirmed first-party token gets 428; a third-party one does not', async () => {
    const app = buildApp();
    for (const clientId of [OFFICE, EXTENSION, NEXTCLOUD]) {
      const res = await post(app, delegated(clientId));
      expect(res.status).toBe(428);
      expect(res.body.code).toBe('AI_ACKNOWLEDGEMENT_REQUIRED');
      expect(res.body.details).toMatchObject({ requiredVersion: 1 });
    }
    expect((await post(app, delegated('someone-else'))).status).toBe(200);
    expect(app.locals.sideEffect).toHaveBeenCalledTimes(1);
  });

  test('enforcement off, or the feature off, never refuses them', async () => {
    store.files[PLATFORM].aiAcknowledgement.enforce = false;
    expect((await post(buildApp(), delegated(OFFICE))).status).toBe(200);
    store.files[PLATFORM].aiAcknowledgement.enforce = true;
    store.files[PLATFORM].aiAcknowledgement.enabled = false;
    expect((await post(buildApp(), delegated(OFFICE))).status).toBe(200);
  });

  test('with a bearer-style principal: read the notice, confirm, then send; the client is recorded', async () => {
    const app = buildApp();
    const user = JSON.stringify(delegated(OFFICE));
    const notice = await request(app)
      .get('/api/eu-ai-act/acknowledgements/me?language=en')
      .set('x-user', user);
    expect(notice.status).toBe(200);
    expect(notice.body).toMatchObject({ enabled: true, enforce: true, acknowledged: false });
    const confirm = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', user)
      .send({ version: 1, textHash: notice.body.textHash, language: 'en' });
    expect(confirm.status).toBe(201);
    expect(confirm.body.client).toBe('office');
    expect((await entriesOf('alice'))[0]).toMatchObject({
      version: 1,
      client: 'office'
    });
    const audit = store.audits.find(a => a.resource === 'aiAcknowledgement');
    expect(audit.details).toMatchObject({ subject: 'user', client: 'office' });
    expect((await post(app, delegated(OFFICE))).status).toBe(200);
    // One record per user: the confirmation counts in the other first-party client too.
    expect((await post(app, delegated(EXTENSION))).status).toBe(200);
    expect(
      (await request(app).get('/api/eu-ai-act/acknowledgements/me').set('x-user', user)).body
        .acknowledged
    ).toBe(true);
  });

  test('a cookie session records no client; a body cannot claim one', async () => {
    const app = buildApp();
    const hash = service.textHash('Use AI responsibly.');
    const res = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: hash, language: 'en', client: 'office' });
    // The schema is strict: an unknown field is a validation error, not a claim.
    expect(res.status).toBe(400);
    const ok = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: hash, language: 'en' });
    expect(ok.status).toBe(201);
    expect(ok.body.client).toBeUndefined();
  });

  test('the policy link leaves absolute: sub-path and forwarded host respected', async () => {
    store.files[PLATFORM].aiAcknowledgement.policyUrl = '/page/ai-policy';
    const res = await request(buildApp())
      .get('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'ihub.example.org');
    expect(res.body.policyUrl).toBe('https://ihub.example.org/page/ai-policy');
    store.files[PLATFORM].aiAcknowledgement.policyUrl = 'https://corp.example/policy';
    const external = await request(buildApp())
      .get('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'));
    expect(external.body.policyUrl).toBe('https://corp.example/policy');
    store.files[PLATFORM].aiAcknowledgement.policyUrl = '';
    const none = await request(buildApp())
      .get('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'));
    expect(none.body.policyUrl).toBe('');
  });
});

describe('admin routes', () => {
  beforeEach(() => seed());
  const admin = req => req.set('x-admin', '1');

  test('every action refuses a non-admin', async () => {
    const app = buildApp({ chat: false });
    for (const [method, url] of [
      ['post', '/api/admin/eu-ai-act/acknowledgements/_request-again'],
      ['delete', '/api/admin/eu-ai-act/users/bob/acknowledgements'],
      ['delete', '/api/admin/eu-ai-act/acknowledgements'],
      ['get', '/api/admin/eu-ai-act/acknowledgements/_export']
    ]) {
      expect((await request(app)[method](url)).status).toBe(403);
    }
  });

  test('request again raises the version atomically, also under parallel calls', async () => {
    const app = buildApp({ chat: false });
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        admin(request(app).post('/api/admin/eu-ai-act/acknowledgements/_request-again'))
      )
    );
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(store.files[PLATFORM].aiAcknowledgement.requiredVersion).toBe(4);
    expect(results.map(r => r.body.requiredVersion).sort()).toEqual([2, 3, 4]);
    expect(store.audits.filter(a => a.action === 'update')).toHaveLength(3);
    // Everyone is outdated now.
    expect((await service.summary()).acknowledged).toBe(0);
  });

  test('remove one: 204, entries gone, audit written; unknown user 404', async () => {
    const app = buildApp({ chat: false });
    expect(
      (await admin(request(app).delete('/api/admin/eu-ai-act/users/bob/acknowledgements'))).status
    ).toBe(204);
    expect(await entriesOf('bob')).toEqual([]);
    expect(store.audits.at(-1)).toMatchObject({
      action: 'delete',
      resource: 'aiAcknowledgement',
      resourceId: 'bob',
      details: { entries: 1 }
    });
    expect(
      (await admin(request(app).delete('/api/admin/eu-ai-act/users/nobody/acknowledgements')))
        .status
    ).toBe(404);
  });

  test('remove all sets resetAt, so old guest cookies die, and deletes the entries after', async () => {
    const app = buildApp({ chat: false });
    const old = guest.signAcknowledgement(`guest:${GUEST_ID}`, 1, Date.now() - 5000);
    const usersBefore = JSON.stringify(store.files[USERS]);
    expect((await admin(request(app).delete('/api/admin/eu-ai-act/acknowledgements'))).status).toBe(
      204
    );
    // One settings write; users.json is not touched.
    expect(JSON.stringify(store.files[USERS])).toBe(usersBefore);
    const { resetAt } = store.files[PLATFORM].aiAcknowledgement;
    expect(typeof resetAt).toBe('string');
    expect(guest.verifyAcknowledgement(old, `guest:${GUEST_ID}`, service.getSettings())).toBeNull();
    expect(store.audits.at(-1)).toMatchObject({ action: 'delete', resourceId: '*' });
    expect(store.audits.at(-1).details).toMatchObject({ users: 1, entries: 1 });
    // Hidden at once, deleted in the background.
    expect(await service.summary()).toMatchObject({ acknowledged: 0 });
    for (let i = 0; i < 50 && (await entriesOf('bob'))?.length; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(await entriesOf('bob')).toEqual([]);
  });

  test('after "Remove all" a user confirms the same version again and passes', async () => {
    const app = buildApp();
    await admin(request(app).delete('/api/admin/eu-ai-act/acknowledgements'));
    // Let the clock move past resetAt before the new confirmation.
    await new Promise(resolve => setTimeout(resolve, 5));
    const confirm = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('bob'))
      .send({ version: 1, textHash: service.textHash('Use AI responsibly.'), language: 'en' });
    expect(confirm.status).toBe(201);
    expect(
      (await request(app).post('/api/apps/x/chat/y').set('x-user', asUser('bob')).send({})).status
    ).toBe(200);
  });

  test('export: CSV, filter by status, audited; a bad status is 400', async () => {
    const app = buildApp({ chat: false });
    const res = await admin(
      request(app).get('/api/admin/eu-ai-act/acknowledgements/_export?status=acknowledged')
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('ai-acknowledgements.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(service.CSV_HEADERS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith('bob,')).toBe(true);
    expect(store.audits.at(-1)).toMatchObject({ action: 'export', resource: 'aiAcknowledgement' });
    expect(
      (await admin(request(app).get('/api/admin/eu-ai-act/acknowledgements/_export?status=nope')))
        .status
    ).toBe(400);
  });
});

describe('acknowledgement documents', () => {
  beforeEach(() => seed({ users: { u0: { username: 'u0' } }, acknowledgements: {} }));
  const entry = { version: 1, textHash: 'sha256:x', acknowledgedAt: new Date().toISOString() };

  test('50 parallel acknowledgements for different users lose none, users.json untouched', async () => {
    const usersBefore = JSON.stringify(store.files[USERS]);
    const ids = Array.from({ length: 50 }, (_, i) => `u${i}`);
    await Promise.all(ids.map(id => repo().record(id, entry)));
    for (const id of ids) expect(await entriesOf(id)).toHaveLength(1);
    expect(JSON.stringify(store.files[USERS])).toBe(usersBefore);
  });

  test('the same user confirming twice at once is recorded once', async () => {
    const results = await Promise.all([repo().record('u0', entry), repo().record('u0', entry)]);
    expect(results.filter(r => r.recorded)).toHaveLength(1);
    expect(await entriesOf('u0')).toHaveLength(1);
  });

  test('one entry per version; clear counts what it removed and stamps the time', async () => {
    expect((await repo().record('u0', entry)).recorded).toBe(true);
    expect((await repo().record('u0', entry)).recorded).toBe(false);
    await repo().record('u0', { ...entry, version: 2 });
    expect(await repo().clear('u0', { now: '2026-05-05T00:00:00.000Z' })).toEqual({ entries: 2 });
    expect(await repo().get('u0')).toMatchObject({
      userId: 'u0',
      aiAcknowledgements: [],
      aiAcknowledgementsClearedAt: '2026-05-05T00:00:00.000Z'
    });
  });

  test('summary and CSV list the namespace once instead of reading per user', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `u${i}`);
    const users = Object.fromEntries(ids.map(id => [id, { username: id }]));
    await seed({ users, acknowledgements: { u1: [entry], u2: [entry] } });
    const documents = storage.current.documents;
    const get = jest.spyOn(documents, 'get');
    const list = jest.spyOn(documents, 'list');
    try {
      expect(await service.summary()).toMatchObject({ acknowledged: 2, total: 30 });
      expect(get).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0][0]).toBe(AI_ACKNOWLEDGEMENTS_NAMESPACE);
    } finally {
      get.mockRestore();
      list.mockRestore();
    }
  });

  test('a fresh read skips an unchanged users.json and re-reads a changed one', async () => {
    const { default: configStore } = await import('../services/config/ConfigStore.js');
    const spy = jest.spyOn(configStore, 'readJsonStrict');
    const file = service.usersFilePath();
    try {
      await loadUsersFresh(file);
      await loadUsersFresh(file);
      expect(spy).toHaveBeenCalledTimes(1);

      // Another worker rewrote the file: its token changed.
      bump(USERS);
      await loadUsersFresh(file);
      expect(spy).toHaveBeenCalledTimes(2);

      // This worker's own write leaves the cached copy current: no read after it.
      await updateUsersFile(file, usersConfig => {
        usersConfig.users.u0.name = 'U Zero';
        return true;
      });
      const reads = spy.mock.calls.length;
      expect((await loadUsersFresh(file)).users.u0.name).toBe('U Zero');
      expect(spy).toHaveBeenCalledTimes(reads);

      // A shared volume can keep the token after another host's write: past
      // a few seconds the file is read again although its token matches.
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5_000);
      try {
        await loadUsersFresh(file);
        expect(spy).toHaveBeenCalledTimes(reads + 1);
        await loadUsersFresh(file);
        expect(spy).toHaveBeenCalledTimes(reads + 1);
      } finally {
        clock.mockRestore();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('an unreadable document is replaced instead of blocking the user for good', async () => {
    await repo().record('u0', entry);
    const files = await fs.readdir(storage.dir, { recursive: true });
    const name = files.find(file => file.endsWith(`${acknowledgementKey('u0')}.json`));
    await fs.writeFile(path.join(storage.dir, name), '{"torn');
    expect(await repo().get('u0')).toBeNull();
    expect((await repo().record('u0', entry)).recorded).toBe(true);
    expect(await entriesOf('u0')).toHaveLength(1);
  });

  test('deleting a user removes their acknowledgement document', async () => {
    await repo().record('u0', entry);
    const { USER_CLEANUP_STEPS } = await import('../services/userDeletion.js');
    const step = USER_CLEANUP_STEPS.find(item => item.name === 'aiAcknowledgements');
    expect(await step.run('u0')).toEqual({ removed: 1 });
    expect(await repo().get('u0')).toBeNull();
  });
});

describe('EU AI Act master switch off (step 9)', () => {
  const FILE = 'config/eu-ai-act-conformity.json';
  const admin = req => req.set('x-admin', '1');
  const post = (app, user) => {
    const req = request(app).post('/api/apps/x/chat/c1').send({});
    if (user === 'guest') req.set('x-user', 'guest');
    else if (user) req.set('x-user', user);
    return req;
  };
  const actor = { id: 'admin', name: 'Anna Admin' };
  beforeEach(async () => {
    await seed();
    store.files[FILE] = {
      version: 1,
      enabled: false,
      changedAt: '2026-11-12T09:30:00.000Z',
      changedBy: actor,
      reason: 'Internal research sandbox, no EU users.',
      statementVersion: 1,
      history: []
    };
  });

  test('the guard lets everyone through without reading users.json, enforcement stays configured', async () => {
    const app = buildApp();
    expect((await post(app, asUser('alice'))).status).toBe(200);
    expect((await post(app, 'guest')).status).toBe(200);
    expect(service.getSettings()).toMatchObject({ enabled: false, configuredEnabled: true });
  });

  test('GET /me says disabled and acknowledged; POST /me is FEATURE_DISABLED', async () => {
    const app = buildApp();
    const me = await request(app)
      .get('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'));
    expect(me.body).toEqual({
      enabled: false,
      enforce: false,
      acknowledged: true,
      requiredVersion: 1
    });
    const confirm = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send({ version: 1, textHash: 'sha256:aa', language: 'en' });
    expect(confirm.status).toBe(403);
    expect(confirm.body.code).toBe('FEATURE_DISABLED');
  });

  test('acknowledgements stay: delete and reset actions are disabled, the export is not', async () => {
    const app = buildApp({ chat: false });
    for (const [method, url] of [
      ['post', '/api/admin/eu-ai-act/acknowledgements/_request-again'],
      ['delete', '/api/admin/eu-ai-act/users/bob/acknowledgements'],
      ['delete', '/api/admin/eu-ai-act/acknowledgements']
    ]) {
      const res = await admin(request(app)[method](url));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEATURE_DISABLED');
    }
    expect(await entriesOf('bob')).toHaveLength(1);
    expect(store.files[PLATFORM].aiAcknowledgement.requiredVersion).toBe(1);
    expect(
      (await admin(request(app).get('/api/admin/eu-ai-act/acknowledgements/_export'))).status
    ).toBe(200);
  });

  test('switched on again: a valid acknowledgement stays valid, others are asked', async () => {
    const app = buildApp();
    store.files[FILE] = { version: 1, enabled: true, history: [] };
    expect((await post(app, asUser('bob'))).status).toBe(200);
    expect((await post(app, asUser('alice'))).status).toBe(428);
    expect(store.files[PLATFORM].aiAcknowledgement.requiredVersion).toBe(1);
  });

  test('a settings save while off still audits a change of `enabled`', () => {
    expect(
      service.describeSettingsChange({ enabled: true }, { enabled: false })?.changed
    ).toContain('enabled');
  });
});
