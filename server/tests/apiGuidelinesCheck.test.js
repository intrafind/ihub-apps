// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, parseChangedLines } from '../../scripts/check-api-guidelines.js';

const rules = (source, file = 'server/routes/example.js', changed = null) =>
  findViolations(source, file, changed).map(v => v.rule);

describe('check-api-guidelines', () => {
  it('flags a hand-written error body, on one line or several', () => {
    assert.deepEqual(rules("res.status(404).json({ error: 'Not found' });"), ['hand-rolled-error']);
    assert.deepEqual(rules("return res.status(500).json({\n  code: 'X',\n  error: 'Failed'\n});"), [
      'hand-rolled-error'
    ]);
    assert.deepEqual(rules("res.status(400).send({ error: 'Bad' });"), ['hand-rolled-error']);
    // a variable status is as much an error body as a literal one
    assert.deepEqual(rules('res.status(error.status).json({ error: error.message });'), [
      'hand-rolled-error'
    ]);
    assert.deepEqual(rules("res.status(status || 500).json({ error: 'x' });"), [
      'hand-rolled-error'
    ]);
  });

  it('accepts a thrown ServiceError and a success body that has an error member', () => {
    assert.deepEqual(rules("throw new ServiceError('NOT_FOUND', 'Task not found');"), []);
    assert.deepEqual(
      rules("res.status(200).json({ status: 'failed', error: 'probe failed' });"),
      []
    );
    assert.deepEqual(rules('res.status(201).json({ error: null });'), []);
    assert.deepEqual(rules('res.json({ error: null });'), []);
  });

  it('leaves an RFC 6749 / 6750 body (error plus error_description) alone', () => {
    assert.deepEqual(
      rules(
        "res.status(401).json({\n  error: 'invalid_token',\n  error_description: 'Token expired'\n});"
      ),
      []
    );
    assert.deepEqual(
      rules("res.status(401).json({ error: 'invalid_token', error_description: 'x' });"),
      []
    );
    // the exception is for that body only: the next call is still flagged
    assert.deepEqual(
      rules(
        "res.status(401).json({ error: 'a', error_description: 'x' });\nres.status(404).json({ error: 'b' });"
      ),
      ['hand-rolled-error']
    );
  });

  it('flags success envelopes', () => {
    assert.deepEqual(rules('res.json({ success: true });'), ['success-envelope']);
    assert.deepEqual(rules("res.json({ message: 'App updated successfully', app });"), [
      'success-envelope'
    ]);
    assert.deepEqual(rules("res.json({ message: 'Hello', app });"), []);
  });

  it('flags status 422', () => {
    assert.deepEqual(rules('res.status(422);'), ['status-422']);
  });

  it('flags a bare verb on a route but accepts an _action segment', () => {
    assert.deepEqual(rules("router.post('/:taskId/run', handler);"), ['route-verb']);
    // Admin routes are registered through buildServerPath(…), on one line or across lines.
    assert.deepEqual(
      rules("app.post(buildServerPath('/api/admin/apps/:appId/toggle'), adminAuth, h);"),
      ['route-verb']
    );
    assert.deepEqual(
      rules("app.post(\n  buildServerPath('/api/admin/proxy/_test'),\n  adminAuth,\n  h\n);"),
      []
    );
    assert.deepEqual(rules('app.post(`${base}/:id/duplicate`, handler);'), ['route-verb']);
    assert.deepEqual(rules("router.post('/:keyId/_rotate', handler);"), []);
    assert.deepEqual(rules('app.post(`${base}/_preview`, handler);'), []);
    // a read named like a verb is a resource read, not an action
    assert.deepEqual(rules("router.get('/jobs/:jobId/download', handler);"), []);
  });

  it('flags a path segment that is not kebab-case', () => {
    assert.deepEqual(rules("router.get('/scheduledTasks/:id', handler);"), ['route-naming']);
    assert.deepEqual(rules("router.get('/scheduled_tasks', handler);"), ['route-naming']);
    assert.deepEqual(rules("router.get('/scheduled-tasks/:taskId/runs', handler);"), []);
    assert.deepEqual(rules("router.get('/manifest.xml', handler);"), []);
    assert.deepEqual(rules("router.get('/_notifications', handler);"), []);
  });

  it('flags paging and snake_case query parameters, direct or destructured', () => {
    assert.deepEqual(rules('const p = req.query.page;'), ['pagination-param']);
    assert.deepEqual(rules('const { limit, offset = 0 } = req.query;'), ['pagination-param']);
    assert.deepEqual(rules('const s = req.query.per_page;'), ['pagination-param']);
    // A handler that reads the parameters through an alias of req.query.
    assert.deepEqual(rules('const query = req.query || {};\nconst page = query.page;'), [
      'pagination-param'
    ]);
    assert.deepEqual(rules('const query = req.query || {};\nconst q = query.cursor;'), []);
    assert.deepEqual(rules('const s = req.query.sort_by;'), ['query-naming']);
    assert.deepEqual(rules('const { limit, cursor, appId } = req.query;'), []);
  });

  it('reports only changed lines', () => {
    const source = [
      "res.status(404).json({ error: 'old' });",
      'const ok = 1;',
      "res.status(404).json({ error: 'new' });"
    ].join('\n');
    assert.deepEqual(
      findViolations(source, 'server/routes/example.js', new Set([3])).map(v => v.line),
      [3]
    );
    assert.deepEqual(findViolations(source, 'server/routes/example.js', new Set([2])), []);
    // a multi-line match is reported when any of its lines changed
    const multi = "res.status(500).json({\n  error: 'x'\n});";
    assert.equal(findViolations(multi, 'server/routes/example.js', new Set([2])).length, 1);
  });

  it('honors api-guidelines-ignore on the same or the previous line', () => {
    assert.deepEqual(
      rules("res.status(404).json({ error: 'x' }); // api-guidelines-ignore: legacy client"),
      []
    );
    assert.deepEqual(
      rules("// api-guidelines-ignore: legacy client\nres.status(404).json({ error: 'x' });"),
      []
    );
  });

  it('exempts endpoints that follow an external specification', () => {
    const source = "res.status(400).json({ error: 'invalid_request' });";
    assert.deepEqual(rules(source, 'server/routes/oauth.js'), []);
    assert.deepEqual(rules(source, 'server/routes/inference/responses.js'), []);
    assert.deepEqual(rules(source, 'server/services/inference/errors.js'), []);
    assert.deepEqual(rules(source, 'server/routes/wellKnown.js'), []);
    assert.deepEqual(rules(source, 'server/routes/chats.js'), ['hand-rolled-error']);
  });

  it('reads the changed lines of checked files from a zero-context diff', () => {
    const diff = [
      'diff --git a/server/routes/chats.js b/server/routes/chats.js',
      '--- a/server/routes/chats.js',
      '+++ b/server/routes/chats.js',
      '@@ -10,0 +11,2 @@ context',
      '+a',
      '+b',
      '@@ -30 +32 @@',
      '-old',
      '+new',
      'diff --git a/server/tests/x.test.js b/server/tests/x.test.js',
      '--- a/server/tests/x.test.js',
      '+++ b/server/tests/x.test.js',
      '@@ -1 +1 @@',
      'diff --git a/client/src/x.js b/client/src/x.js',
      '--- a/client/src/x.js',
      '+++ b/client/src/x.js',
      '@@ -1 +1 @@',
      'diff --git a/server/migrations/V001__x.js b/server/migrations/V001__x.js',
      '+++ b/server/migrations/V001__x.js',
      '@@ -0,0 +1,3 @@'
    ].join('\n');
    const files = parseChangedLines(diff);
    assert.deepEqual([...files.keys()], ['server/routes/chats.js']);
    assert.deepEqual([...files.get('server/routes/chats.js')], [11, 12, 32]);
  });

  it('never reads a path that leaves the server directory', () => {
    const diff = '+++ b/server/../secrets.js\n@@ -0,0 +1 @@\n';
    assert.equal(parseChangedLines(diff).size, 0);
  });
});
