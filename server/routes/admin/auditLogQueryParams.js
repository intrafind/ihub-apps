/**
 * Query-string parsing for the admin audit log endpoints.
 *
 * Both the list endpoint and the CSV export run through {@link
 * parseAuditLogQuery}, so an export can never disagree with what is on screen.
 * Kept out of the route module so the URL contract can be unit-tested without
 * standing up Express.
 */

// Fields that can be filtered by value. Each accepts an include parameter
// (`?action=create`) and an exclude parameter (`?actionExclude=login`).
export const FILTER_FIELDS = ['actor', 'resource', 'action', 'result', 'source'];

// `resource`, `action`, `result` and `source` draw from comma-free
// vocabularies, so a comma in one of those parameters is a value separator.
// An actor username can legitimately contain a comma ("Doe, John"), so the
// actor filter reads repeated parameters only and is never comma-split.
const COMMA_SPLIT_FIELDS = new Set(['resource', 'action', 'result', 'source']);

// Upper bound on filter values per field, so a crafted URL can't build an
// enormous filter set. Only hygiene — matching a value is a Set lookup either
// way — so it is set well above what the checkbox UI can emit: that control
// writes whichever of the include/exclude forms is expressible, and the
// shorter of the two never exceeds half the number of distinct values in the
// date range. `MAX_FILTER_VALUES` in
// `client/src/features/admin/utils/auditLogFilters.js` must match.
export const MAX_FILTER_VALUES = 2000;

// Upper bound on the free-text search term.
export const MAX_QUERY_LENGTH = 200;

// Upper bound on rows a single list request may return.
export const MAX_PAGE_SIZE = 1000;

export class BadFilterError extends Error {}

/**
 * Parse one filter parameter into an array of values, or undefined when it is
 * absent. Handles both repeated parameters (`?a=1&a=2`) and — for the
 * comma-free fields — comma-separated lists (`?a=1,2`).
 *
 * @throws {BadFilterError} when more than MAX_FILTER_VALUES values are given
 */
export function parseFilterValues(raw, { splitCommas }) {
  if (raw === undefined || raw === null) return undefined;
  const values = [];
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    if (typeof item !== 'string') continue;
    for (const part of splitCommas ? item.split(',') : [item]) {
      const value = part.trim();
      if (!value) continue;
      if (values.length >= MAX_FILTER_VALUES) {
        throw new BadFilterError(
          `Too many filter values; at most ${MAX_FILTER_VALUES} per field are accepted`
        );
      }
      values.push(value);
    }
  }
  return values.length > 0 ? values : undefined;
}

/**
 * Build the queryAuditLog() options from a request's query string. Shared by
 * the list and the CSV export endpoints so an export always matches what is on
 * screen.
 *
 * @throws {BadFilterError} on a filter that exceeds its limits
 */
export function parseAuditLogQuery(query = {}) {
  const options = { from: query.from, to: query.to };

  for (const field of FILTER_FIELDS) {
    const splitCommas = COMMA_SPLIT_FIELDS.has(field);
    options[field] = parseFilterValues(query[field], { splitCommas });
    options[`${field}Exclude`] = parseFilterValues(query[`${field}Exclude`], { splitCommas });
  }

  // `q` is a single free-text term; a repeated parameter takes the first value.
  const rawQ = Array.isArray(query.q) ? query.q[0] : query.q;
  if (typeof rawQ === 'string' && rawQ.trim()) {
    if (rawQ.length > MAX_QUERY_LENGTH) {
      throw new BadFilterError(`Search term is too long; at most ${MAX_QUERY_LENGTH} characters`);
    }
    options.q = rawQ;
  }

  return options;
}

/** Truthy query-string flag: `?facets=1`, `?facets=true`, or a bare `?facets`. */
export function isFlagSet(value) {
  if (value === undefined) return false;
  const first = Array.isArray(value) ? value[0] : value;
  return first === '' || first === '1' || first === 'true';
}

export function clampInt(raw, fallback, min, max) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
