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
 * Connector modules of `script` definitions, loaded from the definition
 * folder: `<dir>/<module>` → the connector. A re-installed folder has a new
 * module mtime, which is part of the import URL, so the fresh code is loaded.
 */
const scriptConnectors = new Map();

/** Connector of a `script` definition, loaded once per folder and module version. */
async function loadScriptConnector(definition) {
  const entry = integrationRegistry.get(definition.id);
  if (!entry?.dir) {
    throw new Error(`Integration ${definition.id}: definition folder is unknown`);
  }
  const file = path.resolve(entry.dir, definition.protocol.module);
  if (!file.startsWith(path.resolve(entry.dir) + path.sep)) {
    throw new Error(`Integration ${definition.id}: module path leaves the definition folder`);
  }
  const stat = await fs.stat(file);
  const key = `${file}@${definition.version}@${stat.mtimeMs}`;
  if (scriptConnectors.has(key)) return scriptConnectors.get(key);
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
      module: definition.protocol.module
    });
    return { ...connector, id: connector.id || definition.id };
  })();
  scriptConnectors.set(key, loading);
  loading.then(
    connector => {
      loading.__loaded = connector;
    },
    () => scriptConnectors.delete(key)
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
  const entry = integrationRegistry.get(definition.id);
  if (!entry?.dir) return null;
  const file = path.resolve(entry.dir, definition.protocol.module);
  for (const [key, value] of scriptConnectors) {
    if (key.startsWith(`${file}@`) && value.__loaded) return value.__loaded;
  }
  return null;
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
export async function test({ definition, instance, language = 'en', user }) {
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
      ? await connector.test({ definition, instance, values, language, user })
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

/** The chat scope provider of an installation, when the connector has one. */
export function scopeProvider(resolved) {
  const connector =
    resolved.definition.protocol.type === 'script'
      ? loadedScriptConnector(resolved.definition)
      : getConnector(resolved.definition.protocol.module);
  return connector?.scopeProvider ? connector.scopeProvider(resolved) : null;
}

export function invalidate(instanceId) {
  for (const connector of listConnectors()) connector.invalidate?.(instanceId);
  for (const loading of scriptConnectors.values()) {
    loading.__loaded?.invalidate?.(instanceId);
  }
}
