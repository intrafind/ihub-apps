// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin watermark key API (#3331): auth on every route, no key value in
 * lists, audit entries that never hold a key, reveal that audits first and fails
 * closed, and the global audit middleware redacting a bare `key`.
 */
import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);

const { ServiceError } = await import('../utils/ServiceError.js');
const state = { auditReturns: true, entries: [] };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    if (req.headers['x-role'] === 'admin') {
      req.user = { id: 'admin', username: 'admin' };
      return next();
    }
    return next(
      new ServiceError(req.headers['x-role'] ? 'FORBIDDEN' : 'AUTH_REQUIRED', 'Not allowed')
    );
  }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: jest.fn(entry => {
    if (!state.auditReturns) return null;
    state.entries.push(JSON.parse(JSON.stringify({ ...entry, req: undefined })));
    return { id: 'x' };
  })
}));

const loggedLines = [];
const captureLogger = level => (message, meta) =>
  loggedLines.push(JSON.stringify({ level, message, meta }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: {
    info: captureLogger('info'),
    warn: captureLogger('warn'),
    error: captureLogger('error'),
    debug: captureLogger('debug')
  }
}));

const { startTestStorage } = await import('./helpers/testStorage.js');
const { default: registerAdminWatermarkKeyRoutes } =
  await import('../routes/admin/watermarkKeys.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { resetWatermarkKeyStore } =
  await import('../services/provenance/watermark/WatermarkKeyStore.js');
const { redact } = await import('../middleware/auditLogger.js');

let storage;
let app;
const admin = r => r.set('x-role', 'admin');

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-wm-admin-' });
  app = express();
  app.use(express.json());
  registerAdminWatermarkKeyRoutes(app);
  app.use(errorHandler);
});
afterAll(async () => {
  await storage.stop();
});
beforeEach(async () => {
  resetWatermarkKeyStore();
  await configStore.writeJson('config/watermark-keys.json', { version: 1, nextSeq: {}, keys: [] });
  state.auditReturns = true;
  state.entries.length = 0;
  loggedLines.length = 0;
});

const routes = [
  ['get', '/api/admin/watermark-keys'],
  ['post', '/api/admin/watermark-keys'],
  ['post', '/api/admin/watermark-keys/wm-ihub-x-2026-1/_activate'],
  ['post', '/api/admin/watermark-keys/wm-ihub-x-2026-1/_reveal'],
  ['delete', '/api/admin/watermark-keys/wm-ihub-x-2026-1']
];

describe('watermark key routes: authorization', () => {
  test.each(routes)('%s %s needs an admin', async (method, url) => {
    expect((await request(app)[method](url)).status).toBe(401);
    expect((await request(app)[method](url).set('x-role', 'user')).status).toBe(403);
  });
});

describe('watermark key routes', () => {
  test('create returns the key once, as a string, with the snippet and Location; list never does', async () => {
    const res = await admin(request(app).post('/api/admin/watermark-keys')).send({
      key: '9007199254740991',
      label: 'Q4'
    });
    expect(res.status).toBe(201);
    expect(res.body.keyId).toMatch(/^wm-ihub-[0-9a-f-]{36}-2026-1$/);
    expect(res.headers.location).toMatch(
      new RegExp(`/api/admin/watermark-keys/${res.body.keyId}$`)
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      status: 'active',
      key: '9007199254740991',
      label: 'Q4'
    });
    expect(res.body.vllmConfigSnippet).toContain('"key":9007199254740991');
    const list = await admin(request(app).get('/api/admin/watermark-keys'));
    expect(list.status).toBe(200);
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('9007199254740991');
  });

  test('a generated key and rotation; duplicate 409; invalid 400; delete rules', async () => {
    const first = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    expect(first.body.source).toBe('generated');
    const second = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    expect(second.body.keyId).toMatch(/^wm-ihub-[0-9a-f-]{36}-2026-2$/);
    const del = id => admin(request(app).delete(`/api/admin/watermark-keys/${id}`));
    const dup = await admin(request(app).post('/api/admin/watermark-keys')).send({
      key: first.body.key
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('WATERMARK_KEY_DUPLICATE');
    const bad = await admin(request(app).post('/api/admin/watermark-keys')).send({
      key: '9007199254740993'
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('WATERMARK_KEY_INVALID');
    expect((await del(second.body.keyId)).status).toBe(409);
    expect((await del(first.body.keyId)).status).toBe(204);
    expect((await del(first.body.keyId)).status).toBe(404);
  });

  test('activate swaps the active key', async () => {
    const first = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    await admin(request(app).post('/api/admin/watermark-keys')).send({});
    const res = await admin(
      request(app).post(`/api/admin/watermark-keys/${first.body.keyId}/_activate`)
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ keyId: first.body.keyId, status: 'active' });
  });

  test('activate is audited with from/to ids only, answers 404 for an unknown key and is a quiet no-op when already active', async () => {
    const first = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    const second = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    const firstId = first.body.keyId;
    const secondId = second.body.keyId;
    state.entries.length = 0;
    const res = await admin(request(app).post(`/api/admin/watermark-keys/${firstId}/_activate`));
    expect(res.status).toBe(200);
    expect(res.body.key).toBeUndefined();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      action: 'update',
      resource: 'watermarkKey',
      resourceId: firstId,
      details: { from: secondId, to: firstId }
    });
    const audited = JSON.stringify(state.entries);
    expect(audited).not.toContain(first.body.key);
    expect(audited).not.toContain(second.body.key);

    state.entries.length = 0;
    const again = await admin(request(app).post(`/api/admin/watermark-keys/${firstId}/_activate`));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('active');
    expect(state.entries).toHaveLength(0);

    const missing = await admin(
      request(app).post(`/api/admin/watermark-keys/${firstId.replace(/-\d+$/, '')}-99/_activate`)
    );
    expect(missing.status).toBe(404);
  });

  test('reveal writes the audit entry and returns the key with no-store', async () => {
    const created = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    state.entries.length = 0;
    const res = await admin(
      request(app).post(`/api/admin/watermark-keys/${created.body.keyId}/_reveal`)
    );
    expect(res.status).toBe(200);
    expect(res.body.key).toBe(created.body.key);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      action: 'read',
      resource: 'watermarkKey',
      resourceId: created.body.keyId
    });
  });

  test('reveal fails closed when the audit write fails', async () => {
    const created = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    state.auditReturns = false;
    const res = await admin(
      request(app).post(`/api/admin/watermark-keys/${created.body.keyId}/_reveal`)
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WATERMARK_AUDIT_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain(created.body.key);
  });

  test('each change writes one audit entry and no entry, log line or error holds a key', async () => {
    const a = await admin(request(app).post('/api/admin/watermark-keys')).send({
      key: '777000111222'
    });
    const b = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    await admin(request(app).post(`/api/admin/watermark-keys/${a.body.keyId}/_activate`));
    await admin(request(app).post(`/api/admin/watermark-keys/${a.body.keyId}/_reveal`));
    const dup = await admin(request(app).post('/api/admin/watermark-keys')).send({
      key: '777000111222'
    });
    await admin(request(app).delete(`/api/admin/watermark-keys/${b.body.keyId}`));
    expect(state.entries.map(e => `${e.action}:${e.result || 'success'}`)).toEqual([
      'create:success',
      'create:success',
      'update:success',
      'read:success',
      'create:failure',
      'delete:success'
    ]);
    const everything = JSON.stringify([state.entries, loggedLines, dup.body]);
    for (const value of ['777000111222', b.body.key, a.body.key]) {
      expect(everything).not.toContain(String(value));
    }
  });

  test('the key store file holds ciphertext only', async () => {
    const created = await admin(request(app).post('/api/admin/watermark-keys')).send({});
    await new Promise(resolve => setTimeout(resolve, 100));
    const walk = async dir => {
      let text = '';
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        text += entry.isDirectory() ? await walk(p) : await fs.readFile(p, 'utf8').catch(() => '');
      }
      return text;
    };
    expect(await walk(storage.dir)).not.toContain(created.body.key);
  });
});

describe('audit middleware redaction', () => {
  test('a bare key (and keys) is redacted, so a rejected create leaves no key in a request log', () => {
    const out = redact({ key: 123456789, keys: [1, 2], label: 'x', nested: { key: 5 } });
    expect(out.key).toBe('***REDACTED***');
    expect(out.keys).toBe('***REDACTED***');
    expect(out.nested.key).toBe('***REDACTED***');
    expect(out.label).toBe('x');
    // A neighbour of the pattern is not swallowed.
    expect(redact({ keyboard: 'k', monkey: 'm' })).toEqual({ keyboard: 'k', monkey: 'm' });
  });
});
