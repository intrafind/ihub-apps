// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Kill points of the fault tests (`server/tests/faults/`, docs/run-testing.md).
 *
 * A fault test proves what a run does when its process dies at a known place:
 * after a tool was started and before its result was stored, for example. The
 * place is marked in the code with `killPoint('<name>')`. The fault harness
 * starts a server with the name of one kill point; when the server reaches
 * that place, it writes the name to a file and kills itself with SIGKILL, the
 * way a machine that loses power ends a process. The harness reads the file,
 * so it knows the place was reached without reading log lines.
 *
 * In every installation `killPoint()` does nothing. A kill point is armed only
 * when **both** of these hold when this module is imported:
 *
 * - `NODE_ENV` is `test`, and
 * - `IHUB_TEST_KILLPOINT` names a kill point.
 *
 * The two are read once, at import, never at a call: a value set later in a
 * running server arms nothing. With `NODE_ENV=production` the module is inert
 * whatever else is set (`server/tests/killPoint.test.js`).
 *
 * Environment, all read once:
 *
 * - `IHUB_TEST_KILLPOINT`: `<name>` or `<name>@<n>`. With `@<n>` the process is
 *   killed when it reaches the place for the n-th time (counted per process);
 *   without it, the first time.
 * - `IHUB_TEST_KILLPOINT_FILE`: the file the name is appended to (one line)
 *   before the kill. A kill point fires once per file: a process that finds
 *   the name in the file, when it starts or when it reaches the place, does
 *   not die. A cluster primary replaces a worker that died, and the
 *   replacement and the other workers inherit the environment; without this
 *   rule each of them would die at the same place in turn. (Two workers that
 *   reach the place in the same instant can both die.)
 *
 * Every call site is listed in `server/tests/faults/KILLPOINTS.md`;
 * `server/tests/killPoint-inventory.test.js` fails when the list and the code
 * differ, and when the name of the variable appears in any other server file.
 *
 * @module utils/killPoint
 */
import fs from 'node:fs';

/** The form of a kill point name: lower-case words joined by hyphens. */
export const KILL_POINT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** `<name>` or `<name>@<n>`, n being a whole number from 1 on without a leading zero. */
const KILL_POINT_SPEC = /^([^@]+)(?:@([1-9]\d*))?$/;

/**
 * Read `<name>` or `<name>@<n>`.
 *
 * @param {string} spec
 * @returns {{name: string, hit: number}}
 * @throws {Error} When the name or the count is malformed
 *
 * @example
 * parseKillPointSpec('after-tool-start@2'); // { name: 'after-tool-start', hit: 2 }
 */
export function parseKillPointSpec(spec) {
  const parts = KILL_POINT_SPEC.exec(String(spec));
  if (!parts || !KILL_POINT_NAME.test(parts[1])) {
    throw new Error(
      `IHUB_TEST_KILLPOINT must be "<name>" or "<name>@<n>" with n >= 1, got "${spec}"`
    );
  }
  return { name: parts[1], hit: parts[2] ? Number(parts[2]) : 1 };
}

/** What `killPoint` is in every process that is not armed. */
const disarmed = () => Object.assign(() => {}, { armed: false });

/** Whether the file already holds the name: the kill point fired before this process started. */
function firedBefore(file, name, readFile) {
  if (!file) return false;
  try {
    return String(readFile(file, 'utf8')).split('\n').includes(name);
  } catch {
    // No file yet: nothing fired.
    return false;
  }
}

/**
 * Build the `killPoint` function for an environment. The server uses the one
 * built at import ({@link killPoint}); the parameters exist for the unit test.
 *
 * @param {Object} [options]
 * @param {Record<string, string|undefined>} [options.env=process.env]
 * @param {() => void} [options.kill] - Ends the process; SIGKILL to itself by default
 * @param {(file: string, text: string) => void} [options.appendFile]
 * @param {(file: string, encoding: string) => string} [options.readFile]
 * @param {(line: string) => void} [options.warn] - Gets one line when the point is armed
 * @returns {((name: string) => void) & {armed: boolean}}
 * @throws {Error} When armed with a malformed `IHUB_TEST_KILLPOINT`
 */
export function createKillPoint({
  env = process.env,
  kill = () => process.kill(process.pid, 'SIGKILL'),
  appendFile = fs.appendFileSync,
  readFile = fs.readFileSync,
  warn = line => process.stderr.write(`${line}\n`)
} = {}) {
  const spec = env.IHUB_TEST_KILLPOINT;
  if (env.NODE_ENV !== 'test' || !spec) return disarmed();

  const target = parseKillPointSpec(spec);
  const file = env.IHUB_TEST_KILLPOINT_FILE || '';
  if (firedBefore(file, target.name, readFile)) return disarmed();

  warn(
    `[killPoint] TEST ONLY: this process kills itself at "${target.name}" (hit ${target.hit}). ` +
      'Never set IHUB_TEST_KILLPOINT outside a fault test.'
  );
  let hits = 0;
  const armed = name => {
    if (name !== target.name) return;
    hits += 1;
    if (hits !== target.hit) return;
    // Another process of this stack fired the point in the meantime: once is enough.
    if (firedBefore(file, target.name, readFile)) return;
    // Synchronous, so the line is written before the process is gone.
    if (file) appendFile(file, `${target.name}\n`);
    kill();
  };
  return Object.assign(armed, { armed: true });
}

/**
 * Mark a place where a fault test can end the process. Does nothing unless the
 * process was started for a fault test (see the module comment).
 *
 * @param {string} name - A name listed in `server/tests/faults/KILLPOINTS.md`
 * @returns {void}
 *
 * @example
 * killPoint('e2e-counter-after-write');
 */
export const killPoint = createKillPoint();

export default killPoint;
