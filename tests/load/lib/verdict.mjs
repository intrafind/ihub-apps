// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pass or fail for a smoke run (`local-smoke.mjs`). A capacity run has no
 * verdict of this kind: it is read by people, with its SLOs. A smoke run only
 * has to show that every scenario of its profile still works.
 */

import { CHAT_LABELS } from './report.mjs';

/**
 * The verdict on one run, from its shard result.
 *
 * @param {Object} result - `shard-0.json` of the run
 * @param {Object} options
 * @param {number} options.maxErrorPct
 * @returns {{ok: boolean, lines: string[]}}
 */
export function judge(result, { maxErrorPct: limit = 0 } = {}) {
  const counts = result.metrics.counts || {};
  const total = name => Object.values(counts[name] || {}).reduce((a, b) => a + b, 0);
  const mix = result.meta.config.mix || {};
  const lines = [];
  let ok = true;
  let turnsOk = 0;
  let turnsFailed = 0;
  for (const label of CHAT_LABELS) {
    turnsOk += total(`${label}.turn.ok`);
    turnsFailed += total(`${label}.turn.error`);
  }
  // A scenario of the mix that is a chat: at least one of its turns must have ended.
  for (const [scenario, weight] of Object.entries(mix)) {
    if (!(weight > 0) || !CHAT_LABELS.includes(scenario)) continue;
    const ended = total(`${scenario}.turn.ok`);
    lines.push(`${scenario}: ${ended} turns ended, ${total(`${scenario}.turn.error`)} failed`);
    if (ended === 0) {
      ok = false;
      lines.push(`FAILED: no turn of ${scenario} ended`);
    }
  }
  const all = turnsOk + turnsFailed;
  const errorPct = all ? (turnsFailed / all) * 100 : 0;
  lines.push(`turns: ${turnsOk} ended, ${turnsFailed} failed (${errorPct.toFixed(1)} %)`);
  if (all === 0) {
    ok = false;
    lines.push('FAILED: the run made no turn at all');
  }
  if (errorPct > limit) {
    ok = false;
    lines.push(`FAILED: more than ${limit} % of the turns failed`);
    for (const name of Object.keys(counts).filter(key => key.startsWith('error.'))) {
      lines.push(`  ${name}: ${total(name)}`);
    }
  }
  const short = total('agentTurn.toolRounds.short');
  if (short > 0) {
    ok = false;
    lines.push(`FAILED: ${short} agent turns ran fewer tool calls than asked for`);
  }
  return { ok, lines };
}
