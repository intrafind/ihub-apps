// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The pure part of the storage provider editors (Office 365, Google Drive,
 * Nextcloud; `StorageProviderEditor.jsx`): per definition the route segment,
 * the defaults, the file sources and the required settings, the redirect URI
 * an admin registers with the provider, and the checks before a save.
 *
 * Mirrors the install fields of
 * `server/defaults/integration-definitions/com.intrafind__{office365,google-drive,nextcloud}`
 * and the provider shape of `server/services/integrations/cloudStorageConfig.js`.
 *
 * @module features/admin/components/integrations/editors/storageEditorModel
 */

/**
 * @typedef {Object} StorageSource
 * @property {string} key - the boolean install field (on unless `false`)
 * @property {string} labelKey
 * @property {string} labelDefault
 * @property {string} [helpKey]
 * @property {string} [helpDefault]
 */

/**
 * @typedef {Object} StorageEditorSpec
 * @property {string} type - provider type (`office365`, …)
 * @property {string} service - the route segment `/api/integrations/<service>/…`
 * @property {string} idPrefix - DOM id prefix of the editor
 * @property {string[]} required - the install fields a save needs
 * @property {string[]} urlFields - fields that must be http(s) URLs when set
 * @property {StorageSource[]} sources - the source switches (none for Nextcloud)
 * @property {Object} defaults - the values the editor shows for fields not stored
 * @property {string[]} advanced - fields under "Advanced settings"
 */

const K = 'admin.integrations.editors.storage';

/** @type {Object<string, StorageEditorSpec>} definition id → spec */
export const STORAGE_EDITOR_SPECS = Object.freeze({
  'com.intrafind/office365': Object.freeze({
    type: 'office365',
    service: 'office365',
    idPrefix: 'office365',
    required: ['tenantId', 'clientId', 'clientSecretRef'],
    urlFields: ['redirectUri', 'siteUrl'],
    sources: [
      {
        key: 'sourcePersonalDrive',
        labelKey: `${K}.sources.personalDrive`,
        labelDefault: 'Personal OneDrive',
        helpKey: `${K}.sources.personalDriveHelp`,
        helpDefault: 'Asks for Files.Read only, which users consent to themselves.'
      },
      {
        key: 'sourceFollowedSites',
        labelKey: `${K}.sources.followedSites`,
        labelDefault: 'Followed SharePoint sites',
        helpKey: `${K}.sources.followedSitesHelp`,
        helpDefault: 'Asks for Sites.Read.All and Files.Read.All (admin consent).'
      },
      {
        key: 'sourceTeams',
        labelKey: `${K}.sources.teams`,
        labelDefault: 'Microsoft Teams',
        helpKey: `${K}.sources.teamsHelp`,
        helpDefault:
          'Asks for Team.ReadBasic.All, Channel.ReadBasic.All and Files.Read.All (admin consent).'
      }
    ],
    defaults: Object.freeze({
      tenantId: '',
      clientId: '',
      clientSecretRef: '',
      redirectUri: '',
      sourcePersonalDrive: true,
      sourceFollowedSites: true,
      sourceTeams: true,
      siteUrl: '',
      driveId: ''
    }),
    advanced: ['siteUrl', 'driveId']
  }),
  'com.intrafind/google-drive': Object.freeze({
    type: 'googledrive',
    service: 'googledrive',
    idPrefix: 'googledrive',
    required: ['clientId', 'clientSecretRef'],
    urlFields: ['redirectUri'],
    sources: [
      { key: 'sourceMyDrive', labelKey: `${K}.sources.myDrive`, labelDefault: 'My Drive' },
      {
        key: 'sourceSharedDrives',
        labelKey: `${K}.sources.sharedDrives`,
        labelDefault: 'Shared drives'
      },
      {
        key: 'sourceSharedWithMe',
        labelKey: `${K}.sources.sharedWithMe`,
        labelDefault: 'Shared with me'
      }
    ],
    defaults: Object.freeze({
      clientId: '',
      clientSecretRef: '',
      redirectUri: '',
      sourceMyDrive: true,
      sourceSharedDrives: true,
      sourceSharedWithMe: true
    }),
    advanced: []
  }),
  'com.intrafind/nextcloud': Object.freeze({
    type: 'nextcloud',
    service: 'nextcloud',
    idPrefix: 'nextcloud',
    required: ['serverUrl', 'clientId', 'clientSecretRef'],
    urlFields: ['redirectUri', 'serverUrl'],
    sources: [],
    defaults: Object.freeze({
      serverUrl: '',
      clientId: '',
      clientSecretRef: '',
      redirectUri: ''
    }),
    advanced: []
  })
});

/** The definition ids that have a storage editor. */
export const STORAGE_DEFINITION_IDS = Object.freeze(Object.keys(STORAGE_EDITOR_SPECS));

/**
 * The spec of a storage definition, or null.
 * @param {string|null|undefined} definitionId
 * @returns {StorageEditorSpec|null}
 */
export function storageEditorSpec(definitionId) {
  return definitionId && Object.hasOwn(STORAGE_EDITOR_SPECS, definitionId)
    ? STORAGE_EDITOR_SPECS[definitionId]
    : null;
}

/**
 * The values the editor starts with: the defaults, overlaid with the
 * installation's effective values (only the spec's fields, nulls skipped).
 * @param {StorageEditorSpec} spec
 * @param {Object} [stored] - `instance.values`
 * @returns {Object}
 */
export function initialStorageValues(spec, stored = {}) {
  const values = { ...spec.defaults };
  for (const key of Object.keys(spec.defaults)) {
    const value = stored?.[key];
    if (value !== undefined && value !== null) values[key] = value;
  }
  return values;
}

/**
 * The callback path of an installation, below the deployment's base URL;
 * the same the server derives (`cloudStorageCallbackPath`).
 * @param {StorageEditorSpec} spec
 * @param {string} instanceId
 * @returns {string} e.g. `integrations/nextcloud/nextcloud-hq/callback` (relative to `/api/`)
 */
export function storageCallbackEndpoint(spec, instanceId) {
  return `integrations/${spec.service}/${encodeURIComponent(instanceId)}/callback`;
}

/**
 * The redirect URI to register with the provider: the configured one, else
 * the one the server derives from a request of this browser — origin, the
 * runtime base path and the callback path. `apiUrl` is the client's
 * `buildApiUrl` (it adds the base path, or returns an absolute URL when the
 * API lives elsewhere).
 *
 * @param {StorageEditorSpec} spec
 * @param {string} instanceId
 * @param {Object} env
 * @param {string} env.origin - `window.location.origin`
 * @param {(endpoint: string) => string} env.apiUrl - `buildApiUrl`
 * @param {string} [configured] - the installation's `redirectUri`
 * @returns {{ url: string, derived: boolean }}
 *
 * @example
 *   storageRedirectUri(spec, 'nextcloud-hq', {
 *     origin: 'https://ihub.example.com',
 *     apiUrl: e => `/ihub/api/${e}`
 *   });
 *   // → { url: 'https://ihub.example.com/ihub/api/integrations/nextcloud/nextcloud-hq/callback', derived: true }
 */
export function storageRedirectUri(spec, instanceId, { origin, apiUrl }, configured = '') {
  const own = typeof configured === 'string' ? configured.trim() : '';
  if (own) return { url: own, derived: false };
  const path = apiUrl(storageCallbackEndpoint(spec, instanceId));
  return { url: /^https?:\/\//i.test(path) ? path : `${origin}${path}`, derived: true };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The first problem of the values a save would send, or null: a required
 * field left empty, a URL field that is no http(s) URL, a configured redirect
 * URI that does not end in this installation's callback path.
 *
 * @param {StorageEditorSpec} spec
 * @param {string} instanceId
 * @param {Object} values
 * @returns {{ key: string, messageKey: string, messageDefault: string, params?: Object }|null}
 */
export function storageValuesProblem(spec, instanceId, values) {
  for (const key of spec.required) {
    if (!String(values?.[key] ?? '').trim()) {
      return {
        key,
        messageKey: `${K}.errors.required.${key}`,
        messageDefault: REQUIRED_MESSAGES[key] || 'This field is required.'
      };
    }
  }
  for (const key of spec.urlFields) {
    const value = String(values?.[key] ?? '').trim();
    if (value && !isHttpUrl(value)) {
      return {
        key,
        messageKey: `${K}.errors.url`,
        messageDefault: 'Enter an http(s) URL.'
      };
    }
  }
  const redirect = String(values?.redirectUri ?? '').trim();
  const path = `/api/${storageCallbackEndpoint(spec, instanceId)}`;
  if (redirect && !new URL(redirect).pathname.endsWith(path)) {
    return {
      key: 'redirectUri',
      messageKey: `${K}.errors.redirectPath`,
      messageDefault: 'The redirect URI has to end in {{path}}.',
      params: { path }
    };
  }
  return null;
}

const REQUIRED_MESSAGES = Object.freeze({
  tenantId: 'Enter the Directory (tenant) ID of the app registration.',
  clientId: 'Enter the client ID of the OAuth app.',
  clientSecretRef: 'Pick the credential that holds the client secret.',
  serverUrl: 'Enter the URL of the Nextcloud server.'
});

/**
 * The values a save sends: the spec's fields only (a field the definition
 * dropped never goes back), trimmed strings, booleans as they are.
 * @param {StorageEditorSpec} spec
 * @param {Object} values
 * @returns {Object}
 */
export function storageValuesToSave(spec, values) {
  const out = {};
  for (const key of Object.keys(spec.defaults)) {
    const value = values?.[key];
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}
