// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import validate from '../validators/validate.js';
import errorHandler from '../middleware/errorHandler.js';

describe('validate() with the global error middleware', () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/body',
      validate({ body: z.object({ name: z.string().min(1), n: z.coerce.number().int() }) }),
      (req, res) => res.json(req.body)
    );
    app.get(
      '/query',
      validate({ query: z.object({ page: z.coerce.number().int().min(1) }) }),
      (req, res) => res.json(req.query)
    );
    app.get(
      '/params/:id',
      validate({ params: z.object({ id: z.string().regex(/^\d+$/) }) }),
      (req, res) => res.json(req.params)
    );
    app.use(errorHandler);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise(resolve => server.close(resolve)));

  const postBody = body =>
    fetch(`${base}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('passes valid data through, parsed (coerced values replace the raw ones)', async () => {
    const res = await postBody({ name: 'a', n: '3' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'a', n: 3 });
  });

  it('answers a body failure as 400 VALIDATION_FAILED with an errors list', async () => {
    const res = await postBody({ name: '', n: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /^application\/problem\+json/);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(body.type, 'urn:ihub:problem:VALIDATION_FAILED');
    assert.equal(body.status, 400);
    assert.equal(typeof body.detail, 'string');
    assert.ok(Array.isArray(body.errors));
    assert.deepEqual(body.errors.map(e => e.pointer).sort(), ['/n', '/name']);
    for (const error of body.errors) {
      assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'pointer']);
    }
    assert.equal(body.details, undefined, 'the issues live in errors, not in details');
    assert.equal(body.error, undefined, 'the old error member is gone');
  });

  it('answers query and params failures the same way', async () => {
    const query = await fetch(`${base}/query?page=0`);
    assert.equal(query.status, 400);
    assert.equal((await query.json()).errors[0].pointer, '/page');
    const params = await fetch(`${base}/params/abc`);
    assert.equal(params.status, 400);
    assert.equal((await params.json()).code, 'VALIDATION_FAILED');
  });

  it('hands a non-validation error to the middleware as a 500', async () => {
    const app = express();
    app.get(
      '/x',
      validate({
        query: {
          parse() {
            throw new Error('boom');
          }
        }
      }),
      () => {}
    );
    app.use(errorHandler);
    const s = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/x`);
      assert.equal(res.status, 500);
      assert.equal((await res.json()).code, 'INTERNAL_ERROR');
    } finally {
      await new Promise(resolve => s.close(resolve));
    }
  });
});
