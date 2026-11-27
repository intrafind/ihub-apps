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
const nonEmptyStrings = value =>
  Array.isArray(value) && value.length ? value.filter(s => typeof s === 'string' && s) : undefined;

/** The value at a dotted path of a block, or undefined. */
const at = (block, dotted) => dotted.split('.').reduce((node, key) => node?.[key], block);

/**
 * How a `platform.iFinder` / `platform.iAssistant`-shaped block maps onto the
 * values of its installation (the mapping of V192): install value, path in the
 * block, and which values count (any non-empty one by default).
 */
const IFINDER_VALUES = [
  ['baseUrl', 'baseUrl'],
  ['authMode', 'authMode'],
  ['useOidcKeyPair', 'useOidcKeyPair', value => value === true],
  ['privateKeyRef', 'privateKeyRef'],
  ['algorithm', 'algorithm'],
  ['issuer', 'issuer'],
  ['audience', 'audience'],
  ['tokenExpirationSeconds', 'tokenExpirationSeconds', Number.isFinite],
  ['defaultScope', 'defaultScope'],
  ['jwtSubjectField', 'jwtSubjectField'],
  ['tokenExchangeProvider', 'tokenExchange.oidcProvider'],
  ['tokenExchangeGrant', 'tokenExchange.grantType'],
  ['tokenExchangeAudience', 'tokenExchange.audience'],
  ['tokenExchangeScopeIndexRead', 'tokenExchange.scopeMap.fa_index_read'],
  ['tokenExchangeScopeAssistant', 'tokenExchange.scopeMap.fa_iassistant'],
  ['tokenExchangeScopeSmartCollections', 'tokenExchange.scopeMap.fi_smartcollections'],
  ['tokenExchangeExtraScopes', 'tokenExchange.extraScopes', 'strings'],
  ['searchProfileApplication', 'searchProfileApplication'],
  ['defaultSearchProfile', 'defaultSearchProfile'],
  ['allowedSearchProfiles', 'allowedSearchProfiles', 'strings'],
  ['allowUserSearchProfileChange', 'allowUserSearchProfileChange', value => value === false],
  ['timeout', 'timeout', Number.isFinite],
  ['downloadDir', 'downloadDir'],
  ['searchEndpoint', 'endpoints.search'],
  ['documentEndpoint', 'endpoints.document'],
  ['fieldsEndpoint', 'endpoints.fields'],
  ['facetsEndpoint', 'endpoints.facets']
];

const IASSISTANT_VALUES = [
  ['defaultProfileId', 'defaultProfileId'],
  ['defaultSearchProfile', 'defaultSearchProfile'],
  ['verifySearchProfileAccess', 'verifySearchProfileAccess', value => value === false],
  ['groundedOnly', 'groundedOnly', value => value === true],
  ['searchProfileCacheTtlMs', 'searchProfileCacheTtlMs', Number.isFinite]
];

/** The install values `mapping` takes from `block`. */
function valuesFrom(block, mapping, values = {}) {
  for (const [key, dotted, accept = nonEmpty] of mapping) {
    const value = at(block, dotted);
    if (accept === 'strings') {
      const strings = nonEmptyStrings(value);
      if (strings) values[key] = strings;
    } else if (accept(value)) {
      values[key] = value;
    }
  }
  return values;
}

/** The block the `<prefix>A__B=value` variables describe, or undefined when none is set. */
function blockFromEnv(prefix, env) {
  let block;
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;
    const pathParts = key
      .slice(prefix.length)
      .split('__')
      .map(part => toCamelCase(part));
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

/** Provider keys: the setup wizard counts as done (V075). */
function applySetupKeys(platform, env, changes) {
  const setupKey = SETUP_KEY_VARS.find(name => text(env[name]));
  if (!setupKey || platform.setup?.configured !== false) return;
  platform.setup.configured = true;
  changes.platform = true;
  changes.applied.push(`${setupKey} → setup.configured`);
}

/** `IHUB_PLATFORM__I_FINDER__*` / `__I_ASSISTANT__*`: both installations (V192). */
function applyIFinder(env, changes) {
  const iFinder = blockFromEnv(IFINDER_ENV_PREFIX, env);
  const iAssistant = blockFromEnv(IASSISTANT_ENV_PREFIX, env);
  if (!iFinder && !iAssistant) return;
  const enabled = iFinder?.enabled === true;
  changes.add(
    'ifinder',
    'com.intrafind/ifinder',
    enabled,
    valuesFrom(iFinder || {}, IFINDER_VALUES),
    `${IFINDER_ENV_PREFIX}*`
  );
  changes.add(
    'iassistant',
    'com.intrafind/iassistant',
    enabled,
    valuesFrom(iAssistant || {}, IASSISTANT_VALUES, { connection: 'ifinder' }),
    `${IASSISTANT_ENV_PREFIX}*`
  );
}

/** `AZURE_*`: the shipped `entra` installation, enabled with all three (V197). */
function applyEntra(installed, env, now, changes) {
  const entra = installed.find(entry => entry?.id === 'entra');
  const tenantId = text(env.AZURE_TENANT_ID);
  const clientId = text(env.AZURE_CLIENT_ID);
  if (!entra || !(tenantId || clientId)) return;
  entra.values = { ...entra.values };
  if (tenantId) entra.values.tenantId = tenantId;
  if (clientId) entra.values.clientId = clientId;
  entra.enabled = Boolean(tenantId && clientId && text(env.AZURE_CLIENT_SECRET));
  entra.updatedAt = now;
  changes.integrations = true;
  changes.applied.push(
    `AZURE_* → installation "entra" (${entra.enabled ? 'enabled' : 'disabled'})`
  );
}

/** Search engine keys (V204) and `MCP_SERVER_URL` (V050, V193). */
function applyKeyedInstallations(env, changes) {
  if (text(env.BRAVE_SEARCH_API_KEY)) {
    changes.add('brave', 'com.intrafind/brave-search', true, {}, 'BRAVE_SEARCH_API_KEY');
  }
  if (text(env.STAAN_API_KEY)) {
    changes.add('staan', 'com.intrafind/staan-search', true, {}, 'STAAN_API_KEY');
  }
  const mcpUrl = text(env.MCP_SERVER_URL);
  if (mcpUrl) {
    changes.add(
      'legacy-mcp-server',
      'com.intrafind/mcp-server',
      true,
      { transport: 'streamableHttp', url: mcpUrl },
      'MCP_SERVER_URL',
      { label: { en: 'Legacy MCP Server (promoted from MCP_SERVER_URL)' } }
    );
  }
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
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  const installed = integrations.installed;
  const changes = {
    platform: false,
    integrations: false,
    applied: [],
    // Add an installation unless one with this id exists.
    add(id, definition, enabled, values, source, extra) {
      if (installed.some(entry => entry?.id === id)) return;
      installed.push(installation(id, definition, enabled, values, now, extra));
      this.integrations = true;
      this.applied.push(`${source} → installation "${id}"`);
    }
  };

  applySetupKeys(platform, env, changes);
  applyIFinder(env, changes);
  applyEntra(installed, env, now, changes);
  applyKeyedInstallations(env, changes);

  const { platform: platformChanged, integrations: integrationsChanged, applied } = changes;
  return { platform: platformChanged, integrations: integrationsChanged, applied };
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
