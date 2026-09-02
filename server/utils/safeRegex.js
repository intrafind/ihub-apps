/**
 * Regex safety for patterns supplied at runtime (by a model or an API caller):
 * bounded length, a denylist of nested-quantifier shapes that backtrack
 * exponentially (ReDoS), and a compile check.
 *
 * Shared by the `ask_user` tool (which validates the pattern a model declares)
 * and `InteractionService` (which enforces it on the answer).
 *
 * @module utils/safeRegex
 */

export const MAX_PATTERN_LENGTH = 200;

/**
 * Regular expression shapes that are considered unsafe (ReDoS vulnerable):
 * they can cause exponential backtracking.
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
 * Validate that a regex pattern is safe (not vulnerable to ReDoS) and compiles.
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
 * Compile a pattern when it is safe; `null` otherwise (callers treat an unsafe
 * or invalid pattern as "no constraint" rather than rejecting every answer).
 * @param {string} pattern
 * @returns {RegExp|null}
 */
export function compileSafeRegex(pattern) {
  if (!validateRegexPattern(pattern).valid) return null;
  return new RegExp(pattern);
}

export default { validateRegexPattern, compileSafeRegex, MAX_PATTERN_LENGTH };
