// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { z } from 'zod';
import errorHandler from '../middleware/errorHandler.js';
import { ServiceError } from '../utils/ServiceError.js';
import { toErrorResponse } from '../utils/errorResponse.js';
import { EtagMismatchError, StorageError, InvalidKeyError } from '../storage/errors.js';
import { LLMError, LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';
import { API_ERROR_CODES, apiErrorI18nKey } from '../../shared/apiErrors.js';
import { STORAGE_CODE_STATUS } from '../storage/errors.js';

const en = JSON.parse(readFileSync(new URL('../../shared/i18n/en.json', import.meta.url), 'utf8'));
const de = JSON.parse(readFileSync(new URL('../../shared/i18n/de.json', import.meta.url), 'utf8'));

describe('toErrorResponse', () => {
  it('answers a ServiceError with its code, message and details', () => {
    const { status, body } = toErrorResponse(
      new ServiceError('NOT_FOUND', 'Scheduled task not found', { details: { taskId: 't1' } })
    );
    assert.equal(status, 404);
    assert.deepEqual(body, {
      error: 'Scheduled task not found',
      code: 'NOT_FOUND',
      details: { taskId: 't1' }
    });
  });

  it('lets a ServiceError name its own status and wraps non-object details', () => {
    const e = new ServiceError('FORBIDDEN', 'No', { status: 403, details: ['a'] });
    assert.deepEqual(e.details, { value: ['a'] });
    assert.equal(new ServiceError('CONFLICT', 'x', { status: 412 }).status, 412);
  });

  it('never sends the message of a 5xx', () => {
    const { status, body } = toErrorResponse(
      new ServiceError('SERVICE_UNAVAILABLE', 'connect ECONNREFUSED 10.0.0.5:5432')
    );
    assert.equal(status, 503);
    assert.equal(body.error, en.apiErrors.SERVICE_UNAVAILABLE);
    const plain = toErrorResponse(new Error('secret /etc/passwd'));
    assert.equal(plain.status, 500);
    assert.deepEqual(plain.body, { error: en.apiErrors.INTERNAL_ERROR, code: 'INTERNAL_ERROR' });
  });

  it('maps storage errors by their status, keeping the storage code', () => {
    const conflict = toErrorResponse(new EtagMismatchError('stale'));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'ETAG_MISMATCH');
    assert.equal(conflict.body.error, 'stale');
    assert.equal(toErrorResponse(new InvalidKeyError('bad key')).status, 400);
    const bare = toErrorResponse(new StorageError('x', { code: 'INVALID_CURSOR' }));
    assert.equal(bare.status, 400);
    const unknown = toErrorResponse(new StorageError('boom', { code: 'SOMETHING_NEW' }));
    assert.equal(unknown.status, 500);
    assert.equal(unknown.body.code, 'STORAGE_ERROR');
  });

  it('maps LLM errors by code, without the provider text or its status', () => {
    const limited = toErrorResponse(
      new LLMError('Anthropic said: slow down', {
        code: LLM_ERROR_CODES.RATE_LIMITED,
        status: 429,
        retryAfterMs: 2500,
        provider: 'anthropic'
      })
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.equal(limited.body.error, en.apiErrors.RATE_LIMITED);
    assert.deepEqual(limited.body.details, { retryAfterMs: 2500, provider: 'anthropic' });
    assert.equal(limited.headers['Retry-After'], '3');
    // A rejected provider key must not look like an expired session to the client.
    const auth = toErrorResponse(new LLMError('bad key', { code: 'AUTH_FAILED', status: 401 }));
    assert.equal(auth.status, 502);
    assert.equal(toErrorResponse(new LLMError('x', { code: 'QUOTA_EXCEEDED' })).status, 429);
  });

  it('maps a ZodError to VALIDATION_FAILED with the issues as details', () => {
    const result = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    const { status, body } = toErrorResponse(result.error);
    assert.equal(status, 400);
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(body.details.issues[0].path, 'a.b');
    assert.equal(body.details.issues[0].code, 'invalid_type');
  });

  it('answers the RFC 6749 shape for OAuth', () => {
    assert.deepEqual(toErrorResponse(new Error('x'), { rfc: true }).body, {
      error: 'server_error',
      error_description: en.apiErrors.INTERNAL_ERROR
    });
    assert.equal(
      toErrorResponse(new ServiceError('BAD_REQUEST', 'Missing grant_type'), { rfc: true }).body
        .error,
      'invalid_request'
    );
  });
});

describe('errorHandler in an Express app', () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/api/echo', (req, res) => res.json(req.body));
    app.get('/api/throws', () => {
      throw new ServiceError('NOT_FOUND', 'Thing not found');
    });
    app.get('/api/rejects', async () => {
      throw new EtagMismatchError('stale');
    });
    app.get('/api/oauth/token', () => {
      throw new Error('boom');
    });
    app.get('/ihub/api/oauth/token', () => {
      throw new Error('boom');
    });
    app.get('/api/started', (req, res, next) => {
      res.write('partial');
      next(new Error('late'));
    });
    app.use(errorHandler);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise(resolve => server.close(resolve)));

  it('answers a thrown ServiceError and a rejected async handler', async () => {
    const thrown = await fetch(`${base}/api/throws`);
    assert.equal(thrown.status, 404);
    assert.deepEqual(await thrown.json(), { error: 'Thing not found', code: 'NOT_FOUND' });
    const rejected = await fetch(`${base}/api/rejects`);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'ETAG_MISMATCH');
  });

  it('answers malformed and oversized bodies as JSON', async () => {
    const bad = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope'
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.code, 'BAD_REQUEST');
    assert.equal(badBody.details.type, 'entity.parse.failed');
    const big = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(4000) })
    });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).code, 'PAYLOAD_TOO_LARGE');
  });

  it('keeps OAuth endpoints on the RFC shape, with and without a base path', async () => {
    for (const path of ['/api/oauth/token', '/ihub/api/oauth/token']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'server_error');
      assert.ok(body.error_description);
      assert.equal(body.code, undefined);
    }
  });

  it('hands an error after the response started to Express, which drops the connection', async () => {
    // Nothing may be appended to a response that has begun: no JSON error, and the body
    // cannot complete.
    const res = await fetch(`${base}/api/started`);
    await assert.rejects(res.text());
  });
});

describe('the code registry', () => {
  const codes = [...Object.keys(API_ERROR_CODES), ...Object.keys(STORAGE_CODE_STATUS)];
  it('has an English and a German message for every code', () => {
    for (const code of new Set(codes)) {
      assert.ok(en.apiErrors?.[code], `en: ${apiErrorI18nKey(code)}`);
      assert.ok(de.apiErrors?.[code], `de: ${apiErrorI18nKey(code)}`);
    }
  });
  it('covers every storage and LLM code', () => {
    for (const code of Object.values(LLM_ERROR_CODES)) assert.ok(code in API_ERROR_CODES, code);
    for (const code of Object.keys(STORAGE_CODE_STATUS)) {
      assert.equal(API_ERROR_CODES[code], STORAGE_CODE_STATUS[code], code);
    }
  });
  it('has no message without a code', () => {
    for (const code of Object.keys(en.apiErrors)) assert.ok(code in API_ERROR_CODES, code);
    for (const code of Object.keys(de.apiErrors)) assert.ok(code in en.apiErrors, code);
  });
});
