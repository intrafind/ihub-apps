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
export function deepMerge(target, source) {
  // Handle null/undefined cases
  if (!source || typeof source !== 'object') {
    return target;
  }
  if (!target || typeof target !== 'object') {
    return source;
  }

  // Start with a shallow copy of target
  const result = { ...target };

  for (const key of Object.keys(source)) {
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
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      // Arrays and primitives are replaced entirely
      result[key] = sourceVal;
    }
  }

  return result;
}

export default deepMerge;
