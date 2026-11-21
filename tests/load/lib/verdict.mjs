// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pass or fail for a smoke run (`local-smoke.mjs`). A capacity run has no
 * verdict of this kind: it is read by people, with its SLOs. A smoke run only
 * has to show that every scenario of its profile still works.
 */

import { CHAT_LABELS } from './report.mjs';

/** Order by code unit: the same on every machine. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The verdict on one run, from its shard result.
 *
 * `run.mjs` counts every session of a scenario as `session.<scenario>.ok` or
 * `session.<scenario>.error`, whatever the scenario does: a chat, an upload, a
 * crawl, page loads. Every scenario of the mix is judged by these. A scenario
 * that is a chat is judged by its turns as well.
 *
 * @param {Object} result - `shard-0.json` of the run
 * @param {Object} options
 * @param {number} options.maxErrorPct - Of the turns, and of the sessions of each scenario
 * @returns {{ok: boolean, lines: string[]}}
 */
export function judge(result, { maxErrorPct: limit = 0 } = {}) {
  const counts = result.metrics.counts || {};
  const total = name => Object.values(counts[name] || {}).reduce((a, b) => a + b, 0);
  const share = (failed, all) => (all ? (failed / all) * 100 : 0);
  const mix = result.meta.config.mix || {};
  const lines = [];
  let ok = true;
  let overLimit = false;
  let turnsOk = 0;
  let turnsFailed = 0;
  for (const label of CHAT_LABELS) {
    turnsOk += total(`${label}.turn.ok`);
    turnsFailed += total(`${label}.turn.error`);
  }
  for (const [scenario, weight] of Object.entries(mix)) {
    if (!(weight > 0)) continue;
    // Every scenario of the mix: at least one of its sessions must have ended,
    // and no more of them failed than the limit allows. A scenario that fails
    // before its first turn (an upload, a crawl), or that has no turn at all,
    // shows only here.
    const sessionsOk = total(`session.${scenario}.ok`);
    const sessionsFailed = total(`session.${scenario}.error`);
    lines.push(`${scenario}: ${sessionsOk} sessions ended, ${sessionsFailed} failed`);
    if (sessionsOk === 0) {
      ok = false;
      lines.push(`FAILED: no session of ${scenario} ended`);
    }
    if (share(sessionsFailed, sessionsOk + sessionsFailed) > limit) {
      ok = false;
      overLimit = true;
      lines.push(`FAILED: more than ${limit} % of the sessions of ${scenario} failed`);
    }
    // A scenario of the mix that is a chat: at least one of its turns must have ended.
    if (!CHAT_LABELS.includes(scenario)) continue;
    const ended = total(`${scenario}.turn.ok`);
    lines.push(`${scenario}: ${ended} turns ended, ${total(`${scenario}.turn.error`)} failed`);
    if (ended === 0) {
      ok = false;
      lines.push(`FAILED: no turn of ${scenario} ended`);
    }
  }
  const all = turnsOk + turnsFailed;
  const errorPct = share(turnsFailed, all);
  lines.push(`turns: ${turnsOk} ended, ${turnsFailed} failed (${errorPct.toFixed(1)} %)`);
  if (all === 0) {
    ok = false;
    lines.push('FAILED: the run made no turn at all');
  }
  if (errorPct > limit) {
    ok = false;
    overLimit = true;
    lines.push(`FAILED: more than ${limit} % of the turns failed`);
  }
  if (overLimit) {
    // What failed, by its code: `error.<scope>.<code>` (`metrics.error`).
    const errors = Object.keys(counts)
      .filter(key => key.startsWith('error.'))
      .sort(byCodeUnit);
    for (const name of errors) lines.push(`  ${name}: ${total(name)}`);
  }
  const short = total('agentTurn.toolRounds.short');
  if (short > 0) {
    ok = false;
    lines.push(`FAILED: ${short} agent turns ran fewer tool calls than asked for`);
  }
  return { ok, lines };
}
