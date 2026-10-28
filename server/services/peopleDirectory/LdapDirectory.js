// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createHash } from 'node:crypto';
import { SizeLimitExceededError, TimeLimitExceededError, NoSuchObjectError } from 'ldapts';
import { DirectoryConnectionError, isTimeoutError, openDirectoryConnection } from './connection.js';
import { formatRdn, isDnWithin, parseDn, rdnEquals } from './dn.js';
import { mapEntryToPerson, requestedAttributes } from './mapping.js';
import { STRUCTURED_SEARCH_FIELDS, structuredFieldAttributes } from './presets.js';
import {
  ToolArgumentError,
  buildSearchFilter,
  cleanStructuredValue,
  resolveResultLimit,
  timeLimitSeconds,
  tokenizeQuery
} from './query.js';

/**
 * The three read-only operations on an LDAP people directory. Each opens one
 * connection (see connection.js), runs its search and unbinds in `finally`; a
 * pool is not worth it at chat-tool call rates.
 *
 * Only mapped attributes are requested, never `*`. Results are `Person`
 * objects (mapping.js); "size limit exceeded" is a partial result, not an
 * error.
 */

/** LDAP result code "sizeLimitExceeded". */
const SIZE_LIMIT_EXCEEDED = 4;

/** How long `list_units` answers from its cache. */
export const UNITS_CACHE_TTL_MS = 60 * 60 * 1000;
/** Most units listed; a directory with more is not one to narrow by unit. */
const MAX_UNITS = 500;

const unitsCache = new Map();

/** Forget cached unit lists (tests, and a directory whose config changed). */
export function clearUnitsCache() {
  unitsCache.clear();
}

/**
 * The cache key covers the whole resolved directory, so any change to its
 * config (here or on another cluster worker, which reloads the file but never
 * ran this worker's `clearUnitsCache`) misses the old list.
 */
function unitsCacheKey(resolved) {
  const config = createHash('sha256').update(JSON.stringify(resolved)).digest('hex');
  return `${resolved.id}|${config}`;
}

/** Cache a directory's unit list, dropping the lists of its earlier configs. */
function cacheUnits(resolved, value) {
  for (const key of unitsCache.keys()) {
    if (key.startsWith(`${resolved.id}|`)) unitsCache.delete(key);
  }
  unitsCache.set(unitsCacheKey(resolved), { value, expiresAt: Date.now() + UNITS_CACHE_TTL_MS });
}

/**
 * Run `work(client)` on a fresh connection and always unbind.
 * @param {Object} resolved
 * @param {Object} deps
 * @param {(client: Object) => Promise<*>} work
 */
async function withConnection(resolved, deps, work) {
  const connect = deps.connect || openDirectoryConnection;
  const { client } = await connect(resolved, deps.connectOptions);
  try {
    return await work(client);
  } finally {
    try {
      await client.unbind();
    } catch {
      // the connection is gone either way
    }
  }
}

/**
 * The one-level children of the search base that are not people: authorities
 * in x500.bund.de (`ou=THW`), departments or sites elsewhere.
 *
 * @param {Object} resolved
 * @param {Object} client - Open ldapts client
 * @returns {Promise<{units: Array<{unitId: string, name: string, dn: string}>, truncated: boolean}>}
 */
async function fetchUnits(resolved, client) {
  const key = unitsCacheKey(resolved);
  const cached = unitsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let entries;
  let truncated = false;
  client.lastSearchResultCode = null;
  try {
    ({ searchEntries: entries } = await client.search(resolved.searchBase, {
      scope: 'one',
      filter: `(!${resolved.personFilter})`,
      attributes: ['1.1'],
      sizeLimit: MAX_UNITS + 1,
      timeLimit: timeLimitSeconds(resolved.timeoutMs)
    }));
    // Result code 4: the server's own size limit cut the list short.
    if (client.lastSearchResultCode === SIZE_LIMIT_EXCEEDED) truncated = true;
  } catch (error) {
    if (!(error instanceof SizeLimitExceededError)) throw error;
    entries = [];
    truncated = true;
  }
  if (entries.length > MAX_UNITS) {
    entries = entries.slice(0, MAX_UNITS);
    truncated = true;
  }

  const units = [];
  for (const entry of entries) {
    if (typeof entry.dn !== 'string' || !isDnWithin(entry.dn, resolved.searchBase)) continue;
    let leaf;
    try {
      [leaf] = parseDn(entry.dn);
    } catch {
      continue;
    }
    units.push({
      unitId: formatRdn(leaf),
      name: leaf.map(ava => ava.value).join(' '),
      dn: entry.dn
    });
  }
  units.sort((a, b) => a.name.localeCompare(b.name));
  const value = { units, truncated };
  cacheUnits(resolved, value);
  return value;
}

/**
 * Find the unit a `unit` argument names, by its id (`ou=THW`) or its name
 * (`THW`). Only a unit from the directory's own list (or, when that list was
 * cut short, one {@link lookupUnit} found) is ever used as a search base; the
 * argument is never concatenated into a DN.
 */
function matchUnit(units, requested) {
  const wanted = requested.trim();
  let wantedRdn = null;
  try {
    const parsed = parseDn(wanted);
    if (parsed.length === 1) wantedRdn = parsed[0];
  } catch {
    // not an RDN; match by name below
  }
  return (
    units.find(unit => {
      if (wantedRdn) {
        try {
          return rdnEquals(parseDn(unit.dn)[0], wantedRdn);
        } catch {
          return false;
        }
      }
      return false;
    }) || units.find(unit => unit.name.toLowerCase() === wanted.toLowerCase())
  );
}

/**
 * Look up a unit the directory's cut-short unit list may have missed. Only a
 * unit id (`ou=THW`) is looked up, as a direct child of the search base, and
 * only a non-person entry that exists there is used. The RDN is parsed and
 * written back escaped, so the argument itself never becomes part of a DN.
 *
 * @returns {Promise<{unitId: string, name: string, dn: string}|null>}
 */
async function lookupUnit(resolved, client, requested) {
  let rdns;
  try {
    rdns = parseDn(requested.trim());
  } catch {
    return null;
  }
  if (rdns.length !== 1) return null;
  const unitId = formatRdn(rdns[0]);
  const dn = `${unitId},${resolved.searchBase}`;
  if (!isDnWithin(dn, resolved.searchBase)) return null;
  try {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: `(!${resolved.personFilter})`,
      attributes: ['1.1'],
      sizeLimit: 1,
      timeLimit: timeLimitSeconds(resolved.timeoutMs)
    });
    if (searchEntries.length === 0) return null;
  } catch (error) {
    if (error instanceof NoSuchObjectError) return null;
    throw error;
  }
  return { unitId, name: rdns[0].map(ava => ava.value).join(' '), dn };
}

/**
 * Check the arguments of a people search and build what it sends, before any
 * connection is opened: a bad argument never reaches the directory.
 *
 * @param {Object} resolved - Resolved directory
 * @param {Object} args - Tool arguments
 * @returns {Object} The prepared search
 * @throws {ToolArgumentError}
 */
export function prepareSearch(resolved, args = {}) {
  const { tokens, dropped } = tokenizeQuery(args.query);
  const fields = structuredFieldAttributes(resolved);
  const structured = [];
  for (const field of STRUCTURED_SEARCH_FIELDS) {
    const value = cleanStructuredValue(field, args[field]);
    if (value === null) continue;
    if (!fields[field]) {
      throw new ToolArgumentError(`This directory cannot be searched by "${field}".`);
    }
    structured.push({ attributes: fields[field], value });
  }
  const { effectiveMaxResults, sizeLimit } = resolveResultLimit(
    args.maxResults,
    resolved.maxResults
  );
  const unit = typeof args.unit === 'string' && args.unit.trim() ? args.unit : null;
  if (unit && !resolved.units) {
    throw new ToolArgumentError('This directory has no units to narrow by; leave "unit" out.');
  }
  return {
    dropped,
    unit,
    effectiveMaxResults,
    sizeLimit,
    filter: buildSearchFilter({
      personFilter: resolved.personFilter,
      searchAttributes: resolved.searchAttributes,
      tokens,
      structured
    }),
    attributes: requestedAttributes(resolved.mapping)
  };
}

/**
 * Run a prepared search on an open connection.
 *
 * @param {Object} resolved
 * @param {Object} client - Open ldapts client
 * @param {Object} prepared - From {@link prepareSearch}
 * @returns {Promise<{base: string, entries: Object[], truncated: boolean}>} At most
 *   `effectiveMaxResults` raw entries
 */
export async function runSearch(resolved, client, prepared) {
  let base = resolved.searchBase;
  if (prepared.unit) {
    const { units, truncated: partial } = await fetchUnits(resolved, client);
    const unit =
      matchUnit(units, prepared.unit) ||
      (partial ? await lookupUnit(resolved, client, prepared.unit) : null);
    if (!unit) {
      throw new ToolArgumentError(
        partial
          ? `Unknown unit "${prepared.unit}". The directory lists only part of its units; pass a unitId such as "ou=Name", or search without "unit".`
          : `Unknown unit "${prepared.unit}". Call list_units of this directory and pass one of its unitId values.`
      );
    }
    base = unit.dn;
  }

  let entries;
  let truncated = false;
  client.lastSearchResultCode = null;
  try {
    ({ searchEntries: entries } = await client.search(base, {
      scope: 'sub',
      filter: prepared.filter,
      attributes: prepared.attributes,
      sizeLimit: prepared.sizeLimit,
      timeLimit: timeLimitSeconds(resolved.timeoutMs)
    }));
    // Result code 4: the server's own size limit cut the answer short.
    if (client.lastSearchResultCode === SIZE_LIMIT_EXCEEDED) truncated = true;
  } catch (error) {
    if (error instanceof SizeLimitExceededError) {
      // Result code 4 without entries: a partial result, not an error.
      entries = [];
      truncated = true;
    } else if (error instanceof TimeLimitExceededError) {
      throw new DirectoryConnectionError(
        'The directory stopped the search because it took too long. Narrow the search.',
        { code: 'time_limit', step: 'search', cause: error }
      );
    } else if (isTimeoutError(error)) {
      throw new DirectoryConnectionError('The directory did not answer the search in time.', {
        code: 'timeout',
        step: 'search',
        cause: error
      });
    } else {
      throw error;
    }
  }

  if (entries.length > prepared.effectiveMaxResults) {
    entries = entries.slice(0, prepared.effectiveMaxResults);
    truncated = true;
  }
  return { base, entries, truncated };
}

/**
 * The model-facing result of a search.
 * @returns {{directory: string, results: Object[], truncated: boolean, hint?: string}}
 */
export function searchResult(resolved, prepared, { entries, truncated }) {
  const results = entries.map(
    entry => mapEntryToPerson(entry, { directoryId: resolved.id, mapping: resolved.mapping }).person
  );
  const hints = [];
  if (truncated) {
    hints.push(
      `More people match than the ${prepared.effectiveMaxResults} returned. Narrow the search: add a first name, a function${resolved.units ? ', or a unit from list_units' : ''}. Do not page through the directory.`
    );
  }
  if (prepared.dropped.length > 0) {
    hints.push(`Ignored words shorter than 2 characters: ${prepared.dropped.join(', ')}.`);
  }
  if (results.length === 0 && !truncated) {
    hints.push('Nobody matches. Try the surname alone, or another spelling.');
  }
  return {
    directory: resolved.id,
    results,
    truncated,
    ...(hints.length > 0 && { hint: hints.join(' ') })
  };
}

/**
 * `<id>__search_people`.
 *
 * @param {Object} resolved - Resolved directory
 * @param {Object} args - Tool arguments
 * @param {Object} [deps] - `{ connect, connectOptions }` for tests
 * @returns {Promise<{directory: string, results: Object[], truncated: boolean, hint?: string}>}
 * @throws {ToolArgumentError|DirectoryConnectionError}
 */
export async function searchPeople(resolved, args = {}, deps = {}) {
  const prepared = prepareSearch(resolved, args);
  return withConnection(resolved, deps, async client =>
    searchResult(resolved, prepared, await runSearch(resolved, client, prepared))
  );
}

/**
 * `<id>__get_person`. The DN must lie inside the directory's search base, so
 * the tool cannot read entries elsewhere in the directory.
 *
 * @returns {Promise<Object>} The `Person`, or `{ directory, error }` when not found
 */
export async function getPerson(resolved, args = {}, deps = {}) {
  const personId = typeof args.personId === 'string' ? args.personId.trim() : '';
  if (!personId) {
    throw new ToolArgumentError('"personId" is required: the personId of a search result.');
  }
  if (!isDnWithin(personId, resolved.searchBase)) {
    throw new ToolArgumentError(
      "This personId does not belong to this directory. Pass the personId of a result from this directory's search_people."
    );
  }
  const attributes = requestedAttributes(resolved.mapping);
  return withConnection(resolved, deps, async client => {
    let entries = [];
    try {
      ({ searchEntries: entries } = await client.search(personId, {
        scope: 'base',
        filter: resolved.personFilter,
        attributes,
        sizeLimit: 2,
        timeLimit: timeLimitSeconds(resolved.timeoutMs)
      }));
    } catch (error) {
      if (!(error instanceof NoSuchObjectError)) throw error;
    }
    if (entries.length === 0) {
      return {
        directory: resolved.id,
        error: { code: 'not_found', message: 'No person with this personId in this directory.' }
      };
    }
    return mapEntryToPerson(entries[0], { directoryId: resolved.id, mapping: resolved.mapping })
      .person;
  });
}

/**
 * `<id>__list_units`: the units a search can be narrowed to, cached for an hour.
 * @returns {Promise<{directory: string, units: Array<{unitId: string, name: string}>, truncated: boolean}>}
 */
export async function listUnits(resolved, _args = {}, deps = {}) {
  if (!resolved.units) {
    throw new ToolArgumentError('This directory has no units.');
  }
  const cached = unitsCache.get(unitsCacheKey(resolved));
  const value =
    cached && cached.expiresAt > Date.now()
      ? cached.value
      : await withConnection(resolved, deps, client => fetchUnits(resolved, client));
  return {
    directory: resolved.id,
    units: value.units.map(({ unitId, name }) => ({ unitId, name })),
    truncated: value.truncated
  };
}
