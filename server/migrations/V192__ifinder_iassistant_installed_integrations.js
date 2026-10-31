// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V192 — iFinder and iAssistant become installed integrations
 *
 * The iFinder connection (`platform.iFinder`) and the iAssistant settings
 * (`platform.iAssistant`) move into `config/integrations.json` as the two
 * built-in installations `ifinder` (definition `com.intrafind/ifinder`) and
 * `iassistant` (`com.intrafind/iassistant`). The blocks leave platform.json;
 * nothing reads them any more.
 *
 * Apps bind the installations instead of requiring the old integration id
 * and listing the tool ids:
 *
 * - `tools: ["iFinder_search", …]` or `["iFinder"]` → `integrations.ifinder.actions`
 *   (the whole list means every action, and is left out)
 * - an app on the iAssistant model (`preferredModel`) or with
 *   `iassistant.enabled` → `integrations.iassistant` with no actions
 * - a binding that existed only for its scope settings keeps the app's tools
 *   as they were: `actions: []`
 * - `requiredIntegrations: ["ifinder"]` without iFinder tools → an
 *   `integrations.ifinder` binding with `actions: []` (the gate, not the
 *   tools); an app that binds `iassistant` needs no such binding, since the
 *   iAssistant installation runs on iFinder
 *
 * `IHUB_PLATFORM__I_FINDER__*` and `IHUB_PLATFORM__I_ASSISTANT__*` variables,
 * which configCache applied to the blocks in memory, are folded into the
 * installations; the variables do nothing afterwards.
 *
 * The shipped `tools/iFinder.json` is removed: the iFinder installation owns
 * the seven actions and their tool ids (`iFinder_search`, …) stay the same.
 */

export const version = '192';
export const description = 'ifinder_iassistant_installed_integrations';

const IFINDER_ACTIONS = [
  'search',
  'getContent',
  'getMetadata',
  'discover',
  'getFields',
  'getFacetValues',
  'listProfiles'
];
const IFINDER_TOOL_PREFIX = 'iFinder_';

export async function precondition(ctx) {
  if (await ctx.fileExists('config/platform.json')) return true;
  if (await ctx.fileExists('tools/iFinder.json')) return true;
  const apps = await ctx.listFiles('apps', '*.json');
  return apps.length > 0;
}

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== '';
}

function put(values, key, value) {
  if (nonEmpty(value)) values[key] = value;
}

/** The `ifinder` installation an iFinder block describes. */
export function iFinderInstanceFrom(iFinder = {}) {
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
  const now = new Date().toISOString();
  return {
    id: 'ifinder',
    definition: 'com.intrafind/ifinder',
    definitionVersion: '1.0.0',
    enabled: iFinder.enabled === true,
    values,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: [],
    installedAt: now,
    updatedAt: now
  };
}

/** The `iassistant` installation an iAssistant block describes, on the iFinder connection. */
export function iAssistantInstanceFrom(iAssistant = {}, iFinder = {}) {
  const values = { connection: 'ifinder' };
  put(values, 'defaultProfileId', iAssistant.defaultProfileId);
  put(values, 'defaultSearchProfile', iAssistant.defaultSearchProfile);
  if (iAssistant.verifySearchProfileAccess === false) values.verifySearchProfileAccess = false;
  if (iAssistant.groundedOnly === true) values.groundedOnly = true;
  if (Number.isFinite(iAssistant.searchProfileCacheTtlMs)) {
    values.searchProfileCacheTtlMs = iAssistant.searchProfileCacheTtlMs;
  }
  const now = new Date().toISOString();
  return {
    id: 'iassistant',
    definition: 'com.intrafind/iassistant',
    definitionVersion: '1.0.0',
    enabled: iFinder.enabled === true,
    values,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: [],
    installedAt: now,
    updatedAt: now
  };
}

/**
 * The app with its iFinder and iAssistant usage expressed as bindings, or
 * null when nothing changes.
 * @param {Object} app
 * @returns {{ app: Object, notes: string[] } | null}
 */
export function migrateApp(app) {
  if (!app || typeof app !== 'object') return null;
  const notes = [];
  const next = structuredClone(app);
  const integrations =
    next.integrations && typeof next.integrations === 'object' ? { ...next.integrations } : {};

  // --- iFinder: the requirement and the tool ids become the binding
  const required = Array.isArray(next.requiredIntegrations) ? next.requiredIntegrations : [];
  const requiredIFinder = required.includes('ifinder');
  const tools = Array.isArray(next.tools) ? next.tools : [];
  const iFinderRefs = tools.filter(
    id => id === 'iFinder' || (typeof id === 'string' && id.startsWith(IFINDER_TOOL_PREFIX))
  );
  const hadScopeBinding = Boolean(integrations.ifinder);
  const usesAssistant =
    next.preferredModel === 'iassistant-conversation' ||
    next.iassistant?.enabled === true ||
    Boolean(integrations.iassistant);

  // A requirement alone (no iFinder tools, no scope settings) only gated the
  // app on the integration being on. An app on the iAssistant model gets that
  // from its `iassistant` binding; any other app keeps a binding without
  // actions, so it does not gain the seven tools it never had.
  const requirementOnly = requiredIFinder && !iFinderRefs.length && !hadScopeBinding;
  const bindsIFinder = requirementOnly
    ? !usesAssistant
    : Boolean(iFinderRefs.length || hadScopeBinding);

  if (bindsIFinder) {
    const binding = { ...(integrations.ifinder || {}) };
    if (iFinderRefs.length) {
      const all = iFinderRefs.includes('iFinder');
      const names = all
        ? IFINDER_ACTIONS
        : [
            ...new Set(
              iFinderRefs
                .map(id => id.slice(IFINDER_TOOL_PREFIX.length))
                .filter(name => IFINDER_ACTIONS.includes(name))
            )
          ];
      if (names.length === IFINDER_ACTIONS.length) delete binding.actions;
      else binding.actions = names;
      next.tools = tools.filter(id => !iFinderRefs.includes(id));
      if (next.tools.length === 0) delete next.tools;
      notes.push(
        `iFinder tools → integrations.ifinder${binding.actions ? ` (${names.join(', ')})` : ''}`
      );
    } else {
      // Scope settings or the requirement only: the app had no iFinder tools,
      // and keeps none.
      if (!Array.isArray(binding.actions)) binding.actions = [];
      if (requirementOnly) notes.push('requiredIntegrations ifinder → integrations.ifinder');
    }
    integrations.ifinder = binding;
  }
  if (requiredIFinder) {
    const rest = required.filter(id => id !== 'ifinder');
    if (rest.length) next.requiredIntegrations = rest;
    else delete next.requiredIntegrations;
    if (requirementOnly && usesAssistant) {
      notes.push('requiredIntegrations ifinder dropped: the iassistant binding needs iFinder');
    }
  }

  // --- iAssistant: the model, or the app setting, means the app uses it
  if (usesAssistant) {
    const binding = { ...(integrations.iassistant || {}) };
    // iAssistant offers no tool actions; the binding carries the scopes.
    if (!Array.isArray(binding.actions)) binding.actions = [];
    if (!integrations.iassistant) notes.push('iAssistant model → integrations.iassistant');
    integrations.iassistant = binding;
  }

  if (Object.keys(integrations).length) next.integrations = integrations;
  if (JSON.stringify(next) === JSON.stringify(app)) return null;
  return { app: next, notes };
}

/** `UPPER_SNAKE_CASE` → `camelCase`, as configCache maps `IHUB_*` variables. */
function toCamelCase(segment) {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function parseEnvValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function setNestedValue(target, pathParts, value) {
  let current = target;
  for (const key of pathParts.slice(0, -1)) {
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[pathParts.at(-1)] = value;
}

/**
 * The platform block with the `IHUB_PLATFORM__<BLOCK>__*` overrides of the
 * environment applied, the way configCache applied them in memory before the
 * block moved. The overrides never reached platform.json, so the migration
 * folds them into the installation itself; configCache ignores them from now
 * on and warns while they are still set.
 *
 * @param {Object|undefined} block - `platform.iFinder` or `platform.iAssistant`
 * @param {string} envPrefix - e.g. `IHUB_PLATFORM__I_FINDER__`
 * @param {Object} env
 * @returns {{ block: Object|undefined, applied: string[] }}
 */
export function withEnvOverrides(block, envPrefix, env = process.env) {
  const applied = [];
  let result = block;
  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith(envPrefix) || envValue === undefined) continue;
    const pathParts = envKey.slice(envPrefix.length).split('__').map(toCamelCase);
    if (pathParts.some(part => !part)) continue;
    if (!result || typeof result !== 'object') result = {};
    setNestedValue(result, pathParts, parseEnvValue(envValue));
    applied.push(envKey);
  }
  return { block: result, applied };
}

export const IFINDER_ENV_PREFIX = 'IHUB_PLATFORM__I_FINDER__';
export const IASSISTANT_ENV_PREFIX = 'IHUB_PLATFORM__I_ASSISTANT__';

export async function up(ctx, env = process.env) {
  // 1. The installations
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    const fromEnv = {
      iFinder: withEnvOverrides(platform?.iFinder, IFINDER_ENV_PREFIX, env),
      iAssistant: withEnvOverrides(platform?.iAssistant, IASSISTANT_ENV_PREFIX, env)
    };
    const iFinder = fromEnv.iFinder.block;
    const iAssistant = fromEnv.iAssistant.block;
    const applied = [...fromEnv.iFinder.applied, ...fromEnv.iAssistant.applied];
    if (applied.length) {
      ctx.log(
        `Folded ${applied.join(', ')} into the installations; the variables are ignored from now on and can be removed`
      );
    }
    if (iFinder || iAssistant) {
      const config = (await ctx.fileExists('config/integrations.json'))
        ? await ctx.readJson('config/integrations.json')
        : { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } };
      if (!Array.isArray(config.installed)) config.installed = [];
      if (!config.installed.some(inst => inst?.id === 'ifinder')) {
        config.installed.push(iFinderInstanceFrom(iFinder || {}));
        ctx.log(
          `platform.iFinder → installed integration "ifinder" (${iFinder?.enabled === true ? 'enabled' : 'disabled'})`
        );
      }
      if (!config.installed.some(inst => inst?.id === 'iassistant')) {
        config.installed.push(iAssistantInstanceFrom(iAssistant || {}, iFinder || {}));
        ctx.log('platform.iAssistant → installed integration "iassistant"');
      }
      await ctx.writeJson('config/integrations.json', config);
      delete platform.iFinder;
      delete platform.iAssistant;
      await ctx.writeJson('config/platform.json', platform);
    }
  }

  // 2. The shipped tool file: the installation owns the actions now
  if (await ctx.fileExists('tools/iFinder.json')) {
    await ctx.deleteFile('tools/iFinder.json');
    ctx.log('Removed tools/iFinder.json: the iFinder installation owns these actions');
  }

  // 3. Apps bind the installations
  const files = await ctx.listFiles('apps', '*.json');
  for (const file of files) {
    const path = `apps/${file}`;
    const app = await ctx.readJson(path);
    const migrated = migrateApp(app);
    if (!migrated) continue;
    await ctx.writeJson(path, migrated.app);
    ctx.log(`${path}: ${migrated.notes.join('; ') || 'bindings updated'}`);
  }
}
