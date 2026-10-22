// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sources a tool call reports beside its result. Some tools carry them on a
 * channel the result the model reads does not: an MCP result's
 * `structuredContent.sources` is gone once the connection turns the result
 * into the text the model reads (`McpServerConnection.normalizeToolResult`).
 *
 * The loop runs every tool call in a scope (`services/loop/AgentLoop.js`), and
 * code deep inside the call reports into it — whichever executor ran the tool
 * (chat, workflow, agent), none of which needs to pass anything along. What
 * was reported counts as the tool's own report (`producers/envelope.js`).
 *
 * @module services/sources/toolCallScope
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Most source inputs one call reports this way; the frame keeps fewer still. */
const MAX_REPORTED = 100;

const scope = new AsyncLocalStorage();

/**
 * Run a tool call with a place for the sources it reports beside its result.
 *
 * @param {Array} reported - receives the reported source inputs
 * @param {Function} fn - runs the call
 * @param {Object|null} [turn] - state shared by every tool call of one answer
 *   (`services/loop/AgentLoop.js` keeps one per run), for numbering what the
 *   answer cites ({@link allocatePassageMarkers})
 * @returns {*} what `fn` returns
 */
export function runToolCallScope(reported, fn, turn = null) {
  return scope.run({ reported, turn }, fn);
}

/**
 * Report source inputs of the tool call in progress; outside one, nothing.
 *
 * @param {unknown} sources - source inputs (`shared/sources/source.js`)
 */
export function reportToolCallSources(sources) {
  const reported = scope.getStore()?.reported;
  if (!reported || !Array.isArray(sources)) return;
  const room = MAX_REPORTED - reported.length;
  if (room > 0) reported.push(...sources.slice(0, room));
}

/**
 * Reserve `count` consecutive passage numbers (the `N` of `s:N` and of
 * `<cite type="s">N</cite>`) for the tool call in progress. The numbers run on
 * across the answer's tool calls, parallel ones included, because their
 * sources are merged into one answer, where a marker names one passage only.
 * Outside a turn (a direct call) the numbering starts at 1.
 *
 * @param {number} count
 * @returns {number} the first reserved number
 */
export function allocatePassageMarkers(count) {
  const turn = scope.getStore()?.turn;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!turn || typeof turn !== 'object') return 1;
  const first = (Number.isInteger(turn.passageMarkers) ? turn.passageMarkers : 0) + 1;
  turn.passageMarkers = first - 1 + n;
  return first;
}
