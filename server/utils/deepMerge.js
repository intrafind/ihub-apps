/**
 * Deep merge objects, preserving nested properties.
 * Arrays are replaced, not merged.
 *
 * @param {Object} target - The target object to merge into
 * @param {Object} source - The source object to merge from
 * @returns {Object} A new object with deeply merged properties
 *
 * @example
 * const target = { a: { b: 1, c: 2 }, d: 3 };
 * const source = { a: { b: 10 }, e: 5 };
 * deepMerge(target, source);
 * // Returns: { a: { b: 10, c: 2 }, d: 3, e: 5 }
 *
 * @example
 * // Arrays are replaced, not merged
 * const target = { items: [1, 2, 3] };
 * const source = { items: [4, 5] };
 * deepMerge(target, source);
 * // Returns: { items: [4, 5] }
 */
export function deepMerge(target, source, _seen) {
  // Handle null/undefined cases
  if (!source || typeof source !== 'object') {
    return target;
  }
  if (!target || typeof target !== 'object') {
    return source;
  }

  // Cycle protection. Without this, sharing a reference between target and
  // source (e.g. `state.data.nodeResults` ending up on both sides after a
  // node mutates state and returns stateUpdates that point back) drives this
  // function into unbounded recursion and crashes the worker. If we've seen
  // the same target+source pair already, return the shallow merge and stop.
  const seen = _seen || new WeakMap();
  const existing = seen.get(target);
  if (existing && existing.has(source)) {
    return { ...target, ...source };
  }
  const innerSet = existing || new Set();
  innerSet.add(source);
  seen.set(target, innerSet);

  // Start with a shallow copy of target
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const sourceVal = source[key];
    const targetVal = result[key];

    // If both are plain objects (not arrays, not null), recurse
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal, seen);
    } else {
      // Arrays and primitives are replaced entirely
      result[key] = sourceVal;
    }
  }

  return result;
}

export default deepMerge;
