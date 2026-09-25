/**
 * Structured logging for failed Office.js calls.
 *
 * Office rejections used to end in `console.error(err)` plus a bare
 * `window.alert(result.error?.message)`, and field reports came back with
 * neither — just "an error occurred" (issue #2449). Every failure now records
 * the three fields Office actually populates (`name`, `code`, `message`) with
 * the call that produced them, so a report carries something diagnosable:
 *
 * - always on the console, as one structured record rather than a raw object;
 * - in a small in-memory ring the user can dump from the pane's devtools with
 *   `window.ihubOfficeErrors()` — the task pane is often the only place a
 *   customer can reproduce the problem, and the console there is easy to lose.
 *
 * Deliberately free of imports: every Office component reaches this module
 * through the action runner, so a dependency here lands in all of them. The
 * records are kept whether or not `window.enableDebugLogging()` is on — an
 * Office failure the user is reporting is never routine.
 *
 * `describeOfficeError` produces the short one-liner the pane shows the user;
 * it deliberately includes the Office error name/code so a screenshot of the
 * notice is enough to identify the failure.
 */

/** Enough to cover a reproduction attempt; small enough to never matter. */
const MAX_RECORDS = 25;

const records = [];

/**
 * @param {string} scope - the Office call that failed, e.g. `displayReplyAllFormAsync`
 * @param {unknown} error - `result.error`, or a thrown exception
 * @param {object} [context] - anything that helps place the failure (action, mode, sizes)
 * @returns {{ at: string, scope: string, name: string|null, code: number|string|null, message: string }}
 */
export function logOfficeError(scope, error, context = {}) {
  const record = {
    at: new Date().toISOString(),
    scope,
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: error?.message ?? (error == null ? '' : String(error)),
    ...context
  };

  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();

  console.error(`[iHub][office] ${scope} failed`, record);

  return record;
}

/** The recorded failures, oldest first. */
export function getOfficeErrorLog() {
  return records.map(record => ({ ...record }));
}

/**
 * A single line naming the Office error, for the pane's notice strip.
 * @param {unknown} error
 * @returns {string} e.g. `NumberOfArgumentsMismatch (9002): …`, or '' when
 *   there is nothing to say
 */
export function describeOfficeError(error) {
  if (!error) return '';
  const name = typeof error.name === 'string' ? error.name : '';
  const code = error.code === undefined || error.code === null ? '' : String(error.code);
  const message = typeof error.message === 'string' ? error.message : String(error);
  const label = name && code ? `${name} (${code})` : name || (code && `Office error ${code}`) || '';
  if (!label) return message;
  return message ? `${label}: ${message}` : label;
}

if (typeof window !== 'undefined') {
  // Dumped by a user reproducing a problem in the task pane's devtools.
  window.ihubOfficeErrors = getOfficeErrorLog;
}
