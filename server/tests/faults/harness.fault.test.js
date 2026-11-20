// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-tests of the fault harness (`harness.mjs`, docs/run-testing.md).
 *
 * Three questions are answered here, before any feature relies on the harness:
 *
 * 1. Can the harness see a write that ran twice? The fixture server
 *    (`fixtures/journalServer.mjs`) is killed after its write and started again,
 *    once with its protection against a repeated write and once without. The
 *    counter must show 1 and 2. A harness that showed 1 both times would prove
 *    nothing about the product either.
 * 2. Does it work on the real server? A real server is killed at a named kill
 *    point with a write in flight, killed with a model call open, and started
 *    again on the same contents directory.
 * 3. Does it clean up after itself, and does every wait end? A wait has its
 *    limit also when a server takes a connection and never answers; a start
 *    that runs into its limit stops what it started; a process that ended by
 *    itself is not signalled again; a contents directory is removed, or kept
 *    with the output of its servers when the run asks for that
 *    (`KEEP_FAULT_CONTENTS=1`, as the nightly workflow does).
 *
 * What a run does after such a kill (needs attention, run again, resume) is
 * not tested here: those cases come with the features that build it.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASE_TIMEOUT_MS,
  COUNTER_READ,
  COUNTER_WRITE,
  SETUP_TIMEOUT_MS,
  TOOLS_APP,
  USER,
  leftBehind,
  removeContents,
  startFixture,
  startStack,
  until
} from './harness.mjs';
import { CONTENTS_PREFIX, SERVER_LOG, keepsContents } from './settings.mjs';

const CASE = { timeout: CASE_TIMEOUT_MS };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The contents directories of fault stacks that are in the repository right now. */
const faultContents = () =>
  new Set(fs.readdirSync(root).filter(name => name.startsWith(CONTENTS_PREFIX)));

describe('a wait of the harness', () => {
  test('ends at its limit, also when a look never returns', async () => {
    await assert.rejects(
      until(() => new Promise(() => {}), {
        what: 'an answer that never comes',
        timeoutMs: 100,
        detail: () => ' [the last output]'
      }),
      /Timed out after 100 ms waiting for an answer that never comes \[the last output\]/
    );
  });

  test('ends at its limit when the condition never holds', async () => {
    await assert.rejects(
      until(() => false, { what: 'a condition that never holds', timeoutMs: 100 }),
      /Timed out after 100 ms waiting for a condition that never holds/
    );
  });

  test('ends with the answer of the look that holds, and with the error of one that fails', async () => {
    const looks = { count: 0 };
    const third = () => {
      looks.count += 1;
      return looks.count >= 3 ? 'there' : null;
    };
    assert.equal(await until(third, { what: 'the third look' }), 'there');
    assert.equal(looks.count, 3, 'no look after the one that held');
    await assert.rejects(
      until(
        () => {
          throw new Error('the look broke');
        },
        { what: 'a look that breaks' }
      ),
      /the look broke/
    );
  });
});

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

  test('a server that ended by itself is not signalled again', CASE, async t => {
    const fixture = await startFixture({ killPoint: 'fixture-after-write' });
    // Held on an object: read in `finally`, set in the lines before it.
    const state = { stopped: false };
    try {
      // It dies at its kill point, and nobody waits for that: the harness
      // still holds the process as the server of the fixture.
      await fixture.runJob('job-1');
      await until(() => !fixture.running, {
        what: 'the fixture server to be gone',
        timeoutMs: CASE_TIMEOUT_MS
      });

      // The id of its process group is free now, and can be the id of a group
      // this harness never started. Nothing may be sent to it.
      const kill = t.mock.method(process, 'kill');
      await fixture.stop();
      state.stopped = true;
      assert.deepEqual(
        kill.mock.calls.map(call => call.arguments),
        [],
        'stopping a server that is gone sends no signal'
      );
    } finally {
      if (!state.stopped) await fixture.stop();
    }
  });

  test(
    'a server that runs is signalled as a group, by the id the harness started',
    CASE,
    async t => {
      const fixture = await startFixture();
      const state = { stopped: false };
      try {
        const kill = t.mock.method(process, 'kill');
        await fixture.stop();
        state.stopped = true;
        const sent = kill.mock.calls.map(call => call.arguments);
        assert.ok(sent.length >= 1, 'the stop sent a signal');
        const groups = new Set(sent.map(([pid]) => pid));
        assert.equal(groups.size, 1, 'to one process group');
        assert.ok([...groups][0] < 0, 'a group, not a single process');
        assert.deepEqual(sent[0][1], 'SIGKILL');
      } finally {
        if (!state.stopped) await fixture.stop();
      }
    }
  );

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

  test(
    'a frozen server takes a connection and does not answer: the wait for it ends at its limit',
    CASE,
    async () => {
      await stack.restart();
      await stack.kill('SIGSTOP');
      try {
        // The system still takes the connection for the frozen process, and no
        // answer comes. The limit of the wait holds all the same.
        await assert.rejects(
          stack.healthy({ timeoutMs: 300 }),
          /Timed out after 300 ms waiting for the server to answer \/api\/health/
        );
        assert.equal(stack.running, true, 'frozen, not gone');
      } finally {
        await stack.kill('SIGCONT');
      }
      await stack.healthy();
      const health = await (await stack.api()).get('/api/health');
      assert.equal(health.status, 200);
    }
  );

  test('a kill point of the fixture is not one the server can die at', CASE, async () => {
    await stack.restart({ killPoint: 'fixture-after-write' });
    const api = await stack.api();
    const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"other-point"}`);
    assert.equal(turn.error, null, 'the server reached no place of that name and lived');
    assert.equal(stack.counter.count('other-point'), 1);
    assert.equal(stack.running, true);
  });
});

describe('the contents directory of a stack', () => {
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
        if (!first.keepsContents) {
          assert.ok(
            leftBehind().contents.includes(first.contentsDir),
            'and a run that ends here, before that stack stopped, still removes it'
          );
        }
      } finally {
        await second?.stop();
        await first.stop();
      }
      // The run decides (KEEP_FAULT_CONTENTS=1, as in the nightly workflow): the
      // stack that made the directory removed it, or kept it with the output
      // of the servers that ran on it.
      if (first.keepsContents) {
        const log = fs.readFileSync(path.join(first.contentsPath, SERVER_LOG), 'utf8');
        assert.match(log, /\S/, 'kept, with the output of its servers');
      } else {
        assert.equal(fs.existsSync(first.contentsPath), false, 'and that stack removed it');
      }
      assert.ok(!leftBehind().contents.includes(first.contentsDir), 'nothing is left to clean up');
    }
  );

  test(
    'a stack that keeps its contents leaves the directory, with the output of its server',
    { timeout: SETUP_TIMEOUT_MS },
    async () => {
      const stack = await startStack({ keepContents: true });
      try {
        try {
          assert.equal(stack.keepsContents, true);
          assert.ok(
            !leftBehind().contents.includes(stack.contentsDir),
            'the end of the run does not remove it either'
          );
        } finally {
          await stack.stop();
        }
        const log = path.join(stack.contentsPath, SERVER_LOG);
        assert.ok(fs.existsSync(log), `${SERVER_LOG} is in the kept directory`);
        assert.match(fs.readFileSync(log, 'utf8'), /\S/, 'and holds what the server wrote');
      } finally {
        // Kept for this test. It stays only in a run that was asked to keep them.
        if (!keepsContents()) removeContents(stack.contentsDir);
      }
    }
  );

  test(
    'a stack that does not keep them removes its directory, whatever the run was asked for',
    { timeout: SETUP_TIMEOUT_MS },
    async () => {
      const stack = await startStack({ keepContents: false });
      try {
        assert.equal(stack.keepsContents, false);
        assert.ok(fs.existsSync(stack.contentsPath));
        assert.ok(leftBehind().contents.includes(stack.contentsDir));
      } finally {
        await stack.stop();
      }
      assert.equal(fs.existsSync(stack.contentsPath), false);
      assert.ok(!leftBehind().contents.includes(stack.contentsDir));
    }
  );

  test(
    'a start that runs into its limit stops what it started and leaves nothing',
    CASE,
    async () => {
      const before = { ...leftBehind(), directories: faultContents() };
      // No seed is done within this limit, on any machine.
      await assert.rejects(
        startStack({ startTimeoutMs: 10, keepContents: false }),
        /Seeding contents-e2e-faults-[0-9a-f]+ did not finish within \d+ ms/
      );
      assert.deepEqual({ ...leftBehind(), directories: faultContents() }, before);
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
