// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin OAuth connection routes answer errors through the global error
 * middleware: disabled OAuth clients and missing path parameters are
 * BAD_REQUEST, an unknown connection is NOT_FOUND.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: { oauth: { enabled: { clients: true } } }, revoked: false };
const revokeConnection = jest.fn(async () => ({
  revoked: state.revoked,
  refreshTokensRevoked: 0
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));
jest.unstable_mockModule('../services/oauth/ConnectionService.js', () => ({
  listConnections: () => ({ items: [], nextCursor: null, total: 0 }),
  revokeConnection
}));
jest.unstable_mockModule('../services/oauth/CimdGovernanceService.js', () => ({
  listCimdClientRows: () => []
}));

const { default: registerRoutes } = await import('../routes/admin/oauthConnections.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerRoutes(app);
app.use(errorHandler);

const BASE = '/api/admin/oauth/connections';

function expectProblem(res, code) {
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
}

beforeEach(() => {
  state.platform = { oauth: { enabled: { clients: true } } };
  state.revoked = false;
  revokeConnection.mockClear();
});

describe('admin OAuth connection routes: errors', () => {
  it.each([
    ['list', () => request(app).get(BASE)],
    ['revoke', () => request(app).delete(`${BASE}/client/alice`)]
  ])('answers BAD_REQUEST on %s while OAuth clients are disabled', async (_name, call) => {
    state.platform = { oauth: { enabled: { clients: false } } };
    const res = await call().expect(400);
    expectProblem(res, 'BAD_REQUEST');
    expect(res.body.detail).toContain('not enabled');
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it('answers BAD_REQUEST when no platform config exists at all', async () => {
    state.platform = null;
    const res = await request(app).get(BASE).expect(400);
    expectProblem(res, 'BAD_REQUEST');
  });

  it('passes a blank-looking key through to the store', async () => {
    state.revoked = true;
    await request(app).delete(`${BASE}/%20/alice`).expect(200);
    expect(revokeConnection).toHaveBeenCalledWith(' ', 'alice');
  });

  it('decodes the path once: a literal percent sign of a key reaches the store as it is', async () => {
    state.revoked = true;
    // Express decodes `%2541` to `%41`; a second decode would turn it into `A`.
    await request(app)
      .delete(`${BASE}/client/${encodeURIComponent('user%41')}`)
      .expect(200);
    expect(revokeConnection).toHaveBeenCalledWith('client', 'user%41');
  });

  it('answers NOT_FOUND for an unknown connection', async () => {
    const res = await request(app).delete(
      `${BASE}/${encodeURIComponent('https://x.example/c')}/nobody`
    );
    expect(res.status).toBe(404);
    expectProblem(res, 'NOT_FOUND');
    expect(res.body.detail).toBe('Connection not found');
    expect(revokeConnection).toHaveBeenCalledWith('https://x.example/c', 'nobody');
  });

  it('answers a malformed percent-encoding without a 200', async () => {
    const res = await request(app).delete(`${BASE}/%E0%A4%A/alice`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(revokeConnection).not.toHaveBeenCalled();
  });
});
