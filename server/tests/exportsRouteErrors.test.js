// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/exports/pdf` answers errors through the global error middleware
 * (RFC 9457 problem+json with a registry `code`).
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { render: null };

const real0 = await import('../middleware/authRequired.js');
const real1 = await import('../featureRegistry.js');
const real2 = await import('../services/documents/templates/applyTemplate.js');
const real3 = await import('../services/documents/ExportService.js');
const realCache = (await import('../configCache.js')).default;
jest.unstable_mockModule('../configCache.js', async () => ({
  default: Object.assign(Object.create(realCache), {
    getPlatform: () => ({}),
    getFeatures: () => ({}),
    getApps: () => ({ data: [] })
  })
}));
jest.unstable_mockModule('../middleware/authRequired.js', async () => ({
  ...real0,
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../featureRegistry.js', async () => ({
  ...real1,
  isFeatureEnabled: () => true
}));
jest.unstable_mockModule('../services/documents/templates/applyTemplate.js', async () => ({
  ...real2,
  templateBundleFor: async () => null,
  applyTemplateToPdfSpec: spec => ({ spec, assets: {} })
}));
jest.unstable_mockModule('../services/documents/ExportService.js', async () => ({
  ...real3,
  buildMarkdownExportSpec: () => ({ title: 'Doc' }),
  buildChatExportSpec: () => ({ title: 'Chat' }),
  renderExport: async (...args) => state.render(...args)
}));
jest.unstable_mockModule('../utils/logger.js', async () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerExportRoutes } = await import('../routes/exports.js');
const { DocumentGenerationError } = await import('../services/documents/renderService.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerExportRoutes(app);
app.use(errorHandler);

const post = body => request(app).post('/api/exports/pdf').send(body);
const expectProblem = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
};

beforeEach(() => {
  state.render = async () => ({ buffer: Buffer.from('%PDF'), pages: 1 });
});

describe('POST /api/exports/pdf errors', () => {
  it('renders a markdown export', async () => {
    const res = await post({ kind: 'markdown', markdown: '# hi', template: 'default' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('answers an invalid kind with BAD_REQUEST', async () => {
    expectProblem(await post({ kind: 'nope', template: 'default' }), 400, 'BAD_REQUEST');
  });

  it('answers a busy renderer with SERVICE_UNAVAILABLE', async () => {
    state.render = async () => {
      throw new DocumentGenerationError('x', 'busy');
    };
    expectProblem(
      await post({ kind: 'markdown', markdown: 'a', template: 'default' }),
      503,
      'SERVICE_UNAVAILABLE'
    );
  });

  it('answers a renderer timeout with TIMEOUT', async () => {
    state.render = async () => {
      throw new DocumentGenerationError('x', 'timeout');
    };
    expectProblem(
      await post({ kind: 'markdown', markdown: 'a', template: 'default' }),
      504,
      'TIMEOUT'
    );
  });

  it('answers an invalid document with 422', async () => {
    state.render = async () => {
      throw new DocumentGenerationError('x', 'invalid');
    };
    const res = await post({ kind: 'markdown', markdown: 'a', template: 'default' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('answers an unexpected error with INTERNAL_ERROR', async () => {
    state.render = async () => {
      throw new Error('boom');
    };
    expectProblem(
      await post({ kind: 'markdown', markdown: 'a', template: 'default' }),
      500,
      'INTERNAL_ERROR'
    );
  });
});
