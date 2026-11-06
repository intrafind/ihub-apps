// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The marketplace admin routes answer errors through the global error
 * middleware (`application/problem+json`: `{ type, title, status, detail, code, details? }`):
 * status and code come from the `ServiceError` the services throw, never from the text of a message.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const registryService = {
  getRegistry: jest.fn(),
  createRegistry: jest.fn(),
  refreshRegistry: jest.fn(),
  deleteRegistry: jest.fn(),
  getItemDetail: jest.fn(),
  testRegistry: jest.fn(),
  getRegistryWithAuth: jest.fn()
};
const contentInstaller = {
  install: jest.fn(),
  update: jest.fn(),
  uninstall: jest.fn()
};

jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: registryService
}));
const realInstaller = await import('../services/marketplace/ContentInstaller.js');
jest.unstable_mockModule('../services/marketplace/ContentInstaller.js', () => ({
  ...realInstaller,
  default: contentInstaller
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: configCache } = await import('../configCache.js');
const { default: registerMarketplaceRoutes } = await import('../routes/admin/marketplace.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');

configCache.getFeatures = () => ({ marketplace: true });

const app = express();
app.use(express.json());
registerMarketplaceRoutes(app);
app.use(errorHandler);

const ITEM = '/api/admin/marketplace/registries/main/items/integration/ckan';

beforeEach(() => {
  for (const fn of [...Object.values(registryService), ...Object.values(contentInstaller)]) {
    fn.mockReset();
  }
});

describe('marketplace admin routes: errors', () => {
  it('answers an unsafe registry id with BAD_REQUEST', async () => {
    const res = await request(app).delete('/api/admin/marketplace/registries/bad%20id').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(registryService.deleteRegistry).not.toHaveBeenCalled();
  });

  it('answers an unknown registry with the NOT_FOUND the service threw', async () => {
    registryService.deleteRegistry.mockRejectedValue(
      new ServiceError('NOT_FOUND', "Registry 'gone' not found")
    );
    const res = await request(app).delete('/api/admin/marketplace/registries/gone').expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: 'urn:ihub:problem:NOT_FOUND',
      status: 404,
      detail: "Registry 'gone' not found",
      code: 'NOT_FOUND'
    });
    expect(res.body.error).toBeUndefined();
  });

  it('answers a duplicate registry with CONFLICT and an invalid one with BAD_REQUEST', async () => {
    registryService.createRegistry.mockRejectedValueOnce(
      new ServiceError('CONFLICT', "Registry with id 'main' already exists")
    );
    await request(app).post('/api/admin/marketplace/registries').send({ id: 'main' }).expect(409);
    registryService.createRegistry.mockRejectedValueOnce(
      new ServiceError('BAD_REQUEST', 'Invalid registry config: id is required')
    );
    const res = await request(app).post('/api/admin/marketplace/registries').send({}).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('refuses an invalid item name and an invalid version', async () => {
    const name = await request(app)
      .post('/api/admin/marketplace/registries/main/items/integration/bad%20name/_install')
      .send({})
      .expect(400);
    expect(name.body).toMatchObject({
      type: 'urn:ihub:problem:BAD_REQUEST',
      status: 400,
      detail: 'Invalid item name',
      code: 'BAD_REQUEST'
    });

    const version = await request(app)
      .post(`${ITEM}/_install`)
      .send({ version: 'not a version!' })
      .expect(400);
    expect(version.body).toMatchObject({
      type: 'urn:ihub:problem:INVALID_VERSION',
      status: 400,
      detail: 'Invalid version',
      code: 'INVALID_VERSION'
    });
    expect(contentInstaller.install).not.toHaveBeenCalled();
  });

  it.each([
    ['LOCAL_CONTENT_EXISTS', 409],
    ['VERSION_NOT_LISTED', 409],
    ['INCOMPATIBLE_IHUB_VERSION', 409],
    ['UNSUPPORTED_DEFINITION_SCHEMA', 422],
    ['CONTENT_VALIDATION_FAILED', 422]
  ])('an install that fails with %s answers %i with that code', async (code, status) => {
    contentInstaller.install.mockRejectedValue(new ServiceError(code, 'The item cannot be used'));
    const res = await request(app).post(`${ITEM}/_install`).send({}).expect(status);
    expect(res.body).toMatchObject({
      type: `urn:ihub:problem:${code}`,
      status,
      detail: 'The item cannot be used',
      code
    });
  });

  it('answers an uninstall of an integration that is in use with INTEGRATION_IN_USE', async () => {
    contentInstaller.uninstall.mockRejectedValue(
      new ServiceError('INTEGRATION_IN_USE', "integration 'ckan' is still installed")
    );
    const res = await request(app).post(`${ITEM}/_uninstall`).send({}).expect(409);
    expect(res.body.code).toBe('INTEGRATION_IN_USE');
  });

  it('hides the reason of an unexpected failure', async () => {
    contentInstaller.update.mockRejectedValue(new Error('ECONNRESET at /srv/secret/path'));
    const res = await request(app).post(`${ITEM}/_update`).send({}).expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });

  it('still answers a failed registry test with 200 and success false', async () => {
    registryService.testRegistry.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await request(app)
      .post('/api/admin/marketplace/registries/_test')
      .send({ source: 'https://example.com/x.json' })
      .expect(200);
    expect(res.body).toEqual({ success: false, itemCount: 0, message: 'connect ECONNREFUSED' });
  });
});
