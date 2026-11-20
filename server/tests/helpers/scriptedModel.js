// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A scripted model for in-process tests: the test hands in the answer of every
 * model call, in order, and gets back a transport for an `LLMClient`.
 *
 * ```js
 * const model = scriptedModel([
 *   turn.toolCalls([{ name: 'lookup', args: { key: 'k' } }]),
 *   turn.text('done')
 * ]);
 * const { client } = makeClient({ transport: model.transport });
 * // ... run the code under test ...
 * model.assertDone();
 * ```
 *
 * A call the script has no turn for is an error of the test, not of the model:
 * the transport throws, and the test fails after it ran even when the code
 * under test caught that throw and carried on (see the end of this file).
 * `assertDone()` also fails on turns that were never asked for.
 *
 * Import this helper at the top of the test file. Under `node --test` a lazy
 * `await import()` inside a test or a `before` hook leaves no way to fail the
 * single test: the test file then fails as a whole when its process ends.
 *
 * Turns speak the OpenAI streaming wire format, the one the test client and the
 * `openai` adapter read. See docs/run-testing.md.
 *
 * @module tests/helpers/scriptedModel
 */
import { sseResponse, textResponse, jsonResponse } from '../loop/helpers/llmFixtures.js';

const encoder = new TextEncoder();

/** Thrown, and kept, when the model is called without a turn left in the script. */
export class UnscriptedModelCallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnscriptedModelCallError';
  }
}

/** Thrown, and kept, when a `turn.when` condition does not hold for the request. */
export class UnexpectedModelRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnexpectedModelRequestError';
  }
}

const delta = (fields, finishReason = null) => ({
  choices: [{ index: 0, delta: fields, finish_reason: finishReason }]
});

function textEvents(deltas, { usage, finishReason = 'stop' } = {}) {
  return [
    delta({ role: 'assistant', content: '' }),
    ...deltas.filter(d => d !== '').map(d => delta({ content: d })),
    { ...delta({}, finishReason), ...(usage ? { usage } : {}) },
    '[DONE]'
  ];
}

function toolCallEvents(calls, { content = '', usage } = {}) {
  return [
    delta({
      role: 'assistant',
      ...(content ? { content } : {}),
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id || `call_${index + 1}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
      }))
    }),
    { ...delta({}, 'tool_calls'), ...(usage ? { usage } : {}) },
    '[DONE]'
  ];
}

const sseLine = event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`;

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * The turns a script is made of. Each one answers one model call.
 */
export const turn = {
  /**
   * A text answer.
   *
   * @param {string|string[]} text - The answer, or its deltas.
   * @param {Object} [options]
   * @param {Object} [options.usage] - Token usage on the last chunk (OpenAI shape).
   * @param {string} [options.finishReason='stop']
   */
  text(text, options = {}) {
    const deltas = Array.isArray(text) ? text : [text];
    return { kind: 'text', respond: () => sseResponse(textEvents(deltas, options)) };
  },

  /**
   * One or more tool calls in one answer.
   *
   * @param {Array<{name: string, args?: Object, id?: string}>} calls - `id` defaults to `call_<n>`.
   * @param {Object} [options]
   * @param {string} [options.content] - Text the model says before the calls.
   * @param {Object} [options.usage]
   */
  toolCalls(calls, options = {}) {
    return { kind: 'toolCalls', respond: () => sseResponse(toolCallEvents(calls, options)) };
  },

  /**
   * An HTTP error from the provider.
   *
   * @param {number} status
   * @param {string|Object} [body] - An object is sent as JSON.
   * @param {Object} [options]
   * @param {Object} [options.headers]
   */
  error(status, body = '', { headers } = {}) {
    return {
      kind: 'error',
      respond: () =>
        typeof body === 'string'
          ? textResponse(body, { status, headers })
          : jsonResponse(body, { status, headers })
    };
  },

  /**
   * A call that never answers. It ends when the caller aborts (Stop, a
   * deadline), with the abort's own reason. For cancel and time limit tests;
   * `model.waitForCall(n)` tells the test that the call has arrived.
   */
  hang() {
    return {
      kind: 'hang',
      respond: (_request, ctx) =>
        new Promise((_resolve, reject) => {
          const signal = ctx?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(abortError(signal));
            return;
          }
          signal.addEventListener('abort', () => reject(abortError(signal)), { once: true });
        })
    };
  },

  /**
   * A text answer whose deltas arrive one timer apart. The timer comes from the
   * clock the test passes (`helpers/fakeClock.js`), so the test decides when
   * each delta arrives and no real time passes.
   *
   * @param {string[]} deltas
   * @param {Object} options
   * @param {{setTimer: Function}} options.clock
   * @param {number} [options.intervalMs=1000] - Time between two deltas.
   * @param {Object} [options.usage]
   * @param {string} [options.finishReason='stop']
   */
  slow(deltas, { clock, intervalMs = 1000, usage, finishReason } = {}) {
    if (!clock || typeof clock.setTimer !== 'function') {
      throw new TypeError(
        'turn.slow needs a clock with setTimer(fn, ms), see helpers/fakeClock.js'
      );
    }
    return {
      kind: 'slow',
      respond: (_request, ctx) => {
        const [head, ...rest] = textEvents(deltas, { usage, finishReason });
        const signal = ctx?.signal;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseLine(head)));
            let closed = false;
            const fail = () => {
              if (closed) return;
              closed = true;
              controller.error(abortError(signal));
            };
            signal?.addEventListener('abort', fail, { once: true });
            const next = index => {
              if (closed) return;
              if (index >= rest.length) {
                closed = true;
                controller.close();
                return;
              }
              const event = rest[index];
              // The deltas wait for the clock; the closing chunks follow the last delta at once.
              const isDelta = typeof event === 'object' && event.choices?.[0]?.delta?.content;
              const send = () => {
                if (closed) return;
                controller.enqueue(encoder.encode(sseLine(event)));
                next(index + 1);
              };
              if (isDelta) clock.setTimer(send, intervalMs);
              else send();
            };
            next(0);
          }
        });
        return {
          ok: true,
          status: 200,
          statusText: '200',
          headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
          body,
          text: async () => '',
          json: async () => ({})
        };
      }
    };
  },

  /**
   * Check the request before answering it. When `predicate` returns false or
   * throws, the call fails like an unscripted one: the transport throws and the
   * test fails.
   *
   * @param {(request: Object, call: number) => boolean|void} predicate - Returning nothing counts as true,
   *   so the predicate can use assertions.
   * @param {Object|Array} inner - The turn that answers when the request is as expected.
   * @param {string} [label] - Names the expectation in the failure.
   */
  when(predicate, inner, label = 'the request is as expected') {
    return { kind: 'when', predicate, inner: asTurn(inner), label };
  },

  /**
   * Streamed events as they are, for a wire detail the other turns do not
   * produce. An array in a script means the same.
   *
   * @param {Array<Object|string>} events - See `sseResponse` in `loop/helpers/llmFixtures.js`.
   */
  raw(events) {
    return { kind: 'raw', respond: () => sseResponse(events) };
  }
};

function asTurn(entry) {
  if (Array.isArray(entry)) return turn.raw(entry);
  if (typeof entry === 'function') return { kind: 'function', respond: entry };
  if (entry && typeof entry === 'object' && typeof entry.kind === 'string') return entry;
  throw new TypeError(
    'A script entry is a turn (turn.text, turn.toolCalls, ...), an array of streamed events, or a function'
  );
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** A frozen copy, so a later change by the code under test cannot rewrite what was sent. */
function snapshot(request) {
  try {
    return deepFreeze(structuredClone(request));
  } catch {
    return request;
  }
}

/** Unscripted calls of strict models that no `assertDone()` has reported yet. */
const unreported = new Set();
/** The ones of them handed to jest, which fails the running test with them when it ends. */
const handedToJest = new Set();

/**
 * The state of jest's `expect` when this is jest and it takes errors for the
 * running test, else null.
 *
 * jest adds the errors in `suppressedErrors` to the test that ends next. That
 * does not depend on a hook, so it also works when this helper was first
 * imported inside a test or a `beforeAll`: there jest refuses a new hook
 * ("Cannot add a hook after tests have started running").
 */
function jestState() {
  const state = globalThis.expect?.getState?.();
  return Array.isArray(state?.suppressedErrors) ? state : null;
}

/** Make sure an unscripted call of a strict model fails something, whatever the code under test does. */
function reportLater(error) {
  const state = jestState();
  if (!state) {
    unreported.add(error);
    return;
  }
  // What jest no longer holds belongs to a test that has ended.
  for (const earlier of handedToJest) {
    if (!state.suppressedErrors.includes(earlier)) handedToJest.delete(earlier);
  }
  handedToJest.add(error);
  globalThis.expect.setState({ suppressedErrors: [...state.suppressedErrors, error] });
}

/** Take errors back that are reported another way (`assertDone()` throws them itself). */
function reported(errors) {
  const taken = [];
  const fromJest = [];
  for (const error of errors) {
    if (unreported.delete(error)) taken.push(error);
    else if (handedToJest.delete(error)) fromJest.push(error);
  }
  const state = fromJest.length > 0 ? jestState() : null;
  if (state) {
    globalThis.expect.setState({
      suppressedErrors: state.suppressedErrors.filter(error => !fromJest.includes(error))
    });
  }
  return [...taken, ...fromJest];
}

/**
 * Build a scripted model.
 *
 * @param {Array} turns - One entry per model call: a turn, an array of streamed
 *   events, or a function `(request, ctx) => Response`.
 * @param {Object} [options]
 * @param {boolean} [options.strict=true] - Fail the running test on a call without a turn. With `false` the
 *   transport still throws, and whether the test fails is up to the code under test (how
 *   `scheduledTaskHarness.scriptedChatService` has always behaved).
 * @param {(request: Object, ctx: Object) => Promise<void>|void} [options.onRequest] - Runs before each scripted
 *   call is answered.
 * @param {(request: Object, ctx: Object) => Promise<Object|undefined>|Object|undefined} [options.intercept] -
 *   Answers a call outside the script (a helper call such as the notes composer of a scheduled task).
 *   Return a response to answer it; such a call is neither recorded nor counted. Return nothing to let
 *   the script answer.
 * @param {boolean} [options.freezeRequests=true] - Record a frozen copy of each request (false: the object itself).
 * @returns {{transport: Function, requests: Object[], calls: number, remaining: number,
 *   unscripted: Error[], waitForCall: (n: number) => Promise<Object>, assertDone: () => void}}
 */
export function scriptedModel(
  turns = [],
  { strict = true, onRequest, intercept, freezeRequests = true } = {}
) {
  const queue = turns.map(asTurn);
  const requests = [];
  const unscripted = [];
  const waiters = [];

  const fail = error => {
    unscripted.push(error);
    if (strict) reportLater(error);
    return error;
  };

  const model = {
    requests,
    unscripted,
    get calls() {
      return requests.length;
    },
    get remaining() {
      return queue.length;
    },

    /**
     * The transport of an `LLMClient` (`makeClient({ transport })`, or
     * `llmClient.transport = model.transport`).
     */
    async transport(request, ctx) {
      if (intercept) {
        const answered = await intercept(request, ctx);
        if (answered !== undefined) return answered;
      }
      requests.push(freezeRequests ? snapshot(request) : request);
      const call = requests.length;
      for (const waiter of waiters.splice(0)) {
        if (waiter.call <= call) waiter.resolve(requests[waiter.call - 1]);
        else waiters.push(waiter);
      }
      await onRequest?.(request, ctx);
      let next = queue.shift();
      if (!next) {
        throw fail(new UnscriptedModelCallError(`script exhausted after ${call} calls`));
      }
      while (next.kind === 'when') {
        let holds;
        let cause;
        try {
          holds = next.predicate(request, call) !== false;
        } catch (error) {
          holds = false;
          cause = error;
        }
        if (!holds) {
          const error = new UnexpectedModelRequestError(
            `model call ${call}: expected that ${next.label}` + (cause ? `: ${cause.message}` : '')
          );
          if (cause) error.cause = cause;
          throw fail(error);
        }
        next = next.inner;
      }
      return next.respond(request, ctx);
    },

    /**
     * Resolves with the request of the n-th scripted call once it has arrived
     * (at once when it already has). Lets a test wait for a `turn.hang()`
     * without a sleep.
     *
     * @param {number} n - 1 for the first call.
     * @returns {Promise<Object>}
     */
    waitForCall(n) {
      if (requests.length >= n) return Promise.resolve(requests[n - 1]);
      return new Promise(resolve => waiters.push({ call: n, resolve }));
    },

    /**
     * Fail unless the script was used exactly: no call without a turn, no
     * request a `turn.when` rejected, no turn left over.
     */
    assertDone() {
      reported(unscripted);
      if (unscripted.length > 0) throw unscripted[0];
      if (queue.length > 0) {
        throw new Error(
          `the script has ${queue.length} unused turn(s) after ${requests.length} call(s): ` +
            queue.map(entry => entry.kind).join(', ')
        );
      }
    }
  };
  model.transport = model.transport.bind(model);
  return model;
}

/**
 * Report, once, the unscripted calls no `assertDone()` has reported. The hook
 * below calls it after every test; a test of this helper calls it to keep an
 * intended violation from failing itself.
 *
 * @returns {Error[]}
 */
export function takeUnreportedModelCalls() {
  return reported([...unreported, ...handedToJest]);
}

// A call without a turn must fail the test that made it, also when the code
// under test turned the throw into an error answer and the test asserted on
// something else. How that is done depends on the runner:
//
// - jest: the error is handed to jest (`reportLater`), which fails the running
//   test with it when the test ends. This works wherever the helper was
//   imported.
// - `node --test`: a hook after each test throws the error. The hook needs
//   this helper to be imported at the top of the test file: registered while a
//   test or a `before` hook is running (a lazy `await import()`), it is
//   accepted and never run.
// - `node --test` with such a late import, and a plain script: what is still
//   unreported when the process ends fails the process. The test file is red
//   and the message names the call. `node:test` has no way to fail a running
//   test from outside it, so here the file fails, not the single test.
const failOnUnreported = () => {
  const [first] = reported([...unreported]);
  if (first) throw first;
};
const underJest = typeof globalThis.expect?.getState === 'function';
const underNodeTest =
  !underJest &&
  (Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes('--test') ||
    /\.test\.[cm]?js$/.test(process.argv[1] || ''));
if (underJest) {
  // A jest that does not take errors this way gets the hook instead, as far as it still can.
  if (!jestState() && typeof globalThis.afterEach === 'function') {
    globalThis.afterEach(failOnUnreported);
  }
} else {
  // A plain script (no test runner) gets no hook: there `node:test` would start
  // a runner of its own and print its summary.
  if (underNodeTest) {
    const { afterEach } = await import('node:test');
    afterEach(failOnUnreported);
  }
  process.once('exit', () => {
    if (unreported.size === 0) return;
    const [first] = unreported;
    console.error(
      `[scriptedModel] ${unreported.size} model call(s) without a turn were reported by no test. ` +
        `The first: ${first.message}\n` +
        'The hook that fails the test that made such a call did not run. Import ' +
        'helpers/scriptedModel.js at the top of the test file, not inside a test or a before ' +
        'hook, or call model.assertDone() in the test.'
    );
    if (!process.exitCode) process.exitCode = 1;
  });
}
