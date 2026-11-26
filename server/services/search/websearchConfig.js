// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The installed web search engines as the search providers and the tool
 * loader read them (`config/integrations.json`, installations of type
 * `web-search`; see `webSearchEngines.js`), and the API keys of the keyed
 * built-in engines.
 *
 * A keyed engine's key lives in the credential store: the installation's
 * `apiKeyRef` field references it. The environment variables
 * `BRAVE_SEARCH_API_KEY` and `STAAN_API_KEY` apply when no credential is
 * referenced (or the referenced one is empty), as before.
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
import {
  ENGINE_API_KEY_FIELD,
  ENGINE_AUTHORIZATION_FIELD,
  ENGINE_INSTANCE_URL_FIELD,
  builtInEngine,
  isWebSearchEngine,
  sortWebSearchEngines
} from './webSearchEngines.js';

/** Every installation in `config/integrations.json`, or an empty list. */
function installedIntegrations() {
  try {
    const installed = configCache.getIntegrations?.()?.data?.installed;
    return Array.isArray(installed) ? installed : [];
  } catch {
    return [];
  }
}

/**
 * The installed web search engines, enabled or not, in the order
 * `websearch.provider: "auto"` tries them (Brave, Staan, SearXNG, then any
 * other engine by id).
 *
 * @returns {Object[]} installations of type `web-search`
 */
export function listWebSearchEngines() {
  return sortWebSearchEngines(installedIntegrations().filter(isWebSearchEngine));
}

/**
 * The installed web search engine with this id, enabled or not, or null (no
 * such installation, or one that is not a web search engine).
 *
 * @param {string} id - e.g. `brave`
 * @returns {Object|null}
 */
export function getWebSearchEngine(id) {
  if (typeof id !== 'string' || !id) return null;
  return (
    installedIntegrations().find(entry => entry?.id === id && isWebSearchEngine(entry)) || null
  );
}

/**
 * Where a keyed built-in engine's API key comes from, and the key.
 *
 * @param {string} engineId - `brave` or `staan` (any other id has no key)
 * @param {Object} [values] - install values to read the credential reference
 *   from; the installed engine's values by default. The admin's test passes
 *   the unsaved values here.
 * @returns {{ key: string|undefined, source: 'credential'|'env'|null, ref: string|null, refMissing: boolean }}
 *   `refMissing`: a credential is referenced but has no value (or does not exist)
 */
export function resolveEngineApiKeyDetails(engineId, values) {
  const engine = builtInEngine(engineId);
  if (!engine?.keyEnv) return { key: undefined, source: null, ref: null, refMissing: false };
  const effectiveValues = values ?? getWebSearchEngine(engineId)?.values ?? {};
  const ref = effectiveValues?.[ENGINE_API_KEY_FIELD];
  let refMissing = false;
  if (typeof ref === 'string' && ref) {
    try {
      const secret = credentialService.tryResolveSecret(ref);
      if (secret) return { key: secret, source: 'credential', ref, refMissing: false };
    } catch (error) {
      logger.error('Failed to resolve a web search API key from the credential store', {
        component: 'WebSearch',
        engine: engineId,
        error: error.message
      });
    }
    refMissing = true;
  }
  const fromEnv = config[engine.keyEnv] || process.env[engine.keyEnv] || undefined;
  return {
    key: fromEnv,
    source: fromEnv ? 'env' : null,
    ref: typeof ref === 'string' && ref ? ref : null,
    refMissing
  };
}

/**
 * A keyed built-in engine's API key: the credential its installation
 * references, else the environment variable.
 *
 * @param {string} engineId - `brave` or `staan`
 * @param {Object} [values] - install values (unsaved ones in the admin test)
 * @returns {string|undefined}
 */
export function resolveEngineApiKey(engineId, values) {
  return resolveEngineApiKeyDetails(engineId, values).key;
}

/** The Brave Search API key: the `brave` installation's credential, else `BRAVE_SEARCH_API_KEY`. */
export function resolveBraveApiKey() {
  return resolveEngineApiKey('brave');
}

/** The Staan API key: the `staan` installation's credential, else `STAAN_API_KEY`. */
export function resolveStaanApiKey() {
  return resolveEngineApiKey('staan');
}

/**
 * The base URL of a SearXNG instance as the admin entered it, reduced to what
 * the provider appends `/search` to: scheme, host, port and path, without a
 * trailing slash, a trailing `/search` (the ticket's example is
 * `http://localhost:8080/search`), a query string, a fragment or credentials.
 *
 * @param {unknown} value - the `instanceUrl` install value
 * @returns {string|null} e.g. `https://search.example.org/searx`, or null when it is not an http(s) URL
 * @example
 * normalizeSearxngBaseUrl('http://localhost:8080/search'); // → 'http://localhost:8080'
 */
export function normalizeSearxngBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/search$/, '');
  return `${url.origin}${path}`;
}

/**
 * The `Authorization` header value for the credential a SearXNG installation
 * references. SearXNG has no authentication of its own: a reverse proxy in
 * front of it asks for one. The secret is sent as `Bearer <secret>`; a secret
 * that already starts with `Basic ` or `Bearer ` is sent as it is, which is how
 * a proxy that wants HTTP Basic is served.
 *
 * @param {string} secret
 * @returns {string}
 */
export function searxngAuthorizationHeader(secret) {
  const value = String(secret).trim();
  return /^(basic|bearer)\s+\S/i.test(value) ? value : `Bearer ${value}`;
}

/**
 * What a SearXNG search needs: the instance's base URL and, when the
 * installation references one, the `Authorization` header value.
 *
 * @param {Object} [values] - install values; the installed engine's by default
 *   (the admin's test passes the unsaved ones)
 * @returns {{ baseUrl: string|null, authorization: string|undefined, ref: string|null, refMissing: boolean }}
 *   `baseUrl` null: no (valid) URL; `refMissing`: a credential is referenced but has no value
 */
export function resolveSearxngSettings(values) {
  const effective = values ?? getWebSearchEngine('searxng')?.values ?? {};
  const baseUrl = normalizeSearxngBaseUrl(effective?.[ENGINE_INSTANCE_URL_FIELD]);
  const ref = effective?.[ENGINE_AUTHORIZATION_FIELD];
  if (typeof ref !== 'string' || !ref) {
    return { baseUrl, authorization: undefined, ref: null, refMissing: false };
  }
  try {
    const secret = credentialService.tryResolveSecret(ref);
    if (secret) {
      return { baseUrl, authorization: searxngAuthorizationHeader(secret), ref, refMissing: false };
    }
  } catch (error) {
    logger.error('Failed to resolve the SearXNG credential from the credential store', {
      component: 'WebSearch',
      engine: 'searxng',
      error: error.message
    });
  }
  return { baseUrl, authorization: undefined, ref, refMissing: true };
}

/**
 * Whether an engine has what it needs to answer: a keyed built-in engine
 * (Brave, Staan) needs a key; SearXNG needs the URL of its instance;
 * third-party engines need nothing iHub can check here (their own test says
 * more).
 *
 * @param {{ id: string }|null} engine - the installation
 * @returns {boolean}
 */
export function isWebSearchEngineConfigured(engine) {
  if (!engine?.id) return false;
  if (
    engine.id === 'searxng' &&
    (!engine.definition || engine.definition === builtInEngine('searxng').definition)
  ) {
    return Boolean(resolveSearxngSettings(engine.values || {}).baseUrl);
  }
  const builtIn = builtInEngine(engine.id);
  if (!builtIn?.keyEnv || (engine.definition && engine.definition !== builtIn.definition)) {
    return true;
  }
  return Boolean(resolveEngineApiKey(engine.id, engine.values || {}));
}
