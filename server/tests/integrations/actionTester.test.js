// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The pieces of the action test runner (#2974) on their own: secret
 * redaction, the outbound request recorder, the argument check and the
 * per-action usage counter. The routes are covered in `actionRoutes.test.js`.
 *
 * Run with `npm run test:integrations`.
 */

const { REDACTED, isSecretName, redactBody, redactDeep, redactHeaders, redactUrl, scrubSecrets } =
  await import('../../utils/secretRedaction.js');
const { recordOutbound, withOutboundRecording, MAX_RECORDED_REQUESTS } =
  await import('../../utils/outboundRecorder.js');
const { argumentProblems, auditArgs } =
  await import('../../services/integrations/tester/ActionTester.js');
const usage = await import('../../services/integrations/actionUsage.js');
const { testNeedsConfirmation, testConnectionsOf, sideEffectOfMethod } =
  await import('../../services/integrations/actionDetail.js');

describe('secret redaction', () => {
  it('knows credential names and leaves ordinary ones alone', () => {
    for (const name of [
      'Authorization',
      'cookie',
      'X-Api-Key',
      'apiKey',
      'api_key',
      'client_secret',
      'accessToken',
      'password',
      'passwd',
      'token'
    ]) {
      assert.equal(isSecretName(name), true, name);
    }
    for (const name of ['author', 'keyword', 'max_tokens', 'q', 'title', 'tokens_used']) {
      assert.equal(isSecretName(name), false, name);
    }
  });

  it('redacts credential headers and scrubs their values elsewhere', () => {
    const { headers, found } = redactHeaders({
      Authorization: 'Bearer abcdef123456',
      Accept: 'application/json',
      'X-Trace': 'abcdef123456'
    });
    assert.equal(headers.Authorization, REDACTED);
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers['X-Trace'], REDACTED);
    assert.ok(found.includes('abcdef123456'));
    assert.equal(scrubSecrets('token=abcdef123456;', found), `token=${REDACTED};`);
  });

  it('redacts URLs, JSON and form bodies and nested secret keys', () => {
    assert.equal(
      redactUrl('https://user:pw@api.example/x?apiKey=k123456&q=ok'),
      `https://${REDACTED}@api.example/x?apiKey=${REDACTED}&q=ok`
    );
    assert.match(
      redactUrl('https://api.example/x?sig=abcdef123456', ['abcdef123456']),
      /sig=\[redacted\]/
    );
    const json = redactBody(JSON.stringify({ q: 'a', auth: { password: 'pw-123456' } })).text;
    assert.match(json, /"password": "\[redacted\]"/);
    assert.match(redactBody('user=a&password=pw-123456').text, /password=\[redacted\]/);
    assert.deepEqual(redactDeep({ list: [{ apiKey: 'x' }], keep: 'y' }), {
      list: [{ apiKey: REDACTED }],
      keep: 'y'
    });
    // Short values are not treated as secrets by value (they would redact words).
    assert.equal(scrubSecrets('a cat', ['cat']), 'a cat');
  });
});

describe('outbound recorder', () => {
  it('records the requests made inside a recording, and nothing outside', async () => {
    const outside = await withOutboundRecording('https://x.example', {}, async () => ({
      status: 200
    }));
    assert.equal(outside.status, 200);
    const { result, requests } = await recordOutbound(async () => {
      await withOutboundRecording(
        'https://api.example/a',
        { method: 'post', headers: { Authorization: 'Bearer t' }, body: '{"a":1}' },
        async () => ({ status: 201 })
      );
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].status, 201);
    assert.equal(requests[0].headers.Authorization, 'Bearer t');
    assert.equal(requests[0].body, '{"a":1}');
  });

  it('keeps the error and the requests of a failing call, within the cap', async () => {
    const { error, requests } = await recordOutbound(async () => {
      for (let i = 0; i < MAX_RECORDED_REQUESTS + 5; i++) {
        await withOutboundRecording(`https://api.example/${i}`, {}, async () => ({ status: 200 }));
      }
      await withOutboundRecording('https://api.example/fail', {}, async () => {
        throw new Error('refused');
      });
    });
    assert.equal(error.message, 'refused');
    assert.equal(requests.length, MAX_RECORDED_REQUESTS);
  });
});

describe('test arguments and confirmation', () => {
  const schema = {
    type: 'object',
    properties: { q: { type: 'string' }, rows: { type: 'integer' }, ratio: { type: 'number' } },
    required: ['q']
  };

  it('checks shape, required properties and declared types', () => {
    assert.deepEqual(argumentProblems({ q: 'a', rows: 2, ratio: 1 }, schema), []);
    assert.deepEqual(argumentProblems({}, schema), ['q is required']);
    assert.deepEqual(argumentProblems({ q: 'a', rows: 1.5 }, schema), ['rows must be integer']);
    assert.deepEqual(argumentProblems([], schema), ['args must be an object']);
    assert.match(argumentProblems({ q: 'x'.repeat(70_000) }, schema)[0], /at most/);
  });

  it('asks for a confirmation for everything but a trusted read', () => {
    assert.equal(
      testNeedsConfirmation({ sideEffect: 'read', sideEffectSource: 'definition' }),
      false
    );
    assert.equal(testNeedsConfirmation({ sideEffect: 'read', sideEffectSource: 'admin' }), false);
    assert.equal(
      testNeedsConfirmation({ sideEffect: 'read', sideEffectSource: 'annotation' }),
      true
    );
    for (const sideEffect of ['write', 'destructive', 'unknown']) {
      assert.equal(testNeedsConfirmation({ sideEffect, sideEffectSource: 'definition' }), true);
    }
  });

  it('offers the connections the installation signs in with', () => {
    assert.deepEqual(testConnectionsOf({ auth: { mode: 'oauth-user' } }), [
      { id: 'me', kind: 'personal' }
    ]);
    assert.deepEqual(testConnectionsOf({ auth: { mode: 'none' } }), [{ id: 'me', kind: 'none' }]);
    assert.deepEqual(
      testConnectionsOf({ auth: { mode: 'service-account', credentialRef: 'svc' } }),
      [{ id: 'shared', kind: 'service-account', credentialRef: 'svc' }]
    );
  });

  it('maps OpenAPI methods to the side effect they suggest', () => {
    assert.equal(sideEffectOfMethod('get'), 'read');
    assert.equal(sideEffectOfMethod('PATCH'), 'write');
    assert.equal(sideEffectOfMethod('DELETE'), 'destructive');
    assert.equal(sideEffectOfMethod(null), null);
  });

  it('records arguments for the audit log without secrets, bounded', () => {
    assert.equal(auditArgs({ q: 'a', token: 'tok-123456' }), '{"q":"a","token":"[redacted]"}');
    assert.ok(auditArgs({ q: 'x'.repeat(1000) }).length <= 501);
  });
});

describe('action usage', () => {
  let dir;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-action-usage-'));
    await usage._setActionUsageDir(dir);
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('counts calls, errors, tests and approval answers of one action over 7 days', async () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    usage.recordActionEvent('jira', 'addComment', 'call', now - 1000);
    usage.recordActionEvent('jira', 'addComment', 'call', now - 2 * day);
    usage.recordActionEvent('jira', 'addComment', 'error', now - 2 * day);
    usage.recordActionEvent('jira', 'addComment', 'test', now - 3000);
    usage.recordActionEvent('jira', 'addComment', 'call', now - 9 * day); // outside the window
    usage.recordActionEvent('jira', 'search', 'call', now - 1000); // another action
    usage.recordActionEvent('jira', 'addComment', 'bogus', now); // ignored
    // An old day file is deleted on read.
    usage.recordActionEvent('jira', 'addComment', 'call', now - 20 * day);

    const service = new EventEmitter();
    usage.startActionUsageTracking(service);
    const approval = decision => ({
      kind: 'approval',
      prompt: { displayData: { integration: { id: 'jira', action: 'addComment' } } },
      answer: { decision }
    });
    service.emit('answered', approval('approve'));
    service.emit('answered', approval('reject'));
    service.emit('answered', approval('reject'));
    service.emit('expired', approval(undefined));
    service.emit('answered', { kind: 'question', answer: { decision: 'approve' } });

    const counted = await usage.readActionUsage('jira', 'addComment', { now });
    assert.equal(counted.calls, 2);
    assert.equal(counted.errors, 1);
    assert.equal(counted.tests, 1);
    assert.equal(counted.approved, 1);
    assert.equal(counted.rejected, 2);
    assert.equal(counted.expired, 1);
    assert.equal(counted.lastCallAt, new Date(now - 1000).toISOString());
    const files = await fs.readdir(dir);
    assert.ok(!files.includes('2026-10-13.jsonl'), 'files past the retention are deleted');
  });
});
