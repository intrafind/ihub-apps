// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The EU AI Act master switch (step 9): the record and its helper, the three
 * admin routes, the audit trail and the public config member.
 *
 * Native-ESM jest. The record lives in one in-memory "store".
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const FILE = 'config/eu-ai-act-conformity.json';
const store = { files: {}, audits: [] };
const clone = value => (value === undefined ? undefined : structuredClone(value));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => {
  let queue = Promise.resolve();
  return {
    default: {
      // Sequential compare-and-set, like the real store inside one process.
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
    getEuAiActConformity: () => store.files[FILE] ?? { version: 1, enabled: true, history: [] },
    refreshCacheEntry: () => Promise.resolve()
  }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => store.audits.push(entry)
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    if (req.headers['x-admin'] !== '1') {
      return next(new req.app.locals.ServiceError('FORBIDDEN', 'admin only'));
    }
    // The test principal travels in a header.
    req.user = JSON.parse(req.headers['x-user'] || '{"id":"admin","name":"Anna Admin"}');
    return next();
  }
}));

const conformity = await import('../services/euAiAct/conformity.js');
const { default: registerRoutes } = await import('../routes/admin/euAiActConformity.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');
const { euAiActConformitySchema } = await import('../validators/euAiActConformitySchema.js');
const { isEuAiActEnabled, getConformity, setConformity } = conformity;

const ACTOR = { id: 'admin', name: 'Anna Admin' };
const REASON = 'Internal research sandbox, no EU users, no public output.';
const OFF_RECORD = {
  version: 1,
  enabled: false,
  changedAt: '2026-11-12T09:30:00.000Z',
  changedBy: ACTOR,
  reason: REASON,
  statementVersion: 1,
  history: [
    {
      enabled: false,
      changedAt: '2026-11-12T09:30:00.000Z',
      changedBy: ACTOR,
      reason: REASON,
      statementVersion: 1
    }
  ]
};

function buildApp() {
  const app = express();
  app.locals.ServiceError = ServiceError;
  app.use(express.json());
  registerRoutes(app);
  app.use(errorHandler);
  return app;
}
const admin = (req, user) => {
  req.set('x-admin', '1');
  if (user) req.set('x-user', JSON.stringify(user));
  return req;
};

beforeEach(() => {
  store.files = {};
  store.audits = [];
});

describe('the helper', () => {
  test('no record means on', () => {
    expect(isEuAiActEnabled()).toBe(true);
    expect(getConformity()).toMatchObject({ enabled: true, valid: true, history: [] });
  });

  test('a complete off record switches off', () => {
    store.files[FILE] = clone(OFF_RECORD);
    expect(isEuAiActEnabled()).toBe(false);
    expect(getConformity()).toMatchObject({ enabled: false, reason: REASON, changedBy: ACTOR });
  });

  test.each([
    ['no who', { ...OFF_RECORD, changedBy: undefined }],
    ['no reason', { ...OFF_RECORD, reason: null }],
    ['no time', { ...OFF_RECORD, changedAt: undefined }],
    ['an unknown member', { ...OFF_RECORD, extra: 1 }],
    ['not an object', 'off']
  ])('a hand-edited off record with %s stays on and is reported invalid', (name, record) => {
    store.files[FILE] = record;
    expect(isEuAiActEnabled()).toBe(true);
    expect(getConformity()).toMatchObject({ enabled: true, valid: false });
  });

  test('an uninitialised cache means on', () => {
    // configCache without the getter (startup): never throws
    store.files = null;
    expect(isEuAiActEnabled()).toBe(true);
    store.files = {};
  });

  test('the shipped default is a valid record', async () => {
    const { default: shipped } = await import('../defaults/config/eu-ai-act-conformity.json', {
      with: { type: 'json' }
    });
    expect(euAiActConformitySchema.safeParse(shipped).success).toBe(true);
    expect(shipped.enabled).toBe(true);
  });

  test('setConformity records who, when and why, newest first', async () => {
    const off = await setConformity({ enabled: false, reason: `  ${REASON}  `, actor: ACTOR });
    expect(off.previous).toBe(true);
    expect(off.current).toMatchObject({
      enabled: false,
      reason: REASON,
      changedBy: ACTOR,
      statementVersion: 1
    });
    expect(off.current.changedAt).toMatch(/Z$/);
    const on = await setConformity({ enabled: true, actor: { id: 'lena', name: 'Lena K.' } });
    expect(on.current.enabled).toBe(true);
    expect(on.current.history.map(h => h.enabled)).toEqual([true, false]);
    expect(on.current.history[0]).toMatchObject({ changedBy: { id: 'lena' }, reason: null });
  });

  test('switching to the state it is already in is a CONFLICT', async () => {
    await expect(setConformity({ enabled: true, actor: ACTOR })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { enabled: true }
    });
    await setConformity({ enabled: false, reason: REASON, actor: ACTOR });
    await expect(
      setConformity({ enabled: false, reason: REASON, actor: ACTOR })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { enabled: false }
    });
  });

  test('20 parallel disables: exactly one wins, the others conflict, one history entry', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        setConformity({ enabled: false, reason: REASON, actor: ACTOR })
      )
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(r => r.status === 'rejected' && r.reason.code === 'CONFLICT')
    ).toHaveLength(19);
    expect(store.files[FILE].history).toHaveLength(1);
  });

  test('the history keeps the last 100 switches', async () => {
    for (let i = 0; i < 60; i++) {
      await setConformity({ enabled: false, reason: REASON, actor: ACTOR });
      await setConformity({ enabled: true, actor: ACTOR });
    }
    expect(store.files[FILE].history).toHaveLength(100);
  });

  test('requireEuAiActEnabled passes while on and answers FEATURE_DISABLED while off', () => {
    const next = jest.fn();
    conformity.requireEuAiActEnabled('provenance')({}, {}, next);
    expect(next).toHaveBeenCalledWith();
    store.files[FILE] = clone(OFF_RECORD);
    const next2 = jest.fn();
    conformity.requireEuAiActEnabled('provenance')({}, {}, next2);
    expect(next2.mock.calls[0][0]).toMatchObject({
      code: 'FEATURE_DISABLED',
      details: { feature: 'provenance' }
    });
  });
});

describe('routes', () => {
  test('GET needs an admin and returns the record', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/admin/eu-ai-act/conformity')).status).toBe(403);
    const res = await admin(request(app).get('/api/admin/eu-ai-act/conformity'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ enabled: true, valid: true, history: [] });
  });

  test('disable: validates reason (19 vs 20 characters) and the acceptance', async () => {
    const app = buildApp();
    const post = body =>
      admin(request(app).post('/api/admin/eu-ai-act/conformity/_disable').send(body));
    const short = await post({ reason: 'x'.repeat(19), acceptResponsibility: true });
    expect(short.status).toBe(400);
    expect(short.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(short.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(short.body.errors[0].pointer).toBe('/reason');
    expect(
      (await post({ reason: ' '.repeat(10) + 'x'.repeat(15), acceptResponsibility: true })).status
    ).toBe(400);
    const noAccept = await post({ reason: REASON });
    expect(noAccept.status).toBe(400);
    expect(noAccept.body.errors[0].pointer).toBe('/acceptResponsibility');
    expect((await post({ reason: REASON, acceptResponsibility: false })).status).toBe(400);
    expect((await post({ reason: 'x'.repeat(1001), acceptResponsibility: true })).status).toBe(400);
    expect(store.files[FILE]).toBeUndefined();
    expect(store.audits).toHaveLength(0);
    expect((await post({ reason: 'x'.repeat(20), acceptResponsibility: true })).status).toBe(200);
  });

  test('disable then enable: the record, one audit entry each, the actor from the session', async () => {
    const app = buildApp();
    const off = await admin(
      request(app)
        .post('/api/admin/eu-ai-act/conformity/_disable')
        .send({ reason: REASON, acceptResponsibility: true }),
      { id: 'dmeyer', name: 'Dana Meyer' }
    );
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({
      enabled: false,
      reason: REASON,
      changedBy: { id: 'dmeyer', name: 'Dana Meyer' }
    });
    expect(isEuAiActEnabled()).toBe(false);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: 'toggle',
      resource: 'euAiActConformity',
      resourceId: 'conformity',
      details: { from: true, to: false, reason: REASON, statementVersion: 1 }
    });

    const again = await admin(
      request(app)
        .post('/api/admin/eu-ai-act/conformity/_disable')
        .send({ reason: REASON, acceptResponsibility: true })
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'CONFLICT', details: { enabled: false } });
    expect(store.audits).toHaveLength(1);

    const on = await admin(request(app).post('/api/admin/eu-ai-act/conformity/_enable').send({}));
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(on.body.history).toHaveLength(2);
    expect(store.audits).toHaveLength(2);
    expect(store.audits[1].details).toMatchObject({ from: false, to: true, reason: null });
    expect(
      (await admin(request(app).post('/api/admin/eu-ai-act/conformity/_enable').send({}))).status
    ).toBe(409);
  });

  test('a body cannot name the actor or carry unknown members', async () => {
    const app = buildApp();
    const res = await admin(
      request(app)
        .post('/api/admin/eu-ai-act/conformity/_disable')
        .send({
          reason: REASON,
          acceptResponsibility: true,
          changedBy: { id: 'evil', name: 'Evil' }
        })
    );
    expect(res.status).toBe(400);
    expect(store.files[FILE]).toBeUndefined();
  });

  test.each([
    ['a personal API key', { id: 'admin', name: 'A', isPersonalApiKey: true }],
    ['an OAuth client token', { id: 'admin', name: 'A', isOAuthClient: true }],
    ['a delegated token', { id: 'admin', name: 'A', clientId: 'office' }],
    ['an agent', { id: 'agent-1', name: 'Agent', isAgent: true }],
    ['a bearer-token auth mode', { id: 'admin', name: 'A', authMode: 'oauth_personal_key' }]
  ])('%s cannot switch (INTERACTIVE_SESSION_REQUIRED)', async (name, user) => {
    const app = buildApp();
    for (const [path, body] of [
      ['_disable', { reason: REASON, acceptResponsibility: true }],
      ['_enable', {}]
    ]) {
      const res = await admin(
        request(app).post(`/api/admin/eu-ai-act/conformity/${path}`).send(body),
        user
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INTERACTIVE_SESSION_REQUIRED');
    }
    expect(store.files[FILE]).toBeUndefined();
    expect(store.audits).toHaveLength(0);
  });

  test('a non-admin gets 403 on all three routes', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/admin/eu-ai-act/conformity')).status).toBe(403);
    expect(
      (await request(app).post('/api/admin/eu-ai-act/conformity/_disable').send({})).status
    ).toBe(403);
    expect(
      (await request(app).post('/api/admin/eu-ai-act/conformity/_enable').send({})).status
    ).toBe(403);
  });
});
