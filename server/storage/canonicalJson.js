/**
 * Canonical JSON — the serialization an enveloped document's `etag` is taken
 * over.
 *
 * The etag is documented as derived from the data rather than chosen by the
 * provider, so that two providers holding the same document report the same
 * value and a migration can verify a copy by comparing etags. Plain
 * `JSON.stringify` cannot carry that: it emits keys in insertion order, so the
 * digest depends on the order the *writer* happened to build the object in.
 * The filesystem provider got away with it only because it persists the JSON
 * text and re-parses it, which preserves that order by accident. A provider
 * storing bodies in a PostgreSQL `jsonb` column — the backend the capability
 * table plans for — cannot: `jsonb` orders keys by length, then bytewise, so
 * `{"title":"x","id":"c1"}` reads back as `{"id":"c1","title":"x"}` and
 * recomputes to a different digest for a byte-perfect copy.
 *
 * Sorting keys removes the one degree of freedom that is nobody's decision.
 * Array order is data and is left alone.
 *
 * **What this does not promise.** It is not RFC 8785. A backend that
 * normalizes *values* on the way in — `jsonb` collapsing `1.0` to `1`,
 * dropping duplicate keys, or re-escaping unicode — still reads back something
 * this function serializes differently, and no serializer on the reading side
 * can undo that. Such a provider persists the etag it minted at write time and
 * reports that, which is why {@link DocumentStore} states the guarantee as a
 * requirement on providers rather than as a property of this function.
 *
 * @module storage/canonicalJson
 */

/**
 * Serialize `data` with object keys in sorted order, at every depth.
 *
 * Matches `JSON.stringify` in every other respect — same escaping, same
 * treatment of `null`, and the same dropping of `undefined` values and
 * function properties — so for data whose keys are already sorted the two
 * produce identical bytes.
 *
 * @param {any} data - JSON-serializable document body
 * @returns {string} The canonical serialization
 */
export function canonicalJson(data) {
  return JSON.stringify(data, replacer);
}

/**
 * `JSON.stringify` replacer that hands back plain objects with sorted keys.
 *
 * Runs after the value's own `toJSON()`, which is what makes a `Date` (and
 * anything else with a `toJSON`) serialize exactly as `JSON.stringify` would.
 * Arrays fall through untouched: their order is the document's, not the
 * writer's incidental choice.
 *
 * @param {string} _key - Property name, unused
 * @param {any} value - Value after any `toJSON()` has been applied
 * @returns {any} The value, or a key-sorted copy of a plain object
 */
function replacer(_key, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

export default canonicalJson;
