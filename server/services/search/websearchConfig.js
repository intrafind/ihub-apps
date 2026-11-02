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
 * `websearch.provider: "auto"` tries them (Brave, Staan, Qwant, then any
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
 * Whether an engine has what it needs to answer: a keyed built-in engine
 * (Brave, Staan) needs a key; Qwant and third-party engines need nothing iHub
 * can check here (their own test says more).
 *
 * @param {{ id: string }|null} engine - the installation
 * @returns {boolean}
 */
export function isWebSearchEngineConfigured(engine) {
  if (!engine?.id) return false;
  const builtIn = builtInEngine(engine.id);
  if (!builtIn?.keyEnv || (engine.definition && engine.definition !== builtIn.definition)) {
    return true;
  }
  return Boolean(resolveEngineApiKey(engine.id, engine.values || {}));
}
