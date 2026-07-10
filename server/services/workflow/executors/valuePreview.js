/**
 * Build a JSON-parseable preview of a tool-call value. Long string fields are
 * truncated IN PLACE before stringifying so the resulting preview stays valid
 * JSON — the UI does `JSON.parse` on these previews (step-log tool args/
 * results, reviewer / memory-composer structured output) to render details,
 * and truncating the JSON string itself instead produces an invalid suffix
 * that breaks that rendering.
 *
 * @module services/workflow/executors/valuePreview
 */

const MAX_LEN = 1024;
const MAX_FIELD_LEN = 320;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;

export function previewToolValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return value.length > MAX_LEN
      ? `${value.slice(0, MAX_LEN)}…[truncated ${value.length - MAX_LEN} chars]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const compact = compactStringsForPreview(value, MAX_FIELD_LEN, 0);
    const json = JSON.stringify(compact);
    // Final safety net: if the compacted form is still huge, fall back to
    // truncating the JSON string (and accept that the UI's JSON.parse will
    // fail for this row — better than spilling MB of state to disk).
    return json.length > MAX_LEN
      ? `${json.slice(0, MAX_LEN)}…[truncated ${json.length - MAX_LEN} chars]`
      : json;
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Recursively shorten long string fields inside an object/array so the
 * JSON.stringify output stays under ~1KB while remaining VALID JSON. String
 * fields longer than `maxFieldLen` get a `…[+N]` suffix appended in the
 * cloned copy. Depth is bounded to keep cyclic / pathological inputs from
 * blowing the stack; arrays are capped at MAX_ARRAY_ITEMS with a trailing
 * `…[+N items]` placeholder.
 */
export function compactStringsForPreview(value, maxFieldLen, depth) {
  if (depth > MAX_DEPTH) return '[…]';
  if (typeof value === 'string') {
    return value.length > maxFieldLen
      ? `${value.slice(0, maxFieldLen)}…[+${value.length - maxFieldLen}]`
      : value;
  }
  if (Array.isArray(value)) {
    const limited = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(v => compactStringsForPreview(v, maxFieldLen, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      limited.push(`…[+${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return limited;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = compactStringsForPreview(v, maxFieldLen, depth + 1);
    }
    return out;
  }
  return value;
}
