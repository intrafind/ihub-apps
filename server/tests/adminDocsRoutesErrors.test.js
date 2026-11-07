// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The documentation administration routes answer errors through the global
 * error middleware: a missing `path` is a BAD_REQUEST, an unknown page is a
 * NOT_FOUND, and an unexpected failure is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = { tocError: null };

const realDocs = await import('../utils/docsLibrary.js');
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/docsLibrary.js', () => ({
  ...realDocs,
  loadDocsToc: async (...args) => {
    if (state.tocError) throw state.tocError;
    return realDocs.loadDocsToc(...args);
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminDocsRoutes } = await import('../routes/admin/docs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const docsDir = mkdtempSync(join(tmpdir(), 'ihub-docs-'));
writeFileSync(join(docsDir, 'intro.md'), '# Intro\n\nHello docs.\n');

const app = express();
app.use(express.json());
registerAdminDocsRoutes(app, { docsDir });
app.use(errorHandler);

beforeEach(() => {
  state.tocError = null;
});

describe('documentation administration routes: errors', () => {
  it('answers a missing path with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/admin/docs/page').expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('path is required');
  });

  it('answers an unknown page with NOT_FOUND', async () => {
    const res = await request(app).get('/api/admin/docs/page?path=nope.md').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toContain('Documentation page not found');
  });

  it('serves an existing page', async () => {
    const res = await request(app).get('/api/admin/docs/page?path=intro.md').expect(200);
    expect(JSON.stringify(res.body)).toContain('Hello docs');
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.tocError = new Error('boom at /srv/secret/path');
    const res = await request(app).get('/api/admin/docs/toc').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
