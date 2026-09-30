/**
 * `GET /api/sources/:provider/content|metadata` (routes/sources.js): one route
 * for every source provider's actions, so the sources panel acts on a source
 * by its `provider` and `ref` alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import sourceRoutes from '../routes/sources.js';
import {
  _resetSourceProviders,
  registerSourceProvider,
  sourceProviderError
} from '../services/sources/providers.js';

function appFor(user = { id: 'ada', groups: ['users'] }) {
  const app = express();
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/sources', sourceRoutes);
  return app;
}

const calls = [];

/** A stream that sends `chunks` and then fails, like an upstream reset. */
function failingStream(chunks) {
  const pending = [...chunks];
  return new Readable({
    read() {
      if (pending.length) this.push(Buffer.from(pending.shift()));
      else setImmediate(() => this.destroy(new Error('upstream reset')));
    }
  });
}

test.beforeEach(() => {
  calls.length = 0;
  _resetSourceProviders();
  registerSourceProvider({
    id: 'testdocs',
    async content({ ref, user, format }) {
      calls.push({ ref, user: user.id, format });
      if (ref.id === 'missing') throw sourceProviderError(404, 'Document not found');
      if (ref.id === 'broken') throw new Error('upstream exploded');
      if (ref.id === 'reset-early' || ref.id === 'reset-late') {
        return {
          contentType: 'application/pdf',
          contentDisposition: 'attachment; filename="doc.pdf"',
          stream: failingStream(ref.id === 'reset-late' ? ['%PDF-1.7'] : [])
        };
      }
      if (format === 'text')
        return { contentType: 'text/plain', fileName: 'a "b".txt', body: 'hi' };
      return {
        contentType: 'application/pdf',
        contentDisposition: 'attachment; filename="doc.pdf"',
        stream: Readable.from([Buffer.from('%PDF-1.7')])
      };
    },
    async metadata({ ref }) {
      return { title: `Doc ${ref.id}`, scope: ref.scope ?? null };
    }
  });
  registerSourceProvider({ id: 'nodetails', content: async () => ({ body: 'x' }) });
});

test.after(() => _resetSourceProviders());

test('content: streams what the provider returns, with its headers, for the signed-in user', async () => {
  const res = await request(appFor())
    .get('/api/sources/testdocs/content')
    .query({ id: 'doc-1', scope: 'sales', format: 'pdf' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="doc.pdf"');
  assert.equal(res.body.toString(), '%PDF-1.7');
  assert.deepEqual(calls, [{ ref: { id: 'doc-1', scope: 'sales' }, user: 'ada', format: 'pdf' }]);
});

test('content: a body with a file name, defaulting to the original format', async () => {
  const text = await request(appFor())
    .get('/api/sources/testdocs/content')
    .query({ id: 'doc-1', format: 'text' });
  assert.equal(text.status, 200);
  assert.equal(text.text, 'hi');
  assert.equal(text.headers['content-disposition'], 'attachment; filename="a _b_.txt"');
  await request(appFor()).get('/api/sources/testdocs/content').query({ id: 'doc-2' });
  assert.deepEqual(calls.at(-1), { ref: { id: 'doc-2' }, user: 'ada', format: 'original' });
});

test('content: a provider error keeps its status; anything else is a 500', async () => {
  const missing = await request(appFor())
    .get('/api/sources/testdocs/content')
    .query({ id: 'missing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Document not found');
  const broken = await request(appFor())
    .get('/api/sources/testdocs/content')
    .query({ id: 'broken' });
  assert.equal(broken.status, 500);
});

test('content: a stream that fails before any byte is a 502, not a hang or a crash', async () => {
  const res = await request(appFor())
    .get('/api/sources/testdocs/content')
    .query({ id: 'reset-early' });
  assert.equal(res.status, 502);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['content-disposition'], undefined);
  assert.equal(res.body.error, 'Source content stream failed');
});

test('content: a stream that fails midway aborts the response', async () => {
  await assert.rejects(
    request(appFor()).get('/api/sources/testdocs/content').query({ id: 'reset-late' }),
    error => /socket hang up|ECONNRESET|aborted/i.test(`${error.code} ${error.message}`)
  );
});

test('the request shape is checked before any provider is asked', async () => {
  const app = appFor();
  const cases = [
    ['/api/sources/testdocs/content', {}, 400],
    ['/api/sources/testdocs/content', { id: 'x'.repeat(1025) }, 400],
    ['/api/sources/testdocs/content', { id: 'a', scope: 's'.repeat(257) }, 400],
    ['/api/sources/testdocs/content', { id: 'a', format: 'exe' }, 400],
    ['/api/sources/testdocs/content', { id: ['a', 'b'] }, 400],
    ['/api/sources/..%2Fadmin/content', { id: 'a' }, 400],
    ['/api/sources/unknown/content', { id: 'a' }, 404],
    ['/api/sources/constructor/content', { id: 'a' }, 400]
  ];
  for (const [path, query, status] of cases) {
    const res = await request(app).get(path).query(query);
    assert.equal(res.status, status, `${path} ${JSON.stringify(query)}`);
  }
  assert.equal(calls.length, 0);
});

test('metadata: the provider’s details, or 404 when it has none', async () => {
  const res = await request(appFor())
    .get('/api/sources/testdocs/metadata')
    .query({ id: 'doc-1', scope: 'hr' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { title: 'Doc doc-1', scope: 'hr' });
  const none = await request(appFor()).get('/api/sources/nodetails/metadata').query({ id: 'a' });
  assert.equal(none.status, 404);
});
