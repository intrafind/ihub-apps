/**
 * URL encoding for the audit log's multi-value filters.
 *
 * Each filterable field has two query parameters: the include set (`action`)
 * and the exclude set (`actionExclude`), which is subtracted from it. `*` is a
 * wildcard meaning "every value", an absent include set defaults to `*`, and
 * exclusion always wins over inclusion:
 *
 *   matches(v) = (include has '*' || include has v) && !(exclude has '*' || exclude has v)
 *
 * The same rule is implemented server-side in `AuditLogService.queryAuditLog`.
 * Both directions are readable so existing single-value links (`?resource=app`)
 * keep working, but the checkbox UI **writes** the exclusion form: an inclusion
 * list means "pin exactly these", which would silently hide a resource type
 * introduced by a later release from every bookmarked view.
 */

/** Fields with checkbox filters, in the order they appear in the filter row. */
export const FILTER_FIELDS = ['actor', 'resource', 'action', 'result', 'source'];

export const WILDCARD = '*';

/**
 * Fields whose values cannot contain a comma, so a comma in the parameter is a
 * value separator. `actor` is absent on purpose: a username can legitimately
 * contain one ("Doe, John"), so the actor filter uses repeated parameters only.
 */
const COMMA_SPLIT_FIELDS = new Set(['resource', 'action', 'result', 'source']);

export function splitsOnComma(field) {
  return COMMA_SPLIT_FIELDS.has(field);
}

/**
 * Turn the raw repeated values of one query parameter into a Set, applying
 * comma splitting for the fields that allow it.
 *
 * @param {string[]} raw - every value of the parameter, e.g. searchParams.getAll('action')
 * @param {string} field
 * @returns {Set<string>|null} null when the parameter is absent
 */
export function parseFilterParam(raw, field) {
  if (!raw || raw.length === 0) return null;
  const values = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const part of splitsOnComma(field) ? item.split(',') : [item]) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  return values.length > 0 ? new Set(values) : null;
}

/**
 * The matcher for one field. Mirrors the server exactly.
 *
 * @param {Set<string>|null} include
 * @param {Set<string>|null} exclude
 * @returns {(value: string) => boolean}
 */
export function buildMatcher(include, exclude) {
  if (exclude?.has(WILDCARD)) return () => false;
  const includesAll = !include || include.has(WILDCARD);
  return value => (includesAll || include.has(value)) && !(exclude ? exclude.has(value) : false);
}

/**
 * Build the option list a checkbox control renders for one field: the facet
 * values from the server, plus any value named by the current filter that the
 * date range happens to contain no entries for. Without that union an active
 * filter on a value outside the range would be invisible and un-untickable.
 *
 * @param {Array<{value: string, count: number}>} facetValues
 * @param {Set<string>|null} include
 * @param {Set<string>|null} exclude
 * @returns {Array<{value: string, count: number}>}
 */
export function mergeFilterOptions(facetValues = [], include, exclude) {
  const options = facetValues.filter(o => o && typeof o.value === 'string' && o.value !== '');
  const known = new Set(options.map(o => o.value));
  const extras = [];
  for (const set of [include, exclude]) {
    if (!set) continue;
    for (const value of set) {
      if (value === WILDCARD || known.has(value)) continue;
      known.add(value);
      extras.push({ value, count: 0 });
    }
  }
  extras.sort((a, b) => a.value.localeCompare(b.value));
  return [...options, ...extras];
}

/**
 * Which of `options` the current filter selects.
 *
 * @param {Array<{value: string}>} options
 * @param {Set<string>|null} include
 * @param {Set<string>|null} exclude
 * @returns {string[]}
 */
export function selectedOptionValues(options, include, exclude) {
  const matches = buildMatcher(include, exclude);
  return options.filter(o => matches(o.value)).map(o => o.value);
}

/**
 * Encode a checkbox selection as URL parameter updates for one field.
 *
 * Everything selected clears both parameters (so values added by a later
 * release stay visible), nothing selected writes `<field>Exclude=*`, and a
 * partial selection writes the unselected values as the exclude set.
 *
 * @param {string} field
 * @param {Array<{value: string}>} options - the full option list the selection came from
 * @param {string[]} selected
 * @returns {Record<string, string|string[]|null>} updates for `setMany`
 */
export function encodeSelection(field, options, selected) {
  const excludeParam = `${field}Exclude`;
  if (options.length === 0) return { [field]: null, [excludeParam]: null };

  const selectedSet = new Set(selected);
  const unselected = options.filter(o => !selectedSet.has(o.value)).map(o => o.value);

  if (unselected.length === 0) return { [field]: null, [excludeParam]: null };
  if (unselected.length === options.length) return { [field]: null, [excludeParam]: WILDCARD };
  return {
    [field]: null,
    [excludeParam]: splitsOnComma(field) ? unselected.join(',') : unselected
  };
}

/**
 * Add or remove values from a field's exclude set, keeping the include set as
 * it is. Used by the quick presets, which express "hide these" directly rather
 * than going through the checkbox list.
 *
 * @param {string} field
 * @param {Set<string>|null} exclude - the current exclude set
 * @param {string[]} values
 * @param {boolean} hidden - true to exclude the values, false to stop excluding them
 * @returns {Record<string, string|string[]|null>} updates for `setMany`
 */
export function setExcluded(field, exclude, values, hidden) {
  const next = new Set(exclude ?? []);
  for (const value of values) {
    if (hidden) next.add(value);
    else next.delete(value);
  }
  const list = Array.from(next);
  if (list.length === 0) return { [`${field}Exclude`]: null };
  return { [`${field}Exclude`]: splitsOnComma(field) ? list.join(',') : list };
}

/** True when the field's filter leaves at least one value out. */
export function isFieldFiltered(include, exclude) {
  if (exclude && exclude.size > 0) return true;
  return Boolean(include && !include.has(WILDCARD) && include.size > 0);
}
