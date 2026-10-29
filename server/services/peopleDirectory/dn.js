// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Distinguished names (RFC 4514): parsing, normalisation and containment.
 *
 * `get_person` takes a DN from the model and must only read entries inside the
 * directory's search base. That check is done on parsed RDNs, never on
 * strings: `cn=x\,ou=people,o=firma` ends with the text "ou=people,o=firma" but
 * is a single RDN whose value contains a comma, so it does not lie in
 * `ou=people,o=firma`; `o=Bund,c=DE.evil` is not inside `o=Bund,c=DE` either.
 *
 * A DN that does not parse is rejected, never guessed at.
 */

/** OIDs and long names of the naming attributes, mapped onto their short names. */
const ATTRIBUTE_TYPE_ALIASES = {
  '2.5.4.3': 'cn',
  commonname: 'cn',
  '2.5.4.4': 'sn',
  surname: 'sn',
  '2.5.4.6': 'c',
  countryname: 'c',
  '2.5.4.7': 'l',
  localityname: 'l',
  '2.5.4.8': 'st',
  stateorprovincename: 'st',
  '2.5.4.9': 'street',
  streetaddress: 'street',
  '2.5.4.10': 'o',
  organizationname: 'o',
  '2.5.4.11': 'ou',
  organizationalunitname: 'ou',
  '2.5.4.12': 'title',
  '0.9.2342.19200300.100.1.25': 'dc',
  domaincomponent: 'dc',
  '0.9.2342.19200300.100.1.1': 'uid',
  userid: 'uid'
};

const DESCR = /^[A-Za-z][A-Za-z0-9-]*$/;
const NUMERICOID = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))+$/;
const HEX = /^[0-9a-fA-F]$/;
/** Characters RFC 4514 lets a backslash escape. */
const ESCAPABLE = new Set(['\\', '"', '+', ',', ';', '<', '>', ' ', '#', '=']);
/** Characters a string value must not contain unescaped. */
const MUST_ESCAPE = new Set(['"', ';', '<', '>', '\u0000']);
/** Characters `escapeDnValue` escapes with a backslash wherever they appear. */
const DN_SPECIALS = new Set(['\\', '"', '+', ',', ';', '<', '>', '=']);

export class DnSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DnSyntaxError';
  }
}

/**
 * The short, lower-case name of an attribute type: `CN`, `commonName` and
 * `2.5.4.3` all become `cn`.
 * @param {string} type
 * @returns {string}
 */
export function normalizeAttributeType(type) {
  const lower = String(type).trim().toLowerCase();
  const withoutPrefix = lower.startsWith('oid.') ? lower.slice(4) : lower;
  return ATTRIBUTE_TYPE_ALIASES[withoutPrefix] || withoutPrefix;
}

/**
 * Normalise a value with caseIgnoreMatch, the equality rule of every naming
 * attribute involved here (`c`, `o`, `ou`, `l`, `dc`, `cn`, `uid`): Unicode
 * compatibility form, outer whitespace trimmed, inner whitespace collapsed,
 * case folded. A `#hex` (BER) value is compared as its lower-cased hex.
 * @param {string} value
 * @param {boolean} [isHex]
 * @returns {string}
 */
export function normalizeAttributeValue(value, isHex = false) {
  if (isHex) return `#${value.toLowerCase()}`;
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Parse a DN string into RDNs, leaf first, each a list of attribute
 * type/value pairs. Whitespace around `,`, `+` and `=` is tolerated, since
 * directories commonly return `cn=x, ou=y`.
 *
 * @param {string} input
 * @returns {Array<Array<{type: string, value: string, normType: string, normValue: string}>>}
 * @throws {DnSyntaxError} When the input is not a DN
 */
export function parseDn(input) {
  if (typeof input !== 'string') throw new DnSyntaxError('A DN must be a string');
  const text = input;
  if (text.trim() === '') return [];
  if (text.length > 4096) throw new DnSyntaxError('DN is too long');

  const rdns = [];
  let rdn = [];
  let i = 0;

  const skipSpaces = () => {
    while (i < text.length && text[i] === ' ') i++;
  };

  while (true) {
    skipSpaces();
    // Attribute type, up to "=".
    const typeStart = i;
    while (i < text.length && text[i] !== '=' && text[i] !== ',' && text[i] !== '+') i++;
    if (i >= text.length || text[i] !== '=') {
      throw new DnSyntaxError(`Missing "=" after attribute type at position ${typeStart}`);
    }
    const rawType = text.slice(typeStart, i).trim();
    const typeBody = rawType.toLowerCase().startsWith('oid.') ? rawType.slice(4) : rawType;
    if (!DESCR.test(typeBody) && !NUMERICOID.test(typeBody)) {
      throw new DnSyntaxError(`Invalid attribute type "${rawType}"`);
    }
    i++; // "="
    skipSpaces();

    let value;
    let isHex = false;
    if (text[i] === '#') {
      // hexstring = SHARP 1*hexpair
      i++;
      const hexStart = i;
      while (i < text.length && HEX.test(text[i])) i++;
      const hex = text.slice(hexStart, i);
      if (hex.length === 0 || hex.length % 2 !== 0) {
        throw new DnSyntaxError('Invalid hex value');
      }
      value = hex;
      isHex = true;
      skipSpaces();
      if (i < text.length && text[i] !== ',' && text[i] !== '+') {
        throw new DnSyntaxError('Invalid hex value');
      }
    } else {
      const bytes = [];
      let pendingSpaces = 0;
      const pushText = chars => {
        for (const byte of Buffer.from(chars, 'utf8')) bytes.push(byte);
      };
      while (i < text.length && text[i] !== ',' && text[i] !== '+') {
        const ch = text[i];
        if (ch === '\\') {
          if (i + 1 >= text.length) throw new DnSyntaxError('Dangling escape at end of DN');
          const next = text[i + 1];
          if (HEX.test(next) && HEX.test(text[i + 2] || '')) {
            pushText(' '.repeat(pendingSpaces));
            pendingSpaces = 0;
            bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
            i += 3;
            continue;
          }
          if (!ESCAPABLE.has(next)) {
            throw new DnSyntaxError(`Invalid escape "\\${next}"`);
          }
          pushText(' '.repeat(pendingSpaces) + next);
          pendingSpaces = 0;
          i += 2;
          continue;
        }
        if (MUST_ESCAPE.has(ch)) {
          throw new DnSyntaxError(`Unescaped "${ch === '\u0000' ? 'NUL' : ch}" in value`);
        }
        if (ch === ' ') {
          // Held back: unescaped trailing spaces are not part of the value.
          pendingSpaces++;
          i++;
          continue;
        }
        pushText(' '.repeat(pendingSpaces) + ch);
        pendingSpaces = 0;
        i++;
      }
      const decoded = Buffer.from(bytes);
      try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
      } catch {
        throw new DnSyntaxError('Value is not valid UTF-8');
      }
    }

    rdn.push({
      type: rawType,
      value,
      normType: normalizeAttributeType(rawType),
      normValue: normalizeAttributeValue(value, isHex)
    });

    if (i >= text.length) {
      rdns.push(rdn);
      break;
    }
    if (text[i] === '+') {
      i++;
      continue;
    }
    // ","
    rdns.push(rdn);
    rdn = [];
    i++;
    if (i >= text.length || text.slice(i).trim() === '') {
      throw new DnSyntaxError('DN ends with ","');
    }
  }

  return rdns;
}

/**
 * The comparable form of an RDN: its normalised type=value pairs, sorted, so a
 * multi-valued RDN compares as an unordered set.
 * @param {Array<{normType: string, normValue: string}>} rdn
 * @returns {string}
 */
function rdnKey(rdn) {
  return rdn
    .map(ava => `${ava.normType}=${JSON.stringify(ava.normValue)}`)
    .sort((a, b) => (a < b ? -1 : Number(a > b)))
    .join('+');
}

/**
 * Whether two parsed RDNs are equal.
 * @returns {boolean}
 */
export function rdnEquals(a, b) {
  return a.length === b.length && rdnKey(a) === rdnKey(b);
}

/**
 * Whether `dn` names an entry strictly below `base`: its RDN sequence ends with
 * the base's RDN sequence and is longer than it. Malformed input of either kind
 * is never inside anything.
 *
 * @param {string} dn
 * @param {string} base
 * @returns {boolean}
 */
export function isDnWithin(dn, base) {
  let entry;
  let root;
  try {
    entry = parseDn(dn);
    root = parseDn(base);
  } catch {
    return false;
  }
  if (entry.length <= root.length) return false;
  const offset = entry.length - root.length;
  for (let k = 0; k < root.length; k++) {
    if (!rdnEquals(entry[offset + k], root[k])) return false;
  }
  return true;
}

/**
 * Whether two DNs name the same entry.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function dnEquals(a, b) {
  try {
    const left = parseDn(a);
    const right = parseDn(b);
    return left.length === right.length && left.every((rdn, k) => rdnEquals(rdn, right[k]));
  } catch {
    return false;
  }
}

/**
 * The value of the RDN of type `type` nearest the leaf, as the directory wrote
 * it (unescaped, not normalised): `dn:l` of `cn=…,l=Karlsruhe,ou=MRI,…` is
 * "Karlsruhe". Null when the DN has no such component or does not parse.
 *
 * @param {string} dn
 * @param {string} type
 * @returns {string|null}
 */
export function dnComponent(dn, type) {
  const wanted = normalizeAttributeType(type);
  let rdns;
  try {
    rdns = parseDn(dn);
  } catch {
    return null;
  }
  for (const rdn of rdns) {
    const match = rdn.find(ava => ava.normType === wanted);
    if (match && match.value.trim()) return match.value.trim();
  }
  return null;
}

/**
 * Escape an attribute value for a DN string (RFC 4514 §2.4).
 * @param {string} value
 * @returns {string}
 */
export function escapeDnValue(value) {
  let escaped = '';
  for (const ch of String(value)) {
    if (ch === '\0') escaped += '\\00';
    else if (DN_SPECIALS.has(ch)) escaped += `\\${ch}`;
    else escaped += ch;
  }
  return escaped.replace(/^([ #])/, '\\$1').replace(/ $/, '\\ ');
}

/**
 * The string form of a parsed RDN, e.g. `ou=THW` or `cn=a+uid=b`.
 * @param {Array<{type: string, value: string}>} rdn
 * @returns {string}
 */
export function formatRdn(rdn) {
  return rdn.map(ava => `${ava.type}=${escapeDnValue(ava.value)}`).join('+');
}
