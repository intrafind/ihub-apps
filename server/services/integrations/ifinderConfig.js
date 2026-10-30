// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder connection and the iAssistant settings, read from the two
 * built-in installations `ifinder` and `iassistant` in
 * `contents/config/integrations.json` (definitions `com.intrafind/ifinder`
 * and `com.intrafind/iassistant`).
 *
 * This is the one place that knows the field names of those installations
 * and the code defaults behind them. Everything that used to read
 * `platform.iFinder` or `platform.iAssistant` reads the objects returned
 * here, which keep the field names the callers always used.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import configCache from '../../configCache.js';

/** A draft installation under test replaces the installed one for the calls it makes. */
const overrides = new AsyncLocalStorage();

export const IFINDER_DEFINITION_ID = 'com.intrafind/ifinder';
export const IASSISTANT_DEFINITION_ID = 'com.intrafind/iassistant';
export const IFINDER_INSTANCE_ID = 'ifinder';
export const IASSISTANT_INSTANCE_ID = 'iassistant';

export const IFINDER_DEFAULT_ENDPOINTS = Object.freeze({
  search: '/public-api/retrieval/api/v1/search-profiles/{profileId}/_search',
  document: '/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}',
  // Discovery endpoints. `fields` is profile-independent: it describes the
  // index schema, not a profile's view of it.
  fields: '/public-api/retrieval/api/v1/schema-types/{schemaType}/fields',
  facets: '/public-api/retrieval/api/v1/search-profiles/{profileId}/facets/{facetId}/_search'
});

/** An installation of `integrations.json` by id, or null. */
export function installedInstance(id) {
  const installed = configCache.getIntegrations?.()?.data?.installed;
  if (!Array.isArray(installed)) return null;
  return installed.find(instance => instance?.id === id) || null;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : [];
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The iFinder connection: where it is, how iHub authenticates users at it,
 * and the search settings. `installed` and `enabled` say whether there is a
 * working installation at all.
 *
 * @returns {Object}
 */
export function getIFinderConfig() {
  const override = overrides.getStore()?.ifinder;
  if (override) return override;
  return iFinderConfigFromInstance(installedInstance(IFINDER_INSTANCE_ID));
}

/**
 * The connection an installation (saved or draft) describes.
 * @param {Object|null} instance - an `integrations.json` entry
 * @returns {Object}
 */
export function iFinderConfigFromInstance(instance) {
  const v = instance?.values || {};
  const scopeMap = {};
  if (v.tokenExchangeScopeIndexRead) scopeMap.fa_index_read = v.tokenExchangeScopeIndexRead;
  if (v.tokenExchangeScopeAssistant) scopeMap.fa_iassistant = v.tokenExchangeScopeAssistant;
  if (v.tokenExchangeScopeSmartCollections) {
    scopeMap.fi_smartcollections = v.tokenExchangeScopeSmartCollections;
  }
  return {
    installed: Boolean(instance),
    enabled: Boolean(instance) && instance.enabled !== false,
    // The environment wins over the installation, as it always did.
    baseUrl: process.env.IFINDER_API_URL || v.baseUrl || '',
    endpoints: {
      search: v.searchEndpoint || IFINDER_DEFAULT_ENDPOINTS.search,
      document: v.documentEndpoint || IFINDER_DEFAULT_ENDPOINTS.document,
      fields: v.fieldsEndpoint || IFINDER_DEFAULT_ENDPOINTS.fields,
      facets: v.facetsEndpoint || IFINDER_DEFAULT_ENDPOINTS.facets
    },
    defaultSearchProfile:
      v.defaultSearchProfile || process.env.IFINDER_SEARCH_PROFILE || 'searchprofile-standard',
    // The iFinder application whose search profile assignments listProfiles
    // reads (`searchprofile.applications`).
    searchProfileApplication: v.searchProfileApplication || 'ifinder',
    // Which of the user's profiles may be offered and searched; empty offers
    // all of them. The default profile is always allowed.
    allowedSearchProfiles: stringList(v.allowedSearchProfiles),
    // false pins every chat (and the model) to the default profile.
    allowUserSearchProfileChange: v.allowUserSearchProfileChange !== false,
    downloadDir: v.downloadDir || '/tmp/ifinder-downloads',
    timeout: finite(v.timeout, 30000),
    authMode: v.authMode === 'oidcTokenExchange' ? 'oidcTokenExchange' : 'ihubSigned',
    useOidcKeyPair: v.useOidcKeyPair === true,
    privateKeyRef: typeof v.privateKeyRef === 'string' ? v.privateKeyRef : '',
    algorithm: v.algorithm || 'RS256',
    issuer: v.issuer || 'ihub-apps',
    audience: v.audience || 'ifinder-api',
    tokenExpirationSeconds: finite(v.tokenExpirationSeconds, 3600),
    defaultScope: v.defaultScope || 'fa_index_read',
    jwtSubjectField: v.jwtSubjectField || 'email',
    tokenExchange: {
      oidcProvider: v.tokenExchangeProvider || '',
      grantType: v.tokenExchangeGrant || 'tokenExchange',
      audience: v.tokenExchangeAudience || '',
      scopeMap,
      extraScopes: stringList(v.tokenExchangeExtraScopes)
    }
  };
}

/**
 * Whether iFinder can be used: installed, switched on and pointing somewhere.
 * @param {Object} [cfg] - `getIFinderConfig()`
 * @returns {boolean}
 */
export function isIFinderConfigured(cfg = getIFinderConfig()) {
  return cfg?.enabled === true && typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() !== '';
}

/**
 * The iAssistant settings, on the iFinder connection.
 * @returns {Object}
 */
export function getIAssistantConfig() {
  const override = overrides.getStore()?.iassistant;
  if (override) return override;
  return iAssistantConfigFromInstance(installedInstance(IASSISTANT_INSTANCE_ID));
}

/**
 * The iAssistant settings an installation (saved or draft) describes, on the
 * iFinder connection it names.
 * @param {Object|null} instance
 * @param {Object} [ifinder] - the connection; the installed one by default
 * @returns {Object}
 */
export function iAssistantConfigFromInstance(instance, ifinder = getIFinderConfig()) {
  const v = instance?.values || {};
  return {
    installed: Boolean(instance),
    enabled: Boolean(instance) && instance.enabled !== false && ifinder.enabled,
    baseUrl: ifinder.baseUrl,
    defaultProfileId: v.defaultProfileId || process.env.IASSISTANT_PROFILE_ID || '',
    defaultFilter: [],
    // The search profile used when neither the app nor the model names one.
    defaultSearchProfile: v.defaultSearchProfile || 'searchprofile-standard',
    // Whether iHub checks the configured search profile against the ones the
    // user has in iFinder before creating a conversation.
    verifySearchProfileAccess: v.verifySearchProfileAccess !== false,
    searchProfileCacheTtlMs: finite(v.searchProfileCacheTtlMs, 300000),
    searchProfileApplication: ifinder.searchProfileApplication,
    // Installation-wide default for grounded-only answering; an app's own
    // `iassistant.groundedOnly` wins over it in either direction.
    groundedOnly: v.groundedOnly === true
  };
}

/**
 * Run `fn` with these configurations in place of the installed ones (the
 * wizard tests an installation before it is saved). Only the calls made
 * inside `fn` see them.
 *
 * @param {{ ifinder?: Object, iassistant?: Object }} configs
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export function withIntegrationConfigs(configs, fn) {
  const current = overrides.getStore() || {};
  return overrides.run({ ...current, ...configs }, fn);
}

/** Whether a draft configuration is in place for the current call. */
export function hasConfigOverride() {
  return Boolean(overrides.getStore());
}
