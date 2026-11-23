// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Segment planner — decides which tool calls of one assistant turn may run
 * concurrently.
 *
 * Two modes (`policy.parallelMode`):
 *
 * - `targets` (the default; concept §5.3): read-only tools always run in
 *   parallel with each other; other tools run in parallel only when their
 *   argument "targets" (the values of the arguments) are known and don't
 *   overlap with any other call in the same group; anything ambiguous — a call
 *   whose target cannot be inferred from its arguments — runs sequentially.
 * - `readOnly` (#2485; what a chat turn uses): only calls of tools that are
 *   **trusted** reads (`utils/toolApproval` `isTrustedReadOnly`: a declared
 *   `sideEffect: 'read'`, never an MCP annotation and never a default) share a
 *   batch, and only when every call of the round is one. A single call that
 *   changes something, asks a person, hands the turn over, may be held for an
 *   approval or is unknown makes the whole round run one call at a time, in
 *   the model's order. Targets are not looked at: two writes never overlap,
 *   however different their arguments. Whether a call may be taken over
 *   before it runs is read from the tool's stamp and, for a tool nobody
 *   stamped, asked of the seams that would do it (`options.mayTakeOver`).
 *
 * Results are always re-ordered into the original call order by the loop, so
 * planning never changes what the model sees.
 *
 * @module services/loop/segmentPlanner
 */
import { needsApproval } from '../../../shared/toolApproval.js';
import { isTrustedReadOnly } from '../../utils/toolApproval.js';

function targetsOf(args) {
  const out = new Set();
  const walk = value => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const s = String(value).trim().toLowerCase();
      if (s) out.add(s);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(args);
  return out;
}

function overlaps(a, b) {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/**
 * Whether a call may pause or end the turn instead of running: an interactive
 * tool (a question), a passthrough tool (it takes the turn over), or a call
 * that needs a person's approval (its stamped policy, #2945). Such a call
 * never shares a batch.
 *
 * @param {Object} def - the call's tool definition (`{}` for an unknown tool)
 * @returns {boolean}
 */
function pausesTurn(def) {
  return def.interactive === true || def.passthrough === true || needsApproval(def);
}

/** Nothing takes a call over where the caller names no seam that could. */
const nothingTakesOver = () => false;

/**
 * The batches of the `readOnly` mode: every call a trusted read that cannot
 * pause the turn → groups of at most `maxParallel` in call order; anything
 * else in the round → one call per batch.
 *
 * @param {Array<{toolDef: object|null, position: number}>} positioned
 * @param {number} maxParallel
 * @param {(item: Object) => boolean} mayTakeOver - whether a seam may take the call over
 * @returns {Array<Array<Object>>}
 */
function planReadOnlyBatches(positioned, maxParallel, mayTakeOver) {
  const batchable = item =>
    Boolean(item.toolDef) &&
    !pausesTurn(item.toolDef) &&
    // A tool that asks a person, whether or not its caller marked it `interactive`.
    item.toolDef.requiresUserInput !== true &&
    isTrustedReadOnly(item.toolDef) &&
    !mayTakeOver(item);
  if (!positioned.every(item => batchable(item))) return positioned.map(item => [item]);
  const batches = [];
  for (let start = 0; start < positioned.length; start += maxParallel) {
    batches.push(positioned.slice(start, start + maxParallel));
  }
  return batches;
}

/**
 * @param {Array<{call: object, toolDef: object|null, args: object}>} items - resolved calls in model order
 * @param {{ parallel?: boolean, maxParallel?: number, parallelMode?: 'targets'|'readOnly' }} [policy]
 * @param {Object} [options]
 * @param {(item: {call: object, toolDef: object|null, args: object}) => boolean} [options.mayTakeOver] -
 *   whether something may take the call over before it runs (an approval, a
 *   question, a passthrough tool), beyond what the tool's own stamp says. Read
 *   in the `readOnly` mode only: such a call never shares a batch.
 * @returns {Array<Array<{call, toolDef, args, position: number}>>} batches to run in sequence;
 *   calls inside a batch run concurrently
 * @example
 * // readOnly mode: two declared reads share a batch, a write makes the round serial
 * planToolBatches([search, read], { parallelMode: 'readOnly' })        // [[search, read]]
 * planToolBatches([search, write, read], { parallelMode: 'readOnly' }) // [[search], [write], [read]]
 */
export function planToolBatches(items, policy = {}, { mayTakeOver = nothingTakesOver } = {}) {
  const positioned = items.map((item, position) => ({ ...item, position }));
  const parallel = policy.parallel !== false;
  const maxParallel = Math.max(1, Number.isInteger(policy.maxParallel) ? policy.maxParallel : 4);
  if (!parallel || positioned.length <= 1) return positioned.map(item => [item]);
  if (policy.parallelMode === 'readOnly') {
    return planReadOnlyBatches(positioned, maxParallel, mayTakeOver);
  }

  const batches = [];
  let current = [];
  let currentTargets = [];
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    currentTargets = [];
  };

  for (const item of positioned) {
    const def = item.toolDef || {};
    // A call that needs a person's approval (its stamped policy, #2945) may
    // pause the turn like an interactive tool, so it never shares a batch.
    if (pausesTurn(def)) {
      // Interactive / passthrough / gated tools terminate or pause the turn — never overlap them.
      flush();
      batches.push([item]);
      continue;
    }
    const readOnly = def.readOnly === true;
    const targets = targetsOf(item.args);
    const known = targets.size > 0;
    // Two calls may share a batch when both are read-only, or when both
    // targets are known and disjoint. A mutable call with no inferable target
    // (empty / opaque arguments) is ambiguous and never overlaps anything.
    const disjoint = other =>
      (readOnly && other.toolDef?.readOnly === true) ||
      (known && other._targets.size > 0 && !overlaps(targets, other._targets));
    const canJoin = current.length < maxParallel && current.every(disjoint);
    if (!canJoin) flush();
    current.push({ ...item, _targets: targets });
    currentTargets.push(targets);
  }
  flush();
  return batches.map(batch => batch.map(({ _targets, ...rest }) => rest));
}
