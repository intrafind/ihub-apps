// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { z } from 'zod';
import errorHandler from '../middleware/errorHandler.js';
import { ServiceError } from '../utils/ServiceError.js';
import {
  toErrorResponse,
  publicMessage,
  sendProblem,
  jsonPointer,
  PROBLEM_CONTENT_TYPE
} from '../utils/errorResponse.js';
import { sendErrorResponse } from '../utils/responseHelpers.js';
import { EtagMismatchError, StorageError, InvalidKeyError } from '../storage/errors.js';
import { LLMError, LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';
import { API_ERROR_CODES, apiErrorI18nKey } from '../../shared/apiErrors.js';
import { STORAGE_CODE_STATUS } from '../storage/errors.js';

const en = JSON.parse(readFileSync(new URL('../../shared/i18n/en.json', import.meta.url), 'utf8'));
const de = JSON.parse(readFileSync(new URL('../../shared/i18n/de.json', import.meta.url), 'utf8'));

describe('toErrorResponse', () => {
  it('answers a ServiceError with its code, message and details', () => {
    const { status, body, headers } = toErrorResponse(
      new ServiceError('NOT_FOUND', 'Scheduled task not found', { details: { taskId: 't1' } })
    );
    assert.equal(status, 404);
    assert.deepEqual(body, {
      type: 'urn:ihub:problem:NOT_FOUND',
      title: en.apiErrors.NOT_FOUND,
      status: 404,
      detail: 'Scheduled task not found',
      code: 'NOT_FOUND',
      details: { taskId: 't1' }
    });
    assert.equal(headers['Content-Type'], PROBLEM_CONTENT_TYPE);
  });

  it('lets a ServiceError name its own status and wraps non-object details', () => {
    const e = new ServiceError('FORBIDDEN', 'No', { status: 403, details: ['a'] });
    assert.deepEqual(e.details, { value: ['a'] });
    assert.equal(new ServiceError('CONFLICT', 'x', { status: 412 }).status, 412);
  });

  it('sends the message of a 5xx when it is safe', () => {
    const { status, body } = toErrorResponse(
      new ServiceError('SERVICE_UNAVAILABLE', 'The search index is being rebuilt, try again soon')
    );
    assert.equal(status, 503);
    assert.equal(body.detail, 'The search index is being rebuilt, try again soon');
    const plain = toErrorResponse(new Error('Export queue is full'));
    assert.equal(plain.status, 500);
    assert.deepEqual(plain.body, {
      type: 'urn:ihub:problem:INTERNAL_ERROR',
      title: en.apiErrors.INTERNAL_ERROR,
      status: 500,
      detail: 'Export queue is full',
      code: 'INTERNAL_ERROR'
    });
  });

  it('replaces the message of a 5xx with the fixed text when it could help an attacker', () => {
    const unsafe = [
      'connect ECONNREFUSED 10.0.0.5:5432',
      'ENOENT: no such file or directory, open /var/app/contents/config/platform.json',
      'Failed to fetch https://internal.corp.example/api/v1/users',
      'Invalid token for user admin',
      'password authentication failed for user "ihub"',
      'SELECT * FROM users WHERE id = 1 failed',
      'Error at Object.run (/srv/app/server/x.js:10:5)',
      'value QWxhZGRpbjpvcGVuU2VzYW1lVGhpc0lzTG9uZw rejected',
      'line one\nline two',
      'x'.repeat(201),
      'config.json is unreadable',
      'C:\\app\\data\\x'
    ];
    for (const message of unsafe) {
      const { body } = toErrorResponse(new ServiceError('SERVICE_UNAVAILABLE', message));
      assert.equal(body.detail, en.apiErrors.SERVICE_UNAVAILABLE, message);
      assert.equal(publicMessage(message), null, message);
    }
  });

  it('never shows the message of a runtime bug, a system error or a provider', () => {
    for (const error of [
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      new ReferenceError('foo is not defined'),
      Object.assign(new Error('socket hang up'), { syscall: 'read', errno: -104 }),
      new LLMError('Anthropic said: your prompt contained X', { code: 'PROVIDER_ERROR' })
    ]) {
      const { body } = toErrorResponse(error);
      assert.match(body.detail, /^[A-Z]/);
      assert.ok(Object.values(en.apiErrors).includes(body.detail), body.detail);
    }
  });

  it('shows the message of a 4xx as thrown, and the filter does not apply to it', () => {
    const { body } = toErrorResponse(
      new ServiceError('NOT_FOUND', 'Task t-1 not found in /tasks/')
    );
    assert.equal(body.detail, 'Task t-1 not found in /tasks/');
  });

  it('maps storage errors by their status, keeping the storage code', () => {
    const conflict = toErrorResponse(new EtagMismatchError('stale'));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'ETAG_MISMATCH');
    assert.equal(conflict.body.detail, 'stale');
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
    assert.equal(limited.body.detail, en.apiErrors.RATE_LIMITED);
    assert.deepEqual(limited.body.details, { retryAfterMs: 2500, provider: 'anthropic' });
    assert.equal(limited.headers['Retry-After'], '3');
    // A rejected provider key must not look like an expired session to the client.
    const auth = toErrorResponse(new LLMError('bad key', { code: 'AUTH_FAILED', status: 401 }));
    assert.equal(auth.status, 502);
    assert.equal(toErrorResponse(new LLMError('x', { code: 'QUOTA_EXCEEDED' })).status, 429);
  });

  it('maps a ZodError to VALIDATION_FAILED with one entry in errors per problem', () => {
    const result = z
      .object({ a: z.object({ b: z.string() }), c: z.number() })
      .safeParse({ a: { b: 1 }, c: 'x' });
    const { status, body } = toErrorResponse(result.error);
    assert.equal(status, 400);
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(body.details, undefined);
    assert.equal(body.errors.length, 2);
    assert.equal(body.errors[0].pointer, '/a/b');
    assert.equal(body.errors[0].code, 'invalid_type');
    assert.equal(body.errors[1].pointer, '/c');
  });

  it('moves details.issues of a ServiceError into errors, and leaves other details alone', () => {
    const listed = toErrorResponse(
      new ServiceError('VALIDATION_FAILED', 'Invalid task', {
        details: {
          taskId: 't1',
          issues: [{ path: 'schedule.cron', code: 'invalid_string', message: 'Bad cron' }]
        }
      })
    ).body;
    assert.deepEqual(listed.errors, [
      { pointer: '/schedule/cron', code: 'invalid_string', message: 'Bad cron' }
    ]);
    assert.deepEqual(listed.details, { taskId: 't1' });
    const only = toErrorResponse(
      new ServiceError('VALIDATION_FAILED', 'Invalid', {
        details: { issues: [{ path: ['a'], message: 'No' }] }
      })
    ).body;
    assert.equal(only.details, undefined);
    assert.equal(only.errors[0].code, 'INVALID');
    // a list that is not a list of problems stays in details
    const other = toErrorResponse(
      new ServiceError('CONFLICT', 'Busy', { details: { issues: ['a', 'b'] } })
    ).body;
    assert.deepEqual(other.details, { issues: ['a', 'b'] });
    assert.equal(other.errors, undefined);
  });

  it('answers a bare list of problems as errors, with the field it is about', () => {
    // Zod issues (`path` array) and `{ field, message }` entries of the proxy routes
    const zod = toErrorResponse(
      new ServiceError('BAD_REQUEST', 'Invalid app configuration', {
        details: [{ code: 'custom', path: ['redirectConfig', 'url'], message: 'Must be http(s)' }]
      })
    ).body;
    assert.equal(zod.details, undefined);
    assert.deepEqual(zod.errors, [
      { pointer: '/redirectConfig/url', code: 'custom', message: 'Must be http(s)' }
    ]);
    const fields = toErrorResponse(
      new ServiceError('BAD_REQUEST', 'Invalid proxy', {
        details: [{ field: 'proxy.https', message: 'Not a URL' }]
      })
    ).body;
    assert.equal(fields.errors[0].pointer, '/proxy/https');
    // a list that is not a list of problems stays a value
    const other = toErrorResponse(
      new ServiceError('CONFLICT', 'Busy', { details: ['a', 'b'] })
    ).body;
    assert.deepEqual(other.details, { value: ['a', 'b'] });
    assert.equal(other.errors, undefined);
  });

  it('writes a JSON Pointer for a path (RFC 6901)', () => {
    assert.equal(jsonPointer(['a', 0, 'b']), '/a/0/b');
    assert.equal(jsonPointer('a.b'), '/a/b');
    assert.equal(jsonPointer(['a/b', 'c~d']), '/a~1b/c~0d');
    assert.equal(jsonPointer([]), '');
  });

  it('answers the RFC 6749 shape for OAuth', () => {
    assert.deepEqual(toErrorResponse(new TypeError('x'), { rfc: true }).body, {
      error: 'server_error',
      error_description: en.apiErrors.INTERNAL_ERROR
    });
    assert.equal(
      toErrorResponse(new ServiceError('BAD_REQUEST', 'Missing grant_type'), { rfc: true }).body
        .error,
      'invalid_request'
    );
    assert.equal(
      toErrorResponse(new ServiceError('BAD_REQUEST', 'x'), { rfc: true }).headers['Content-Type'],
      undefined
    );
  });

  it('sendProblem and the response helpers answer without throwing', () => {
    const sent = [];
    const res = {
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.code = code;
        return this;
      },
      json(body) {
        sent.push(body);
        return this;
      }
    };
    sendProblem(res, new ServiceError('FORBIDDEN', 'No access'));
    assert.equal(res.code, 403);
    assert.equal(res.headers['Content-Type'], PROBLEM_CONTENT_TYPE);
    assert.equal(sent[0].detail, 'No access');

    sendErrorResponse(res, 404, 'App not found');
    assert.equal(res.code, 404);
    assert.equal(sent[1].code, 'NOT_FOUND');
    assert.equal(sent[1].detail, 'App not found');

    sendErrorResponse(res, 429, 'Slow down', {
      code: 'RATE_LIMITED',
      details: { retryAfterMs: 2000 }
    });
    assert.equal(res.code, 429);
    assert.equal(res.headers['Retry-After'], '2');
    assert.deepEqual(sent[2].details, { retryAfterMs: 2000 });

    sendErrorResponse(res, 418, 'Teapot');
    assert.equal(sent[3].code, 'BAD_REQUEST');
    assert.equal(sent[3].status, 418);

    // a code the registry does not know (a protocol code of another subsystem) still
    // gets the title of its status, never "Internal error" on a 400
    sendErrorResponse(res, 400, 'No such model', { code: 'unknown-model' });
    assert.equal(sent[4].code, 'unknown-model');
    assert.equal(sent[4].type, 'urn:ihub:problem:unknown-model');
    assert.equal(sent[4].title, en.apiErrors.BAD_REQUEST);
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
    assert.match(thrown.headers.get('content-type'), /^application\/problem\+json/);
    assert.deepEqual(await thrown.json(), {
      type: 'urn:ihub:problem:NOT_FOUND',
      title: en.apiErrors.NOT_FOUND,
      status: 404,
      detail: 'Thing not found',
      code: 'NOT_FOUND'
    });
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
      assert.match(res.headers.get('content-type'), /^application\/json/);
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
