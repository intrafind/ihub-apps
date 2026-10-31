// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The web search installation (`websearch`, definition
 * `com.intrafind/web-search`) as the search providers and the tool loader
 * read it: the default engine and the API keys. The keys live in the
 * credential store (the installation holds references); the environment
 * variables `BRAVE_SEARCH_API_KEY` and `STAAN_API_KEY` apply when no
 * reference is set, as before.
 *
 * Functions only, no module-scope work: this sits on both sides of the
 * `configCache → toolLoader → WebSearchService` import cycle.
 *
 * @module services/search/websearchConfig
 */
import config from '../../config.js';
import configCache from '../../configCache.js';
import credentialService from '../CredentialService.js';
import logger from '../../utils/logger.js';

export const WEBSEARCH_INSTANCE_ID = 'websearch';
export const WEBSEARCH_DEFINITION_ID = 'com.intrafind/web-search';

/** The installed `websearch` instance, or null. */
export function getWebSearchInstallation() {
  try {
    const installed = configCache.getIntegrations?.()?.data?.installed || [];
    return installed.find(instance => instance?.id === WEBSEARCH_INSTANCE_ID) || null;
  } catch {
    return null;
  }
}

/** Whether web search is installed and switched on. */
export function isWebSearchEnabled() {
  const instance = getWebSearchInstallation();
  return Boolean(instance) && instance.enabled !== false;
}

/**
 * The effective web search settings.
 * @returns {{ installed: boolean, enabled: boolean, defaultProvider: string, allowedGroups: string[] }}
 */
export function getWebSearchConfig() {
  const instance = getWebSearchInstallation();
  const values = instance?.values || {};
  const defaultProvider = ['auto', 'brave', 'staan', 'qwant'].includes(values.defaultProvider)
    ? values.defaultProvider
    : 'auto';
  return {
    installed: Boolean(instance),
    enabled: Boolean(instance) && instance.enabled !== false,
    defaultProvider,
    allowedGroups: Array.isArray(instance?.allowedGroups) ? instance.allowedGroups : []
  };
}

function keyFromCredential(fieldKey, envName) {
  const ref = getWebSearchInstallation()?.values?.[fieldKey];
  if (typeof ref === 'string' && ref) {
    try {
      const secret = credentialService.tryResolveSecret(ref);
      if (secret) return secret;
    } catch (error) {
      logger.error('Failed to resolve a web search API key from the credential store', {
        component: 'WebSearch',
        field: fieldKey,
        error: error.message
      });
    }
  }
  return config[envName] || process.env[envName] || undefined;
}

/** The Brave Search API key: the installation's credential, else `BRAVE_SEARCH_API_KEY`. */
export function resolveBraveApiKey() {
  return keyFromCredential('braveCredentialRef', 'BRAVE_SEARCH_API_KEY');
}

/** The Staan API key: the installation's credential, else `STAAN_API_KEY`. */
export function resolveStaanApiKey() {
  return keyFromCredential('staanCredentialRef', 'STAAN_API_KEY');
}
