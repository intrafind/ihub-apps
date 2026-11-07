// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `proxyAuth` fails closed when the user validation rejects: 403 USER_VALIDATION_FAILED carrying
 * the validation's message, the request never reaches the route handler and `req.user` stays unset.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const platform = {
  auth: { mode: 'proxy', authenticatedGroup: 'authenticated' },
  proxyAuth: { enabled: true, userHeader: 'X-Forwarded-User' }
};
const validateAndPersistExternalUser = jest.fn();

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: jest.fn(() => platform), getLocalizations: jest.fn() }
}));
jest.unstable_mockModule('../utils/authorization.js', () => ({
  enhanceUserGroups: jest.fn(user => user),
  mapExternalGroups: jest.fn(groups => groups || [])
}));
jest.unstable_mockModule('../utils/userManager.js', () => ({ validateAndPersistExternalUser }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { proxyAuth } = await import('../middleware/proxyAuth.js');
const { resetProxyTrustForTests } = await import('../utils/proxyAuthTrust.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

let handlerRuns;
let seenUser;
const app = express();
app.use(proxyAuth);
app.get('/api/probe', (req, res) => {
  handlerRuns += 1;
  seenUser = req.user;
  res.json({ ok: true });
});
app.use(errorHandler);

beforeEach(() => {
  resetProxyTrustForTests();
  handlerRuns = 0;
  seenUser = undefined;
  validateAndPersistExternalUser.mockReset();
});

describe('proxyAuth: user validation', () => {
  it('answers a rejected validation with 403 USER_VALIDATION_FAILED and never runs the handler', async () => {
    validateAndPersistExternalUser.mockRejectedValue(new Error('Your account is disabled.'));
    const res = await request(app).get('/api/probe').set('X-Forwarded-User', 'alice');
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('USER_VALIDATION_FAILED');
    expect(res.body.detail).toBe('Your account is disabled.');
    expect(handlerRuns).toBe(0);
    expect(seenUser).toBeUndefined();
    expect(res.body.ok).toBeUndefined();
  });

  it('lets the request go on with req.user when validation succeeds', async () => {
    validateAndPersistExternalUser.mockImplementation(async user => ({ ...user, validated: true }));
    const res = await request(app).get('/api/probe').set('X-Forwarded-User', 'alice');
    expect(res.status).toBe(200);
    expect(handlerRuns).toBe(1);
    expect(seenUser).toMatchObject({ id: 'alice', authMethod: 'proxy', validated: true });
  });

  it('never validates (and sets no user) without an identity header', async () => {
    const res = await request(app).get('/api/probe');
    expect(res.status).toBe(200);
    expect(validateAndPersistExternalUser).not.toHaveBeenCalled();
    expect(seenUser).toBeNull();
  });
});
