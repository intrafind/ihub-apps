// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import {
  FORBIDDEN_ATTRIBUTES,
  MAPPED_PERSON_FIELDS,
  SEARCH_PRESET_IDS
} from '../services/peopleDirectory/presets.js';

/**
 * Schema of one people directory, the shape `services/peopleDirectory/*`
 * works on. A directory is an installation of the built-in integration
 * `com.intrafind/ldap-directory`; `services/integrations/ldapDirectoryConfig.js`
 * turns the installation's values into this shape. Every enabled directory
 * becomes the tools `<id>__search_people`, `<id>__get_person` and, with
 * `units`, `<id>__list_units` (see services/peopleDirectory/PeopleDirectoryService.js);
 * with `browse` on, also the admin LDAP browser tools `<id>__browse_search`,
 * `<id>__browse_read` and `<id>__browse_children` (services/peopleDirectory/LdapBrowser.js).
 *
 * Secrets are never stored here: a service bind names a credential profile
 * (`passwordRef`), and the schema refuses anything else that looks like a
 * password. Certificate policy is not configurable through `tlsOptions`
 * either; it comes only from `tlsCa` and the platform's SSL whitelist.
 */

/**
 * Directory ids are installation ids (`integrationsConfigSchema`), and become
 * the prefix of tool ids (`<id>__search_people`). The installation service
 * refuses `__` inside an id, so the prefix parses back unambiguously.
 */
export const PEOPLE_DIRECTORY_ID_PATTERN = /^(?!.*__)[a-zA-Z0-9._-]{1,64}$/;

/** Name of a trust anchor in the certificate store `contents/config/certs/<name>.pem`. */
export const CERTIFICATE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export const PEOPLE_DIRECTORY_DEFAULTS = Object.freeze({
  maxResults: 10,
  timeoutMs: 8000,
  concurrency: 2,
  requestDelayMs: 0
});

export const PEOPLE_DIRECTORY_LIMITS = Object.freeze({
  maxResults: 50,
  timeoutMs: 30000,
  concurrency: 10,
  requestDelayMs: 60000
});

/** The admin LDAP browser's default and highest result limit per search. */
export const LDAP_BROWSE_DEFAULTS = Object.freeze({ maxResults: 50 });
export const LDAP_BROWSE_LIMITS = Object.freeze({ maxResults: 200 });

const localizedStringSchema = z.record(
  z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format'),
  z.string().min(1)
);

const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const attributeNameSchema = z
  .string()
  .regex(ATTRIBUTE_NAME, 'Not an LDAP attribute name')
  .refine(name => !FORBIDDEN_ATTRIBUTES.has(name.toLowerCase()), {
    message: 'This attribute never leaves the directory'
  });

/**
 * One mapping source: an attribute (`mail`), a DN component (`dn:l`), or
 * attributes joined with a space (`givenName sn`).
 */
const mappingSourceSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    source => {
      if (source.startsWith('dn:')) return ATTRIBUTE_NAME.test(source.slice(3));
      return source.split(/\s+/).every(part => ATTRIBUTE_NAME.test(part));
    },
    { message: 'Use an attribute name, "dn:<type>" or attribute names separated by spaces' }
  )
  .refine(
    source =>
      source.startsWith('dn:') ||
      source.split(/\s+/).every(part => !FORBIDDEN_ATTRIBUTES.has(part.toLowerCase())),
    { message: 'This attribute never leaves the directory' }
  );

const attributeMappingSchema = z
  .object(
    Object.fromEntries(
      MAPPED_PERSON_FIELDS.map(field => [
        field,
        z.union([mappingSourceSchema, z.array(mappingSourceSchema).max(8)]).optional()
      ])
    )
  )
  .strict();

/**
 * The only TLS settings a directory (or an inherited sign-in provider) may
 * change. Everything that weakens verification — `rejectUnauthorized`,
 * `checkServerIdentity`, `ca`, `servername` — is rejected here.
 */
export const ALLOWED_TLS_OPTION_KEYS = ['minVersion', 'maxVersion', 'ciphers'];

const tlsVersionSchema = z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);

const tlsOptionsSchema = z
  .object({
    minVersion: tlsVersionSchema.optional(),
    maxVersion: tlsVersionSchema.optional(),
    ciphers: z.string().min(1).max(2000).optional()
  })
  .strict();

const bindSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('anonymous') }).strict(),
  z
    .object({
      mode: z.literal('service'),
      dn: z.string().trim().min(1).max(1024),
      passwordRef: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .describe('Id of the credential profile holding the bind password')
    })
    .strict()
]);

/**
 * The admin LDAP browser of a directory: raw entries for admins, off unless
 * switched on. It shares the directory's connection, and by default its bind.
 *
 * - `groups`: who may browse, separate from the directory's `groups`. Never
 *   `*`: raw directory content is not for every caller.
 * - `base`: the DN the browser is confined to; the directory's base DN when
 *   left out.
 * - `bind`: a separate (ideally read-only) account for browsing.
 * - `denyAttributes`: attributes withheld on top of the built-in list.
 */
const browseSchema = z
  .object({
    enabled: z.boolean().prefault(false),
    groups: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine(group => group !== '*', {
            message: 'The LDAP browser is never open to every caller; name groups'
          })
      )
      .prefault(['admins']),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(LDAP_BROWSE_LIMITS.maxResults)
      .prefault(LDAP_BROWSE_DEFAULTS.maxResults),
    base: z.string().trim().min(1).max(1024).optional(),
    bind: bindSchema.optional(),
    denyAttributes: z
      .array(z.string().regex(ATTRIBUTE_NAME, 'Not an LDAP attribute name'))
      .max(64)
      .optional()
  })
  .strict();

/**
 * Whether a value is a usable `ldap://` or `ldaps://` URL: a host, an optional
 * port, and nothing else (no credentials, path, query or fragment).
 * @param {string} value
 * @returns {boolean}
 */
export function isLdapUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'ldap:' && url.protocol !== 'ldaps:') return false;
  if (!url.hostname || url.username || url.password) return false;
  if (url.search || url.hash) return false;
  return url.pathname === '' || url.pathname === '/';
}

const ldapUrlSchema = z
  .string()
  .trim()
  .refine(isLdapUrl, { message: 'Use ldaps://host:636 or ldap://host:389' });

const hostPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(\*\.|\.)?[A-Za-z0-9.:[\]-]+$/, 'Not a host name or pattern');

export const peopleDirectorySchema = z
  .object({
    id: z
      .string()
      .regex(
        PEOPLE_DIRECTORY_ID_PATTERN,
        'Use letters, digits, dots, hyphens and underscores (no "__")'
      ),
    enabled: z.boolean().prefault(true),
    type: z.enum(['ldap']).prefault('ldap'),
    authProvider: z.string().trim().min(1).optional(),
    url: ldapUrlSchema.optional(),
    starttls: z.boolean().optional(),
    baseDn: z.string().trim().min(1).max(1024).optional(),
    preset: z.enum(SEARCH_PRESET_IDS).optional(),
    tlsOptions: tlsOptionsSchema.optional(),
    bind: bindSchema.optional(),
    searchBase: z.string().trim().min(1).max(1024).optional(),
    personFilter: z
      .string()
      .trim()
      .max(2000)
      .regex(/^\(.*\)$/s, 'An LDAP filter in parentheses, e.g. (objectClass=person)')
      .optional(),
    searchAttributes: z.array(attributeNameSchema).min(1).max(12).optional(),
    attributeMapping: attributeMappingSchema.optional(),
    units: z.boolean().prefault(false),
    allowPlaintext: z.boolean().prefault(false),
    tlsCa: z
      .array(z.string().regex(CERTIFICATE_NAME_PATTERN, 'Not a certificate name'))
      .max(16)
      .optional(),
    allowedHosts: z.array(hostPatternSchema).max(32).optional(),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(PEOPLE_DIRECTORY_LIMITS.maxResults)
      .prefault(PEOPLE_DIRECTORY_DEFAULTS.maxResults),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(PEOPLE_DIRECTORY_LIMITS.timeoutMs)
      .prefault(PEOPLE_DIRECTORY_DEFAULTS.timeoutMs),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(PEOPLE_DIRECTORY_LIMITS.concurrency)
      .prefault(PEOPLE_DIRECTORY_DEFAULTS.concurrency),
    requestDelayMs: z
      .number()
      .int()
      .min(0)
      .max(PEOPLE_DIRECTORY_LIMITS.requestDelayMs)
      .prefault(PEOPLE_DIRECTORY_DEFAULTS.requestDelayMs),
    // Who may use the directory, ANDed with the tool grants. "*" opens it to
    // every caller, anonymous ones included; an empty list closes it.
    groups: z.array(z.string().trim().min(1)).prefault(['authenticated']),
    dataFlow: z.enum(['internal', 'external']).prefault('internal'),
    browse: browseSchema.optional(),
    name: localizedStringSchema.optional(),
    description: localizedStringSchema.optional()
  })
  .strict()
  .superRefine((directory, ctx) => {
    if (!directory.authProvider) {
      if (!directory.url) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'A URL is required unless the directory reuses a sign-in provider'
        });
      }
      if (!directory.baseDn) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseDn'],
          message: 'A base DN is required unless the directory reuses a sign-in provider'
        });
      }
    }
  });

export const peopleDirectoriesFileSchema = z
  .object({
    directories: z.array(peopleDirectorySchema).prefault([])
  })
  .superRefine((file, ctx) => {
    const seen = new Set();
    file.directories.forEach((directory, index) => {
      if (seen.has(directory.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['directories', index, 'id'],
          message: `Duplicate directory id "${directory.id}"`
        });
      }
      seen.add(directory.id);
    });
  });
