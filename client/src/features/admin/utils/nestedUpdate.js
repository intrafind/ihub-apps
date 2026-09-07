/**
 * Immutably set a value at a nested path without repeating spread pyramids
 * like `{...obj, a: {...obj.a, b: {...obj.a.b, c: value}}}`.
 *
 * @param {Object} obj - source object (not mutated)
 * @param {Array<string>|string} path - key path, e.g. ['upload', 'imageUpload', 'enabled'] or 'upload.imageUpload.enabled'
 * @param {*} value - value to set at the path
 * @returns {Object} a new object with `value` set at `path`
 */
export function updateIn(obj, path, value) {
  const keys = Array.isArray(path) ? path : path.split('.');
  if (keys.length === 0) {
    return value;
  }
  const [head, ...rest] = keys;
  const base = obj && typeof obj === 'object' ? obj : {};
  if (rest.length === 0) {
    return { ...base, [head]: value };
  }
  return { ...base, [head]: updateIn(base[head], rest, value) };
}

/**
 * Immutably replace the item at `index` in `array` with `{...array[index], ...patch}`.
 *
 * @param {Array<Object>} array - source array (not mutated)
 * @param {number} index - index of the item to patch
 * @param {Object} patch - fields to merge into the item at `index`
 * @returns {Array<Object>} a new array with the patched item
 */
export function updateAt(array, index, patch) {
  return array.map((item, i) => (i === index ? { ...item, ...patch } : item));
}
