// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-use acknowledgement (#3326): the versioning rule, the 428 guard, the user
 * and admin routes, the guest cookie, the CSV and concurrent writes.
 *
 * Native-ESM jest. users.json and platform.json live in one in-memory "store".
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const store = { files: {}, audits: [] };

const clone = value => (value === undefined ? undefined : structuredClone(value));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => {
  let queue = Promise.resolve();
  return {
    default: {
      readJson: async p => clone(store.files[p]) ?? null,
      readJsonStrict: async p => clone(store.files[p]) ?? null,
      writeJson: async (p, data) => {
        store.files[p] = clone(data);
      },
      // Sequential compare-and-set: the mutation sees the latest body.
      updateJson: (p, mutate) => {
        const run = queue.then(async () => {
          const current = clone(store.files[p]) ?? null;
          const next = await mutate(current);
          if (next === undefined) return { data: current, written: false };
          store.files[p] = clone(next);
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

const service = await import('../services/aiAcknowledgement/aiAcknowledgementService.js');
const guest = await import('../services/aiAcknowledgement/guestAcknowledgement.js');
const { aiAcknowledgementRequired } = await import('../middleware/aiAcknowledgementRequired.js');
const { default: registerUserRoutes } = await import('../routes/aiAcknowledgementRoutes.js');
const { default: registerAdminRoutes } = await import('../routes/admin/aiAcknowledgements.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');
const { recordAiAcknowledgement, clearAiAcknowledgements } =
  await import('../utils/userManager.js');
const { setGuestId, guestOwnerId } = await import('../services/chat/chatOwner.js');
const { mergeSettingsForSave, describeSettingsChange } = service;

const USERS = 'config/users.json';
const PLATFORM = 'config/platform.json';
const GUEST_ID = 'a'.repeat(64);

function seed({ settings = {}, users } = {}) {
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
      bob: {
        username: 'bob',
        authMethods: ['oidc'],
        aiAcknowledgements: [
          { version: 1, textHash: 'sha256:aa', acknowledgedAt: '2026-01-01T00:00:00.000Z' }
        ]
      },
      '=evil': { username: '=cmd', name: '=HYPERLINK("x")', authMethods: ['local'] }
    },
    metadata: { version: '2.0.0' }
  };
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
    expect(service.summary()).toMatchObject({ acknowledged: 1, pending: 2, total: 3 });
    expect(service.buildCsvRows('acknowledged').map(r => r[0])).toEqual(['bob']);
    expect(service.buildCsvRows('pending').map(r => r[0])).toEqual(['alice', '=evil']);
    expect(service.buildCsvRows(undefined)).toHaveLength(3);
    const { buildCsv } = await import('../utils/csv.js');
    const csv = buildCsv([...service.CSV_HEADERS], service.buildCsvRows('pending'));
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
    const value = guest.signAcknowledgement(subject, 1);
    expect(guest.verifyAcknowledgement(value, subject, settings)).toBe(true);
    expect(guest.verifyAcknowledgement(value + 'x', subject, settings)).toBe(false);
    expect(guest.verifyAcknowledgement(value, `guest:${'b'.repeat(64)}`, settings)).toBe(false);
    expect(guest.verifyAcknowledgement(value, subject, { ...settings, requiredVersion: 2 })).toBe(
      false
    );
    expect(guest.verifyAcknowledgement('garbage', subject, settings)).toBe(false);
    expect(guest.verifyAcknowledgement(undefined, subject, settings)).toBe(false);
  });

  test('a cookie issued before resetAt stops counting', () => {
    const issued = Date.now() - 60_000;
    const value = guest.signAcknowledgement(subject, 1, issued);
    const resetAt = new Date(Date.now() - 1000).toISOString();
    expect(guest.verifyAcknowledgement(value, subject, { ...settings, resetAt })).toBe(false);
    expect(
      guest.verifyAcknowledgement(value, subject, {
        ...settings,
        resetAt: new Date(issued - 1000).toISOString()
      })
    ).toBe(true);
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

  test('another worker wrote the acknowledgement a moment ago: the store is re-read', async () => {
    const app = buildApp();
    // The cached copy is stale, the store (readJsonStrict) is current: both read the same
    // object here, so write through a user the cache has not seen by dropping it from the cache view.
    const fresh = structuredClone(store.files[USERS]);
    fresh.users.alice.aiAcknowledgements = [
      { version: 1, textHash: 'sha256:x', acknowledgedAt: 'now' }
    ];
    const original = store.files[USERS];
    // loadUsers() sees `original` (no ack); loadUsersFresh() replaces the cache entry with `fresh`.
    const { default: configStore } = await import('../services/config/ConfigStore.js');
    const spy = jest.spyOn(configStore, 'readJsonStrict').mockResolvedValue(fresh);
    expect(original.users.alice.aiAcknowledgements).toBeUndefined();
    expect((await post(app, asUser('alice'))).status).toBe(200);
    spy.mockRestore();
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
    expect(store.files[USERS].users.alice.aiAcknowledgements).toHaveLength(1);
    const second = await request(app)
      .post('/api/eu-ai-act/acknowledgements/me')
      .set('x-user', asUser('alice'))
      .send(body);
    expect(second.status).toBe(200);
    expect(store.files[USERS].users.alice.aiAcknowledgements).toHaveLength(1);
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
    expect(store.files[USERS].users.alice.aiAcknowledgements).toBeUndefined();
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

  beforeEach(() => {
    seed();
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
    expect(store.files[USERS].users.alice.aiAcknowledgements[0]).toMatchObject({
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
    expect(service.summary().acknowledged).toBe(0);
  });

  test('remove one: 204, entries gone, audit written; unknown user 404', async () => {
    const app = buildApp({ chat: false });
    expect(
      (await admin(request(app).delete('/api/admin/eu-ai-act/users/bob/acknowledgements'))).status
    ).toBe(204);
    expect(store.files[USERS].users.bob.aiAcknowledgements).toBeUndefined();
    expect(store.audits.at(-1)).toMatchObject({
      action: 'delete',
      resource: 'aiAcknowledgement',
      resourceId: 'bob'
    });
    expect(
      (await admin(request(app).delete('/api/admin/eu-ai-act/users/nobody/acknowledgements')))
        .status
    ).toBe(404);
  });

  test('remove all clears every record and sets resetAt, so old guest cookies die', async () => {
    const app = buildApp({ chat: false });
    const old = guest.signAcknowledgement(`guest:${GUEST_ID}`, 1, Date.now() - 5000);
    expect((await admin(request(app).delete('/api/admin/eu-ai-act/acknowledgements'))).status).toBe(
      204
    );
    expect(Object.values(store.files[USERS].users).some(u => u.aiAcknowledgements)).toBe(false);
    const { resetAt } = store.files[PLATFORM].aiAcknowledgement;
    expect(typeof resetAt).toBe('string');
    expect(guest.verifyAcknowledgement(old, `guest:${GUEST_ID}`, service.getSettings())).toBe(
      false
    );
    expect(store.audits.at(-1)).toMatchObject({ action: 'delete', resourceId: '*' });
    expect(store.audits.at(-1).details).toMatchObject({ users: 1, entries: 1 });
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

describe('userManager helpers', () => {
  beforeEach(() => seed({ users: { u0: { username: 'u0' } } }));

  test('50 parallel acknowledgements for different users lose none', async () => {
    const users = {};
    for (let i = 0; i < 50; i += 1) users[`u${i}`] = { username: `u${i}` };
    seed({ users });
    const file = service.usersFilePath();
    await Promise.all(
      Object.keys(users).map(id =>
        recordAiAcknowledgement(
          id,
          { version: 1, textHash: 'sha256:x', acknowledgedAt: new Date().toISOString() },
          file
        )
      )
    );
    const stored = store.files[USERS].users;
    expect(Object.values(stored).every(u => u.aiAcknowledgements?.length === 1)).toBe(true);
  });

  test('one entry per version; unknown users are reported; clear counts what it removed', async () => {
    const file = service.usersFilePath();
    const entry = { version: 1, textHash: 'sha256:x', acknowledgedAt: 'now' };
    expect((await recordAiAcknowledgement('u0', entry, file)).recorded).toBe(true);
    expect((await recordAiAcknowledgement('u0', entry, file)).recorded).toBe(false);
    expect((await recordAiAcknowledgement('ghost', entry, file)).entry).toBeNull();
    await recordAiAcknowledgement('u0', { ...entry, version: 2 }, file);
    expect(await clearAiAcknowledgements('u0', file)).toEqual({
      users: 1,
      entries: 2,
      found: true
    });
    expect((await clearAiAcknowledgements('ghost', file)).found).toBe(false);
    expect(await clearAiAcknowledgements(null, file)).toEqual({
      users: 0,
      entries: 0,
      found: true
    });
  });

  test('deleting a user removes their acknowledgements with the record', () => {
    // The entries live on the user object: removing the record removes them.
    seed();
    delete store.files[USERS].users.bob;
    expect(service.buildCsvRows(undefined).map(r => r[0])).not.toContain('bob');
  });
});
