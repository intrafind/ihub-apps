// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-tests of the fault harness (`harness.mjs`, docs/run-testing.md).
 *
 * Two questions are answered here, before any feature relies on the harness:
 *
 * 1. Can the harness see a write that ran twice? The fixture server
 *    (`fixtures/journalServer.mjs`) is killed after its write and started again,
 *    once with its protection against a repeated write and once without. The
 *    counter must show 1 and 2. A harness that showed 1 both times would prove
 *    nothing about the product either.
 * 2. Does it work on the real server? A real server is killed at a named kill
 *    point with a write in flight, killed with a model call open, and started
 *    again on the same contents directory.
 *
 * What a run does after such a kill (needs attention, run again, resume) is
 * not tested here: those cases come with the features that build it.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CASE_TIMEOUT_MS,
  COUNTER_READ,
  COUNTER_WRITE,
  SETUP_TIMEOUT_MS,
  TOOLS_APP,
  USER,
  startFixture,
  startStack
} from './harness.mjs';

const CASE = { timeout: CASE_TIMEOUT_MS };

describe('the fixture server: the harness sees a double write', () => {
  test('with the protection, a job killed after its write is not written again', CASE, async () => {
    const fixture = await startFixture({ killPoint: 'fixture-after-write' });
    try {
      const ran = await fixture.runJob('job-1');
      const exit = await fixture.waitKilledAt('fixture-after-write');
      assert.equal(exit.signal, 'SIGKILL');
      assert.equal(ran.status, 0, 'the server died before it answered');
      assert.equal(fixture.counter.count('job-1'), 1);

      await fixture.restart();
      assert.deepEqual(await fixture.job('job-1'), { id: 'job-1', state: 'needs-attention' });
      assert.equal(fixture.counter.count('job-1'), 1, 'the write was not repeated');
    } finally {
      await fixture.stop();
    }
  });

  test('without the protection, the same kill shows a counter of 2', CASE, async () => {
    const fixture = await startFixture({ guard: false, killPoint: 'fixture-after-write' });
    try {
      await fixture.runJob('job-1');
      await fixture.waitKilledAt('fixture-after-write');
      assert.equal(fixture.counter.count('job-1'), 1);

      await fixture.restart();
      assert.deepEqual(await fixture.job('job-1'), { id: 'job-1', state: 'write-done' });
      assert.equal(
        fixture.counter.count('job-1'),
        2,
        'the restart repeated the write, and the counter in the harness shows it'
      );
    } finally {
      await fixture.stop();
    }
  });

  test('killed before the write, the repeated write is the only one', CASE, async () => {
    const fixture = await startFixture({ guard: false, killPoint: 'fixture-before-write' });
    try {
      await fixture.runJob('job-1');
      await fixture.waitKilledAt('fixture-before-write');
      assert.equal(fixture.counter.count('job-1'), 0, 'nothing was written when it died');

      await fixture.restart();
      assert.equal(fixture.counter.count('job-1'), 1);
    } finally {
      await fixture.stop();
    }
  });

  test('"<name>@2" lets the first pass and kills at the second', CASE, async () => {
    const fixture = await startFixture({ killPoint: 'fixture-after-write@2' });
    try {
      const first = await fixture.runJob('job-1');
      assert.deepEqual(first.body, { id: 'job-1', state: 'write-done' });

      await fixture.runJob('job-2');
      await fixture.waitKilledAt('fixture-after-write');
      assert.deepEqual(fixture.counter.snapshot(), {
        total: 2,
        counters: { 'job-1': { count: 1, values: [] }, 'job-2': { count: 1, values: [] } }
      });
    } finally {
      await fixture.stop();
    }
  });

  test('a server that is started again without a kill point is not killed', CASE, async () => {
    const fixture = await startFixture({ killPoint: 'fixture-after-write' });
    try {
      await fixture.runJob('job-1');
      await fixture.waitKilledAt('fixture-after-write');
      await fixture.restart();
      const second = await fixture.runJob('job-2');
      assert.deepEqual(second.body, { id: 'job-2', state: 'write-done' });
      await assert.rejects(
        fixture.waitKilledAt('fixture-after-write'),
        /started without a kill point/
      );
    } finally {
      await fixture.stop();
    }
  });

  test('a kill point that KILLPOINTS.md does not list is refused', CASE, async () => {
    await assert.rejects(
      startFixture({ killPoint: 'no-such-kill-point' }),
      /Unknown kill point "no-such-kill-point"/
    );
  });
});

describe('a real server', () => {
  /** @type {Awaited<ReturnType<typeof startStack>>} */
  let stack;

  before(
    async () => {
      stack = await startStack();
    },
    { timeout: SETUP_TIMEOUT_MS }
  );
  after(async () => {
    await stack?.stop();
  });

  test('a write tool call is counted once, in the harness', CASE, async () => {
    const api = await stack.api();
    const turn = await api.chatTurn(
      TOOLS_APP,
      `e2e-tool:${COUNTER_WRITE}:{"key":"plain","value":"first"}`
    );
    assert.equal(turn.status, 200);
    assert.equal(turn.error, null);
    assert.equal(turn.answer, 'E2E tool result seen: {"key":"plain","count":1}');
    assert.deepEqual(stack.counter.read('plain'), { key: 'plain', count: 1, values: ['first'] });

    // The model was offered both test tools, and got the result of the call.
    const requests = await stack.stub.requests(`${COUNTER_WRITE}:{"key":"plain"`);
    const offered = requests[0].tools.map(tool => tool.function.name);
    assert.ok(offered.includes(COUNTER_WRITE) && offered.includes(COUNTER_READ), offered.join());
    assert.deepEqual(
      requests.map(body => body.messages.at(-1).role),
      ['user', 'tool']
    );
  });

  test('the read tool returns what was written, for a regular user too', CASE, async () => {
    stack.counter.write('outside', 'A text from outside iHub.');
    const api = await stack.api(USER);
    const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_READ}:{"key":"outside"}`);
    assert.equal(turn.status, 200);
    const requests = await stack.stub.requests(`${COUNTER_READ}:{"key":"outside"}`);
    assert.deepEqual(JSON.parse(requests.at(-1).messages.at(-1).content), {
      key: 'outside',
      count: 1,
      values: ['A text from outside iHub.']
    });
    assert.equal(stack.counter.count('outside'), 1, 'a read does not count');
  });

  test(
    'the server dies at a kill point with a write in flight; the restart does not repeat the write',
    CASE,
    async () => {
      await stack.restart({ killPoint: 'e2e-counter-after-write' });
      const api = await stack.api();
      const chatId = 'fault-write-in-flight';
      const dying = api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"in-flight"}`, {
        chatId
      });

      const exit = await stack.waitKilledAt('e2e-counter-after-write');
      assert.equal(exit.signal, 'SIGKILL');
      assert.equal(stack.running, false);
      assert.equal(stack.counter.count('in-flight'), 1, 'the write happened before the kill');

      const turn = await dying;
      assert.ok(turn.error, 'the stream of the turn broke when the server died');
      assert.ok(
        turn.frames.some(frame => frame.type === 'tool/started'),
        'the tool call had started'
      );
      assert.ok(
        !turn.frames.some(frame => frame.type === 'tool/completed'),
        'and its result was never sent'
      );

      await stack.restart();
      // The session outlives the server: the same client reads the chat.
      const chat = await stack.readChat(chatId, api);
      assert.equal(chat.status, 200);
      assert.deepEqual(
        chat.body.messages.map(message => message.role),
        ['user'],
        'the question is stored once and no answer was made up'
      );
      assert.equal(stack.counter.count('in-flight'), 1, 'starting again did not repeat the write');
      // One model call asked for the tool; the new server made none for this chat.
      assert.equal((await stack.stub.requests(`${COUNTER_WRITE}:{"key":"in-flight"}`)).length, 1);
    }
  );

  test('the server dies before the write: nothing was written', CASE, async () => {
    await stack.restart({ killPoint: 'e2e-counter-before-write' });
    const api = await stack.api();
    const dying = api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"never"}`);
    await stack.waitKilledAt('e2e-counter-before-write');
    await dying;
    assert.equal(stack.counter.count('never'), 0);
    await stack.restart();
    assert.equal(stack.counter.count('never'), 0);
  });

  test('killed with a model call open, it starts again on the same contents', CASE, async () => {
    await stack.restart();
    const api = await stack.api();
    const chatId = 'fault-model-call-open';
    const dying = api.chatTurn(TOOLS_APP, 'e2e-hang:fault-open-call', { chatId });
    await stack.stub.hanging('fault-open-call');

    await stack.kill('SIGKILL');
    assert.equal(stack.running, false);
    const turn = await dying;
    assert.ok(turn.error, 'the stream of the turn broke when the server died');

    const startsBefore = stack.starts;
    await stack.restart();
    assert.equal(stack.starts, startsBefore + 1);
    const chat = await stack.readChat(chatId, api);
    assert.equal(chat.status, 200);
    assert.deepEqual(
      chat.body.messages.map(message => message.content),
      ['e2e-hang:fault-open-call']
    );
    // The stub lives in this process: it still knows the one call it got.
    assert.equal((await stack.stub.requests('e2e-hang:fault-open-call')).length, 1);
  });

  test('SIGTERM stops the server, and it starts again', CASE, async () => {
    await stack.restart();
    await stack.kill('SIGTERM');
    assert.equal(stack.running, false);
    await stack.restart();
    const health = await (await stack.api()).get('/api/health');
    assert.equal(health.status, 200);
  });

  test('a kill point of the fixture is not one the server can die at', CASE, async () => {
    await stack.restart({ killPoint: 'fixture-after-write' });
    const api = await stack.api();
    const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"other-point"}`);
    assert.equal(turn.error, null, 'the server reached no place of that name and lived');
    assert.equal(stack.counter.count('other-point'), 1);
    assert.equal(stack.running, true);
  });
});

describe('a contents directory that another stack left', () => {
  test(
    'a second stack starts on it with its own model stub and counter, and leaves it in place',
    { timeout: SETUP_TIMEOUT_MS },
    async () => {
      const first = await startStack();
      /** @type {Awaited<ReturnType<typeof startStack>>|undefined} */
      let second;
      try {
        const chatId = 'fault-left-behind';
        const before = await (
          await first.api()
        ).chatTurn(TOOLS_APP, 'What is left behind?', {
          chatId
        });
        assert.equal(before.error, null);
        assert.equal(before.answer, 'E2E reply to: What is left behind? (turn 1)');
        await first.kill('SIGKILL');

        // A seed is for a fresh directory: this one is taken as it is.
        await assert.rejects(
          startStack({ contents: first.contentsDir, seed: { features: { workflows: true } } }),
          /`seed` is for a fresh contents directory/
        );
        second = await startStack({ contents: first.contentsDir });
        assert.equal(second.contentsPath, first.contentsPath);
        const api = await second.api();
        const chat = await second.readChat(chatId, api);
        assert.equal(chat.status, 200);
        assert.deepEqual(
          chat.body.messages.map(message => message.role),
          ['user', 'assistant'],
          'the chat of the first stack is there'
        );

        // The models of the directory now name the stub of the second stack.
        const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"second"}`);
        assert.equal(turn.error, null);
        assert.equal(turn.answer, 'E2E tool result seen: {"key":"second","count":1}');
        assert.equal(second.counter.count('second'), 1);
        assert.equal(first.counter.count('second'), 0);
        assert.equal((await second.stub.requests(`${COUNTER_WRITE}:{"key":"second"}`)).length, 2);
        assert.equal((await first.stub.requests(`${COUNTER_WRITE}:{"key":"second"}`)).length, 0);

        await second.stop();
        second = undefined;
        assert.ok(
          fs.existsSync(first.contentsPath),
          'the directory belongs to the stack that made it'
        );
      } finally {
        await second?.stop();
        await first.stop();
      }
      assert.equal(fs.existsSync(first.contentsPath), false, 'and that stack removed it');
    }
  );

  test('a directory that is not there, or one that is not disposable, is refused', async () => {
    await assert.rejects(
      startStack({ contents: 'contents-e2e-faults-never-made' }),
      /is not a contents directory a stack left/
    );
    await assert.rejects(startStack({ contents: 'contents' }), /contents-e2e/);
  });
});
