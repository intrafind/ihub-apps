// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Turns the environment of a new installation into its configuration, once,
 * on the start that creates `contents/` from server/defaults.
 *
 * A fresh install runs no migration (server/defaults is kept fully migrated),
 * but some migrations used to do more than reshape files: they read
 * environment variables and wrote the result into `contents/`, after which
 * the server reads the configuration, not the variable. A Docker installation
 * configured only through its environment depends on that. This module does
 * the same for a new installation, writing what those migrations and the ones
 * after them would have left:
 *
 * - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`:
 *   the setup wizard counts as done (`platform.setup.configured`, V075).
 * - `IHUB_PLATFORM__I_FINDER__*`, `IHUB_PLATFORM__I_ASSISTANT__*`: the
 *   `ifinder` and `iassistant` installations (V192).
 * - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: the `entra`
 *   installation, enabled when all three are set (V197).
 * - `BRAVE_SEARCH_API_KEY`, `STAAN_API_KEY`: the `brave` and `staan` web
 *   search installations (V204).
 * - `MCP_SERVER_URL`: the `legacy-mcp-server` installation (V050, V193).
 *
 * The shipped installations get the time of this first start as their
 * `installedAt` / `updatedAt` ({@link stampInstallationTimes}).
 *
 * Existing installations never pass through here; their migrations already
 * ran. tests/first-start-environment.test.js pins the output to what the
 * migrations produced on a fresh install.
 *
 * @module utils/firstStartEnvironment
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJSON } from './atomicWrite.js';
import { toCamelCase, parseEnvValue, setNestedValue } from './configOverrides.js';
import { getContentsPath } from './contentsPath.js';
import logger from './logger.js';

const SETUP_KEY_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY'];
const IFINDER_ENV_PREFIX = 'IHUB_PLATFORM__I_FINDER__';
const IASSISTANT_ENV_PREFIX = 'IHUB_PLATFORM__I_ASSISTANT__';

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const nonEmpty = value =>
  value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');

function put(values, key, value) {
  if (nonEmpty(value)) values[key] = value;
}

/** The block the `<prefix>A__B=value` variables describe, or undefined when none is set. */
function blockFromEnv(prefix, env) {
  let block;
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;
    const pathParts = key.slice(prefix.length).split('__').map(toCamelCase);
    if (pathParts.some(part => !part)) continue;
    block ??= {};
    setNestedValue(block, pathParts, parseEnvValue(value));
  }
  return block;
}

function installation(id, definition, enabled, values, now, extra = {}) {
  return {
    id,
    definition,
    definitionVersion: '1.0.0',
    enabled,
    values,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    ...extra,
    installedAt: now,
    updatedAt: now
  };
}

/** The values of the `ifinder` installation a `platform.iFinder`-shaped block describes. */
function iFinderValues(iFinder) {
  const values = {};
  put(values, 'baseUrl', iFinder.baseUrl);
  put(values, 'authMode', iFinder.authMode);
  if (iFinder.useOidcKeyPair === true) values.useOidcKeyPair = true;
  put(values, 'privateKeyRef', iFinder.privateKeyRef);
  put(values, 'algorithm', iFinder.algorithm);
  put(values, 'issuer', iFinder.issuer);
  put(values, 'audience', iFinder.audience);
  if (Number.isFinite(iFinder.tokenExpirationSeconds)) {
    values.tokenExpirationSeconds = iFinder.tokenExpirationSeconds;
  }
  put(values, 'defaultScope', iFinder.defaultScope);
  put(values, 'jwtSubjectField', iFinder.jwtSubjectField);
  const exchange = iFinder.tokenExchange || {};
  put(values, 'tokenExchangeProvider', exchange.oidcProvider);
  put(values, 'tokenExchangeGrant', exchange.grantType);
  put(values, 'tokenExchangeAudience', exchange.audience);
  const scopeMap = exchange.scopeMap || {};
  put(values, 'tokenExchangeScopeIndexRead', scopeMap.fa_index_read);
  put(values, 'tokenExchangeScopeAssistant', scopeMap.fa_iassistant);
  put(values, 'tokenExchangeScopeSmartCollections', scopeMap.fi_smartcollections);
  if (Array.isArray(exchange.extraScopes) && exchange.extraScopes.length) {
    values.tokenExchangeExtraScopes = exchange.extraScopes.filter(s => typeof s === 'string' && s);
  }
  put(values, 'searchProfileApplication', iFinder.searchProfileApplication);
  put(values, 'defaultSearchProfile', iFinder.defaultSearchProfile);
  if (Array.isArray(iFinder.allowedSearchProfiles) && iFinder.allowedSearchProfiles.length) {
    values.allowedSearchProfiles = iFinder.allowedSearchProfiles.filter(
      s => typeof s === 'string' && s
    );
  }
  if (iFinder.allowUserSearchProfileChange === false) values.allowUserSearchProfileChange = false;
  if (Number.isFinite(iFinder.timeout)) values.timeout = iFinder.timeout;
  put(values, 'downloadDir', iFinder.downloadDir);
  const endpoints = iFinder.endpoints || {};
  put(values, 'searchEndpoint', endpoints.search);
  put(values, 'documentEndpoint', endpoints.document);
  put(values, 'fieldsEndpoint', endpoints.fields);
  put(values, 'facetsEndpoint', endpoints.facets);
  return values;
}

/** The values of the `iassistant` installation, on the iFinder connection. */
function iAssistantValues(iAssistant) {
  const values = { connection: 'ifinder' };
  put(values, 'defaultProfileId', iAssistant.defaultProfileId);
  put(values, 'defaultSearchProfile', iAssistant.defaultSearchProfile);
  if (iAssistant.verifySearchProfileAccess === false) values.verifySearchProfileAccess = false;
  if (iAssistant.groundedOnly === true) values.groundedOnly = true;
  if (Number.isFinite(iAssistant.searchProfileCacheTtlMs)) {
    values.searchProfileCacheTtlMs = iAssistant.searchProfileCacheTtlMs;
  }
  return values;
}

/**
 * Apply the environment to the parsed `platform.json` and `integrations.json`
 * of a new installation, in place.
 *
 * @param {{ platform: object, integrations: object }} config
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [now] - ISO timestamp for new installations
 * @returns {{ platform: boolean, integrations: boolean, applied: string[] }}
 *   which files changed, and what was applied (for the log)
 */
export function applyFirstStartEnvironment(
  { platform, integrations },
  env = process.env,
  now = new Date().toISOString()
) {
  const changed = { platform: false, integrations: false, applied: [] };
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  const installed = integrations.installed;
  const has = id => installed.some(entry => entry?.id === id);
  const add = (entry, what) => {
    installed.push(entry);
    changed.integrations = true;
    changed.applied.push(what);
  };

  const setupKey = SETUP_KEY_VARS.find(name => text(env[name]));
  if (setupKey && platform.setup?.configured === false) {
    platform.setup.configured = true;
    changed.platform = true;
    changed.applied.push(`${setupKey} → setup.configured`);
  }

  const iFinder = blockFromEnv(IFINDER_ENV_PREFIX, env);
  const iAssistant = blockFromEnv(IASSISTANT_ENV_PREFIX, env);
  if (iFinder || iAssistant) {
    const enabled = iFinder?.enabled === true;
    if (!has('ifinder')) {
      add(
        installation(
          'ifinder',
          'com.intrafind/ifinder',
          enabled,
          iFinderValues(iFinder || {}),
          now
        ),
        `${IFINDER_ENV_PREFIX}* → installation "ifinder"`
      );
    }
    if (!has('iassistant')) {
      add(
        installation(
          'iassistant',
          'com.intrafind/iassistant',
          enabled,
          iAssistantValues(iAssistant || {}),
          now
        ),
        `${IASSISTANT_ENV_PREFIX}* → installation "iassistant"`
      );
    }
  }

  const entra = installed.find(entry => entry?.id === 'entra');
  const tenantId = text(env.AZURE_TENANT_ID);
  const clientId = text(env.AZURE_CLIENT_ID);
  if (entra && (tenantId || clientId)) {
    entra.values = { ...entra.values };
    if (tenantId) entra.values.tenantId = tenantId;
    if (clientId) entra.values.clientId = clientId;
    entra.enabled = Boolean(tenantId && clientId && text(env.AZURE_CLIENT_SECRET));
    entra.updatedAt = now;
    changed.integrations = true;
    changed.applied.push(
      `AZURE_* → installation "entra" (${entra.enabled ? 'enabled' : 'disabled'})`
    );
  }

  if (text(env.BRAVE_SEARCH_API_KEY) && !has('brave')) {
    add(
      installation('brave', 'com.intrafind/brave-search', true, {}, now),
      'BRAVE_SEARCH_API_KEY → installation "brave"'
    );
  }
  if (text(env.STAAN_API_KEY) && !has('staan')) {
    add(
      installation('staan', 'com.intrafind/staan-search', true, {}, now),
      'STAAN_API_KEY → installation "staan"'
    );
  }

  const mcpUrl = text(env.MCP_SERVER_URL);
  if (mcpUrl && !has('legacy-mcp-server')) {
    add(
      installation(
        'legacy-mcp-server',
        'com.intrafind/mcp-server',
        true,
        { transport: 'streamableHttp', url: mcpUrl },
        now,
        { label: { en: 'Legacy MCP Server (promoted from MCP_SERVER_URL)' } }
      ),
      'MCP_SERVER_URL → installation "legacy-mcp-server"'
    );
  }

  return changed;
}

/**
 * Give every installation without an `installedAt` the time of this first
 * start, in place. The shipped `integrations.json` carries no timestamps.
 *
 * @param {object} integrations - parsed `config/integrations.json`
 * @param {string} [now] - ISO timestamp
 * @returns {boolean} whether anything changed
 */
export function stampInstallationTimes(integrations, now = new Date().toISOString()) {
  let changed = false;
  for (const entry of Array.isArray(integrations.installed) ? integrations.installed : []) {
    if (!entry || typeof entry !== 'object' || entry.installedAt) continue;
    entry.installedAt = now;
    entry.updatedAt ??= now;
    changed = true;
  }
  return changed;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Apply the environment to the `contents/` a new installation was just
 * seeded with. Call only on the start that created `contents/`.
 *
 * @param {{ contentsPath?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {Promise<string[]>} what was applied
 */
export async function importEnvironmentOnFirstStart({
  contentsPath = getContentsPath(),
  env = process.env
} = {}) {
  const platformFile = path.join(contentsPath, 'config', 'platform.json');
  const integrationsFile = path.join(contentsPath, 'config', 'integrations.json');
  const platform = await readJson(platformFile, {});
  const integrations = await readJson(integrationsFile, { installed: [] });

  const now = new Date().toISOString();
  const changed = applyFirstStartEnvironment({ platform, integrations }, env, now);
  const stamped = stampInstallationTimes(integrations, now);
  if (changed.platform) await atomicWriteJSON(platformFile, platform);
  if (changed.integrations || stamped) await atomicWriteJSON(integrationsFile, integrations);
  if (changed.applied.length) {
    logger.info('Applied the environment to the new installation', {
      component: 'Setup',
      applied: changed.applied
    });
  }
  return changed.applied;
}
