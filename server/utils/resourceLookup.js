/**
 * Case-insensitive lookup helpers for resources identified by an `id` field
 * (models, apps, prompts, workflows).
 *
 * External callers — the OpenAI-compatible inference API, MCP tools, chat
 * requests — may send an id in any casing, while configured resource ids are
 * conventionally lowercase. These helpers let lookups and permission checks
 * treat casing as insignificant without requiring stored ids to be rewritten.
 */

/**
 * Find an item in a list by its `id` field, ignoring case.
 * @param {Array<{id?: string}>} list
 * @param {string} id
 * @returns {Object|undefined}
 */
export function findByIdCaseInsensitive(list, id) {
  if (!Array.isArray(list) || typeof id !== 'string') return undefined;
  const target = id.toLowerCase();
  return list.find(item => typeof item?.id === 'string' && item.id.toLowerCase() === target);
}

/**
 * Check whether a Set of ids contains the given id, ignoring case.
 * @param {Set<string>} set
 * @param {string} id
 * @returns {boolean}
 */
export function hasIdCaseInsensitive(set, id) {
  if (!set || typeof id !== 'string') return false;
  if (set.has(id)) return true;
  const target = id.toLowerCase();
  for (const entry of set) {
    if (typeof entry === 'string' && entry.toLowerCase() === target) return true;
  }
  return false;
}
