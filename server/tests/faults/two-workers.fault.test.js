// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-test of the fault harness with two workers (`startStack({ workers: 2 })`):
 * a primary and two worker processes on one contents directory.
 *
 * A kill point then ends one worker, not the server: the primary starts another
 * worker, and the server keeps answering. The kill point fires once. Neither the
 * new worker nor the one that was running beside it dies at the same place
 * again, although all of them were started with the same environment.
 *
 * "Neither" is shown, not assumed: every write of the counter tool names the
 * process it came from, and the test goes on until two processes other than
 * the dead one wrote. Each of those turns has a connection of its own: turns
 * that share one stay with the worker that took it, and the replacement
 * worker takes connections only once it has started.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_TIMEOUT_MS,
  COUNTER_WRITE,
  SETUP_TIMEOUT_MS,
  TOOLS_APP,
  startStack,
  until
} from './harness.mjs';

const CASE = { timeout: CASE_TIMEOUT_MS };

/** How long the replacement worker may take until it wrote, too. */
const BOTH_WORKERS_TIMEOUT_MS = 60_000;
/** How many more turns show that the same two workers are still the ones that answer. */
const ONCE_MORE = 4;

describe('a real server with two workers', () => {
  /** @type {Awaited<ReturnType<typeof startStack>>} */
  let stack;

  before(
    async () => {
      stack = await startStack({ workers: 2, killPoint: 'e2e-counter-after-write' });
    },
    { timeout: SETUP_TIMEOUT_MS }
  );
  after(async () => {
    await stack?.stop();
  });

  test('a kill point ends one worker once; the server keeps answering', CASE, async () => {
    const api = await stack.api();
    const dying = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"first"}`);
    assert.equal(await stack.waitKilledAt('e2e-counter-after-write'), null);
    assert.ok(dying.error, 'the turn on the worker that died broke');
    assert.equal(stack.counter.count('first'), 1);
    assert.equal(stack.running, true, 'the primary lives');

    const [dead] = stack.counter.writers('first');
    assert.match(dead, /^\d+$/, 'the write names the worker that made it');

    await stack.healthy();
    const sent = { turns: 0 };
    /** One turn on a connection of its own: it ends, wrote once, and says which worker wrote. */
    const writerOfNextTurn = async () => {
      sent.turns += 1;
      const key = `after-${sent.turns}`;
      const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"${key}"}`, {
        ownConnection: true
      });
      assert.equal(turn.error, null, `the turn "${key}" ended`);
      assert.equal(turn.answer, `E2E tool result seen: {"key":"${key}","count":1}`);
      const writers = stack.counter.writers(key);
      assert.equal(writers.length, 1, `one write for "${key}"`);
      return writers[0];
    };

    // Both workers reach the place: the one that ran beside the dead one (it
    // was armed when it started) and the replacement (it found the kill point
    // fired when it started). Neither dies there. The replacement takes a
    // while to start; until then every turn goes to the other worker.
    const wrote = new Set();
    await until(
      async () => {
        wrote.add(await writerOfNextTurn());
        return wrote.size >= 2;
      },
      {
        what: 'a write of each of the two workers after the kill',
        timeoutMs: BOTH_WORKERS_TIMEOUT_MS,
        detail: () =>
          ` (${sent.turns} turns, written by ${[...wrote].join(', ')})${stack.logTail()}`
      }
    );
    assert.ok(!wrote.has(dead), 'neither of the two is the worker that died');

    // They are still the same two: no worker died and was replaced since.
    for (let turn = 0; turn < ONCE_MORE; turn += 1) {
      const writer = await writerOfNextTurn();
      assert.ok(wrote.has(writer), `${writer} is one of ${[...wrote].join(', ')}`);
    }
    assert.deepEqual(
      stack.killPointHits(),
      ['e2e-counter-after-write'],
      'the kill point fired once for the whole stack'
    );
    assert.equal(stack.counter.snapshot().total, 1 + sent.turns);
    assert.equal(stack.running, true);
  });

  test('a kill ends the primary and both workers at once', CASE, async () => {
    await stack.kill('SIGKILL');
    assert.equal(stack.running, false);
    // No worker is left that answers on the port.
    await until(
      async () => {
        try {
          await fetch(`${stack.url}/api/health`);
          return false;
        } catch {
          return true;
        }
      },
      { what: 'the port of the server to be closed', timeoutMs: CASE_TIMEOUT_MS }
    );

    await stack.restart();
    const api = await stack.api();
    const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"after"}`);
    assert.equal(turn.error, null);
    assert.equal(stack.counter.count('after'), 1);
  });
});
