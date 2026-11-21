// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-test of `helpers/scriptedModel.js`: a script answers the model calls in
 * order, and a call the script has no turn for fails the test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeClient } from './loop/helpers/llmFixtures.js';
import { createFakeClock } from './helpers/fakeClock.js';
import {
  scriptedModel,
  turn,
  takeUnreportedModelCalls,
  UnscriptedModelCallError,
  UnexpectedModelRequestError
} from './helpers/scriptedModel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const messages = [{ role: 'user', content: 'hi' }];
/** The environment of a child test run: not the marker that says "already inside node --test". */
function childEnv() {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
const call = (client, extra = {}) =>
  client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false }, ...extra });

function clientFor(model, options = {}) {
  return makeClient({ transport: model.transport, maxRetries: 0, ...options }).client;
}

test('turns answer the model calls in order: tool calls, then text with usage', async () => {
  const model = scriptedModel([
    turn.toolCalls([
      { name: 'lookup', args: { key: 'k' } },
      { name: 'lookup', args: { key: 'l' }, id: 'call_b' }
    ]),
    turn.text(['Hel', 'lo'], {
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
    })
  ]);
  const client = clientFor(model);

  const first = await call(client);
  assert.equal(first.finishReason, 'tool_calls');
  assert.deepEqual(
    first.toolCalls.map(c => [c.id, c.function.name, c.function.arguments]),
    [
      ['call_1', 'lookup', '{"key":"k"}'],
      ['call_b', 'lookup', '{"key":"l"}']
    ]
  );

  const second = await call(client);
  assert.equal(second.content, 'Hello');
  assert.equal(second.usage.promptTokens, 9);
  assert.equal(second.usage.completionTokens, 2);

  assert.equal(model.calls, 2);
  assert.equal(model.remaining, 0);
  model.assertDone();
});

test('every request is recorded as a frozen copy', async () => {
  const model = scriptedModel([turn.text('ok')]);
  await call(clientFor(model));
  const [request] = model.requests;
  assert.deepEqual(request.body.messages, messages);
  assert.ok(Object.isFrozen(request) && Object.isFrozen(request.body.messages[0]));
  assert.throws(() => {
    request.body.messages[0].content = 'rewritten';
  }, TypeError);
});

test('a call without a turn throws in the transport and fails assertDone', async () => {
  const model = scriptedModel([turn.text('one')]);
  const client = clientFor(model);
  await call(client);
  await assert.rejects(call(client), /script exhausted after 2 calls/);
  assert.equal(model.unscripted.length, 1);
  assert.ok(model.unscripted[0] instanceof UnscriptedModelCallError);
  assert.throws(() => model.assertDone(), UnscriptedModelCallError);
  // assertDone reported it, so the hook after this test has nothing left to report.
  assert.deepEqual(takeUnreportedModelCalls(), []);
});

test('a strict model leaves an unscripted call for the hook; a lenient one does not', async () => {
  const strict = scriptedModel([]);
  await assert.rejects(strict.transport({ body: {} }, {}), UnscriptedModelCallError);
  const lenient = scriptedModel([], { strict: false });
  await assert.rejects(lenient.transport({ body: {} }, {}), UnscriptedModelCallError);
  const reported = takeUnreportedModelCalls();
  assert.equal(reported.length, 1);
  assert.equal(reported[0], strict.unscripted[0]);
});

test('assertDone fails on turns that were never asked for', async () => {
  const model = scriptedModel([turn.text('one'), turn.toolCalls([{ name: 'x' }]), turn.text('3')]);
  await call(clientFor(model));
  assert.throws(() => model.assertDone(), /2 unused turn\(s\) after 1 call\(s\): toolCalls, text/);
});

test('turn.error answers with the HTTP status and body', async () => {
  const model = scriptedModel([turn.error(400, { error: { message: 'bad request' } })]);
  const response = await model.transport({ body: {} }, {});
  assert.equal(response.ok, false);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: 'bad request' } });
  model.assertDone();
});

test('turn.hang answers nothing until the caller aborts; waitForCall tells when it arrived', async () => {
  const model = scriptedModel([turn.hang()]);
  const controller = new AbortController();
  const arrived = model.waitForCall(1);
  const pending = model.transport({ body: { n: 1 } }, { signal: controller.signal });
  assert.deepEqual((await arrived).body, { n: 1 });
  const stop = new Error('stopped by the test');
  controller.abort(stop);
  await assert.rejects(pending, error => error === stop);
  // A call that is already there resolves at once.
  assert.deepEqual((await model.waitForCall(1)).body, { n: 1 });
  model.assertDone();
});

test('turn.slow sends one delta per clock interval and no real time passes', async () => {
  const clock = createFakeClock();
  const model = scriptedModel([turn.slow(['a', 'b', 'c'], { clock, intervalMs: 60_000 })]);
  const response = await model.transport({ body: {} }, {});
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const contentOf = text =>
    text
      .split('\n\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)).choices[0].delta.content)
      .filter(Boolean);

  // The opening chunk is there at once, the first delta only after the interval.
  assert.deepEqual(contentOf(decoder.decode((await reader.read()).value)), []);
  assert.equal(clock.pending(), 1);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    clock.advance(60_000);
    seen.push(...contentOf(decoder.decode((await reader.read()).value)));
  }
  assert.deepEqual(seen, ['a', 'b', 'c']);
  let rest = '';
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    rest += decoder.decode(chunk.value);
  }
  assert.match(rest, /"finish_reason":"stop"/);
  assert.match(rest, /\[DONE\]/);
  assert.equal(clock.now() - createFakeClock().now(), 180_000);
});

test('turn.slow needs a clock', () => {
  assert.throws(() => turn.slow(['a']), /needs a clock/);
});

test('turn.when checks the request before answering', async () => {
  const model = scriptedModel([
    turn.when(
      request => request.body.messages.length === 1,
      turn.text('ok'),
      'one message is sent'
    ),
    turn.when(
      request => assert.equal(request.body.messages.length, 5),
      turn.text('never'),
      'five messages are sent'
    )
  ]);
  const client = clientFor(model);
  assert.equal((await call(client)).content, 'ok');
  await assert.rejects(call(client), /model call 2: expected that five messages are sent/);
  assert.ok(model.unscripted[0] instanceof UnexpectedModelRequestError);
  assert.throws(() => model.assertDone(), UnexpectedModelRequestError);
});

test('an array of streamed events and a function are turns too', async () => {
  const model = scriptedModel([
    [
      {
        choices: [{ index: 0, delta: { role: 'assistant', content: 'raw' }, finish_reason: null }]
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]'
    ],
    request => turn.text(`echo ${request.body.messages[0].content}`).respond()
  ]);
  const client = clientFor(model);
  assert.equal((await call(client)).content, 'raw');
  assert.equal((await call(client)).content, 'echo hi');
  model.assertDone();
  assert.throws(() => scriptedModel(['text']), /A script entry is/);
});

test('intercept answers a helper call beside the script, unrecorded', async () => {
  const model = scriptedModel([turn.text('scripted')], {
    intercept: request =>
      request.body.messages[0].content === 'helper' ? turn.text('beside').respond() : undefined
  });
  const client = clientFor(model);
  const beside = await call(client, { messages: [{ role: 'user', content: 'helper' }] });
  assert.equal(beside.content, 'beside');
  assert.equal(model.calls, 0);
  assert.equal((await call(client)).content, 'scripted');
  model.assertDone();
});

// The acceptance criterion of #3786: the TEST fails, not only the transport.
// The fixtures swallow the transport's error and assert nothing about it.
test('an unscripted call fails the test that made it, under node:test', () => {
  const fixture = path.join(here, 'fixtures/scriptedModel/swallowed-extra-call.node-fixture.js');
  const run = spawnSync(process.execPath, ['--test', fixture], {
    cwd: serverDir,
    encoding: 'utf8',
    env: childEnv()
  });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 1, output);
  assert.match(output, /script exhausted after 2 calls/);
  assert.match(output, /ℹ pass 1\b/);
  assert.match(output, /ℹ fail 1\b/);
});

test('an unscripted call fails the test that made it, under jest', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      '--testMatch',
      '**/fixtures/scriptedModel/*.jest-fixture.js',
      '--silent'
    ],
    { cwd: serverDir, encoding: 'utf8', env: childEnv() }
  );
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 1, output);
  assert.match(output, /script exhausted after 2 calls/);
  assert.match(output, /Tests:\s+1 failed, 1 passed, 2 total/);
});

// The helper imported late: inside a `before` hook, where both runners accept a hook after each
// test and never run it. The unscripted call must not end in a green file.
test('an unscripted call fails the file when the helper is imported late, under node:test', () => {
  const fixture = path.join(here, 'fixtures/scriptedModel/late-import.node-fixture.js');
  const run = spawnSync(process.execPath, ['--test', fixture], {
    cwd: serverDir,
    encoding: 'utf8',
    env: childEnv()
  });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 1, output);
  assert.match(output, /1 model call\(s\) without a turn were reported by no test/);
  assert.match(output, /The first: script exhausted after 2 calls/);
  assert.match(output, /Import helpers\/scriptedModel\.js at the top of the test file/);
  // node:test cannot fail a running test from outside it: the two tests pass, the file fails.
  assert.match(output, /✖ .*late-import\.node-fixture\.js/);
  assert.match(output, /ℹ fail 1\b/);
});

test('an unscripted call fails the test that made it when the helper is imported late, under jest', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      '--testMatch',
      '**/fixtures/scriptedModel/*.late-jest-fixture.js'
    ],
    { cwd: serverDir, encoding: 'utf8', env: childEnv() }
  );
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 1, output);
  assert.match(output, /Tests:\s+2 failed, 2 passed, 4 total/);
  // jest lists the failed tests with a bullet.
  assert.match(output, /● code that swallows the error of an unscripted call/);
  assert.doesNotMatch(output, /● a test after it is not blamed/);
  assert.doesNotMatch(output, /● a script that is used exactly passes/);
  // jest refuses a hook that is added now; the helper must not try to add one.
  assert.doesNotMatch(output, /Cannot add a hook after tests have started running/);
  assert.doesNotMatch(output, /Test suite failed to run/);
  // A call that `assertDone()` reported is not reported a second time by the runner.
  assert.match(output, /● assertDone reports the call once, not twice/);
  assert.equal(
    output.match(/UnscriptedModelCallError: script exhausted after 2 calls/g)?.length,
    1
  );
  assert.equal(output.match(/reported by assertDone: script exhausted after 2 calls/g)?.length, 1);
});
