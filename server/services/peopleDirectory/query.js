// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { escapeLdapFilterValue } from '../../utils/ldapProviderConfig.js';

/**
 * Query construction for people directory searches.
 *
 * The model never supplies an LDAP filter. It sends free text and a few
 * structured fields; this module turns them into a filter in which every value
 * is RFC 4515-escaped, and checks the result limit before anything reaches the
 * directory:
 *
 *   (&<personFilter>
 *     (|(cn=*greiner*)(sn=*greiner*)(givenName=*greiner*)(mail=*greiner*))   one OR-block per token
 *     (|(cn=*ralf*)(sn=*ralf*)(givenName=*ralf*)(mail=*ralf*))
 *     (sn=greiner*)                                                         structured fields, prefix match
 *   )
 */

/** Shortest search word: a one-letter substring scan matches most of a directory. */
export const MIN_TOKEN_LENGTH = 2;
/** Most search words used; more only lengthen the filter. */
export const MAX_TOKENS = 6;
export const MAX_QUERY_LENGTH = 200;

/** A tool argument the model can correct: it gets the message back, no search is sent. */
export class ToolArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = 'invalid_arguments';
  }
}

/**
 * Remove wildcards the model may add (the search already matches substrings)
 * and surrounding whitespace.
 * @param {*} value
 * @returns {string}
 */
function cleanValue(value) {
  return typeof value === 'string' ? value.replace(/\*/g, '').trim() : '';
}

/**
 * Split free text into search words. Words shorter than two characters (an
 * initial, a stray letter) are dropped and reported, so "Erika M" searches for
 * "Erika"; a query with no usable word at all is refused.
 *
 * @param {*} query
 * @returns {{tokens: string[], dropped: string[]}}
 * @throws {ToolArgumentError}
 */
export function tokenizeQuery(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new ToolArgumentError('"query" is required: a name, an e-mail address or a few words.');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ToolArgumentError(`"query" is too long; use at most ${MAX_QUERY_LENGTH} characters.`);
  }
  const words = query
    .split(/[\s,;]+/)
    .map(cleanValue)
    .filter(Boolean);
  const tokens = [];
  const dropped = [];
  for (const word of words) {
    if ([...word].length < MIN_TOKEN_LENGTH) dropped.push(word);
    else if (!tokens.includes(word)) tokens.push(word);
  }
  if (tokens.length === 0) {
    throw new ToolArgumentError(
      `"query" needs at least one word of ${MIN_TOKEN_LENGTH} or more characters (wildcards are not needed: words already match anywhere in a name). Search by surname, full name or e-mail address.`
    );
  }
  if (tokens.length > MAX_TOKENS) {
    throw new ToolArgumentError(
      `"query" has too many words; use at most ${MAX_TOKENS}, e.g. first and last name.`
    );
  }
  return { tokens, dropped };
}

/**
 * Check a structured, prefix-matched value (`lastName`, `jobTitle`, …).
 * @param {string} field
 * @param {*} value
 * @returns {string|null} The cleaned value, or null when not given
 * @throws {ToolArgumentError}
 */
export function cleanStructuredValue(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ToolArgumentError(`"${field}" must be text.`);
  }
  const cleaned = cleanValue(value);
  if ([...cleaned].length < MIN_TOKEN_LENGTH) {
    throw new ToolArgumentError(
      `"${field}" needs at least ${MIN_TOKEN_LENGTH} characters; leave it out instead.`
    );
  }
  if (cleaned.length > MAX_QUERY_LENGTH) {
    throw new ToolArgumentError(`"${field}" is too long.`);
  }
  return cleaned;
}

/**
 * The number of results to return for a request.
 *
 * A requested value must be an integer of at least 1: `ldapts` sends
 * `sizeLimit: 0` as "no limit", so 0, negative, fractional and non-numeric
 * values are refused before any limit is computed. A valid value above the
 * directory's limit is clamped, never refused.
 *
 * @param {*} requested - `maxResults` from the tool call (may be undefined)
 * @param {number} directoryMax - The directory's `maxResults`
 * @returns {{effectiveMaxResults: number, sizeLimit: number}} `sizeLimit` asks for one more
 *   entry than is returned, so a full page tells "there are more" apart from "exactly that many"
 * @throws {ToolArgumentError}
 */
export function resolveResultLimit(requested, directoryMax) {
  const max = Number.isInteger(directoryMax) && directoryMax >= 1 ? directoryMax : 1;
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
      throw new ToolArgumentError(
        `"maxResults" must be a whole number from 1 to ${max}; leave it out to get up to ${max} results.`
      );
    }
  }
  const effectiveMaxResults = Math.min(requested ?? max, max);
  return { effectiveMaxResults, sizeLimit: effectiveMaxResults + 1 };
}

/**
 * LDAP's search `timeLimit` is in seconds; the directory's `timeoutMs` is in
 * milliseconds. Rounded up, so a short timeout never becomes "no limit" (0).
 * @param {number} timeoutMs
 * @returns {number}
 */
export function timeLimitSeconds(timeoutMs) {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/**
 * `(|(a=*v*)(b=*v*))` for one search word.
 * @param {string[]} attributes
 * @param {string} token
 * @returns {string}
 */
function substringBlock(attributes, token) {
  const value = escapeLdapFilterValue(token);
  return `(|${attributes.map(attribute => `(${attribute}=*${value}*)`).join('')})`;
}

/**
 * `(a=v*)`, or `(|(a=v*)(b=v*))` for a field mapped to several attributes.
 * @param {string[]} attributes
 * @param {string} rawValue
 * @returns {string}
 */
function prefixBlock(attributes, rawValue) {
  const value = escapeLdapFilterValue(rawValue);
  const parts = attributes.map(attribute => `(${attribute}=${value}*)`);
  return parts.length === 1 ? parts[0] : `(|${parts.join('')})`;
}

/**
 * Build the search filter.
 *
 * @param {Object} options
 * @param {string} options.personFilter - The preset's (or directory's) person filter
 * @param {string[]} options.searchAttributes - Attributes a search word is matched against
 * @param {string[]} options.tokens - Search words from {@link tokenizeQuery}
 * @param {Array<{attributes: string[], value: string}>} [options.structured] - Prefix-matched fields
 * @returns {string}
 */
export function buildSearchFilter({ personFilter, searchAttributes, tokens, structured = [] }) {
  if (!Array.isArray(searchAttributes) || searchAttributes.length === 0) {
    throw new Error('No search attributes configured');
  }
  const blocks = tokens.map(token => substringBlock(searchAttributes, token));
  for (const { attributes, value } of structured) {
    if (attributes.length > 0) blocks.push(prefixBlock(attributes, value));
  }
  return `(&${personFilter}${blocks.join('')})`;
}
