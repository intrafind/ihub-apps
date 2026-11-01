// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `native` protocol: a built-in integration whose actions run in a server
 * module (connector). The definition declares the actions, their side effects
 * and guidance; the connector implements them and knows the system's own
 * ways of listing scopes and testing a connection.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getLocalizedString } from '../../../../utils/localize.js';
import logger from '../../../../utils/logger.js';
import integrationRegistry from '../../definitions/IntegrationRegistry.js';
import { effectiveValues, localized } from '../../definitions/installedValues.js';
import { actionRequirementsMet } from '../enforcement.js';
import { toolIdFor, actionEnabled, testResult } from '../common.js';
import { getConnector, listConnectors } from './connectors/index.js';

/**
 * Connector modules of `script` definitions, one entry per module file:
 * `<dir>/<module>` → `{ key, definitionId, loading }`, where `key` is
 * `file@version@mtime` and `loading` the promise of the connector (with
 * `__loaded` set once it resolved, for the sync callers). A re-installed
 * folder has a new module mtime, which is part of the import URL, so the
 * fresh code is loaded, and it takes the file's one entry, so the previous
 * version is no longer served (Node keeps the old module instance in its
 * own cache; nothing here points at it any more).
 *
 * The connector is bundled into one file (see `definitions/scriptModule.js`):
 * only the entry module's URL carries the cache-buster.
 */
const scriptConnectors = new Map();

/** `<dir>/<module>` of a `script` definition, or null when the folder is unknown. */
function scriptModuleFile(definition) {
  const entry = integrationRegistry.get(definition.id);
  if (!entry?.dir) return null;
  const file = path.resolve(entry.dir, definition.protocol.module);
  if (!file.startsWith(path.resolve(entry.dir) + path.sep)) {
    throw new Error(`Integration ${definition.id}: module path leaves the definition folder`);
  }
  return file;
}

/** Connector of a `script` definition, loaded once per folder and module version. */
async function loadScriptConnector(definition) {
  const file = scriptModuleFile(definition);
  if (!file) throw new Error(`Integration ${definition.id}: definition folder is unknown`);
  const stat = await fs.stat(file);
  const key = `${file}@${definition.version}@${stat.mtimeMs}`;
  const current = scriptConnectors.get(file);
  if (current?.key === key) return current.loading;
  const loading = (async () => {
    const url = `${pathToFileURL(file).href}?v=${encodeURIComponent(`${definition.version}-${stat.mtimeMs}`)}`;
    const module = await import(url);
    const connector = module.default || module;
    if (!connector || typeof connector !== 'object' || typeof connector.actions !== 'object') {
      throw new Error(
        `Integration ${definition.id}: module "${definition.protocol.module}" exports no connector (an object with "actions")`
      );
    }
    logger.info('Loaded integration connector module', {
      component: 'NativeAdapter',
      definition: definition.id,
      module: definition.protocol.module,
      version: definition.version,
      replaced: current?.key
    });
    return { ...connector, id: connector.id || definition.id };
  })();
  const entry = { key, definitionId: definition.id, loading };
  scriptConnectors.set(file, entry);
  loading.then(
    connector => {
      loading.__loaded = connector;
    },
    () => {
      // A module that does not load has no entry; the previous version is
      // gone with it, as the installation is broken until it is fixed.
      if (scriptConnectors.get(file) === entry) scriptConnectors.delete(file);
    }
  );
  return loading;
}

/** The connector behind a `native` or `script` definition. */
export async function getConnectorFor(definition) {
  if (definition.protocol.type === 'script') return loadScriptConnector(definition);
  return getConnector(definition.protocol.module);
}

/** The already loaded connector of a `script` definition, or null (sync callers). */
function loadedScriptConnector(definition) {
  let file = null;
  try {
    file = scriptModuleFile(definition);
  } catch {
    return null;
  }
  return (file && scriptConnectors.get(file)?.loading.__loaded) || null;
}

/** The loaded script connector modules, for diagnostics and tests: `[{ definitionId, file, key }]`. */
export function loadedScriptModules() {
  return [...scriptConnectors].map(([file, { key, definitionId }]) => ({
    definitionId,
    file,
    key
  }));
}

/**
 * Definitions were reloaded (a re-install, another worker's announcement):
 * load the connectors of the changed `script` definitions, so the new module
 * serves the next action and its own scope provider is registered, and drop
 * the modules of definitions that are gone. Then the scope providers are
 * synced, because `scopeProvider` below only sees a loaded connector. A
 * module that does not load is logged and leaves the others alone.
 *
 * @param {{ definitionIds?: string[] }} [context] - the changed definitions; all `script` definitions when absent
 */
export async function onChanged({ definitionIds } = {}) {
  const changed = definitionIds
    ? definitionIds.map(id => integrationRegistry.get(id)?.definition || { id })
    : [
        ...integrationRegistry.list().map(entry => entry.definition),
        ...[...scriptConnectors.values()]
          .filter(entry => !integrationRegistry.get(entry.definitionId))
          .map(entry => ({ id: entry.definitionId }))
      ];
  for (const definition of changed) {
    if (!definition.protocol) {
      for (const [file, entry] of scriptConnectors) {
        if (entry.definitionId === definition.id) scriptConnectors.delete(file);
      }
      continue;
    }
    if (definition.protocol.type !== 'script') continue;
    await loadScriptConnector(definition).catch(error => {
      logger.warn('Integration connector module could not be loaded', {
        component: 'NativeAdapter',
        definition: definition.id,
        module: definition.protocol.module,
        error: error.message
      });
    });
  }
  // Dynamic: integrationTools reaches this adapter through the protocol
  // index, and a static import would close that cycle.
  const { syncIntegrationScopeProviders } = await import('../../integrationTools.js');
  await syncIntegrationScopeProviders();
}

const LOCALIZED_KEYS = new Set(['description', 'title']);

/**
 * A JSON schema with its `{ en, de }` descriptions resolved to one language.
 * @param {unknown} node
 * @param {string} language
 */
export function localizeSchema(node, language) {
  if (Array.isArray(node)) return node.map(item => localizeSchema(item, language));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (LOCALIZED_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = getLocalizedString(value, language, 'en', '');
    } else {
      out[key] = localizeSchema(value, language);
    }
  }
  return out;
}

async function connectorFor(definition) {
  const connector = await getConnectorFor(definition);
  if (!connector) {
    throw new Error(
      `Integration ${definition.id}: no native connector "${definition.protocol.module}"`
    );
  }
  return connector;
}

/**
 * The actions of an installation, as the admin UI and the tool loader read them.
 */
export async function discoverActions({ definition, instance, language = 'en' }) {
  const connector = await connectorFor(definition);
  const values = effectiveValues(definition, instance);
  return definition.actions.map(action => {
    const impl = connector.actions?.[action.name];
    const requirementsMet = actionRequirementsMet(action, values);
    const enabled = actionEnabled(instance, action);
    const error = impl ? undefined : `not implemented by connector "${connector.id}"`;
    return {
      name: action.name,
      toolId: toolIdFor(instance.id, action.name, action),
      title: localized(action.title, language, action.name),
      description: localized(action.description, language, ''),
      parameters: localizeSchema(
        impl?.parameters || { type: 'object', properties: {}, required: [] },
        language
      ),
      sideEffect: action.sideEffect,
      dataFlow: action.dataFlow,
      enabledByDefault: action.enabledByDefault !== false,
      enabled,
      requirementsMet,
      needsToken: false,
      available: Boolean(impl) && enabled && requirementsMet,
      error,
      guidance: localized(action.guidance, language, ''),
      examples: (action.examples || []).map(example => localized(example, language, '')),
      sources: action.sources
    };
  });
}

/** Run one action. `context.params` is everything the tool call received. */
export async function run({ definition, instance, action, args = {}, context = {} }) {
  const connector = await connectorFor(definition);
  const impl = connector.actions?.[action.name];
  if (!impl) {
    throw new Error(`Integration ${instance.id}: action ${action.name} is not implemented`);
  }
  const values = effectiveValues(definition, instance);
  return impl.run(args, {
    definition,
    instance,
    values,
    user: context.user,
    chatId: context.chatId,
    scope: context.scope,
    params: context.params || {}
  });
}

/** Test an installation: the connector's steps in the shared report shape. */
export async function test({ definition, instance, language = 'en', user, req }) {
  const started = Date.now();
  let connector;
  try {
    connector = await connectorFor(definition);
  } catch (error) {
    return testResult(
      [{ id: 'module', label: 'Connector module', status: 'fail', message: error.message }],
      started
    );
  }
  const values = effectiveValues(definition, instance);
  let steps;
  try {
    steps = connector.test
      ? await connector.test({ definition, instance, values, language, user, req })
      : [{ id: 'module', label: 'Connector module', status: 'ok', message: 'Loaded' }];
  } catch (error) {
    steps = [{ id: 'test', label: 'Test', status: 'fail', message: error.message }];
  }
  const available = (await discoverActions({ definition, instance, language })).filter(
    a => a.available
  ).length;
  return testResult(steps, started, {
    actionCount: available,
    successMessage: `${localized(definition.name, language, definition.id)} reachable`
  });
}

/** Native connectors list their scopes through their own provider (see `scopeProvider`). */
export async function listScopes() {
  return [];
}

/**
 * The chat scope provider of an installation, when the connector has one.
 * Sync, so a `script` connector must be loaded first: `getConnectorFor`,
 * which `syncIntegrationScopeProviders` awaits before asking, and `onChanged`.
 */
export function scopeProvider(resolved) {
  const connector =
    resolved.definition.protocol.type === 'script'
      ? loadedScriptConnector(resolved.definition)
      : getConnector(resolved.definition.protocol.module);
  return connector?.scopeProvider ? connector.scopeProvider(resolved) : null;
}

/** The connector of a definition when it is already loaded (sync callers), or null. */
function loadedConnector(definition) {
  return definition.protocol.type === 'script'
    ? loadedScriptConnector(definition)
    : getConnector(definition.protocol.module);
}

/** Live status of an installation, when its connector reports one. */
export function status(instance) {
  const definition = integrationRegistry.get(instance?.definition)?.definition;
  if (!definition) return null;
  const connector = loadedConnector(definition);
  return connector?.status ? connector.status(instance) : null;
}

/** The users who connected their own account, for connectors that sign users in. */
export async function listConnections(instance) {
  const definition = integrationRegistry.get(instance?.definition)?.definition;
  if (!definition) return [];
  const connector = await connectorFor(definition);
  return connector.listConnections ? connector.listConnections(instance) : [];
}

/** Disconnect one user from an installation whose connector signs users in. */
export async function disconnectUser(instance, userId) {
  const definition = integrationRegistry.get(instance?.definition)?.definition;
  if (!definition) return { removed: false, unknownServer: true };
  const connector = await connectorFor(definition);
  if (!connector.disconnectUser) return { removed: false, unsupported: true };
  return connector.disconnectUser(instance, userId);
}

export function invalidate(instanceId) {
  for (const connector of listConnectors()) connector.invalidate?.(instanceId);
  for (const { loading } of scriptConnectors.values()) {
    loading.__loaded?.invalidate?.(instanceId);
  }
}
