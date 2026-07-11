/**
 * Shared dot-notation / bracket-array-index path resolver.
 *
 * Four call sites (BaseNodeExecutor.resolveVariable, DAGScheduler._getValueFromPath,
 * TransformNodeExecutor/PromptNodeExecutor.getNestedValue, expressionEvaluator.resolvePath)
 * used to hand-roll this traversal independently and had drifted: two of them
 * supported `items[0]` array-index segments and two silently treated `items[0]`
 * as a literal (always-undefined) property key. This module is the single
 * traversal implementation; callers keep their own pre-processing (`$.`-prefix
 * stripping, `nodeOutputs` remapping, literal-fallback semantics) and delegate
 * the actual walk here.
 *
 * @module services/workflow/pathResolver
 */

const ARRAY_INDEX_RE = /^(\w+)\[(\d+)\]$/;

/**
 * Resolve a dot-notation path (optionally with `name[idx]` array-index
 * segments) against a root object.
 *
 * @param {string|string[]} pathOrParts - Dot-notation path (e.g. "a.b.items[0].c")
 *   or a pre-split array of path segments.
 * @param {*} root - Object to traverse.
 * @returns {*} Resolved value, or undefined if any segment is missing or a
 *   bracketed segment doesn't resolve to an array.
 */
export function resolveDotPath(pathOrParts, root) {
  let parts;
  if (Array.isArray(pathOrParts)) {
    parts = pathOrParts;
  } else if (typeof pathOrParts === 'string' && pathOrParts) {
    parts = pathOrParts.split('.');
  } else {
    return undefined;
  }

  let current = root;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    const arrayMatch = part.match(ARRAY_INDEX_RE);
    if (arrayMatch) {
      const [, name, indexStr] = arrayMatch;
      current = current[name];
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[Number.parseInt(indexStr, 10)];
    } else {
      current = current[part];
    }
  }
  return current;
}
