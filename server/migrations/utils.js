/**
 * Migration utility functions for common JSON configuration transformations.
 * All functions are pure — no side effects or I/O.
 */

/**
 * Get a value at a dot-separated path in an object.
 * @param {object} obj
 * @param {string} dotPath - e.g. 'a.b.c'
 * @returns {{ parent: object|null, key: string, exists: boolean, value: any }}
 */
function resolvePath(obj, dotPath) {
  const keys = dotPath.split('.');
  const lastKey = keys.pop();
  let current = obj;

  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return { parent: null, key: lastKey, exists: false, value: undefined };
    }
    current = current[key];
  }

  if (current == null || typeof current !== 'object') {
    return { parent: null, key: lastKey, exists: false, value: undefined };
  }

  return {
    parent: current,
    key: lastKey,
    exists: Object.prototype.hasOwnProperty.call(current, lastKey),
    value: current[lastKey]
  };
}

/**
 * Ensure all intermediate objects exist along a dot-path, creating them if needed.
 * @param {object} obj
 * @param {string} dotPath
 * @returns {{ parent: object, key: string }}
 */
function ensurePath(obj, dotPath) {
  const keys = dotPath.split('.');
  const lastKey = keys.pop();
  let current = obj;

  for (const key of keys) {
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }

  return { parent: current, key: lastKey };
}

/**
 * Set a value at a dot-path if the key does not already exist.
 * Creates intermediate objects as needed.
 * @param {object} obj - The object to modify (mutated in place)
 * @param {string} dotPath - Dot-separated path (e.g. 'cors.maxAge')
 * @param {any} defaultValue - Value to set if key is missing
 * @returns {boolean} true if the value was set, false if it already existed
 */
export function setDefault(obj, dotPath, defaultValue) {
  const resolved = resolvePath(obj, dotPath);
  if (resolved.exists) {
    return false;
  }
  const { parent, key } = ensurePath(obj, dotPath);
  parent[key] = defaultValue;
  return true;
}

/**
 * Remove a key at a dot-separated path.
 * @param {object} obj - The object to modify (mutated in place)
 * @param {string} dotPath - Dot-separated path
 * @returns {boolean} true if the key was removed, false if it didn't exist
 */
export function removeKey(obj, dotPath) {
  const { parent, key, exists } = resolvePath(obj, dotPath);
  if (!exists || parent == null) {
    return false;
  }
  delete parent[key];
  return true;
}

/**
 * Rename a key by moving its value from one dot-path to another.
 * The old key is removed and the value is placed at the new path.
 * Creates intermediate objects for the new path as needed.
 * @param {object} obj - The object to modify (mutated in place)
 * @param {string} oldDotPath - Source dot-path
 * @param {string} newDotPath - Destination dot-path
 * @returns {boolean} true if the key was renamed, false if old key didn't exist
 */
export function renameKey(obj, oldDotPath, newDotPath) {
  const resolved = resolvePath(obj, oldDotPath);
  if (!resolved.exists || resolved.parent == null) {
    return false;
  }
  const value = resolved.value;
  delete resolved.parent[resolved.key];

  const { parent, key } = ensurePath(obj, newDotPath);
  parent[key] = value;
  return true;
}

/**
 * Check if a value is a plain object (not array, null, Date, etc.)
 * @param {any} val
 * @returns {boolean}
 */
function isPlainObject(val) {
  return val != null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date);
}

/**
 * Deep merge defaults into an existing config object.
 * Existing values always take precedence. Only missing keys are filled from defaults.
 * @param {object} existing - The user's existing configuration
 * @param {object} defaults - The default values to merge in
 * @returns {object} The merged object (existing is mutated and returned)
 */
export function mergeDefaults(existing, defaults) {
  for (const key of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      existing[key] = defaults[key];
    } else if (isPlainObject(existing[key]) && isPlainObject(defaults[key])) {
      mergeDefaults(existing[key], defaults[key]);
    }
    // else: existing value wins, do nothing
  }
  return existing;
}

/**
 * Add an item to an array if no existing item matches by the given id field.
 * @param {Array} array - The array to add to (mutated in place)
 * @param {object} item - The item to add
 * @param {string} [idField='id'] - The field to compare for uniqueness
 * @returns {boolean} true if the item was added, false if already present
 */
export function addIfMissing(array, item, idField = 'id') {
  const exists = array.some(existing => existing[idField] === item[idField]);
  if (exists) {
    return false;
  }
  array.push(item);
  return true;
}

/**
 * Remove an item from an array by its id field value.
 * @param {Array} array - The array to remove from (mutated in place)
 * @param {any} id - The id value to match
 * @param {string} [idField='id'] - The field to compare
 * @returns {boolean} true if an item was removed, false if not found
 */
export function removeById(array, id, idField = 'id') {
  const index = array.findIndex(item => item[idField] === id);
  if (index === -1) {
    return false;
  }
  array.splice(index, 1);
  return true;
}

/**
 * Transform all array items that match a predicate function.
 * @param {Array} array - The array to transform (items mutated in place)
 * @param {function} predicate - Function returning true for items to transform
 * @param {function} transform - Function that receives and mutates matching items
 * @returns {number} Count of items transformed
 */
export function transformWhere(array, predicate, transform) {
  let count = 0;
  for (const item of array) {
    if (predicate(item)) {
      transform(item);
      count++;
    }
  }
  return count;
}
