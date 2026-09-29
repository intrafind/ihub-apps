/**
 * Structured-output seam — checks the model's final answer against an output
 * contract and, when it does not hold, asks the model for one corrected
 * attempt inside the same run.
 *
 * The contract itself is not this module's business: the caller hands in a
 * `validate(content)` function (JSON Schema, plain JSON object, …) that
 * answers `{ valid, value?, text?, errors? }`. The seam only decides what to
 * do with the verdict — retry while attempts and rounds are left, otherwise
 * let the answer stand — and remembers the last verdict so the caller can
 * refuse an answer that never became valid.
 *
 * @module services/loop/seams/structuredOutputSeam
 */

/** Errors listed in the correction prompt; the rest are counted. */
const MAX_LISTED_ERRORS = 10;

/**
 * The correction the model gets after an invalid answer.
 *
 * @param {Array<{path?: string, message: string}>} errors
 * @returns {string}
 */
export function structuredOutputRetryPrompt(errors = []) {
  const listed = errors
    .slice(0, MAX_LISTED_ERRORS)
    .map(error => `- ${error.path ? `${error.path}: ` : ''}${error.message}`);
  if (errors.length > MAX_LISTED_ERRORS) {
    listed.push(`- … and ${errors.length - MAX_LISTED_ERRORS} more`);
  }
  return (
    '[system] Your previous answer does not match the required output format. ' +
    (listed.length > 0 ? `Problems:\n${listed.join('\n')}\n` : '') +
    'Answer again with only the corrected JSON: no explanation, no Markdown code fences.'
  );
}

/**
 * @param {Object} options
 * @param {(content: string) => {valid: boolean, value?: *, text?: string, errors?: Array}} options.validate
 * @param {number} [options.maxRetries=1] - Corrected attempts the model gets.
 * @param {(info: {attempt: number, errors: Array}) => void} [options.onAttemptRejected] -
 *   Called when an answer is rejected and a retry follows, before the retry's
 *   first chunk (a streaming caller closes the rejected attempt there).
 * @returns {Object} The seam, plus `verdict()`, `verdictFor(answer)` and `attempts()`.
 */
export function structuredOutputSeam({ validate, maxRetries = 1, onAttemptRejected = null }) {
  let attempts = 0;
  let verdict = null;
  let checked = null;
  return {
    name: 'structured-output',
    onAnswer(ctx, info) {
      attempts += 1;
      // The answer is the final step's text: prose a tool-using run wrote
      // before its tool calls is part of the run's content, not of the JSON.
      const answer = typeof info.stepText === 'string' ? info.stepText : info.content;
      let result;
      try {
        result = validate(answer);
      } catch (error) {
        result = { valid: false, errors: [{ path: '', message: error.message }] };
      }
      verdict = { ...result, attempts };
      checked = answer;
      if (result.valid) return null;
      if (!info.canRetry || attempts > maxRetries) return null;
      const errors = Array.isArray(result.errors) ? result.errors : [];
      if (typeof onAttemptRejected === 'function') {
        try {
          onAttemptRejected({ attempt: attempts, errors });
        } catch {
          // A caller's bookkeeping must not end the run.
        }
      }
      return {
        handled: true,
        retry: structuredOutputRetryPrompt(errors),
        error: {
          code: 'OUTPUT_VALIDATION_FAILED',
          message: `Answer did not match the output schema (${errors.length} problem${
            errors.length === 1 ? '' : 's'
          }); retrying`
        }
      };
    },
    /** The verdict on the last answer, or null when the run never produced one. */
    verdict: () => verdict,
    /**
     * The last verdict when it was given on exactly `answer`, else null. A
     * run can end on an answer the seam never saw (a forced finish after a
     * rejected attempt), and that answer must be checked on its own.
     */
    verdictFor: answer => (verdict && checked === answer ? verdict : null),
    /** How many answers were checked. */
    attempts: () => attempts
  };
}

export default structuredOutputSeam;
