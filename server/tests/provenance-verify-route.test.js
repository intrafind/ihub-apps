// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/provenance/_verify` (#3327): lookup by text and by hash, a miss is
 * a 200 `found:false`, validation and size errors are problem+json, the lookup
 * is authenticated by default and public on request, rate limited, and the
 * pasted text never reaches the audit log.
 */
import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Anonymous access on, as in the shipped defaults: the case `authRequired` lets through.
const platform = {
  anonymousAuth: { enabled: true },
  provenance: { verify: { access: 'authenticated' } },
  rateLimit: {}
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform, getModels: () => ({ data: [] }) }
}));
const { startTestStorage } = await import('./helpers/testStorage.js');
const { default: registerProvenanceRoutes, MAX_VERIFY_TEXT_BYTES } =
  await import('../routes/provenanceRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { recordTextOutput } = await import('../services/provenance/turnProvenance.js');
const { hashText } = await import('../services/provenance/records.js');

/**
 * The real `authenticatedOnly` runs here, not a stand-in: the shipped default has
 * `anonymousAuth` on, where `authRequired` would let a guest through. A signed-in
 * caller carries `x-test-user`; everyone else is the anonymous principal the auth
 * chain gives a guest.
 */
function buildApp() {
  const server = express();
  server.use(express.json({ limit: '2mb' }));
  server.use((req, _res, next) => {
    const id = req.headers['x-test-user'];
    req.user = id ? { id } : { id: 'anonymous', groups: ['anonymous'] };
    next();
  });
  registerProvenanceRoutes(server);
  server.use(errorHandler);
  return server;
}

let storage;
let app;
let outputId;

beforeAll(async () => {
  storage = await startTestStorage({ prefix: 'ihub-provenance-route-' });
  const p = await recordTextOutput({
    text: 'The verified answer.',
    model: { id: 'model-a' },
    modelConfig: { contentMarking: { text: { by: 'none' } } }
  });
  outputId = p.output_id;
  app = buildApp();
});

afterAll(async () => {
  await storage.stop();
});

const signedIn = r => r.set('x-test-user', 'u1');

describe('POST /api/provenance/_verify', () => {
  test('finds an exact output by text, and by the same text with other line endings and padding', async () => {
    const res = await signedIn(request(app).post('/api/provenance/_verify')).send({
      text: '  The verified answer.\r\n'
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.normalization).toBe('nfc-trim');
    expect(res.body.records[0].output_id).toBe(outputId);
    expect(res.body.records[0].model.id).toBe('model-a');
    expect(res.body.records[0].verify).toMatch(/\/api\/provenance\/_verify$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('finds an output by hash', async () => {
    const res = await signedIn(request(app).post('/api/provenance/_verify')).send({
      contentHash: hashText('The verified answer.').toUpperCase()
    });
    expect(res.status).toBe(200);
    expect(res.body.records[0].output_id).toBe(outputId);
  });

  test('a modified text is a 200 miss that claims nothing about authorship', async () => {
    const res = await signedIn(request(app).post('/api/provenance/_verify')).send({
      text: 'The verified answer. x'
    });
    expect(res.status).toBe(200);
    // A signed-in caller also gets the watermark verdict; with no detector configured
    // that is "not_configured", never "not watermarked".
    expect(res.body).toEqual({
      found: false,
      normalization: 'nfc-trim',
      watermark: { status: 'not_configured' }
    });
  });

  test('both or neither of text and contentHash is a 400 problem', async () => {
    for (const body of [{}, { text: 'a', contentHash: 'b'.repeat(64) }, { contentHash: 'zz' }]) {
      const res = await signedIn(request(app).post('/api/provenance/_verify')).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    }
  });

  test('an unknown normalization is a 400', async () => {
    const res = await signedIn(request(app).post('/api/provenance/_verify')).send({
      text: 'a',
      normalization: 'md5'
    });
    expect(res.status).toBe(400);
  });

  test('a text over the cap is a 413', async () => {
    const res = await signedIn(request(app).post('/api/provenance/_verify')).send({
      text: 'a'.repeat(MAX_VERIFY_TEXT_BYTES + 1)
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('is closed to guests by default, even with anonymous access on, and public on request', async () => {
    const denied = await request(app).post('/api/provenance/_verify').send({ text: 'a' });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('AUTH_REQUIRED');
    platform.provenance.verify.access = 'public';
    try {
      const open = await request(app).post('/api/provenance/_verify').send({ text: 'a' });
      expect(open.status).toBe(200);
    } finally {
      platform.provenance.verify.access = 'authenticated';
    }
  });
});

describe('privacy and abuse limits', () => {
  test('the audit logger excludes the provenance segment, so pasted text is never audited', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../middleware/auditLogger.js', import.meta.url), 'utf8');
    expect(source).toMatch(/EXCLUDED_SEGMENTS = new Set\(\[[^\]]*'provenance'/s);
  });

  test('has its own limiter that answers 429 with Retry-After', async () => {
    platform.rateLimit = { provenanceVerifyApi: { limit: 2, windowMs: 60000 } };
    const limited = buildApp();
    const call = () =>
      request(limited).post('/api/provenance/_verify').set('x-test-user', 'u').send({ text: 'q' });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    platform.rateLimit = {};
  });
});
