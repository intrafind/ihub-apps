// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The limits and the names of the fault harness (`harness.mjs`).
 *
 * They are in a module of their own, which does nothing when it is imported,
 * so that a test of the pull request tier can read them
 * (`server/tests/fault-harness-settings.test.js`). The fault tier itself runs
 * only at night and with the label `run-faults`; what the nightly workflow
 * gives it and what the harness expects must not drift apart unseen.
 */

/** The limit of one fault case. Pass it as the `timeout` of the test. */
export const CASE_TIMEOUT_MS = 90_000;
/**
 * How long `startStack` may take at most: the seed and the first start of the
 * server share this one limit. A started server gets the same limit to answer.
 */
export const START_TIMEOUT_MS = 120_000;
/** How long a signalled process may take to be gone. */
export const EXIT_TIMEOUT_MS = 15_000;
/**
 * The limit of a `before` hook that seeds a contents directory and starts a
 * server. It is longer than a start may take plus the stop of one that failed
 * (see `fault-harness-settings.test.js`): `startStack` gives up and stops what
 * it started before the hook does. A hook that gave up first would leave a
 * server behind that no `after` hook knows.
 */
export const SETUP_TIMEOUT_MS = 180_000;
/** How long a kill point may take to be reached, unless the test says otherwise. */
export const KILL_POINT_TIMEOUT_MS = 60_000;
/** How often a condition is looked at while it is waited for. */
export const POLL_MS = 25;
/**
 * The limit of one look at a server ("does it answer?"). A server that takes
 * the connection and says nothing must not hold the wait up.
 */
export const LOOK_TIMEOUT_MS = 2_000;

/** The variable that keeps the contents directories of a run. */
export const KEEP_VARIABLE = 'KEEP_FAULT_CONTENTS';
/** How the contents directory of a stack is named: this prefix and a random part. */
export const CONTENTS_PREFIX = 'contents-e2e-faults-';
/** The log of the servers of a stack, in a contents directory that is kept. */
export const SERVER_LOG = 'faults-server.log';

/**
 * Whether the stacks of a process keep their contents directories.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function keepsContents(env = process.env) {
  return env[KEEP_VARIABLE] === '1';
}

/**
 * What `stack.stop()` does with the contents directory.
 *
 * @param {Object} stack
 * @param {boolean} stack.keep - The stack keeps its contents (`keepsContents`)
 * @param {boolean} stack.ownsContents - The stack made the directory; false for
 *   one that was started on the directory of another stack
 * @returns {{log: boolean, remove: boolean}} `log`: the output of the server is
 *   added to `faults-server.log` in the directory; `remove`: the directory is deleted
 */
export function afterStop({ keep, ownsContents }) {
  return { log: keep, remove: !keep && ownsContents };
}
