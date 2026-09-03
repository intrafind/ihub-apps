import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRegexPattern,
  testRegexSafely,
  MAX_TESTED_INPUT_LENGTH
} from '../../utils/safeRegex.js';

test('validateRegexPattern: declaration-time checks (length, known-unsafe shapes, compile)', () => {
  assert.equal(validateRegexPattern('^[A-Z]+-\\d+$').valid, true);
  assert.equal(validateRegexPattern('').valid, true);
  assert.equal(validateRegexPattern('(a+)+$').valid, false);
  assert.equal(validateRegexPattern('a'.repeat(201)).valid, false);
  assert.equal(validateRegexPattern('(unclosed').valid, false);
});

test('testRegexSafely: matches, rejects, and cuts off a pattern that backtracks exponentially', () => {
  assert.deepEqual(testRegexSafely('^[A-Z]+-\\d+$', 'ABC-42'), { matched: true });
  assert.deepEqual(testRegexSafely('^[A-Z]+-\\d+$', 'nope'), { matched: false });

  // Passes the denylist, yet takes seconds on this input without the timeout.
  const started = Date.now();
  const verdict = testRegexSafely('(a|aa)+$', `${'a'.repeat(34)}!`, { timeoutMs: 30 });
  assert.deepEqual(verdict, { matched: null, reason: 'timeout' });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);

  assert.deepEqual(testRegexSafely('(a+)+$', 'aaa'), { matched: null, reason: 'unsafe_pattern' });
  assert.deepEqual(testRegexSafely('^a+$', 'a'.repeat(MAX_TESTED_INPUT_LENGTH + 1)), {
    matched: null,
    reason: 'input_too_long'
  });
  assert.deepEqual(testRegexSafely('^a+$', 'a'.repeat(MAX_TESTED_INPUT_LENGTH)), { matched: true });
});
