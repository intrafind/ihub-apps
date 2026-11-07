// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The OAuth client administration routes answer errors through the global error
 * middleware: OAuth clients switched off, an unsafe id, an unknown client (also
 * when the manager reports it), a bad request body, and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  enabled: true,
  client: null,
  updateError: null,
  listError: null,
  algorithm: 'RS256',
  keyPair: null
};

const realManager = await import('../utils/oauthClientManager.js');
jest.unstable_mockModule('../utils/oauthClientManager.js', () => ({
  ...realManager,
  loadOAuthClients: () => ({ clients: [] }),
  findClientById: () => state.client,
  listOAuthClients: () => {
    if (state.listError) throw state.listError;
    return [];
  },
  updateOAuthClient: async () => {
    throw state.updateError;
  }
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../services/oauth/ConnectionService.js', () => ({
  countByClient: async () => ({})
}));
jest.unstable_mockModule('../services/oauth/CimdGovernanceService.js', () => ({
  listCimdClientRows: () => []
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({
      oauth: { enabled: { clients: state.enabled } },
      jwt: { algorithm: state.algorithm }
    })
  }
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { getRSAKeyPair: () => state.keyPair }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminOAuthRoutes } = await import('../routes/admin/oauthClients.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');

const app = express();
app.use(express.json());
registerAdminOAuthRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.enabled = true;
  state.client = null;
  state.updateError = null;
  state.listError = null;
  state.algorithm = 'RS256';
  state.keyPair = null;
});

describe('OAuth client administration routes: errors', () => {
  it('answers BAD_REQUEST while OAuth clients are switched off', async () => {
    state.enabled = false;
    const res = await request(app).get('/api/admin/oauth/clients').expect(400);
    expect(res.body).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'OAuth clients are not enabled on this server'
    });
  });

  it('answers an unsafe id with BAD_REQUEST and an unknown client with NOT_FOUND', async () => {
    const unsafe = await request(app).get('/api/admin/oauth/clients/bad%20id').expect(400);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    const missing = await request(app).get('/api/admin/oauth/clients/nobody').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'OAuth client not found' });
  });

  it('answers a client the manager cannot find with NOT_FOUND on update', async () => {
    state.updateError = new ServiceError('NOT_FOUND', 'OAuth client not found: c1');
    const res = await request(app)
      .put('/api/admin/oauth/clients/c1')
      .send({ name: 'x' })
      .expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', detail: 'OAuth client not found: c1' });
  });

  it('answers a new client without a name with BAD_REQUEST', async () => {
    const res = await request(app).post('/api/admin/oauth/clients').send({}).expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Client name is required' });
  });

  it('keeps an unexpected failure hidden behind the fixed text', async () => {
    state.listError = new Error('ENOENT: no such file /srv/contents/config/oauth-clients.json');
    const res = await request(app).get('/api/admin/oauth/clients').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.detail).not.toMatch(/srv|contents/);
  });

  it('answers the public key downloads with BAD_REQUEST for another algorithm and NOT_FOUND without a key', async () => {
    state.algorithm = 'HS256';
    const wrong = await request(app).get('/api/admin/oauth/public-key/pem').expect(400);
    expect(wrong.body.code).toBe('BAD_REQUEST');
    expect(wrong.body.detail).toContain('HS256');

    state.algorithm = 'RS256';
    const none = await request(app).get('/api/admin/oauth/public-key/base64').expect(404);
    expect(none.body).toMatchObject({ code: 'NOT_FOUND', detail: 'RSA public key not available' });

    state.keyPair = { publicKey: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----' };
    const ok = await request(app).get('/api/admin/oauth/public-key/base64').expect(200);
    expect(ok.text).toBe('abc');
  });
});
