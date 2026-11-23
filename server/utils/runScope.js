// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run a piece of code works for, carried through async boundaries.
 *
 * The run service (`services/run/RunService.js`) runs each run inside a scope
 * with the run's ids: `runId`, `parentRunId`, `kind`, `principalId`,
 * `agentId`, `chatId`, `modelId`. The logger adds the ones a log line does not
 * set itself (`utils/logger.js`), and the span of each model call carries them
 * as attributes (`services/loop/LLMClient.js`), so the lines and spans of one
 * run can be found together without each call site naming them. A run started
 * inside another (an app called as a tool) has a scope of its own and names
 * the outer run as its `parentRunId`.
 *
 * This module has no dependencies: the logger reads it on every line.
 *
 * @module utils/runScope
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** The fields a run scope carries, in the order a log line lists them. */
export const RUN_SCOPE_FIELDS = Object.freeze([
  'runId',
  'parentRunId',
  'kind',
  'principalId',
  'agentId',
  'chatId',
  'modelId'
]);

/**
 * The fields of a scope: the known keys with a value, as strings.
 *
 * @param {Object} fields
 * @returns {Readonly<Object>}
 */
function scopeOf(fields) {
  const scope = {};
  for (const key of RUN_SCOPE_FIELDS) {
    const value = fields?.[key];
    if (value !== undefined && value !== null && value !== '') scope[key] = String(value);
  }
  return Object.freeze(scope);
}

/**
 * Run `fn` inside the scope of a run.
 *
 * @template T
 * @param {Object} fields - `runId`, `parentRunId`, `kind`, `principalId`, `agentId`,
 *   `chatId`, `modelId`; empty ones are left out
 * @param {() => T} fn
 * @returns {T}
 */
export function withRunScope(fields, fn) {
  return storage.run(scopeOf(fields), fn);
}

/**
 * The scope of the run the caller works for, or null outside a run.
 *
 * @returns {Readonly<Object>|null}
 */
export function currentRunScope() {
  return storage.getStore() || null;
}

export default { withRunScope, currentRunScope, RUN_SCOPE_FIELDS };
