/**
 * Shared JSON extraction for LLM responses (the planner's three-stage
 * strategy, which is a superset of the greedy-brace variants other callers
 * used): whole trimmed content → fenced ```json block → first `{`/`[` to the
 * matching last `}`/`]`.
 *
 * @module services/loop/extractJson
 */

const FENCE_RE = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```\s*$/;

function tryParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the first JSON object/array from free-form model output.
 *
 * @param {string} content
 * @returns {Object|Array|null} parsed value or null when none could be recovered
 */
export function extractJson(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;

  const fence = trimmed.match(FENCE_RE);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  // Fences embedded in prose (not the whole message).
  const inner = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (inner) {
    const fenced = tryParse(inner[1].trim());
    if (fenced !== undefined) return fenced;
  }

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']']
  ]) {
    const first = trimmed.indexOf(open);
    const last = trimmed.lastIndexOf(close);
    if (first !== -1 && last > first) {
      const sliced = tryParse(trimmed.slice(first, last + 1));
      if (sliced !== undefined) return sliced;
    }
  }
  return null;
}

/**
 * Heuristic: does the (unparseable) content look truncated rather than malformed?
 * @param {string} content
 * @param {string|null} finishReason
 * @returns {boolean}
 */
export function looksTruncated(content, finishReason) {
  if (finishReason === 'length') return true;
  if (typeof content !== 'string') return false;
  const tail = content.trim().slice(-1);
  return tail !== '}' && tail !== ']' && tail !== '`';
}

export default extractJson;
