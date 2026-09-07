/**
 * Regex safety for patterns supplied at runtime (by a model or an API caller).
 *
 * Two layers, because no denylist makes arbitrary JavaScript regexes safe:
 *
 *  - `validateRegexPattern` — a declaration-time check (bounded length, a
 *    denylist of common nested-quantifier spellings, a compile check). It
 *    gives the author an early, explainable error; it is not a guarantee.
 *  - `testRegexSafely` — the execution-time guarantee: the input is
 *    length-bounded and the match runs inside a `vm` context with a hard
 *    timeout. V8 interrupts regex backtracking on `TerminateExecution`, so a
 *    pattern the denylist does not recognise (`(a|aa)+$` against 34 `a`s) is
 *    cut off after the timeout instead of holding the event loop for seconds.
 *
 * Shared by the `ask_user` tool (validates the pattern a model declares) and
 * `InteractionService` (enforces it on the answer).
 *
 * @module utils/safeRegex
 */
import vm from 'node:vm';

export const MAX_PATTERN_LENGTH = 200;
/** Longest input a runtime pattern is ever tested against. */
export const MAX_TESTED_INPUT_LENGTH = 2000;
/** Hard cap on the CPU time one pattern test may take. */
export const REGEX_TEST_TIMEOUT_MS = 50;

/**
 * Regular expression shapes that are known to backtrack exponentially. A
 * declaration-time hint only — see `testRegexSafely` for the enforcement.
 * @constant {RegExp[]}
 */
const UNSAFE_REGEX_PATTERNS = [
  /\(\.\*\)\+/, // (.*)+
  /\(\.\+\)\+/, // (.+)+
  /\([^)]*\+[^)]*\)\+/, // nested quantifiers like (a+)+
  /\([^)]*\*[^)]*\)\+/, // nested quantifiers like (a*)+
  /\([^)]*\+[^)]*\)\*/, // nested quantifiers like (a+)*
  /\([^)]*\*[^)]*\)\*/, // nested quantifiers like (a*)*
  /\(\[.*?\]\+\)\+/, // ([...]+)+
  /\(\[.*?\]\*\)\+/, // ([...]*)+
  /\(\?:.*?\+.*?\)\+/, // (?:...+...)+
  /\(\?:.*?\*.*?\)\+/ // (?:...*...)+
];

/**
 * Validate that a regex pattern is acceptable to declare: bounded length, none
 * of the known-unsafe shapes, and it compiles.
 * @param {string} pattern - The regex pattern string to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export function validateRegexPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return { valid: true }; // No pattern means no validation needed
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `Regex pattern too long (max ${MAX_PATTERN_LENGTH} characters)` };
  }
  for (const unsafePattern of UNSAFE_REGEX_PATTERNS) {
    if (unsafePattern.test(pattern)) {
      return {
        valid: false,
        error: 'Regex pattern contains potentially unsafe nested quantifiers (ReDoS risk)'
      };
    }
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    return { valid: false, error: `Invalid regex pattern: ${error.message}` };
  }
  return { valid: true };
}

/**
 * Test `input` against `pattern` under hard bounds.
 *
 * @param {string} pattern
 * @param {string} input
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=REGEX_TEST_TIMEOUT_MS]
 * @param {number} [opts.maxInputLength=MAX_TESTED_INPUT_LENGTH]
 * @returns {{matched: boolean|null, reason?: 'unsafe_pattern'|'input_too_long'|'timeout'}}
 *   `matched` is `null` when the test could not be evaluated; `reason` says why.
 */
export function testRegexSafely(
  pattern,
  input,
  { timeoutMs = REGEX_TEST_TIMEOUT_MS, maxInputLength = MAX_TESTED_INPUT_LENGTH } = {}
) {
  if (!validateRegexPattern(pattern).valid) return { matched: null, reason: 'unsafe_pattern' };
  const text = String(input ?? '');
  if (text.length > maxInputLength) return { matched: null, reason: 'input_too_long' };
  const context = vm.createContext({ re: new RegExp(pattern), text });
  try {
    const matched = vm.runInContext('re.test(text)', context, { timeout: timeoutMs });
    return { matched: matched === true };
  } catch (err) {
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { matched: null, reason: 'timeout' };
    throw err;
  }
}

export default {
  validateRegexPattern,
  testRegexSafely,
  MAX_PATTERN_LENGTH,
  MAX_TESTED_INPUT_LENGTH,
  REGEX_TEST_TIMEOUT_MS
};
