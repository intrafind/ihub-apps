// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Form logic of the dedicated **People directory (LDAP)** and **LDAP browser**
 * editors (`PeopleDirectoryEditor`, `LdapBrowserEditor`). Pure functions
 * only, so the editors stay presentation and this file can be unit tested
 * without React.
 *
 * Restored from the directory editor that existed before directories became
 * installations (`client/src/features/admin/utils/peopleDirectories.js` before
 * commit e53c041), adapted to the installation values of
 * `com.intrafind/ldap-directory` (the keys of its `install` fields, see
 * `server/migrations/V198__people_directories_installed_integrations.js`):
 *
 * | Form field                         | Install value                              |
 * | ---------------------------------- | ------------------------------------------ |
 * | `sourceMode` + `authProvider`      | `authProvider` (only when reusing)         |
 * | `url`, `baseDn`, `preset`          | the same keys                              |
 * | `starttls` (`inherit`/`on`/`off`)  | `starttls` (absent / `true` / `false`)     |
 * | `bindMode` (`default`/…), …        | `bindMode`, `bindDn`, `bindPasswordRef`    |
 * | `searchAttributes` (text)          | `searchAttributes` (list)                  |
 * | `attributeMapping[field]` (text)   | `mapping_<field>` (list)                   |
 * | `tlsCa`, `allowedHosts` (text)     | the same keys (lists)                      |
 * | limits (text)                      | `maxResults`, `timeoutMs`, … (numbers)     |
 *
 * The form differs from the values the way the old one differed from a
 * stored directory: lists are the text the admin types, numbers are strings
 * (empty means "the default"), the alternatives the admin picked are explicit,
 * and the model-facing name and description always carry English and German.
 * Validation messages are i18n descriptors (`{ key, defaultValue, values }`),
 * keyed by install field, so they sit next to the server's own field errors.
 *
 * @module features/admin/components/integrations/editors/peopleDirectoryEditorModel
 */

const K = 'admin.integrations.editors.peopleDirectory';
const BROWSER_K = 'admin.integrations.editors.ldapBrowser';

/** The definition ids the editors are registered for. */
export const LDAP_DIRECTORY_DEFINITION_ID = 'com.intrafind/ldap-directory';
export const LDAP_BROWSER_DEFINITION_ID = 'com.intrafind/ldap-browser';

/** Name of a trust anchor: `contents/config/certs/<name>.pem` on the server. */
export const CERTIFICATE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** An LDAP attribute name, as the server schema checks it. */
export const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** An LDAP URL as the definition's `url` field accepts it: a host, an optional port, no path. */
export const LDAP_URL_PATTERN = /^ldaps?:\/\/[^/\\\s?#@]+\/?$/i;

/** The languages the model-facing name and description are edited in. */
export const FORM_LANGUAGES = ['en', 'de'];

/** Preset used when neither the directory nor its sign-in provider names one. */
export const DEFAULT_PRESET_ID = 'openldap';

/** The TLS versions a directory may pin. */
export const TLS_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];

/** The limit fields, in the order the form shows them. */
export const LIMIT_FIELDS = ['maxResults', 'timeoutMs', 'concurrency', 'requestDelayMs'];

/** Used until the editor context answers. */
export const FALLBACK_LIMIT_DEFAULTS = Object.freeze({
  maxResults: 10,
  timeoutMs: 8000,
  concurrency: 2,
  requestDelayMs: 0
});

/** Upper bounds, used until the editor context answers or when it leaves one out. */
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

/** The LDAP browser's result limit: default and upper bound, as on the server. */
export const BROWSE_MAX_RESULTS_DEFAULT = 50;
export const BROWSE_MAX_RESULTS_LIMIT = 200;

/** The `Person` fields a mapping fills, used until the editor context answers. */
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
 * The id of the input that edits an install field, for the error summary to
 * focus. Mapping fields resolve to `pd-mapping-<field>`.
 */
export const FIELD_INPUT_IDS = Object.freeze({
  authProvider: 'pd-auth-provider',
  url: 'pd-url',
  starttls: 'pd-starttls',
  baseDn: 'pd-base-dn',
  preset: 'pd-preset',
  // Error links go to a control that is always rendered.
  bindMode: 'pd-bind-mode-anonymous',
  bindDn: 'pd-bind-dn',
  bindPasswordRef: 'pd-bind-password-ref',
  searchBase: 'pd-search-base',
  personFilter: 'pd-person-filter',
  searchAttributes: 'pd-search-attributes',
  units: 'pd-units',
  allowPlaintext: 'pd-allow-plaintext',
  tlsCa: 'pd-tls-ca',
  allowedHosts: 'pd-allowed-hosts',
  tlsMinVersion: 'pd-tls-min-version',
  tlsMaxVersion: 'pd-tls-max-version',
  tlsCiphers: 'pd-tls-ciphers',
  maxResults: 'pd-max-results',
  timeoutMs: 'pd-timeout-ms',
  concurrency: 'pd-concurrency',
  requestDelayMs: 'pd-request-delay-ms',
  dataFlow: 'pd-data-flow-internal'
});

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/** A stored list or single value as a list. */
const asList = value => {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
};

const numberText = value =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

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

/**
 * A stored language map (or a plain string) with English and German present.
 * @param {Object<string,string>|string|null|undefined} value
 * @returns {Object<string,string>}
 */
export function withFormLanguages(value) {
  const map = typeof value === 'string' ? { en: value } : { ...(value || {}) };
  const result = {};
  for (const lang of FORM_LANGUAGES) result[lang] = typeof map[lang] === 'string' ? map[lang] : '';
  for (const [lang, text] of Object.entries(map)) {
    if (!FORM_LANGUAGES.includes(lang) && typeof text === 'string') result[lang] = text;
  }
  return result;
}

/**
 * A language map without empty entries, or undefined when nothing is left
 * (the installation then shows the definition's name).
 * @param {Object<string,string>} value
 * @returns {Object<string,string>|undefined}
 */
export function withoutEmptyTexts(value) {
  const entries = Object.entries(value || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([lang, text]) => [lang, text.trim()]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The editor's form state from an installation's (effective) values and its
 * stored label and description.
 *
 * @param {Object} values - `instance.values` (effective: defaults applied)
 * @param {Object} [texts]
 * @param {Object<string,string>|string|null} [texts.label] - the stored label (`labelLocalized`)
 * @param {Object<string,string>|string|null} [texts.description] - the stored description
 * @returns {Object} Form state
 */
export function directoryValuesToForm(values = {}, { label, description } = {}) {
  const mapping = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('mapping_'))
      mapping[key.slice('mapping_'.length)] = asList(value).join(', ');
  }
  const bindMode =
    values.bindMode === 'service'
      ? 'service'
      : values.bindMode === 'anonymous'
        ? 'anonymous'
        : 'default';
  return {
    sourceMode: trimmed(values.authProvider) ? 'provider' : 'direct',
    authProvider: values.authProvider ?? '',
    url: values.url ?? '',
    starttls: values.starttls === true ? 'on' : values.starttls === false ? 'off' : 'inherit',
    baseDn: values.baseDn ?? '',
    preset: values.preset ?? '',
    bindMode,
    bindDn: values.bindDn ?? '',
    bindPasswordRef: values.bindPasswordRef ?? '',
    searchBase: values.searchBase ?? '',
    personFilter: values.personFilter ?? '',
    searchAttributes: asList(values.searchAttributes).join(', '),
    attributeMapping: mapping,
    units: values.units === true,
    allowPlaintext: values.allowPlaintext === true,
    tlsCa: asList(values.tlsCa).join('\n'),
    allowedHosts: asList(values.allowedHosts).join('\n'),
    tlsMinVersion: values.tlsMinVersion ?? '',
    tlsMaxVersion: values.tlsMaxVersion ?? '',
    tlsCiphers: values.tlsCiphers ?? '',
    maxResults: numberText(values.maxResults),
    timeoutMs: numberText(values.timeoutMs),
    concurrency: numberText(values.concurrency),
    requestDelayMs: numberText(values.requestDelayMs),
    dataFlow: values.dataFlow === 'external' ? 'external' : 'internal',
    name: withFormLanguages(label),
    description: withFormLanguages(description)
  };
}

/**
 * The install values of the form, without empty optional fields: an omitted
 * field takes the sign-in provider's value, the preset's or the definition's
 * default. Only keys of the definition's `install` fields are written.
 *
 * @param {Object} form - Form state from {@link directoryValuesToForm}
 * @returns {Object} `values` for `PUT /api/admin/integrations/installed/:id`
 */
export function directoryFormToValues(form) {
  const values = {};
  const setText = (key, value) => {
    const text = trimmed(value);
    if (text) values[key] = text;
  };
  if (form.sourceMode === 'provider') setText('authProvider', form.authProvider);
  setText('url', form.url);
  if (form.starttls === 'on') values.starttls = true;
  else if (form.starttls === 'off') values.starttls = false;
  setText('baseDn', form.baseDn);
  setText('preset', form.preset);
  // Without a sign-in provider, "the provider's account" means anonymous.
  const bindMode =
    form.sourceMode !== 'provider' && form.bindMode === 'default' ? 'anonymous' : form.bindMode;
  if (bindMode === 'anonymous' || bindMode === 'service') values.bindMode = bindMode;
  if (bindMode === 'service') {
    setText('bindDn', form.bindDn);
    setText('bindPasswordRef', form.bindPasswordRef);
  }
  setText('searchBase', form.searchBase);
  setText('personFilter', form.personFilter);
  const searchAttributes = parseList(form.searchAttributes);
  if (searchAttributes.length > 0) values.searchAttributes = searchAttributes;
  for (const [field, text] of Object.entries(form.attributeMapping || {})) {
    const candidates = parseMappingCandidates(text);
    if (candidates.length > 0) values[`mapping_${field}`] = candidates;
  }
  if (form.units) values.units = true;
  if (form.allowPlaintext) values.allowPlaintext = true;
  const tlsCa = parseList(form.tlsCa);
  if (tlsCa.length > 0) values.tlsCa = tlsCa;
  const allowedHosts = parseList(form.allowedHosts);
  if (allowedHosts.length > 0) values.allowedHosts = allowedHosts;
  setText('tlsMinVersion', form.tlsMinVersion);
  setText('tlsMaxVersion', form.tlsMaxVersion);
  setText('tlsCiphers', form.tlsCiphers);
  for (const field of LIMIT_FIELDS) {
    const text = trimmed(form[field]);
    if (text !== '') values[field] = Number(text);
  }
  values.dataFlow = form.dataFlow === 'external' ? 'external' : 'internal';
  return values;
}

/** One validation problem: the install field and an i18n descriptor under `prefix`. */
function problem(field, key, defaultValue, values, prefix = K) {
  return { field, message: { key: `${prefix}.errors.${key}`, defaultValue, values } };
}

/** A limit outside its range, or null. */
function limitProblem(field, text, min, max, prefix = K) {
  if (text === '') return null;
  const value = Number(text);
  if (Number.isInteger(value) && value >= min && value <= max) return null;
  return problem(
    field,
    'limitRange',
    'Enter a whole number from {{min}} to {{max}}.',
    { min, max },
    prefix
  );
}

/**
 * Check the form before it is saved, so the admin sees what is missing next
 * to the field instead of a server error. The server validates again.
 *
 * @param {Object} form - Form state
 * @param {Object} [context]
 * @param {Object} [context.limits] - Upper bounds by limit field (editor context)
 * @returns {Array<{field: string, message: {key: string, defaultValue: string, values?: Object}}>}
 */
export function validateDirectoryForm(form, { limits = {} } = {}) {
  const errors = [];
  if (form.sourceMode === 'provider') {
    if (!trimmed(form.authProvider)) {
      errors.push(problem('authProvider', 'authProviderRequired', 'Choose a sign-in provider.'));
    }
  } else {
    if (!trimmed(form.url)) errors.push(problem('url', 'urlRequired', 'Enter the directory URL.'));
    if (!trimmed(form.baseDn)) {
      errors.push(problem('baseDn', 'baseDnRequired', 'Enter the base DN.'));
    }
  }
  if (trimmed(form.url) && !LDAP_URL_PATTERN.test(trimmed(form.url))) {
    errors.push(
      problem('url', 'urlPattern', 'Use ldaps://host:636 or ldap://host:389, without a path.')
    );
  }
  if (form.bindMode === 'service') {
    if (!trimmed(form.bindDn))
      errors.push(problem('bindDn', 'bindDnRequired', 'Enter the bind DN.'));
    if (!trimmed(form.bindPasswordRef)) {
      errors.push(
        problem(
          'bindPasswordRef',
          'passwordRefRequired',
          'Choose the credential that holds the password.'
        )
      );
    }
  }
  const badCa = parseList(form.tlsCa).find(name => !CERTIFICATE_NAME_PATTERN.test(name));
  if (badCa) {
    errors.push(
      problem(
        'tlsCa',
        'tlsCaPattern',
        '"{{name}}" is not a certificate name: use lower-case letters, digits and "-", without ".pem".',
        { name: badCa }
      )
    );
  }
  const filter = trimmed(form.personFilter);
  if (filter && !(filter.startsWith('(') && filter.endsWith(')'))) {
    errors.push(
      problem(
        'personFilter',
        'personFilterPattern',
        'An LDAP filter in parentheses, e.g. (objectClass=person).'
      )
    );
  }
  const badAttribute = parseList(form.searchAttributes).find(
    name => !ATTRIBUTE_NAME_PATTERN.test(name)
  );
  if (badAttribute) {
    errors.push(
      problem('searchAttributes', 'attributeName', '"{{name}}" is not an LDAP attribute name.', {
        name: badAttribute
      })
    );
  }
  for (const field of LIMIT_FIELDS) {
    const found = limitProblem(
      field,
      trimmed(form[field]),
      LIMIT_MINIMA[field],
      limits[field] ?? FALLBACK_LIMIT_MAXIMA[field]
    );
    if (found) errors.push(found);
  }
  return errors;
}

/**
 * The input id of an install field, for the error summary, or null.
 * @param {string} field - e.g. `url`, `mapping_jobTitle`
 * @returns {string|null}
 */
export function inputIdForField(field) {
  const key = String(field ?? '');
  if (key.startsWith('mapping_')) return `pd-mapping-${key.slice('mapping_'.length)}`;
  return FIELD_INPUT_IDS[key] || null;
}

/**
 * How a connection would be secured, from the URL and StartTLS the form ends
 * up with, including what it inherits from a reused sign-in provider.
 *
 * @param {Object} form - Form state
 * @param {Object} [provider] - The reused sign-in provider (editor context `ldapProviders`)
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
 * @param {string} id - Installation id
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
 * The LDAP browser editor's form from its installation values.
 * @param {Object} values - effective values of a `com.intrafind/ldap-browser` installation
 * @returns {Object}
 */
export function browserValuesToForm(values = {}) {
  return {
    directory: values.directory ?? '',
    baseDn: values.baseDn ?? '',
    maxResults: numberText(values.maxResults),
    bindMode:
      values.bindMode === 'service'
        ? 'service'
        : values.bindMode === 'anonymous'
          ? 'anonymous'
          : 'directory',
    bindDn: values.bindDn ?? '',
    bindPasswordRef: values.bindPasswordRef ?? '',
    denyAttributes: asList(values.denyAttributes).join('\n')
  };
}

/**
 * The install values of the LDAP browser form.
 * @param {Object} form
 * @returns {Object}
 */
export function browserFormToValues(form) {
  const values = { directory: trimmed(form.directory) };
  if (trimmed(form.baseDn)) values.baseDn = trimmed(form.baseDn);
  if (trimmed(form.maxResults) !== '') values.maxResults = Number(trimmed(form.maxResults));
  if (form.bindMode === 'anonymous' || form.bindMode === 'service') values.bindMode = form.bindMode;
  if (form.bindMode === 'service') {
    if (trimmed(form.bindDn)) values.bindDn = trimmed(form.bindDn);
    if (trimmed(form.bindPasswordRef)) values.bindPasswordRef = trimmed(form.bindPasswordRef);
  }
  const deny = parseList(form.denyAttributes);
  if (deny.length > 0) values.denyAttributes = deny;
  return values;
}

/**
 * Check the LDAP browser form before it is saved.
 * @param {Object} form
 * @param {Object} [context]
 * @param {number} [context.maxResultsLimit]
 * @returns {Array<{field: string, message: {key: string, defaultValue: string, values?: Object}}>}
 */
export function validateBrowserForm(form, { maxResultsLimit = BROWSE_MAX_RESULTS_LIMIT } = {}) {
  const errors = [];
  const add = (field, key, defaultValue, values) =>
    errors.push(problem(field, key, defaultValue, values, BROWSER_K));
  if (!trimmed(form.directory)) {
    add(
      'directory',
      'directoryRequired',
      'Choose the people directory whose connection the browser uses.'
    );
  }
  const limit = limitProblem('maxResults', trimmed(form.maxResults), 1, maxResultsLimit, BROWSER_K);
  if (limit) errors.push(limit);
  if (form.bindMode === 'service') {
    if (!trimmed(form.bindDn)) add('bindDn', 'bindDnRequired', 'Enter the bind DN.');
    if (!trimmed(form.bindPasswordRef)) {
      add(
        'bindPasswordRef',
        'passwordRefRequired',
        'Choose the credential that holds the password.'
      );
    }
  }
  const badAttribute = parseList(form.denyAttributes).find(
    name => !ATTRIBUTE_NAME_PATTERN.test(name)
  );
  if (badAttribute) {
    add('denyAttributes', 'attributeName', '"{{name}}" is not an LDAP attribute name.', {
      name: badAttribute
    });
  }
  return errors;
}

/**
 * The browse tool ids of a browser installation.
 * @param {string} id
 * @returns {string[]}
 */
export function browseToolIdsFor(id) {
  const prefix = trimmed(id) || '<id>';
  return ['browse_search', 'browse_read', 'browse_children'].map(action => `${prefix}__${action}`);
}
