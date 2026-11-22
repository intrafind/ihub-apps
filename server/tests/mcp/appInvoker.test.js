// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `invokeAppNonStreaming` — the MCP gateway's request/response path into an
 * iHub app. Input validation runs before any config lookup; the app runs on
 * the real run service with a headless host (`services/run/RunService.js`),
 * which owns request preparation, the tool loop and the model calls. Only the
 * model is scripted (`helpers/appRunEnv.js`).
 *
 * Run: node --test server/tests/mcp/appInvoker.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The environment first: it isolates the contents directory before the server loads.
import { startAppRunEnv, USAGE } from '../helpers/appRunEnv.js';
import { turn } from '../helpers/scriptedModel.js';
import { invokeAppNonStreaming } from '../../services/mcp/appInvoker.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

let env;
let user;

before(async () => {
  env = await startAppRunEnv({ platform: { defaultLanguage: 'en' } });
  user = env.user('u1', ['users']);
});

after(async () => {
  await env?.stop();
});

beforeEach(() => env.reset());

const runStarts = () => env.ledger.filter(event => event.type === RUN_LOG_EVENTS.RUN_START);

describe('invokeAppNonStreaming — input validation', () => {
  it('throws when message is missing, empty or not a string', async t => {
    env.script(t, []);
    for (const args of [{}, { message: '   ' }, { message: 42 }]) {
      await assert.rejects(
        invokeAppNonStreaming({ appId: 'specialist', args, user }),
        /Missing required argument/
      );
    }
  });

  it('rejects path-traversal app ids and ids with slashes before any config lookup', async t => {
    env.script(t, []);
    for (const appId of ['../etc/passwd', 'specialist/../../etc']) {
      await assert.rejects(
        invokeAppNonStreaming({ appId, args: { message: 'hi' }, user }),
        /Invalid app id/
      );
    }
  });

  it('rejects unknown apps', async t => {
    env.script(t, []);
    await assert.rejects(
      invokeAppNonStreaming({ appId: 'nope', args: { message: 'hi' }, user }),
      /App not found/
    );
    assert.equal(runStarts().length, 0);
  });
});

describe('invokeAppNonStreaming — on the run service', () => {
  it('runs the app headlessly as the caller and returns the text', async t => {
    const model = env.script(t, [turn.text('hello back', { usage: USAGE })]);
    const text = await invokeAppNonStreaming({
      appId: 'specialist',
      args: { message: 'hi', modelId: 'golden-model', tone: 'formal' },
      user,
      language: 'de',
      timeoutMs: 1234
    });
    assert.equal(text, 'hello back');
    assert.equal(model.requests[0].body.messages.at(-1).content, 'hi');
    const [start] = runStarts();
    assert.equal(start.data.kind, 'subagent');
    assert.equal(start.data.principal.id, 'u1');
    assert.equal(start.data.refs.appId, 'specialist');
    // The caller's run id is the parent of this run in the ledger.
    assert.match(start.data.refs.executionId, /^mcp-/);
  });

  it('returns an empty string when the model produced no text', async t => {
    env.script(t, [turn.text('', { usage: USAGE })]);
    assert.equal(
      await invokeAppNonStreaming({ appId: 'specialist', args: { message: 'hi' }, user }),
      ''
    );
  });

  it('surfaces provider failures with their code', async t => {
    env.script(t, [turn.error(400, { error: { message: 'bad', code: 'bad_request' } })]);
    await assert.rejects(
      invokeAppNonStreaming({ appId: 'specialist', args: { message: 'hi' }, user }),
      error => {
        assert.equal(typeof error.code, 'string');
        assert.notEqual(error.code, 'APP_INVOCATION_FAILED');
        assert.match(error.message, /Invalid request/);
        return true;
      }
    );
  });

  it('refuses a model the caller may not use before the model is called', async t => {
    env.script(t, []);
    await assert.rejects(
      invokeAppNonStreaming({
        appId: 'specialist',
        args: { message: 'hi', modelId: 'golden-model' },
        user: { ...user, permissions: { ...user.permissions, models: new Set() } }
      }),
      error => typeof error.code === 'string'
    );
  });

  it('refuses a caller without resolved permissions, and one who may not open the app', async t => {
    env.script(t, []);
    await assert.rejects(
      invokeAppNonStreaming({ appId: 'specialist', args: { message: 'hi' }, user: { id: 'u1' } }),
      { code: 'PRINCIPAL_UNRESOLVED' }
    );
    await assert.rejects(
      invokeAppNonStreaming({ appId: 'restricted', args: { message: 'hi' }, user }),
      { code: 'APP_NOT_PERMITTED' }
    );
    assert.equal(runStarts().length, 0);
  });
});
