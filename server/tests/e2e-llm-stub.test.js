// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model stub of the end-to-end suites (`tests/config/e2e-llm-stub.mjs`).
 *
 * Two things are pinned here. The default reply is byte for byte what it was
 * before the markers were added: every existing spec reads it. And the markers
 * (`e2e-slow`, `e2e-hang`, `e2e-tool`, `e2e-tools-parallel`, `e2e-script`) do what
 * their specs rely on. Time is the test's own: no test waits for a real delay.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  HANG_AUTO_RELEASE_MS,
  STUB_MODEL_ID,
  STUB_TOOLS_MODEL_ID,
  parseMarker,
  planFor,
  startLlmStub
} from '../../tests/config/e2e-llm-stub.mjs';
import { E2E_SCRIPTS, callTools, say } from '../../tests/config/e2e-scripts.mjs';

/** A clock the test moves: timers wait in `queue` until the test fires them. */
function manualTimers() {
  const queue = [];
  let nextId = 1;
  return {
    queue,
    cleared: [],
    setTimeout(fn, ms) {
      const timer = { id: nextId++, fn, ms };
      queue.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const index = queue.findIndex(timer => timer.id === id);
      if (index >= 0) this.cleared.push(queue.splice(index, 1)[0]);
    },
    /** Fire the oldest waiting timer. */
    fire() {
      const timer = queue.shift();
      assert.ok(timer, 'a timer is waiting');
      timer.fn();
      return timer;
    }
  };
}

/** Wait (event loop turns, not time) until `condition()` holds. */
async function until(condition, what) {
  for (let turn = 0; turn < 2000; turn++) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`never happened: ${what}`);
}

const user = content => ({ role: 'user', content });
const assistant = (content, toolCalls) => ({
  role: 'assistant',
  content,
  ...(toolCalls && { tool_calls: toolCalls })
});
const toolResult = (id, content) => ({ role: 'tool', tool_call_id: id, content });

/** One streamed chunk, byte for byte as the stub has always written it. */
const chunk = (delta, finish = 'null', extra = '') =>
  `data: {"id":"chatcmpl-e2e","created":1,"model":"e2e-stub-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":${delta},"finish_reason":${finish}}]${extra}}\n\n`;
const ROLE_CHUNK = chunk('{"role":"assistant","content":""}');
const USAGE = ',"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}';
const DONE = 'data: [DONE]\n\n';
const words = (...list) => list.map(word => chunk(`{"content":${JSON.stringify(word)}}`)).join('');
const streamed = (...list) => ROLE_CHUNK + words(...list) + chunk('{}', '"stop"', USAGE) + DONE;

describe('e2e model stub', () => {
  let server;
  let base;
  let timers;
  const scripts = {
    demo: [
      callTools({ name: 'lookup', args: { q: 'one' } }),
      say('second turn'),
      body => say(`third turn, ${body.messages.length} messages`)
    ],
    paced: [say('a b', { slowMs: 50 })],
    held: [say('after the hold', { hangKey: 'script-key' })],
    broken: [
      () => {
        throw new Error('a bug in the script');
      }
    ],
    throwsNull: [
      () => {
        throw null;
      }
    ]
  };

  before(async () => {
    timers = manualTimers();
    server = await startLlmStub(0, { scripts, timers });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await fetch(`${base}/__release-all`, { method: 'POST' });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  beforeEach(async () => {
    await fetch(`${base}/__release-all`, { method: 'POST' });
    await fetch(`${base}/__reset`, { method: 'POST' });
    timers.queue.length = 0;
    timers.cleared.length = 0;
  });

  const post = async body => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  };
  const answerOf = async messages => {
    const res = await post({ messages });
    return JSON.parse(res.text).choices[0];
  };
  const get = async pathname => (await fetch(`${base}${pathname}`)).json();
  const control = async pathname => (await fetch(`${base}${pathname}`, { method: 'POST' })).json();

  /** A request whose answer the test reads while it is being written. */
  function open(body) {
    const state = { text: '', ended: false, status: null };
    const req = http.request(`${base}/v1/chat/completions`, { method: 'POST' }, res => {
      state.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', data => (state.text += data));
      res.on('end', () => (state.ended = true));
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end(JSON.stringify(body));
    state.abort = () => req.destroy();
    return state;
  }

  describe('the default reply', () => {
    test('streams byte for byte as before', async () => {
      const res = await post({ stream: true, messages: [user('Hi')] });
      assert.equal(res.status, 200);
      assert.equal(res.type, 'text/event-stream');
      assert.equal(res.text, streamed('E2E ', 'reply ', 'to: ', 'Hi ', '(turn ', '1)'));
    });

    test('answers as one JSON body, byte for byte as before', async () => {
      const res = await post({
        messages: [user('a'), assistant('b'), user([{ type: 'text', text: 'Second question' }])]
      });
      assert.equal(res.type, 'application/json');
      assert.equal(
        res.text,
        '{"id":"chatcmpl-e2e","created":1,"model":"e2e-stub-model","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"E2E reply to: Second question (turn 2)"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}'
      );
    });

    test('fails a message containing e2e-fail with HTTP 400', async () => {
      const res = await post({ stream: true, messages: [user('please e2e-fail now')] });
      assert.equal(res.status, 400);
      assert.equal(res.text, '{"error":{"message":"The stub model refused this request."}}');
    });

    test('reads e2e-fail and e2e-auth outside tool arguments only', async () => {
      const inArguments = await answerOf([user('e2e-tool:lookup:{"q":"e2e-fail e2e-auth"}')]);
      assert.equal(
        inArguments.message.tool_calls[0].function.arguments,
        '{"q":"e2e-fail e2e-auth"}'
      );
      const parallel = await answerOf([user('e2e-tools-parallel:a,b:[{"q":"e2e-auth"},{}]')]);
      assert.equal(parallel.message.tool_calls.length, 2);

      const after = await post({ messages: [user('e2e-tool:lookup:{"q":"x"} e2e-auth')] });
      assert.equal(after.status, 401);
    });

    test('ignores the words in the arguments of every tool marker, not only the first', async () => {
      const second = await post({
        messages: [user('e2e-tool:a:{"q":"x"} and e2e-tool:lookup:{"q":"e2e-auth"}')]
      });
      assert.equal(second.status, 200);
      const parallel = await post({
        messages: [user('e2e-tool:a:{} e2e-tools-parallel:b,c:[{"q":"e2e-auth"},{}]')]
      });
      assert.equal(parallel.status, 200);

      const outside = await post({
        messages: [user('e2e-tool:a:{} e2e-tool:b:{"q":"y"} e2e-auth')]
      });
      assert.equal(outside.status, 401);
    });

    test('a timed e2e-slow it cannot read gets no bare e2e-slow delay', async () => {
      const previous = process.env.E2E_LLM_SLOW_MS;
      process.env.E2E_LLM_SLOW_MS = '600000';
      try {
        for (const text of ['e2e-slow:abc:2', 'e2e-slow:fast:3', 'e2e-slow:100']) {
          const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            body: JSON.stringify({ messages: [user(text)] }),
            signal: AbortSignal.timeout(5000)
          });
          const answer = (await res.json()).choices[0].message.content;
          assert.equal(answer, `E2E reply to: ${text} (turn 1)`);
        }
      } finally {
        if (previous === undefined) delete process.env.E2E_LLM_SLOW_MS;
        else process.env.E2E_LLM_SLOW_MS = previous;
      }
    });

    test('answers a marker it cannot read like any other message', async () => {
      for (const text of [
        'e2e-unknown:thing',
        'e2e-slow:fast:3',
        'e2e-slow:100:0',
        'e2e-slow:100',
        'e2e-hang:',
        'e2e-hang:.',
        'e2e-hang:..',
        'e2e-tool:lookup:not-json',
        'e2e-tool:lookup:[1,2]',
        'e2e-tools-parallel:only_one',
        'e2e-tools-parallel:a,b:[{}]',
        'e2e-script:not-registered'
      ]) {
        const res = await post({ stream: true, messages: [user(text)] });
        const reply = `E2E reply to: ${text} (turn 1)`;
        assert.equal(res.text, streamed(...reply.split(/(?<= )/)), text);
      }
      assert.deepEqual(timers.queue, [], 'no timer was started');
    });

    test('ignores a marker of an earlier message', async () => {
      const choice = await answerOf([
        user('e2e-tool:lookup'),
        assistant('E2E tool result seen: x'),
        user('Back to normal')
      ]);
      assert.equal(choice.message.content, 'E2E reply to: Back to normal (turn 2)');
    });

    test('lists its two models', async () => {
      assert.deepEqual(
        (await get('/v1/models')).data.map(model => model.id),
        [STUB_MODEL_ID, STUB_TOOLS_MODEL_ID]
      );
    });
  });

  describe('parseMarker', () => {
    test('reads every marker', () => {
      assert.deepEqual(parseMarker('e2e-slow:200:5'), { kind: 'slow', ms: 200, count: 5 });
      assert.deepEqual(parseMarker('e2e-slow:60000:2'), { kind: 'slow', ms: 60000, count: 2 });
      assert.deepEqual(parseMarker('e2e-slow:240:500'), { kind: 'slow', ms: 240, count: 500 });
      assert.deepEqual(parseMarker('please e2e-hang:k1 now'), { kind: 'hang', key: 'k1' });
      assert.deepEqual(parseMarker('e2e-script:two-step'), { kind: 'script', name: 'two-step' });
      assert.deepEqual(parseMarker('e2e-tool:read_url'), {
        kind: 'tool',
        parallel: false,
        calls: [{ name: 'read_url', args: {} }]
      });
      assert.deepEqual(
        parseMarker('e2e-tool:read_url:{"url":"https://example.org/a b","n":{"x":"}"}} thanks'),
        {
          kind: 'tool',
          parallel: false,
          calls: [{ name: 'read_url', args: { url: 'https://example.org/a b', n: { x: '}' } } }]
        }
      );
      assert.deepEqual(parseMarker('e2e-tools-parallel:a,b_c'), {
        kind: 'tool',
        parallel: true,
        calls: [
          { name: 'a', args: {} },
          { name: 'b_c', args: {} }
        ]
      });
      assert.deepEqual(parseMarker('e2e-tools-parallel:a,b:[{"q":1},{}]').calls, [
        { name: 'a', args: { q: 1 } },
        { name: 'b', args: {} }
      ]);
    });

    test('takes dotted hang keys, but not . or ..', () => {
      assert.deepEqual(parseMarker('e2e-hang:run.1'), { kind: 'hang', key: 'run.1' });
      assert.equal(parseMarker('e2e-hang:.'), null);
      assert.equal(parseMarker('e2e-hang:..'), null);
      assert.deepEqual(parseMarker('e2e-hang:...'), { kind: 'hang', key: '...' });
    });

    test('refuses a timed reply longer than two minutes in all', () => {
      assert.equal(parseMarker('e2e-slow:60000:3'), null);
      assert.equal(parseMarker('e2e-slow:60000:500'), null);
      assert.equal(parseMarker('e2e-slow:241:500'), null);
    });

    test('returns null without a marker', () => {
      assert.equal(parseMarker('Hello'), null);
      assert.equal(parseMarker(''), null);
      assert.equal(parseMarker(undefined), null);
    });
  });

  describe('e2e-slow', () => {
    test('streams one word per interval, never ahead of the clock', async () => {
      const call = open({ stream: true, messages: [user('e2e-slow:200:3')] });
      // What has arrived while the next interval waits for the test's clock.
      const arrived = async expected => {
        await until(
          () => timers.queue.length === 1 && call.text.length >= expected.length,
          `an interval waiting after ${expected.length} bytes`
        );
        // Anything written ahead of the clock would arrive in these turns.
        for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(call.text, expected);
        assert.equal(call.ended, false);
      };

      await arrived(ROLE_CHUNK);
      assert.equal(timers.fire().ms, 200);
      await arrived(ROLE_CHUNK + words('slow-1 '));
      assert.equal(timers.fire().ms, 200);
      await arrived(ROLE_CHUNK + words('slow-1 ', 'slow-2 '));

      assert.equal(timers.fire().ms, 200);
      await until(() => call.ended, 'the end of the answer');
      assert.equal(call.text, streamed('slow-1 ', 'slow-2 ', 'slow-3'));
      assert.deepEqual(timers.queue, []);
    });

    test('without streaming, answers after the whole time', async () => {
      const call = open({ messages: [user('e2e-slow:200:3')] });
      await until(() => timers.queue.length === 1, 'the wait');
      // Headers sent ahead of the clock would reach the client in these turns.
      for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(call.status, null, 'nothing is sent before the time has passed');
      assert.equal(timers.fire().ms, 600);
      await until(() => call.ended, 'the answer');
      assert.equal(JSON.parse(call.text).choices[0].message.content, 'slow-1 slow-2 slow-3');
    });
  });

  describe('e2e-hang', () => {
    test('holds the answer until the key is released', async () => {
      const call = open({ stream: true, messages: [user('e2e-hang:k1')] });
      await until(async () => (await get('/__stats')).hanging.includes('k1'), 'the hang');
      await until(() => call.text.length > 0, 'the first chunk');
      assert.equal(call.text, ROLE_CHUNK);
      assert.equal(call.ended, false);

      assert.deepEqual(await control('/__release/other-key'), { released: 0 });
      assert.equal(call.ended, false);

      assert.deepEqual(await control('/__release/k1'), { released: 1 });
      await until(() => call.ended, 'the end of the answer');
      assert.equal(call.text, streamed('E2E ', 'released: ', 'k1'));
      assert.deepEqual(await get('/__stats'), { aborted: 0, hanging: [] });
      assert.deepEqual(timers.queue, [], 'the automatic release is cancelled');
    });

    test('releases a hang nobody released after two minutes', async () => {
      assert.equal(HANG_AUTO_RELEASE_MS, 120_000);
      const call = open({ messages: [user('e2e-hang:forgotten')] });
      await until(() => timers.queue.length === 1, 'the automatic release timer');
      for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(call.status, null);

      assert.equal(timers.fire().ms, HANG_AUTO_RELEASE_MS);
      await until(() => call.ended, 'the answer');
      assert.equal(JSON.parse(call.text).choices[0].message.content, 'E2E released: forgotten');
      assert.deepEqual((await get('/__stats')).hanging, []);
    });

    test('release-all ends every hang, also two with the same key', async () => {
      const calls = [
        open({ stream: true, messages: [user('e2e-hang:same')] }),
        open({ stream: true, messages: [user('e2e-hang:same')] }),
        open({ stream: true, messages: [user('e2e-hang:another')] })
      ];
      await until(() => timers.queue.length === 3, 'three hangs');
      assert.deepEqual((await get('/__stats')).hanging.sort(), ['another', 'same']);
      assert.deepEqual(await control('/__release-all'), { released: 3 });
      await until(() => calls.every(call => call.ended), 'the end of all three');
    });

    test('counts a call the caller gave up, and forgets its hang', async () => {
      const call = open({ stream: true, messages: [user('e2e-hang:gone')] });
      await until(async () => (await get('/__stats')).hanging.includes('gone'), 'the hang');
      call.abort();
      await until(async () => (await get('/__stats')).aborted === 1, 'the abort to be counted');
      assert.deepEqual(await get('/__stats'), { aborted: 1, hanging: [] });
      assert.deepEqual(timers.queue, [], 'its timer is cleared');
      assert.equal(timers.cleared[0].ms, HANG_AUTO_RELEASE_MS);
      assert.deepEqual(await control('/__release/gone'), { released: 0 });
    });

    test('a slow answer the caller gave up stops its clock', async () => {
      const call = open({ stream: true, messages: [user('e2e-slow:200:5')] });
      await until(() => timers.queue.length === 1, 'the first interval');
      call.abort();
      await until(async () => (await get('/__stats')).aborted === 1, 'the abort to be counted');
      assert.deepEqual(timers.queue, []);
    });

    test('an answered call is not counted as aborted', async () => {
      await post({ stream: true, messages: [user('Hi')] });
      await post({ messages: [user('e2e-tool:lookup')] });
      assert.equal((await get('/__stats')).aborted, 0);
    });
  });

  describe('e2e-tool', () => {
    test('calls the tool, then answers with what the tool returned', async () => {
      const first = await answerOf([user('e2e-tool:lookup:{"q":"x"}')]);
      assert.equal(first.finish_reason, 'tool_calls');
      assert.equal(first.message.content, null);
      assert.deepEqual(first.message.tool_calls, [
        {
          id: 'call_e2e_0_0',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' }
        }
      ]);

      const result = 'r'.repeat(100);
      const second = await answerOf([
        user('e2e-tool:lookup:{"q":"x"}'),
        assistant(null, first.message.tool_calls),
        toolResult('call_e2e_0_0', result)
      ]);
      assert.equal(second.finish_reason, 'stop');
      assert.equal(second.message.content, `E2E tool result seen: ${'r'.repeat(80)}`);
    });

    test('streams the tool call in the chunk format', async () => {
      const res = await post({ stream: true, messages: [user('e2e-tool:lookup')] });
      assert.equal(
        res.text,
        ROLE_CHUNK +
          chunk(
            '{"tool_calls":[{"index":0,"id":"call_e2e_0_0","type":"function","function":{"name":"lookup","arguments":"{}"}}]}'
          ) +
          chunk('{}', '"tool_calls"', USAGE) +
          DONE
      );
    });

    test('gives a later turn of the same chat its own call ids', async () => {
      const choice = await answerOf([
        user('e2e-tool:lookup'),
        assistant(null, [{ id: 'call_e2e_0_0' }]),
        toolResult('call_e2e_0_0', 'x'),
        assistant('E2E tool result seen: x'),
        user('e2e-tool:lookup')
      ]);
      assert.equal(choice.message.tool_calls[0].id, 'call_e2e_2_0');
    });
  });

  describe('e2e-tools-parallel', () => {
    test('calls the tools in one assistant message, then counts the results', async () => {
      const marker = 'e2e-tools-parallel:first,second:[{"a":1},{"b":2}]';
      const first = await answerOf([user(marker)]);
      assert.deepEqual(
        first.message.tool_calls.map(call => [
          call.id,
          call.function.name,
          call.function.arguments
        ]),
        [
          ['call_e2e_0_0', 'first', '{"a":1}'],
          ['call_e2e_0_1', 'second', '{"b":2}']
        ]
      );

      const second = await answerOf([
        user(marker),
        assistant(null, first.message.tool_calls),
        toolResult('call_e2e_0_0', 'one'),
        toolResult('call_e2e_0_1', 'two')
      ]);
      assert.equal(second.message.content, 'E2E tool results seen: 2');
    });
  });

  describe('e2e-script', () => {
    const marker = user('e2e-script:demo');
    const firstCall = [{ id: 'call_e2e_0_0', type: 'function' }];

    test('picks the turn by the number of assistant messages, in any order', async () => {
      // The second turn is asked for first: a call counter would answer with turn one.
      const second = await answerOf([
        marker,
        assistant(null, firstCall),
        toolResult('call_e2e_0_0', 'x')
      ]);
      assert.equal(second.message.content, 'second turn');

      const first = await answerOf([marker]);
      assert.equal(first.finish_reason, 'tool_calls');
      assert.deepEqual(first.message.tool_calls[0].function, {
        name: 'lookup',
        arguments: '{"q":"one"}'
      });

      // Asked again, the same request gets the same answer.
      assert.deepEqual(await answerOf([marker]), first);
    });

    test('a turn can be a function of the request', async () => {
      const third = await answerOf([marker, assistant('one'), marker, assistant('two'), marker]);
      assert.equal(third.message.content, 'third turn, 5 messages');
    });

    test('says so when the script has no turn left', async () => {
      const messages = [marker, assistant('1'), marker, assistant('2'), marker, assistant('3')];
      const past = await answerOf([...messages, marker]);
      assert.equal(past.message.content, 'E2E script demo: no turn 4');
    });

    test('a turn can be paced and held', async () => {
      const paced = open({ stream: true, messages: [user('e2e-script:paced')] });
      await until(() => timers.queue.length === 1, 'the first interval');
      assert.equal(timers.fire().ms, 50);
      await until(() => timers.queue.length === 1, 'the second interval');
      timers.fire();
      await until(() => paced.ended, 'the end of the paced answer');
      assert.equal(paced.text, streamed('a ', 'b'));

      const held = open({ stream: true, messages: [user('e2e-script:held')] });
      await until(async () => (await get('/__stats')).hanging.includes('script-key'), 'the hang');
      await control('/__release/script-key');
      await until(() => held.ended, 'the end of the held answer');
      assert.equal(held.text, streamed('after ', 'the ', 'hold'));
    });

    test('the shipped scripts are lists of turns', () => {
      assert.ok(Object.keys(E2E_SCRIPTS).length > 0);
      for (const [name, turns] of Object.entries(E2E_SCRIPTS)) {
        assert.match(name, /^[A-Za-z0-9_.-]+$/, name);
        assert.ok(Array.isArray(turns) && turns.length > 0, name);
        for (const turn of turns) {
          assert.ok(typeof turn === 'function' || (turn && typeof turn === 'object'), name);
        }
      }
      assert.deepEqual(planFor({ messages: [user('e2e-script:two-step')] }), {
        content: 'E2E script two-step: step 1',
        toolCalls: []
      });
      assert.equal(
        planFor({
          messages: [user('e2e-script:two-step'), assistant('x'), user('e2e-script:two-step')]
        }).content,
        'E2E script two-step: step 2'
      );
    });

    test('hold-then-call holds one call of the named tool until its key is released', () => {
      const message =
        'e2e-script:hold-then-call hold=k-1 tool=ask_user args={"question":"Which year?"}';
      const plan = planFor({ messages: [user(message)] });
      assert.equal(plan.hangKey, 'k-1');
      assert.equal(plan.toolCalls.length, 1);
      assert.equal(plan.toolCalls[0].name, 'ask_user');
      assert.deepEqual(JSON.parse(plan.toolCalls[0].arguments), { question: 'Which year?' });
      assert.match(
        planFor({ messages: [user('e2e-script:hold-then-call hold=k-2 args={broken')] }).content,
        /needs hold=<key> tool=<name> args=<json>/
      );
    });
  });

  describe('what the stub was sent', () => {
    test('lists the requests, all or the ones with a marker text', async () => {
      await post({ messages: [user('first question')] });
      await post({
        messages: [{ role: 'system', content: 'needle in the system prompt' }, user('x')]
      });
      await post({ messages: [user([{ type: 'text', text: 'needle in a part' }])] });

      assert.equal((await get('/__requests')).items.length, 3);
      assert.deepEqual(
        (await get('/__requests?marker=needle')).items.map(body => body.messages.length),
        [2, 1]
      );
      assert.deepEqual((await get('/__requests?marker=absent')).items, []);
      assert.equal(
        (await get('/__last-request')).body.messages[0].content[0].text,
        'needle in a part'
      );
    });

    test('filters past a body whose messages are no list or hold null', async () => {
      for (const body of [{ messages: {} }, { messages: [null, user('needle here')] }, {}]) {
        await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) });
      }
      const filtered = await fetch(`${base}/__requests?marker=needle`);
      assert.equal(filtered.status, 200);
      assert.deepEqual((await filtered.json()).items, [{ messages: [null, user('needle here')] }]);
      assert.equal((await get('/__requests')).items.length, 3);
    });

    test('empties the list on POST /__requests and on POST /__reset', async () => {
      await post({ messages: [user('one')] });
      assert.deepEqual(await control('/__requests'), { items: [] });
      assert.deepEqual((await get('/__requests')).items, []);

      await post({ messages: [user('two')] });
      const reset = await fetch(`${base}/__reset`, { method: 'POST' });
      assert.equal(reset.status, 204);
      assert.deepEqual((await get('/__requests')).items, []);
    });
  });

  // The stub runs inside the process that starts the server under test
  // (`agents-server.mjs`): a request that ended the stub would end the whole stack.
  describe('a request the stub cannot serve', () => {
    /** A request with the target exactly as given: `fetch` would normalise it. */
    const raw = (method, target) =>
      new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.request({ host: '127.0.0.1', port, method, path: target }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', data => (text += data));
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(text) });
            } catch (error) {
              reject(new Error(`HTTP ${res.statusCode}, body is no JSON: ${error.message}`));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });

    test('a key with a broken escape is refused, and the stub keeps answering', async () => {
      const hung = open({ stream: true, messages: [user('e2e-hang:still-held')] });
      await until(async () => (await get('/__stats')).hanging.length === 1, 'the hang');

      for (const target of ['/__release/%E0', '/__release/50%', '/__release/%']) {
        const refused = await raw('POST', target);
        assert.equal(refused.status, 400, target);
        assert.match(refused.body.error.message, /key/, target);
      }
      // The refused calls released nothing, and the stub still answers.
      assert.deepEqual((await get('/__stats')).hanging, ['still-held']);
      assert.deepEqual(await raw('POST', '/__release/still-held'), {
        status: 200,
        body: { released: 1 }
      });
      await until(() => hung.ended, 'the end of the released answer');
    });

    test('a request target that is no URL is refused', async () => {
      for (const method of ['GET', 'POST']) {
        const refused = await raw(method, '//');
        assert.equal(refused.status, 400, method);
        assert.match(refused.body.error.message, /request target/, method);
      }
      assert.deepEqual(await get('/__stats'), { aborted: 0, hanging: [] });
    });

    test('a script that throws fails its own request only', async () => {
      const failed = await post({ messages: [user('e2e-script:broken')] });
      assert.equal(failed.status, 500);
      assert.equal(
        JSON.parse(failed.text).error.message,
        'The stub model failed: a bug in the script'
      );
      assert.equal(
        (await answerOf([user('still there?')])).message.content,
        'E2E reply to: still there? (turn 1)'
      );
    });

    test('a script that throws null fails its own request with HTTP 500', async () => {
      const failed = await post({ messages: [user('e2e-script:throwsNull')] });
      assert.equal(failed.status, 500);
      assert.equal(JSON.parse(failed.text).error.message, 'The stub model failed: null');
      assert.equal(
        (await answerOf([user('still there?')])).message.content,
        'E2E reply to: still there? (turn 1)'
      );
    });
  });
});

describe('e2e model stub that breaks off an answer itself', () => {
  test('does not count it as a request the caller closed', async () => {
    // A tool call the stub cannot serialise, found after the headers are out.
    const script = () => ({ content: 'x', toolCalls: [{ id: 1n, name: 'n', arguments: '{}' }] });
    const server = await startLlmStub(0, { script });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await assert.rejects(async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({ stream: true, messages: [user('hi')] })
        });
        await res.text();
      });
      const stats = await (await fetch(`${base}/__stats`)).json();
      assert.deepEqual(stats, { aborted: 0, hanging: [] });
      assert.equal((await (await fetch(`${base}/__last-request`)).json()).aborted, false);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('e2e model stub with a suite’s own script', () => {
  test('asks the script first, then the markers, then the default reply', async () => {
    const script = body =>
      body.messages.at(-1).content === 'scripted' ? { content: 'by script' } : null;
    const server = await startLlmStub(0, { script });
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const content = async text =>
      (
        await (
          await fetch(url, { method: 'POST', body: JSON.stringify({ messages: [user(text)] }) })
        ).json()
      ).choices[0].message;
    try {
      assert.equal((await content('scripted')).content, 'by script');
      assert.equal((await content('e2e-tool:lookup')).tool_calls[0].function.name, 'lookup');
      assert.equal((await content('plain')).content, 'E2E reply to: plain (turn 1)');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
