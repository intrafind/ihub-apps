// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The logic of the dedicated iFinder editor, kept out of the component:
 * defaults, the JWT subject choices, the token exchange scope map and the
 * checks before a save. The editor edits the `ifinder` installation's values
 * directly — they are flat and carry the names migration V192 gave the old
 * `platform.iFinder` fields:
 *
 * | Old `platform.iFinder`              | Installation value                     |
 * | ----------------------------------- | -------------------------------------- |
 * | `tokenExchange.oidcProvider`        | `tokenExchangeProvider`                |
 * | `tokenExchange.grantType`           | `tokenExchangeGrant`                   |
 * | `tokenExchange.audience`            | `tokenExchangeAudience`                |
 * | `tokenExchange.scopeMap.fa_index_read` | `tokenExchangeScopeIndexRead`       |
 * | `tokenExchange.scopeMap.fa_iassistant` | `tokenExchangeScopeAssistant`       |
 * | `tokenExchange.scopeMap.fi_smartcollections` | `tokenExchangeScopeSmartCollections` |
 * | `tokenExchange.extraScopes`         | `tokenExchangeExtraScopes`             |
 * | `endpoints.search` / `document` / `fields` / `facets` | `searchEndpoint`, … |
 * | everything else                     | the same name                          |
 *
 * @module features/admin/components/integrations/editors/iFinderEditorModel
 */

/** The definition id of the iFinder integration. */
export const IFINDER_DEFINITION_ID = 'com.intrafind/ifinder';

/** The values the editor shows when the installation has none (the definition's defaults). */
export const IFINDER_DEFAULTS = Object.freeze({
  baseUrl: '',
  authMode: 'ihubSigned',
  useOidcKeyPair: false,
  privateKeyRef: '',
  algorithm: 'RS256',
  issuer: 'ihub-apps',
  audience: 'ifinder-api',
  tokenExpirationSeconds: 3600,
  defaultScope: 'fa_index_read',
  jwtSubjectField: 'email',
  tokenExchangeProvider: '',
  tokenExchangeGrant: 'tokenExchange',
  tokenExchangeAudience: '',
  tokenExchangeScopeIndexRead: '',
  tokenExchangeScopeAssistant: '',
  tokenExchangeScopeSmartCollections: '',
  tokenExchangeExtraScopes: [],
  defaultSearchProfile: 'searchprofile-standard',
  allowedSearchProfiles: [],
  allowUserSearchProfileChange: true
});

/** The signing algorithms iHub can sign the iFinder JWT with. */
export const ALGORITHM_OPTIONS = Object.freeze([
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512'
]);

/** Who issues the iFinder token. */
export const AUTH_MODES = Object.freeze(['ihubSigned', 'oidcTokenExchange']);

/** The token exchange grants. */
export const GRANT_TYPES = Object.freeze(['tokenExchange', 'entraObo']);

/**
 * The fixed subject choices (`utils/iFinderJwt.js` resolves exactly these);
 * anything else is a template with `${user.field}` placeholders.
 */
export const JWT_SUBJECT_OPTIONS = Object.freeze([
  { value: 'email', labelKey: 'email', labelDefault: 'Email address' },
  { value: 'username', labelKey: 'username', labelDefault: 'Username' },
  { value: 'id', labelKey: 'id', labelDefault: 'User ID' },
  { value: 'name', labelKey: 'name', labelDefault: 'Display name' },
  {
    value: String.raw`domain\username`,
    labelKey: 'domainUsername',
    labelDefault: String.raw`Domain\Username (NTLM-style)`
  }
]);

/** The template a custom subject starts with. */
export const CUSTOM_SUBJECT_TEMPLATE = '${user.email}';

/**
 * The scopes iHub asks iFinder tokens for, each with the value that maps it to
 * a scope of the OIDC provider. The installation stores exactly these three
 * (the old free-form scope map had no other entries iHub ever asked for).
 */
export const TOKEN_EXCHANGE_SCOPES = Object.freeze([
  { scope: 'fa_index_read', key: 'tokenExchangeScopeIndexRead' },
  { scope: 'fa_iassistant', key: 'tokenExchangeScopeAssistant' },
  { scope: 'fi_smartcollections', key: 'tokenExchangeScopeSmartCollections' }
]);

/** Whether a subject field is a template rather than one of the fixed choices. */
export function isCustomSubject(field) {
  return !JWT_SUBJECT_OPTIONS.some(option => option.value === field);
}

/**
 * The editor's starting values: the installation's (effective) values over
 * the defaults.
 *
 * @param {Object} values - the installation's values
 * @returns {Object}
 */
export function iFinderEditorValues(values) {
  const merged = { ...IFINDER_DEFAULTS };
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

/**
 * Search profile ids from the textarea: one per line (commas work too),
 * trimmed, without blanks and duplicates.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseProfileList(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/[\n,]/)
        .map(id => id.trim())
        .filter(Boolean)
    )
  ];
}

/**
 * Space-separated scopes from the "Additional scopes" field.
 * @param {string} text
 * @returns {string[]}
 */
export function parseScopeList(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The issuer iFinder must trust when iHub signs with its OIDC key pair: the
 * configured OAuth issuer when it is a URL, else the URL iHub detects from
 * the browser (`server/routes/wellKnown.js` does the same).
 *
 * @param {string} configuredIssuer - `platform.oauth.issuer`
 * @param {string} detectedIssuer - origin plus base path
 * @returns {string}
 */
export function effectiveIssuer(configuredIssuer, detectedIssuer) {
  return configuredIssuer?.startsWith('http') ? configuredIssuer : detectedIssuer || '';
}

/**
 * The first reason the values cannot be saved, or null. The server checks
 * the field types; these are the cross-field rules the old editor enforced.
 *
 * @param {Object} values
 * @param {{ issuer: string }} context - the effective OAuth issuer
 * @returns {{ key: string, messageKey: string, messageDefault: string }|null}
 */
export function validateIFinderValues(values, { issuer }) {
  if (!String(values.baseUrl || '').trim()) {
    return {
      key: 'baseUrl',
      messageKey: 'admin.integrations.editors.ifinder.baseUrlRequired',
      messageDefault: 'Enter the iFinder base URL.'
    };
  }
  if (values.authMode === 'oidcTokenExchange') {
    if (!String(values.tokenExchangeProvider || '').trim()) {
      return {
        key: 'tokenExchangeProvider',
        messageKey: 'admin.integrations.editors.ifinder.tokenExchange.providerRequired',
        messageDefault: 'Select the OIDC provider iHub shares with iFinder.'
      };
    }
    return null;
  }
  if (values.useOidcKeyPair && !String(issuer || '').startsWith('http')) {
    return {
      key: 'useOidcKeyPair',
      messageKey: 'admin.integrations.editors.ifinder.oidcKeyPairNeedsIssuer',
      messageDefault:
        'Signing with the OIDC key pair needs an OAuth issuer URL. It is detected from your server URL, or set it under Admin → Authentication → OAuth Server.'
    };
  }
  return null;
}
