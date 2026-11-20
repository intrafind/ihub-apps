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

    await stack.healthy();
    // Whichever worker gets these turns, the one that was running beside the
    // dead one or its replacement: neither dies at the place again.
    for (const key of ['second', 'third', 'fourth']) {
      const turn = await api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"${key}"}`);
      assert.equal(turn.error, null, `the turn "${key}" ended`);
      assert.equal(turn.answer, `E2E tool result seen: {"key":"${key}","count":1}`);
    }
    assert.equal(stack.counter.snapshot().total, 4);
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
