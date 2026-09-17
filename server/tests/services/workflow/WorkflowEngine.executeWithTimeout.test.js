/**
 * WorkflowEngine._executeWithTimeout tests.
 *
 * Covers the rewrite away from the `new Promise(async (resolve, reject) => ...)`
 * anti-pattern: a synchronous throw before the first await must still reject,
 * and the AbortSignal passed to `fn` must actually fire on timeout and on an
 * outer (workflow-level cancellation) signal.
 */

import { jest } from '@jest/globals';
import { WorkflowEngine } from '../../../services/workflow/WorkflowEngine.js';

function createEngine() {
  // Stub out the heavy collaborators — none of them are touched by
  // _executeWithTimeout, which is a pure timing/abort helper.
  return new WorkflowEngine({ stateManager: {}, scheduler: {} });
}

describe('WorkflowEngine._executeWithTimeout', () => {
  test('resolves normally when fn completes before the timeout', async () => {
    const engine = createEngine();
    const result = await engine._executeWithTimeout(
      () => Promise.resolve('done'),
      1000,
      'timed out'
    );
    expect(result).toBe('done');
  });

  test('rejects with NODE_TIMEOUT when fn exceeds the timeout, aborting the passed signal', async () => {
    const engine = createEngine();
    let receivedSignal;
    const fn = signal =>
      new Promise((resolve, reject) => {
        receivedSignal = signal;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });

    await expect(engine._executeWithTimeout(fn, 20, 'timed out after 20ms')).rejects.toMatchObject({
      code: 'NODE_TIMEOUT',
      message: 'timed out after 20ms'
    });
    expect(receivedSignal.aborted).toBe(true);
  });

  test('a synchronous throw inside fn before its first await rejects correctly', async () => {
    const engine = createEngine();
    const fn = () => {
      throw new Error('boom');
    };

    await expect(engine._executeWithTimeout(fn, 1000, 'timed out')).rejects.toThrow('boom');
  });

  test('a pre-aborted outer signal is propagated to fn immediately', async () => {
    jest.useFakeTimers();
    try {
      const engine = createEngine();
      const outerController = new AbortController();
      outerController.abort();

      let receivedSignal;
      const fn = signal => {
        receivedSignal = signal;
        return new Promise(() => {});
      };

      // Fire-and-forget: fn never settles, so just assert on the signal
      // state rather than awaiting the (intentionally never-resolving)
      // call. The no-op catch avoids an unhandled rejection once
      // clearAllTimers below fires the still-pending timeout.
      engine._executeWithTimeout(fn, 1000, 'timed out', outerController.signal).catch(() => {});
      await Promise.resolve();

      expect(receivedSignal.aborted).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('an outer signal aborting mid-flight propagates to fn', async () => {
    jest.useFakeTimers();
    try {
      const engine = createEngine();
      const outerController = new AbortController();

      let receivedSignal;
      const fn = signal => {
        receivedSignal = signal;
        return new Promise(() => {});
      };

      // No-op catch: prevents the still-pending timeout (cleared below)
      // from surfacing as an unhandled rejection.
      engine._executeWithTimeout(fn, 1000, 'timed out', outerController.signal).catch(() => {});
      await Promise.resolve();
      expect(receivedSignal.aborted).toBe(false);

      outerController.abort();
      expect(receivedSignal.aborted).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('clears the timeout timer once fn settles, leaving no dangling timer', async () => {
    jest.useFakeTimers();
    try {
      const engine = createEngine();
      let resolveFn;
      const fn = () => new Promise(resolve => (resolveFn = resolve));

      const promise = engine._executeWithTimeout(fn, 1000, 'timed out');
      expect(jest.getTimerCount()).toBe(1);

      resolveFn('ok');
      await promise;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
