// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { FilterParser, NoSuchObjectError } from 'ldapts';
import { boundedSearch, withConnection } from './LdapDirectory.js';
import { dnEquals, formatRdn, isDnWithin, parseDn } from './dn.js';
import { FORBIDDEN_ATTRIBUTES } from './presets.js';
import { ToolArgumentError, resolveResultLimit, timeLimitSeconds } from './query.js';

/**
 * The admin LDAP browser: `<id>__browse_search`, `<id>__browse_read` and
 * `<id>__browse_children`. Raw entries, any attribute, for the admins in
 * `browse.groups`; the runner checks access and writes the audit record.
 *
 * Unlike people search, the model writes the LDAP filter. It is parsed, never
 * passed through as text, and refused when it names an attribute on the deny
 * list, so a secret cannot be guessed one character at a time with
 * `(userPassword=a*)`. Denied attributes are also stripped from every entry and
 * named in its `omitted` list.
 *
 * Every DN — the search base, the entry read, the parent listed — must lie in
 * the browse base, and so must every entry returned.
 */

/** Longest filter accepted. */
export const MAX_FILTER_LENGTH = 1000;
/** Longest value returned before it is cut. */
export const MAX_VALUE_LENGTH = 500;
/** Rough ceiling of one response, in characters of JSON. */
export const MAX_RESPONSE_LENGTH = 30000;
/** Most children listed at once. */
export const MAX_CHILDREN = 200;
const MAX_ATTRIBUTES = 50;

const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SCOPES = new Set(['base', 'one', 'sub']);

/** OIDs of denied attributes, for servers that return a type by OID. */
const FORBIDDEN_OIDS = new Set([
  '2.5.4.35', // userPassword
  '2.5.4.36', // userCertificate
  '2.5.4.37', // cACertificate
  '0.9.2342.19200300.100.1.60', // jpegPhoto
  '1.2.840.113556.1.4.90' // unicodePwd
]);

/**
 * An attribute type as compared against the deny list: lower-case, without
 * options (`userPassword;binary` → `userpassword`).
 * @param {string} name
 * @returns {string}
 */
function normalizeAttribute(name) {
  return String(name).split(';')[0].trim().toLowerCase();
}

/**
 * Whether an attribute never leaves the directory: the built-in list
 * ({@link FORBIDDEN_ATTRIBUTES}) or the directory's `browse.denyAttributes`.
 * @param {string} name
 * @param {Set<string>} extra - Lower-cased `browse.denyAttributes`
 * @returns {boolean}
 */
export function isDeniedAttribute(name, extra = new Set()) {
  const type = normalizeAttribute(name);
  return FORBIDDEN_ATTRIBUTES.has(type) || FORBIDDEN_OIDS.has(type) || extra.has(type);
}

function denySet(browse) {
  return new Set((browse.denyAttributes || []).map(normalizeAttribute));
}

/**
 * Parse a filter from the model and check every attribute it names, nested and
 * negated clauses included.
 *
 * @param {*} text - The `filter` argument
 * @param {Set<string>} deny - Lower-cased `browse.denyAttributes`
 * @returns {import('ldapts').Filter}
 * @throws {ToolArgumentError}
 */
export function parseBrowseFilter(text, deny = new Set()) {
  const filter = typeof text === 'string' ? text.trim() : '';
  if (!filter) throw new ToolArgumentError('"filter" is required, e.g. (objectClass=*).');
  if (filter.length > MAX_FILTER_LENGTH) {
    throw new ToolArgumentError(`The filter is longer than ${MAX_FILTER_LENGTH} characters.`);
  }
  let parsed;
  try {
    parsed = FilterParser.parseString(filter);
  } catch (error) {
    throw new ToolArgumentError(`Not a valid LDAP filter (RFC 4515): ${error.message}`);
  }
  const check = node => {
    if (Array.isArray(node.filters)) return node.filters.forEach(check);
    if (node.filter) return check(node.filter);
    // An extensible match without a type compares every attribute that
    // supports the matching rule, denied ones included.
    const attribute = node.attribute ?? node.matchType;
    if (!attribute) {
      throw new ToolArgumentError(
        'An extensible match needs an attribute type, e.g. (cn:caseExactMatch:=Name).'
      );
    }
    if (isDeniedAttribute(attribute, deny)) {
      throw new ToolArgumentError(
        `The filter uses "${attribute}", which never leaves the directory. Leave it out.`
      );
    }
  };
  check(parsed);
  return parsed;
}

/**
 * The attributes to request: all user attributes by default, or the names the
 * model listed.
 * @param {*} list - The `attributes` argument
 * @param {Set<string>} deny
 * @returns {string[]}
 * @throws {ToolArgumentError}
 */
function requestedAttributes(list, deny) {
  if (list === undefined || list === null) return ['*'];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ATTRIBUTES) {
    throw new ToolArgumentError(
      `"attributes" is a list of 1 to ${MAX_ATTRIBUTES} attribute names; leave it out for all.`
    );
  }
  for (const name of list) {
    if (typeof name !== 'string' || !ATTRIBUTE_NAME.test(name)) {
      throw new ToolArgumentError(`"${name}" is not an attribute name.`);
    }
    if (isDeniedAttribute(name, deny)) {
      throw new ToolArgumentError(`"${name}" never leaves the directory. Leave it out.`);
    }
  }
  return [...new Set(list)];
}

/**
 * A DN argument, checked to lie in the browse base (or be it).
 * @param {*} value
 * @param {string} base - The browse base
 * @param {string} name - Argument name, for the message
 * @returns {string}
 * @throws {ToolArgumentError}
 */
function dnInBase(value, base, name) {
  if (value === undefined || value === null || value === '') return base;
  const dn = typeof value === 'string' ? value.trim() : '';
  if (!dn || !(dnEquals(dn, base) || isDnWithin(dn, base))) {
    throw new ToolArgumentError(`"${name}" must be a full DN inside ${base}.`);
  }
  return dn;
}

/** Whether a string decoded from binary data still looks binary. */
function looksBinary(text) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/.test(text);
}

function presentValue(value) {
  if (Buffer.isBuffer(value)) return `[binary, ${value.length} bytes]`;
  const text = String(value);
  if (looksBinary(text)) return `[binary, ${Buffer.byteLength(text)} bytes]`;
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH)}… (${text.length} characters)`
    : text;
}

/**
 * An entry as the model sees it: `{ dn, attributes, omitted? }`, every value a
 * list, denied attributes left out and named.
 * @param {Object} entry - ldapts search entry
 * @param {Set<string>} deny
 * @returns {Object}
 */
export function presentEntry(entry, deny = new Set()) {
  const attributes = {};
  const omitted = [];
  for (const [name, raw] of Object.entries(entry || {})) {
    if (name === 'dn') continue;
    if (isDeniedAttribute(name, deny)) {
      omitted.push(name);
      continue;
    }
    attributes[name] = (Array.isArray(raw) ? raw : [raw]).map(presentValue);
  }
  return { dn: entry.dn, attributes, ...(omitted.length > 0 && { omitted }) };
}

/**
 * Keep items until the response would pass {@link MAX_RESPONSE_LENGTH}.
 * @returns {{kept: Object[], cut: boolean}}
 */
function withinResponseSize(items) {
  const kept = [];
  let size = 0;
  for (const item of items) {
    size += JSON.stringify(item).length;
    if (size > MAX_RESPONSE_LENGTH && kept.length > 0) return { kept, cut: true };
    kept.push(item);
  }
  return { kept, cut: false };
}

/** Run `work` connected with the browser's bind (the directory's by default). */
function withBrowseConnection(resolved, deps, work) {
  return withConnection({ ...resolved, bind: resolved.browse.bind }, deps, work);
}

/**
 * `<id>__browse_search`.
 *
 * @param {Object} resolved - Resolved directory with `browse`
 * @param {Object} args - `filter`, `base`, `scope`, `attributes`, `maxResults`
 * @param {Object} [deps] - `{ connect, connectOptions }` for tests
 * @returns {Promise<Object>}
 * @throws {ToolArgumentError|DirectoryConnectionError}
 */
export async function browseSearch(resolved, args = {}, deps = {}) {
  const { browse } = resolved;
  const deny = denySet(browse);
  const filter = parseBrowseFilter(args.filter, deny);
  const base = dnInBase(args.base, browse.base, 'base');
  const scope = args.scope ?? 'sub';
  if (!SCOPES.has(scope)) {
    throw new ToolArgumentError('"scope" is one of base, one or sub.');
  }
  const attributes = requestedAttributes(args.attributes, deny);
  const { effectiveMaxResults, sizeLimit } = resolveResultLimit(args.maxResults, browse.maxResults);

  return withBrowseConnection(resolved, deps, async client => {
    let outcome;
    try {
      outcome = await boundedSearch(client, base, {
        scope,
        filter,
        attributes,
        sizeLimit,
        timeLimit: timeLimitSeconds(resolved.timeoutMs)
      });
    } catch (error) {
      if (error instanceof NoSuchObjectError) {
        return notFound(resolved, `No entry at ${base}.`);
      }
      throw error;
    }
    let { truncated } = outcome;
    let entries = outcome.entries.filter(entry => inBase(entry, browse.base));
    if (entries.length > effectiveMaxResults) {
      entries = entries.slice(0, effectiveMaxResults);
      truncated = true;
    }
    const { kept, cut } = withinResponseSize(entries.map(entry => presentEntry(entry, deny)));
    return {
      directory: resolved.id,
      base,
      scope,
      entries: kept,
      truncated: truncated || cut,
      ...((truncated || cut) && {
        hint: 'More entries match than were returned. Narrow the filter or the base, or request fewer attributes.'
      }),
      ...(kept.length === 0 && !truncated && { hint: 'No entry matches.' })
    };
  });
}

/**
 * `<id>__browse_read`: one entry by its DN.
 * @returns {Promise<Object>}
 */
export async function browseRead(resolved, args = {}, deps = {}) {
  const { browse } = resolved;
  if (typeof args.dn !== 'string' || !args.dn.trim()) {
    throw new ToolArgumentError('"dn" is required: the full DN of the entry.');
  }
  const deny = denySet(browse);
  const dn = dnInBase(args.dn, browse.base, 'dn');
  const attributes = requestedAttributes(args.attributes, deny);
  return withBrowseConnection(resolved, deps, async client => {
    let entries;
    try {
      ({ entries } = await boundedSearch(client, dn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes,
        sizeLimit: 1,
        timeLimit: timeLimitSeconds(resolved.timeoutMs)
      }));
    } catch (error) {
      if (error instanceof NoSuchObjectError) return notFound(resolved, `No entry at ${dn}.`);
      throw error;
    }
    const entry = entries.find(candidate => inBase(candidate, browse.base));
    if (!entry) return notFound(resolved, `No entry at ${dn}.`);
    const presented = presentEntry(entry, deny);
    const { kept, cut } = withinResponseSize(
      Object.entries(presented.attributes).map(([name, values]) => ({ name, values }))
    );
    return {
      directory: resolved.id,
      entry: {
        ...presented,
        attributes: Object.fromEntries(kept.map(({ name, values }) => [name, values]))
      },
      truncated: cut,
      ...(cut && {
        hint: 'The entry is too large to return whole. Ask for the attributes you need by name.'
      })
    };
  });
}

/**
 * `<id>__browse_children`: the direct children of a DN, without attributes.
 * @returns {Promise<Object>}
 */
export async function browseChildren(resolved, args = {}, deps = {}) {
  const { browse } = resolved;
  const parent = dnInBase(args.dn, browse.base, 'dn');
  return withBrowseConnection(resolved, deps, async client => {
    let outcome;
    try {
      outcome = await boundedSearch(client, parent, {
        scope: 'one',
        filter: '(objectClass=*)',
        attributes: ['objectClass'],
        sizeLimit: MAX_CHILDREN + 1,
        timeLimit: timeLimitSeconds(resolved.timeoutMs)
      });
    } catch (error) {
      if (error instanceof NoSuchObjectError) return notFound(resolved, `No entry at ${parent}.`);
      throw error;
    }
    let { truncated } = outcome;
    let entries = outcome.entries.filter(entry => inBase(entry, browse.base));
    if (entries.length > MAX_CHILDREN) {
      entries = entries.slice(0, MAX_CHILDREN);
      truncated = true;
    }
    const children = entries.map(entry => {
      let rdn = entry.dn;
      try {
        rdn = formatRdn(parseDn(entry.dn)[0]);
      } catch {
        // keep the DN as it came
      }
      const objectClass = entry.objectClass ?? entry.objectclass ?? [];
      return {
        dn: entry.dn,
        rdn,
        objectClass: (Array.isArray(objectClass) ? objectClass : [objectClass]).map(String)
      };
    });
    const { kept, cut } = withinResponseSize(children);
    return {
      directory: resolved.id,
      dn: parent,
      children: kept,
      truncated: truncated || cut,
      ...((truncated || cut) && {
        hint: 'There are more children than were listed. Use browse_search with scope "one" and a filter to find the one you need.'
      })
    };
  });
}

function inBase(entry, base) {
  return typeof entry?.dn === 'string' && (dnEquals(entry.dn, base) || isDnWithin(entry.dn, base));
}

function notFound(resolved, message) {
  return { directory: resolved.id, error: { code: 'not_found', message } };
}
