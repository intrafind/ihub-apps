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

/**
 * Ids a directory cannot take (as on the server): `peopledirectories` selects
 * every directory, `ldapbrowse` every LDAP browser, `new` is this editor's
 * create route, and the others are
 * tool id prefixes the server routes elsewhere.
 */
export const RESERVED_DIRECTORY_IDS = [
  'peopledirectories',
  'ldapbrowse',
  'new',
  'app',
  'workflow',
  'source',
  'knowledge',
  'a2a'
];

/** Name of a trust anchor: `contents/config/certs/<name>.pem` on the server. */
export const CERTIFICATE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** The admin LDAP browser's result limit: default and upper bound, as on the server. */
export const BROWSE_MAX_RESULTS_DEFAULT = 50;
export const BROWSE_MAX_RESULTS_LIMIT = 200;

/** An LDAP attribute name, as the server schema checks it. */
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

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
  // Error links go to a control that is always rendered.
  bind: 'pd-bind-mode-anonymous',
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
  dataFlow: 'pd-data-flow-internal',
  browse: 'pd-browse-enabled',
  'browse.groups': 'pd-browse-groups',
  'browse.maxResults': 'pd-browse-max-results',
  'browse.base': 'pd-browse-base',
  // Error links go to a control that is always rendered while browse is on.
  'browse.bind': 'pd-browse-bind-mode-directory',
  'browse.bind.dn': 'pd-browse-bind-dn',
  'browse.bind.passwordRef': 'pd-browse-bind-password-ref',
  'browse.denyAttributes': 'pd-browse-deny-attributes',
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
    tlsCa: asList(directory.tlsCa).join('\n'),
    allowedHosts: asList(directory.allowedHosts).join('\n'),
    maxResults: numberText(directory.maxResults),
    timeoutMs: numberText(directory.timeoutMs),
    concurrency: numberText(directory.concurrency),
    requestDelayMs: numberText(directory.requestDelayMs),
    groups: Array.isArray(directory.groups) ? [...directory.groups] : ['authenticated'],
    dataFlow: directory.dataFlow === 'external' ? 'external' : 'internal',
    name: withFormLanguages(directory.name),
    description: withFormLanguages(directory.description),
    ...browseToForm(directory.browse)
  };
}

/**
 * The LDAP browser fields of the form. `hasBrowse` remembers that the
 * directory had a `browse` block, so switching the browser off keeps its
 * settings instead of dropping them.
 *
 * @param {Object|undefined} browse - Stored `browse` block
 * @returns {Object} Form fields
 */
function browseToForm(browse) {
  const bind = browse?.bind;
  return {
    hasBrowse: Boolean(browse),
    browseEnabled: browse?.enabled === true,
    browseGroups: Array.isArray(browse?.groups) ? [...browse.groups] : ['admins'],
    browseMaxResults: numberText(browse?.maxResults),
    browseBase: browse?.base ?? '',
    browseBindMode: !bind ? 'directory' : bind.mode === 'service' ? 'service' : 'anonymous',
    browseBindDn: bind?.dn ?? '',
    browseBindPasswordRef: bind?.passwordRef ?? '',
    browseDenyAttributes: asList(browse?.denyAttributes).join('\n')
  };
}

/**
 * The stored `browse` block of a form, or undefined when the directory never
 * had one and the browser stays off.
 *
 * @param {Object} form
 * @returns {Object|undefined}
 */
function formToBrowse(form) {
  if (!form.browseEnabled && !form.hasBrowse) return undefined;
  const browse = {
    enabled: Boolean(form.browseEnabled),
    groups: [...(form.browseGroups || [])]
  };
  const maxResults = trimmed(form.browseMaxResults);
  if (maxResults !== '') browse.maxResults = Number(maxResults);
  const base = trimmed(form.browseBase);
  if (base) browse.base = base;
  if (form.browseBindMode === 'anonymous') {
    browse.bind = { mode: 'anonymous' };
  } else if (form.browseBindMode === 'service') {
    browse.bind = {
      mode: 'service',
      dn: trimmed(form.browseBindDn),
      passwordRef: trimmed(form.browseBindPasswordRef)
    };
  }
  const denyAttributes = parseList(form.browseDenyAttributes);
  if (denyAttributes.length > 0) browse.denyAttributes = denyAttributes;
  return browse;
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
  const tlsCa = parseList(form.tlsCa);
  if (tlsCa.length > 0) directory.tlsCa = tlsCa;
  const allowedHosts = parseList(form.allowedHosts);
  if (allowedHosts.length > 0) directory.allowedHosts = allowedHosts;

  for (const field of LIMIT_FIELDS) {
    const text = trimmed(form[field]);
    if (text !== '') directory[field] = Number(text);
  }

  directory.groups = [...(form.groups || [])];
  directory.dataFlow = form.dataFlow === 'external' ? 'external' : 'internal';
  const browse = formToBrowse(form);
  if (browse) directory.browse = browse;

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

  const badCa = parseList(form.tlsCa).find(name => !CERTIFICATE_NAME_PATTERN.test(name));
  if (badCa) {
    add(
      'tlsCa',
      'admin.peopleDirectories.errors.tlsCaPattern',
      '"{{name}}" is not a certificate name: use lower-case letters, digits and "-", without ".pem".',
      { name: badCa }
    );
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

  // The browse block is saved while the browser is on, and kept while it is
  // off (formToBrowse), so its fields are checked whenever it is sent.
  if (form.browseEnabled && (form.browseGroups || []).length === 0) {
    add(
      'browse.groups',
      'admin.peopleDirectories.errors.browseGroupsRequired',
      'Choose who may use the LDAP browser.'
    );
  }
  if (form.browseEnabled || form.hasBrowse) {
    const maxResults = trimmed(form.browseMaxResults);
    if (maxResults !== '') {
      const value = Number(maxResults);
      if (!Number.isInteger(value) || value < 1 || value > BROWSE_MAX_RESULTS_LIMIT) {
        add(
          'browse.maxResults',
          'admin.peopleDirectories.errors.limitRange',
          'Enter a whole number from {{min}} to {{max}}.',
          { min: 1, max: BROWSE_MAX_RESULTS_LIMIT }
        );
      }
    }
    if (form.browseBindMode === 'service') {
      if (!trimmed(form.browseBindDn)) {
        add(
          'browse.bind.dn',
          'admin.peopleDirectories.errors.bindDnRequired',
          'Enter the bind DN.'
        );
      }
      if (!trimmed(form.browseBindPasswordRef)) {
        add(
          'browse.bind.passwordRef',
          'admin.peopleDirectories.errors.passwordRefRequired',
          'Choose the credential that holds the password.'
        );
      }
    }
    const badAttribute = parseList(form.browseDenyAttributes).find(
      name => !ATTRIBUTE_NAME_PATTERN.test(name)
    );
    if (badAttribute) {
      add(
        'browse.denyAttributes',
        'admin.peopleDirectories.errors.attributeName',
        '"{{name}}" is not an LDAP attribute name.',
        { name: badAttribute }
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
