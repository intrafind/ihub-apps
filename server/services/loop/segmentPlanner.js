/**
 * Segment planner — decides which tool calls of one assistant turn may run
 * concurrently.
 *
 * Rules (concept §5.3): read-only tools always run in parallel with each
 * other; other tools run in parallel only when their argument "targets" (the
 * values of the arguments) are known and don't overlap with any other call in
 * the same group; anything ambiguous — a call whose target cannot be inferred
 * from its arguments — runs sequentially. Results are always re-ordered into
 * the original call order by the loop, so planning never changes what the
 * model sees.
 *
 * @module services/loop/segmentPlanner
 */

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
 * @param {Array<{call: object, toolDef: object|null, args: object}>} items - resolved calls in model order
 * @param {{ parallel?: boolean, maxParallel?: number }} [policy]
 * @returns {Array<Array<{call, toolDef, args, position: number}>>} batches to run in sequence;
 *   calls inside a batch run concurrently
 */
export function planToolBatches(items, policy = {}) {
  const positioned = items.map((item, position) => ({ ...item, position }));
  const parallel = policy.parallel !== false;
  const maxParallel = Math.max(1, Number.isInteger(policy.maxParallel) ? policy.maxParallel : 4);
  if (!parallel || positioned.length <= 1) return positioned.map(item => [item]);

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
    const interactive = def.interactive === true || def.passthrough === true;
    if (interactive) {
      // Interactive / passthrough tools terminate or pause the turn — never overlap them.
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
