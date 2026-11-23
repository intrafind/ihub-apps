// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An API path no route serves answers 404 problem+json with the code
 * `NOT_FOUND`, not the framework's HTML page: also a removed one, such as the
 * Agent Factory's `/api/agents/...` (#3773). The real wiring (registered last
 * in `startup/routes.js`) is checked by `scripts/smoke-boot.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import apiNotFound from '../middleware/apiNotFound.js';
import errorHandler from '../middleware/errorHandler.js';

function app() {
  const server = express();
  server.get('/api/health', (_req, res) => res.json({ status: 'OK' }));
  server.use('/api/', apiNotFound);
  server.use(errorHandler);
  return server;
}

test('an unknown API path answers 404 problem+json with NOT_FOUND', async () => {
  for (const [method, path] of [
    ['get', '/api/agents/runs'],
    ['post', '/api/agents/profiles/legacy/runs'],
    ['get', '/api/admin/agents']
  ]) {
    const res = await request(app())[method](path).expect(404);
    assert.match(res.headers['content-type'], /^application\/problem\+json/, path);
    assert.equal(res.body.code, 'NOT_FOUND', path);
    assert.equal(res.body.status, 404, path);
    assert.match(res.body.detail, new RegExp(`${method.toUpperCase()} ${path}`), path);
  }
});

test('a served API path and a path outside the API are not touched', async () => {
  await request(app()).get('/api/health').expect(200, { status: 'OK' });
  const outside = await request(app()).get('/admin/agents').expect(404);
  assert.doesNotMatch(outside.headers['content-type'] || '', /problem\+json/);
});
