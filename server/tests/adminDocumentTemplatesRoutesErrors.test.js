// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The document template administration routes answer errors through the global
 * error middleware: the document services' errors keep their status, anything
 * unexpected is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const service = {
  getTemplate: jest.fn(),
  saveTemplate: jest.fn(),
  listTemplates: jest.fn(),
  saveTemplateAsset: jest.fn()
};

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const realService = await import('../services/documents/templates/DocumentTemplateService.js');
jest.unstable_mockModule('../services/documents/templates/DocumentTemplateService.js', () => ({
  ...realService,
  getTemplate: (...args) => service.getTemplate(...args),
  saveTemplate: (...args) => service.saveTemplate(...args),
  listTemplates: (...args) => service.listTemplates(...args),
  saveTemplateAsset: (...args) => service.saveTemplateAsset(...args)
}));

const { default: registerRoutes } = await import('../routes/admin/documentTemplates.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { DocumentTemplateError } = realService;

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);

const BASE = '/api/admin/document-templates';

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.status).toBe(status);
  expect(res.body.code).toBe(code);
}

beforeEach(() => {
  Object.values(service).forEach(fn => fn.mockReset());
});

describe('document template administration routes: errors', () => {
  it('answers an unknown template with NOT_FOUND', async () => {
    service.getTemplate.mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/missing`);
    expectProblem(res, 404, 'NOT_FOUND');
  });

  it('keeps the status of a DocumentTemplateError (409 CONFLICT) and its detail', async () => {
    service.saveTemplate.mockRejectedValue(new DocumentTemplateError('Template id exists.', 409));
    const res = await request(app).post(BASE).send({ id: 'dup' });
    expectProblem(res, 409, 'CONFLICT');
    expect(res.body.detail).toContain('Template id exists.');
  });

  it('answers an unexpected error with a 500 INTERNAL_ERROR', async () => {
    service.listTemplates.mockRejectedValue(new Error('disk /secret/path exploded'));
    const res = await request(app).get(BASE);
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('/secret/path');
  });

  it('answers an unknown sample format with BAD_REQUEST', async () => {
    const res = await request(app).post(`${BASE}/t1/sample/gif`).send({});
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(service.getTemplate).not.toHaveBeenCalled();
  });

  it('answers an upload to an unknown slot with BAD_REQUEST', async () => {
    const res = await request(app)
      .post(`${BASE}/t1/files/nonsense`)
      .attach('file', Buffer.from('abc'), 'a.png');
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toContain('Unknown template file slot');
    expect(service.saveTemplateAsset).not.toHaveBeenCalled();
  });

  it('answers an upload without a file with BAD_REQUEST', async () => {
    const res = await request(app).post(`${BASE}/t1/files/logo`).send({});
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toContain('No file uploaded');
    expect(service.saveTemplateAsset).not.toHaveBeenCalled();
  });

  it('answers an oversize file with PAYLOAD_TOO_LARGE', async () => {
    const { ASSET_SLOTS } = await import('../validators/documentTemplateSchema.js');
    const max = Math.max(...Object.values(ASSET_SLOTS).map(slot => slot.maxBytes));
    const res = await request(app)
      .post(`${BASE}/t1/files/logo`)
      .attach('file', Buffer.alloc(max + 1024), 'big.png');
    expectProblem(res, 413, 'PAYLOAD_TOO_LARGE');
    expect(service.saveTemplateAsset).not.toHaveBeenCalled();
  });
});
