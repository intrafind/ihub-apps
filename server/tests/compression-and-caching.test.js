// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Startup transfer size: the client bundle and JSON API responses are
 * compressed, streamed responses are not (a compressor would hold SSE chunks
 * back until its buffer fills), and content-hashed assets are cached for good.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import express from 'express';
import path from 'path';
import request from 'supertest';

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const { createCompressionMiddleware, shouldCompress } =
  await import('../middleware/compression.js');
const { isHashedAsset } = await import('../routes/staticRoutes.js');

const LARGE = 'x'.repeat(20000);

function buildApp() {
  const app = express();
  app.use(createCompressionMiddleware());
  app.get('/json', (req, res) => res.json({ value: LARGE }));
  app.get('/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.write(`data: ${LARGE}\n\n`);
    res.end();
  });
  app.get('/binary', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(Buffer.from(LARGE));
  });
  return app;
}

describe('compression', () => {
  const app = buildApp();

  test('compresses JSON responses', async () => {
    const res = await request(app).get('/json').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('prefers brotli when the client accepts it', async () => {
    const res = await request(app).get('/json').set('Accept-Encoding', 'gzip, deflate, br');
    expect(res.headers['content-encoding']).toBe('br');
  });

  test('leaves server-sent event streams uncompressed', async () => {
    const res = await request(app).get('/sse').set('Accept-Encoding', 'gzip, br');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test('leaves other types uncompressed', async () => {
    const res = await request(app).get('/binary').set('Accept-Encoding', 'gzip, br');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  test.each([
    ['text/javascript; charset=utf-8', true],
    ['application/javascript', true],
    ['text/css', true],
    ['text/html; charset=utf-8', true],
    ['application/json; charset=utf-8', true],
    ['text/event-stream', false],
    ['application/x-ndjson', false],
    ['audio/mpeg', false],
    ['', false]
  ])('shouldCompress(%p) is %p', (contentType, expected) => {
    const res = { getHeader: () => contentType };
    expect(shouldCompress({}, res)).toBe(expected);
  });
});

describe('isHashedAsset', () => {
  const staticPath = path.join('/srv', 'public');

  test('matches files under assets/', () => {
    expect(isHashedAsset(staticPath, path.join(staticPath, 'assets', 'App-CdIMdtCB.js'))).toBe(
      true
    );
  });

  test('does not match other static files', () => {
    expect(isHashedAsset(staticPath, path.join(staticPath, 'sw.js'))).toBe(false);
    expect(isHashedAsset(staticPath, path.join(staticPath, 'fonts', 'inter.css'))).toBe(false);
    expect(isHashedAsset(staticPath, path.join(staticPath, 'office', 'assets', 'x.js'))).toBe(
      false
    );
  });
});
