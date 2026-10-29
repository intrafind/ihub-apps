// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { dnComponent } from './dn.js';
import { MAPPED_PERSON_FIELDS, attributesOfSource } from './presets.js';

/**
 * Map raw directory entries onto `Person`.
 *
 * Every field is present: one the directory does not map, or has no value for,
 * is `null`, so the model can tell "unknown" from "not asked". Each field's
 * sources are tried in order and the first one with a value wins:
 *
 * - `mail` — an attribute (case-insensitive, first non-empty value);
 * - `dn:l` — the nearest DN component of that type (x500.bund.de withholds
 *   `l` from anonymous clients, but the city is in the DN);
 * - `givenName sn` — attributes joined with a space, only when all have a value.
 */

/**
 * First non-empty string value of a possibly multi-valued attribute.
 * Binary values (Buffers) are never returned.
 * @param {*} raw
 * @returns {string|null}
 */
function firstText(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Attribute lookup by name, ignoring case: directories return attribute names
 * in whatever case their schema uses.
 * @param {Object} entry
 * @returns {(name: string) => string|null}
 */
function attributeReader(entry) {
  const byName = new Map();
  for (const [key, value] of Object.entries(entry || {})) {
    if (key === 'dn') continue;
    byName.set(key.toLowerCase(), value);
  }
  return name => firstText(byName.get(name.toLowerCase()));
}

/**
 * Read one mapping source from an entry.
 * @param {Object} entry
 * @param {(name: string) => string|null} read
 * @param {string} source
 * @returns {string|null}
 */
function readSource(entry, read, source) {
  if (source.startsWith('dn:')) {
    return typeof entry?.dn === 'string' ? dnComponent(entry.dn, source.slice(3)) : null;
  }
  const parts = attributesOfSource(source);
  if (parts.length === 1) return read(parts[0]);
  const values = parts.map(read);
  return values.every(Boolean) ? values.join(' ') : null;
}

/**
 * The attributes a search must request to fill every mapped field: never `*`,
 * so attributes nobody mapped (certificates, photos, password hashes) never
 * leave the directory.
 *
 * @param {Object<string, string[]>} mapping - Resolved mapping (`resolveMapping`)
 * @returns {string[]}
 */
export function requestedAttributes(mapping) {
  const names = new Map();
  for (const field of MAPPED_PERSON_FIELDS) {
    for (const source of mapping[field] || []) {
      for (const attribute of attributesOfSource(source)) {
        names.set(attribute.toLowerCase(), attribute);
      }
    }
  }
  // An empty list would ask for every attribute; "1.1" asks for none (the DN
  // still comes back, which is all `dn:` sources need).
  return names.size > 0 ? [...names.values()] : ['1.1'];
}

/**
 * Map one entry onto a `Person`.
 *
 * @param {Object} entry - Entry as returned by ldapts (`dn` plus attributes)
 * @param {Object} options
 * @param {string} options.directoryId
 * @param {Object<string, string[]>} options.mapping - Resolved mapping
 * @returns {{person: Object, usedSources: Object<string, string|null>}}
 */
export function mapEntryToPerson(entry, { directoryId, mapping }) {
  const read = attributeReader(entry);
  const person = {
    directory: directoryId,
    personId: typeof entry?.dn === 'string' ? entry.dn : null
  };
  const usedSources = {};
  for (const field of MAPPED_PERSON_FIELDS) {
    person[field] = null;
    usedSources[field] = null;
    for (const source of mapping[field] || []) {
      const value = readSource(entry, read, source);
      if (value) {
        person[field] = value;
        usedSources[field] = source;
        break;
      }
    }
  }
  return { person, usedSources };
}
