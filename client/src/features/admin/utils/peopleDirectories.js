// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Form logic for the people directory admin pages
 * (`/admin/integrations/people-directories`). Pure functions only, so the
 * pages stay presentation and this file can be unit tested without React.
 *
 * The editor works on a *form* object, which differs from a stored directory
 * (`contents/config/peopleDirectories.json`, schema in
 * `server/validators/peopleDirectorySchema.js`) in four ways:
 *   - lists (search attributes, allowed hosts, mapping candidates) are the text
 *     the admin types, parsed only when the form is turned back into a directory;
 *   - numbers are strings, so an empty field means "use the default";
 *   - `sourceMode`, `bindMode` and the tri-state `starttls` say which of the
 *     alternatives the admin picked, where the stored object only omits fields;
 *   - name and description always carry English and German.
 *
 * `formToDirectory` drops every empty optional field: the schema rejects empty
 * strings, and an omitted field takes the sign-in provider's value or the
 * preset's.
 */

/** Directory ids become the tool id prefix `<id>__search_people`, so no `_`. */
export const DIRECTORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Ids an app can name to mean something else (`peopleDirectories` = every directory). */
export const RESERVED_DIRECTORY_IDS = ['peopledirectories'];

/** Name of a trust anchor in the certificate store. */
export const CERTIFICATE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** The shipped "People search" app, offered for enabling with the first directory. */
export const PEOPLE_SEARCH_APP_ID = 'people-directory';

/** The languages the model-facing name and description are edited in. */
export const FORM_LANGUAGES = ['en', 'de'];

/** Preset used when neither the directory nor its sign-in provider names one. */
export const DEFAULT_PRESET_ID = 'openldap';

/** The limit fields, in the order the form shows them. */
export const LIMIT_FIELDS = ['maxResults', 'timeoutMs', 'concurrency', 'requestDelayMs'];

/** Used until `GET /admin/people-directories/presets` answers. */
export const FALLBACK_LIMIT_DEFAULTS = Object.freeze({
  maxResults: 10,
  timeoutMs: 8000,
  concurrency: 2,
  requestDelayMs: 0
});

/** Upper bounds, used until the presets endpoint answers or when it leaves one out. */
export const FALLBACK_LIMIT_MAXIMA = Object.freeze({
  maxResults: 50,
  timeoutMs: 30000,
  concurrency: 10,
  requestDelayMs: 60000
});

/** Lower bounds, as in the server schema. */
export const LIMIT_MINIMA = Object.freeze({
  maxResults: 1,
  timeoutMs: 1000,
  concurrency: 1,
  requestDelayMs: 0
});

/** The `Person` fields a mapping fills, used until the presets endpoint answers. */
export const DEFAULT_PERSON_FIELDS = [
  'name',
  'firstName',
  'lastName',
  'salutation',
  'academicTitle',
  'jobTitle',
  'department',
  'organization',
  'location',
  'email',
  'phone',
  'fax',
  'mobile',
  'managerId'
];

/**
 * The id of the input that edits a stored field, for the error summary to
 * focus. Mapping fields and the per-language texts are resolved in
 * `inputIdForField`.
 */
export const FIELD_INPUT_IDS = {
  id: 'pd-id',
  enabled: 'pd-enabled',
  authProvider: 'pd-auth-provider',
  url: 'pd-url',
  starttls: 'pd-starttls',
  baseDn: 'pd-base-dn',
  preset: 'pd-preset',
  bind: 'pd-bind-mode',
  'bind.dn': 'pd-bind-dn',
  'bind.passwordRef': 'pd-bind-password-ref',
  searchBase: 'pd-search-base',
  personFilter: 'pd-person-filter',
  searchAttributes: 'pd-search-attributes',
  units: 'pd-units',
  allowPlaintext: 'pd-allow-plaintext',
  tlsCa: 'pd-tls-ca',
  allowedHosts: 'pd-allowed-hosts',
  maxResults: 'pd-max-results',
  timeoutMs: 'pd-timeout-ms',
  concurrency: 'pd-concurrency',
  requestDelayMs: 'pd-request-delay-ms',
  groups: 'pd-groups',
  dataFlow: 'pd-data-flow',
  name: 'pd-name',
  description: 'pd-description'
};

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/** A stored list or single value as a list. */
const asList = value => {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
};

/**
 * Split typed text into a list: commas and line breaks separate entries,
 * blanks and duplicates are dropped.
 *
 * @param {string} text - e.g. "cn, sn\nmail"
 * @returns {string[]} e.g. ["cn", "sn", "mail"]
 */
export function parseList(text) {
  const seen = new Set();
  return String(text ?? '')
    .split(/[,\n]/)
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

/**
 * Split the text of a mapping override into its candidates. Only commas
 * separate candidates: a space joins attributes into one value
 * (`givenName sn`), so inner whitespace is kept, collapsed to one space.
 *
 * @param {string} text - e.g. "givenName sn, cn"
 * @returns {string[]} e.g. ["givenName sn", "cn"]
 */
export function parseMappingCandidates(text) {
  return parseList(String(text ?? '').replace(/\n/g, ',')).map(candidate =>
    candidate.replace(/\s+/g, ' ')
  );
}

/** A stored language map (or a plain string) with English and German present. */
function withFormLanguages(value) {
  const map = typeof value === 'string' ? { en: value } : { ...(value || {}) };
  const result = {};
  for (const lang of FORM_LANGUAGES) result[lang] = typeof map[lang] === 'string' ? map[lang] : '';
  for (const [lang, text] of Object.entries(map)) {
    if (!FORM_LANGUAGES.includes(lang) && typeof text === 'string') result[lang] = text;
  }
  return result;
}

/** A language map without empty entries (the schema rejects them), or undefined. */
function withoutEmptyTexts(value) {
  const entries = Object.entries(value || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([lang, text]) => [lang, text.trim()]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const numberText = value =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/**
 * Lower-case a name into a valid directory id: letters, digits and "-", at
 * most 32 characters, starting with a letter or digit, and different from
 * every id in `existingIds`.
 *
 * @param {string} base - e.g. a sign-in provider name "Corp_AD"
 * @param {string[]} [existingIds] - Ids already in use
 * @returns {string} e.g. "corp-ad", or "corp-ad-2" when that is taken
 */
export function suggestDirectoryId(base, existingIds = []) {
  let slug = String(base ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  if (slug.length < 2 || RESERVED_DIRECTORY_IDS.includes(slug)) slug = 'directory';
  const taken = new Set(existingIds);
  if (!taken.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return slug;
}

/**
 * The form of a new directory. With `authProvider` (the "Use for people
 * search" shortcut on a sign-in provider) it reuses that provider; otherwise
 * it connects directly.
 *
 * @param {Object} [prefill]
 * @param {string} [prefill.authProvider] - Name of an LDAP sign-in provider
 * @param {string} [prefill.name] - Display name for the model-facing name
 * @param {string[]} [prefill.existingIds] - Ids already in use, for the suggested id
 * @returns {Object} Form state
 */
export function createDirectoryForm({ authProvider, name, existingIds = [] } = {}) {
  const provider = trimmed(authProvider);
  const displayName = trimmed(name);
  const form = directoryToForm({
    enabled: true,
    type: 'ldap',
    groups: ['authenticated'],
    dataFlow: 'internal'
  });
  form.id = provider || displayName ? suggestDirectoryId(provider || displayName, existingIds) : '';
  if (provider) {
    form.sourceMode = 'provider';
    form.authProvider = provider;
  }
  if (displayName) form.name = { ...form.name, en: displayName, de: displayName };
  return form;
}

/**
 * Turn a stored directory into the editor's form state.
 *
 * @param {Object} directory - As stored in `peopleDirectories.json`
 * @returns {Object} Form state
 */
export function directoryToForm(directory = {}) {
  const bind = directory.bind;
  const mapping = {};
  for (const [field, value] of Object.entries(directory.attributeMapping || {})) {
    mapping[field] = asList(value).join(', ');
  }
  return {
    id: directory.id ?? '',
    enabled: directory.enabled !== false,
    sourceMode: directory.authProvider ? 'provider' : 'direct',
    authProvider: directory.authProvider ?? '',
    url: directory.url ?? '',
    starttls: directory.starttls === true ? 'on' : directory.starttls === false ? 'off' : 'inherit',
    baseDn: directory.baseDn ?? '',
    preset: directory.preset ?? '',
    // Not edited on this page, but kept so a save does not drop it.
    tlsOptions: directory.tlsOptions,
    bindMode: !bind ? 'default' : bind.mode === 'service' ? 'service' : 'anonymous',
    bindDn: bind?.dn ?? '',
    bindPasswordRef: bind?.passwordRef ?? '',
    searchBase: directory.searchBase ?? '',
    personFilter: directory.personFilter ?? '',
    searchAttributes: asList(directory.searchAttributes).join(', '),
    attributeMapping: mapping,
    units: directory.units === true,
    allowPlaintext: directory.allowPlaintext === true,
    tlsCa: [...asList(directory.tlsCa)],
    allowedHosts: asList(directory.allowedHosts).join('\n'),
    maxResults: numberText(directory.maxResults),
    timeoutMs: numberText(directory.timeoutMs),
    concurrency: numberText(directory.concurrency),
    requestDelayMs: numberText(directory.requestDelayMs),
    groups: Array.isArray(directory.groups) ? [...directory.groups] : ['authenticated'],
    dataFlow: directory.dataFlow === 'external' ? 'external' : 'internal',
    name: withFormLanguages(directory.name),
    description: withFormLanguages(directory.description)
  };
}

/**
 * Turn the editor's form state into a directory as stored, without empty
 * optional fields. Field order follows the documented config file, so a saved
 * file reads like the example in the docs.
 *
 * @param {Object} form - Form state from `directoryToForm` / `createDirectoryForm`
 * @returns {Object} Directory for `peopleDirectories.json`
 */
export function formToDirectory(form) {
  const directory = {
    id: trimmed(form.id),
    enabled: Boolean(form.enabled),
    type: 'ldap'
  };
  const setText = (key, value) => {
    const text = trimmed(value);
    if (text) directory[key] = text;
  };

  if (form.sourceMode === 'provider') setText('authProvider', form.authProvider);
  setText('url', form.url);
  if (form.starttls === 'on') directory.starttls = true;
  else if (form.starttls === 'off') directory.starttls = false;
  setText('baseDn', form.baseDn);
  setText('preset', form.preset);
  if (form.tlsOptions && Object.keys(form.tlsOptions).length > 0) {
    directory.tlsOptions = { ...form.tlsOptions };
  }

  if (form.bindMode === 'anonymous') {
    directory.bind = { mode: 'anonymous' };
  } else if (form.bindMode === 'service') {
    directory.bind = {
      mode: 'service',
      dn: trimmed(form.bindDn),
      passwordRef: trimmed(form.bindPasswordRef)
    };
  }

  setText('searchBase', form.searchBase);
  setText('personFilter', form.personFilter);
  const searchAttributes = parseList(form.searchAttributes);
  if (searchAttributes.length > 0) directory.searchAttributes = searchAttributes;

  const mapping = {};
  for (const [field, text] of Object.entries(form.attributeMapping || {})) {
    const candidates = parseMappingCandidates(text);
    if (candidates.length > 0) mapping[field] = candidates;
  }
  if (Object.keys(mapping).length > 0) directory.attributeMapping = mapping;

  if (form.units) directory.units = true;
  if (form.allowPlaintext) directory.allowPlaintext = true;
  const tlsCa = parseList((form.tlsCa || []).join(','));
  if (tlsCa.length > 0) directory.tlsCa = tlsCa;
  const allowedHosts = parseList(form.allowedHosts);
  if (allowedHosts.length > 0) directory.allowedHosts = allowedHosts;

  for (const field of LIMIT_FIELDS) {
    const text = trimmed(form[field]);
    if (text !== '') directory[field] = Number(text);
  }

  directory.groups = [...(form.groups || [])];
  directory.dataFlow = form.dataFlow === 'external' ? 'external' : 'internal';

  const name = withoutEmptyTexts(form.name);
  if (name) directory.name = name;
  const description = withoutEmptyTexts(form.description);
  if (description) directory.description = description;
  return directory;
}

/**
 * Check the form before it is saved, so the admin sees what is missing next
 * to the field instead of a schema error. The server validates again.
 *
 * Messages are returned as i18n descriptors, so this file stays free of React:
 * the page translates them with `t(message.key, message.defaultValue, message.values)`.
 *
 * @param {Object} form - Form state
 * @param {Object} [context]
 * @param {boolean} [context.isNew] - Whether the id can still be edited
 * @param {string[]} [context.otherIds] - Ids of the other directories
 * @param {Object} [context.limits] - Upper bounds by limit field
 * @returns {Array<{field: string, message: {key: string, defaultValue: string, values?: Object}}>}
 *   One entry per problem, `field` being the stored field path (e.g. `bind.dn`)
 */
export function validateDirectoryForm(form, { isNew = false, otherIds = [], limits = {} } = {}) {
  const errors = [];
  const add = (field, key, defaultValue, values) =>
    errors.push({ field, message: { key, defaultValue, values } });

  const id = trimmed(form.id);
  if (isNew) {
    if (!id) {
      add('id', 'admin.peopleDirectories.errors.idRequired', 'Enter an id.');
    } else if (!DIRECTORY_ID_PATTERN.test(id)) {
      add(
        'id',
        'admin.peopleDirectories.errors.idPattern',
        'Use 2 to 32 lower-case letters, digits and "-", starting with a letter or digit.'
      );
    } else if (RESERVED_DIRECTORY_IDS.includes(id)) {
      add('id', 'admin.peopleDirectories.errors.idReserved', '"{{id}}" is reserved.', { id });
    } else if (otherIds.includes(id)) {
      add('id', 'admin.peopleDirectories.errors.idTaken', 'Another directory uses "{{id}}".', {
        id
      });
    }
  }

  if (form.sourceMode === 'provider') {
    if (!trimmed(form.authProvider)) {
      add(
        'authProvider',
        'admin.peopleDirectories.errors.authProviderRequired',
        'Choose a sign-in provider.'
      );
    }
  } else {
    if (!trimmed(form.url)) {
      add('url', 'admin.peopleDirectories.errors.urlRequired', 'Enter the directory URL.');
    }
    if (!trimmed(form.baseDn)) {
      add('baseDn', 'admin.peopleDirectories.errors.baseDnRequired', 'Enter the base DN.');
    }
  }
  if (trimmed(form.url) && !/^ldaps?:\/\/[^/\s?#]+\/?$/i.test(trimmed(form.url))) {
    add(
      'url',
      'admin.peopleDirectories.errors.urlPattern',
      'Use ldaps://host:636 or ldap://host:389, without a path.'
    );
  }

  if (form.bindMode === 'service') {
    if (!trimmed(form.bindDn)) {
      add('bind.dn', 'admin.peopleDirectories.errors.bindDnRequired', 'Enter the bind DN.');
    }
    if (!trimmed(form.bindPasswordRef)) {
      add(
        'bind.passwordRef',
        'admin.peopleDirectories.errors.passwordRefRequired',
        'Choose the credential that holds the password.'
      );
    }
  }

  const filter = trimmed(form.personFilter);
  if (filter && !(filter.startsWith('(') && filter.endsWith(')'))) {
    add(
      'personFilter',
      'admin.peopleDirectories.errors.personFilterPattern',
      'An LDAP filter in parentheses, e.g. (objectClass=person).'
    );
  }

  for (const field of LIMIT_FIELDS) {
    const text = trimmed(form[field]);
    if (text === '') continue;
    const value = Number(text);
    const min = LIMIT_MINIMA[field];
    const max = limits[field] ?? FALLBACK_LIMIT_MAXIMA[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      add(
        field,
        'admin.peopleDirectories.errors.limitRange',
        'Enter a whole number from {{min}} to {{max}}.',
        { min, max }
      );
    }
  }
  return errors;
}

/**
 * The id of the input that edits a stored field path, or null when the form
 * has none (the error is then listed without a link).
 *
 * @param {string} fieldPath - e.g. "url", "bind.dn", "attributeMapping.jobTitle", "name.de"
 * @returns {string|null}
 */
export function inputIdForField(fieldPath) {
  const path = String(fieldPath ?? '');
  if (!path) return null;
  if (path.startsWith('attributeMapping.')) return `pd-mapping-${path.split('.')[1]}`;
  if (/^(name|description)\.[a-zA-Z-]+$/.test(path)) return `pd-${path}`;
  const parts = path.split('.');
  while (parts.length > 0) {
    const id = FIELD_INPUT_IDS[parts.join('.')];
    if (id) return id;
    parts.pop();
  }
  return null;
}

/**
 * Sort the issues of a rejected save (`details` of a 400, Zod issues with a
 * `path` into `{ directories: [...] }`) into those of the edited directory,
 * by field, and all others.
 *
 * @param {Array<{path?: Array<string|number>, message: string}>} details - Zod issues
 * @param {number} index - Position of the edited directory in the saved list
 * @returns {{fields: Array<{field: string, message: string}>, other: string[]}}
 */
export function splitSaveIssues(details, index) {
  const fields = [];
  const other = [];
  for (const issue of Array.isArray(details) ? details : []) {
    const path = Array.isArray(issue?.path) ? issue.path : [];
    const message = issue?.message || '';
    if (path[0] === 'directories' && path[1] === index && path.length > 2) {
      const fieldPath = path
        .slice(2)
        .filter(part => typeof part === 'string')
        .join('.');
      fields.push({ field: fieldPath, message });
    } else {
      other.push(path.length > 0 ? `${path.join('.')}: ${message}` : message);
    }
  }
  return { fields, other };
}

/**
 * A one-line explanation of a failed save of the directory list: the server's
 * message, followed by the schema issues of a 400 or the clashing id of a 409.
 *
 * @param {Object} err - The error thrown by the admin API call (axios)
 * @returns {string}
 */
export function describeSaveError(err) {
  const body = err?.response?.data;
  const base = body?.error || body?.message || err?.message || 'Unknown error';
  if (Array.isArray(body?.details) && body.details.length > 0) {
    const issues = body.details
      .map(issue => {
        const path = Array.isArray(issue?.path) ? issue.path.join('.') : '';
        return path ? `${path}: ${issue?.message}` : issue?.message;
      })
      .filter(Boolean);
    return issues.length > 0 ? `${base} (${issues.join('; ')})` : base;
  }
  return base;
}

/**
 * The list with one directory put in: it replaces the entry that had
 * `originalId` (an edit), or is appended (a new entry).
 *
 * @param {Array<Object>} directories - Stored list
 * @param {Object} directory - The directory to put in
 * @param {string|null} originalId - Id the directory was loaded with, null when new
 * @returns {Array<Object>} A new list
 */
export function withDirectory(directories, directory, originalId) {
  const list = Array.isArray(directories) ? directories : [];
  const index = originalId ? list.findIndex(entry => entry.id === originalId) : -1;
  if (index === -1) return [...list, directory];
  return list.map((entry, i) => (i === index ? directory : entry));
}

/**
 * The list without one directory.
 *
 * @param {Array<Object>} directories - Stored list
 * @param {string} id - Directory to remove
 * @returns {Array<Object>} A new list
 */
export function withoutDirectory(directories, id) {
  return (directories || []).filter(entry => entry.id !== id);
}

/**
 * The list with one directory switched on or off; everything else unchanged.
 *
 * @param {Array<Object>} directories - Stored list
 * @param {string} id - Directory to switch
 * @param {boolean} enabled - New state
 * @returns {Array<Object>} A new list
 */
export function withDirectoryEnabled(directories, id, enabled) {
  return (directories || []).map(entry => (entry.id === id ? { ...entry, enabled } : entry));
}

/**
 * Whether to offer enabling the shipped "People search" app: a directory was
 * just switched on, and the app exists but is still disabled.
 *
 * @param {{exists?: boolean, enabled?: boolean}|undefined} app - `peopleSearchApp` from the GET
 * @param {{wasEnabled: boolean, isEnabled: boolean}} change - The directory's state before and after
 * @returns {boolean}
 */
export function shouldOfferPeopleSearchApp(app, { wasEnabled, isEnabled }) {
  return Boolean(app?.exists && !app.enabled && isEnabled && !wasEnabled);
}

/**
 * How a connection would be secured, from the URL and StartTLS the form ends
 * up with, including what it inherits from a reused sign-in provider.
 *
 * @param {Object} form - Form state
 * @param {Object} [provider] - The reused sign-in provider from `ldapProviders`
 * @returns {'ldaps'|'starttls'|'plaintext'|'unknown'}
 */
export function transportOf(form, provider) {
  const reuses = form.sourceMode === 'provider';
  const url = trimmed(form.url) || (reuses ? trimmed(provider?.url) : '');
  const starttls =
    form.starttls === 'on'
      ? true
      : form.starttls === 'off'
        ? false
        : reuses && provider?.starttls === true;
  if (/^ldaps:\/\//i.test(url)) return 'ldaps';
  if (/^ldap:\/\//i.test(url)) return starttls ? 'starttls' : 'plaintext';
  return 'unknown';
}

/**
 * The preset the directory searches with: its own, else the reused sign-in
 * provider's, else OpenLDAP.
 *
 * @param {Object} form - Form state
 * @param {Object} [provider] - The reused sign-in provider
 * @returns {string} Preset id
 */
export function effectivePresetId(form, provider) {
  return (
    trimmed(form.preset) ||
    (form.sourceMode === 'provider' ? trimmed(provider?.preset) : '') ||
    DEFAULT_PRESET_ID
  );
}

/**
 * The tool ids a directory adds, as apps and group permissions name them.
 *
 * @param {string} id - Directory id
 * @param {boolean} units - Whether `list_units` is offered
 * @returns {string[]}
 */
export function toolIdsFor(id, units) {
  const prefix = trimmed(id) || '<id>';
  const ids = [`${prefix}__search_people`, `${prefix}__get_person`];
  if (units) ids.push(`${prefix}__list_units`);
  return ids;
}

/**
 * A certificate name from an uploaded file name: lower-cased, extension
 * dropped, every other character than a-z, 0-9 and "-" turned into "-".
 *
 * @param {string} fileName - e.g. "PCA-1-Verwaltung-23.pem"
 * @returns {string} e.g. "pca-1-verwaltung-23"
 */
export function certificateNameFromFileName(fileName) {
  const name = String(fileName ?? '')
    .replace(/\.(pem|crt|cer|der)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return name || 'certificate';
}

/**
 * Base64 of raw bytes, in chunks so a large file does not overflow the
 * argument list of `String.fromCharCode`.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * The request payload for an uploaded certificate file: PEM text as it is, any
 * other content (DER) as base64. The extension does not decide it, because
 * `.crt` and `.cer` files come in both encodings.
 *
 * @param {Uint8Array} bytes - File content
 * @returns {{content: string, encoding: 'pem'|'base64'}}
 */
export function certificatePayloadFromBytes(bytes) {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('-----BEGIN')) return { content: text, encoding: 'pem' };
  return { content: bytesToBase64(bytes), encoding: 'base64' };
}

/**
 * Read an uploaded certificate file into the request payload.
 *
 * @param {File} file
 * @returns {Promise<{content: string, encoding: 'pem'|'base64'}>}
 */
export async function readCertificateFile(file) {
  const buffer = await file.arrayBuffer();
  return certificatePayloadFromBytes(new Uint8Array(buffer));
}

/**
 * The expiry state of a certificate from the store.
 *
 * @param {{expired?: boolean, expiringSoon?: boolean}} certificate
 * @returns {'expired'|'expiringSoon'|'valid'}
 */
export function certificateExpiryState(certificate) {
  if (certificate?.expired) return 'expired';
  if (certificate?.expiringSoon) return 'expiringSoon';
  return 'valid';
}

/**
 * The common name (CN) of a distinguished name as the server prints it —
 * one "type=value" per line ("C=DE\nO=PKI-1-Verwaltung\nCN=PCA-1-Verwaltung-23")
 * or comma-separated — or the whole text when it has no CN.
 *
 * @param {string} subject
 * @returns {string} e.g. "PCA-1-Verwaltung-23"
 */
export function commonNameOf(subject) {
  const text = String(subject ?? '').trim();
  const match = /(?:^|[\n,+])\s*CN=([^\n,+]+)/i.exec(text);
  return match ? match[1].trim() : text;
}

/**
 * A date from the server as a local date, or the raw text when it does not parse.
 *
 * @param {string} value - e.g. "Dec 31 23:59:59 2032 GMT" or an ISO date
 * @param {string} language - UI language
 * @returns {string}
 */
export function formatCertificateDate(value, language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(language || undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}
