#!/usr/bin/env node

/**
 * Tests for transient-error retry in WorkflowLLMHelper.
 *
 * Motivation: a single transient HTTP 503 from Google on one sub-task killed an
 * entire multi-round agent run (the whole sub-workflow was discarded). Agent /
 * workflow LLM calls all funnel through WorkflowLLMHelper.executeStreamingRequest,
 * so retry-with-backoff for transient errors (503/5xx/429/network) belongs there.
 *
 * These cover the pure, easily-isolated pieces:
 *   - isTransientHttpStatus / isTransientLlmError  (what to retry)
 *   - parseRetryAfterMs                            (honor server-instructed delay)
 *   - computeRetryDelayMs                          (exponential backoff + cap + Retry-After)
 *   - WorkflowLLMHelper._runWithRetries            (the generic loop)
 *
 * Run directly: `node server/tests/workflow-llm-retry.test.js`.
 */

import {
  WorkflowLLMHelper,
  isTransientHttpStatus,
  isTransientLlmError,
  parseRetryAfterMs,
  computeRetryDelayMs
} from '../services/workflow/WorkflowLLMHelper.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 isTransientHttpStatus — only 429 and 5xx are transient\n');
{
  check('503 is transient', isTransientHttpStatus(503) === true);
  check('500 is transient', isTransientHttpStatus(500) === true);
  check('502 is transient', isTransientHttpStatus(502) === true);
  check('504 is transient', isTransientHttpStatus(504) === true);
  check('429 is transient', isTransientHttpStatus(429) === true);
  check('400 is NOT transient', isTransientHttpStatus(400) === false);
  check('401 is NOT transient', isTransientHttpStatus(401) === false);
  check('404 is NOT transient', isTransientHttpStatus(404) === false);
  check('200 is NOT transient', isTransientHttpStatus(200) === false);
}

console.log('\n🧪 isTransientLlmError — classified HTTP errors + network faults\n');
{
  check('503 error retryable', isTransientLlmError({ status: 503 }) === true);
  check('429 error retryable', isTransientLlmError({ status: 429 }) === true);
  check('400 error NOT retryable', isTransientLlmError({ status: 400 }) === false);
  check('ECONNRESET network error retryable', isTransientLlmError({ code: 'ECONNRESET' }) === true);
  check(
    "'fetch failed' network error retryable",
    isTransientLlmError({ message: 'fetch failed' }) === true
  );
  check('plain logic error NOT retryable', isTransientLlmError({ message: 'boom' }) === false);
  check('null NOT retryable', isTransientLlmError(null) === false);
  // #1683: a deliberate cancellation (engine.cancel() / node timeout) must
  // never be retried — it would just re-fire the same AbortError and burn the
  // retry budget on a request nobody wants completed anymore. node-fetch/DOM
  // AbortController name these errors 'AbortError', and the message often
  // contains "aborted" — which, without the explicit name/code check, would
  // otherwise match the NETWORK_ERROR_MESSAGES regex below and be retried.
  check(
    "AbortError (by .name) NOT retryable even though its message contains 'aborted'",
    isTransientLlmError({ name: 'AbortError', message: 'The operation was aborted' }) === false
  );
  check(
    'AbortError (by .code) NOT retryable',
    isTransientLlmError({ code: 'ABORT_ERR', message: 'This operation was aborted' }) === false
  );
}

console.log('\n🧪 parseRetryAfterMs — seconds, zero, garbage\n');
{
  check("'5' → 5000ms", parseRetryAfterMs('5') === 5000);
  check("'0' → 0ms", parseRetryAfterMs('0') === 0);
  check('null → null', parseRetryAfterMs(null) === null);
  check("'soon' → null", parseRetryAfterMs('soon') === null);
}

console.log('\n🧪 computeRetryDelayMs — exponential, capped, Retry-After wins\n');
{
  const noJitter = () => 0;
  check(
    'attempt 0 → 1000ms (base)',
    computeRetryDelayMs(0, { baseMs: 1000, capMs: 15000, jitter: noJitter }) === 1000
  );
  check(
    'attempt 1 → 2000ms',
    computeRetryDelayMs(1, { baseMs: 1000, capMs: 15000, jitter: noJitter }) === 2000
  );
  check(
    'attempt 2 → 4000ms',
    computeRetryDelayMs(2, { baseMs: 1000, capMs: 15000, jitter: noJitter }) === 4000
  );
  check(
    'large attempt capped at 15000ms',
    computeRetryDelayMs(10, { baseMs: 1000, capMs: 15000, jitter: noJitter }) === 15000
  );
  check(
    'Retry-After takes precedence over backoff',
    computeRetryDelayMs(0, { retryAfterMs: 7000, baseMs: 1000, capMs: 15000, jitter: noJitter }) ===
      7000
  );
  check(
    'Retry-After is honored past the backoff cap (not clamped to capMs)',
    computeRetryDelayMs(0, {
      retryAfterMs: 30000,
      baseMs: 1000,
      capMs: 15000,
      jitter: noJitter
    }) === 30000
  );
  check(
    'Retry-After bounded by the larger retryAfterCapMs',
    computeRetryDelayMs(0, {
      retryAfterMs: 99000,
      baseMs: 1000,
      capMs: 15000,
      jitter: noJitter
    }) === 60000
  );
}

console.log('\n🧪 WorkflowLLMHelper — maxRetries default is 3\n');
{
  const helper = new WorkflowLLMHelper();
  check('default maxRetries === 3', helper.maxRetries === 3, `got ${helper.maxRetries}`);
  const custom = new WorkflowLLMHelper({ maxRetries: 5 });
  check('constructor override honored', custom.maxRetries === 5, `got ${custom.maxRetries}`);
}

console.log('\n🧪 _runWithRetries — retries transient, gives up correctly\n');
async function runLoopTests() {
  // helper with instant sleep so tests don't actually wait
  const makeHelper = () => {
    const h = new WorkflowLLMHelper({ maxRetries: 3 });
    h._sleep = () => Promise.resolve();
    return h;
  };

  {
    const h = makeHelper();
    let calls = 0;
    const result = await h._runWithRetries(async () => {
      calls += 1;
      return 'ok';
    });
    check('success on first try calls fn once', calls === 1, `calls=${calls}`);
    check('returns the value', result === 'ok');
  }

  {
    const h = makeHelper();
    let calls = 0;
    let retried = 0;
    const result = await h._runWithRetries(
      async () => {
        calls += 1;
        if (calls < 3) {
          const e = new Error('503');
          e.status = 503;
          throw e;
        }
        return 'recovered';
      },
      { onRetry: () => (retried += 1) }
    );
    check('transient twice then success → fn called 3 times', calls === 3, `calls=${calls}`);
    check('onRetry fired twice', retried === 2, `retried=${retried}`);
    check('eventually returns recovered value', result === 'recovered');
  }

  {
    const h = makeHelper();
    let calls = 0;
    let threw = null;
    try {
      await h._runWithRetries(async () => {
        calls += 1;
        const e = new Error('bad request');
        e.status = 400;
        throw e;
      });
    } catch (e) {
      threw = e;
    }
    check('non-transient error thrown immediately', calls === 1, `calls=${calls}`);
    check('the original error propagates', threw?.status === 400);
  }

  {
    const h = makeHelper(); // maxRetries 3
    let calls = 0;
    let threw = null;
    try {
      await h._runWithRetries(async () => {
        calls += 1;
        const e = new Error('503');
        e.status = 503;
        throw e;
      });
    } catch (e) {
      threw = e;
    }
    check('persistent transient → 1 initial + 3 retries = 4 calls', calls === 4, `calls=${calls}`);
    check('final error propagates after exhaustion', threw?.status === 503);
  }
}

await runLoopTests();

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
