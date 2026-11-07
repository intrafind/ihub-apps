// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test fixture for "a tool a consumer can call": every tool is an action of an
 * installed integration, so a test that needs some tool registers a fixture
 * integration for it — a real definition in the integration registry, backed by
 * a test connector — and installs it:
 *
 * ```js
 * before(async () => {
 *   await registerFixtureTools([fixtureTool('lookup', { run: args => ({ found: args.key }) })]);
 * });
 * after(() => unregisterFixtureTools());
 * beforeEach(() => {
 *   configCache.setCacheEntry('config/integrations.json', fixtureIntegrations('lookup'));
 *   configCache.setCacheEntry('config/groups.json', { groups: FIXTURE_OPEN_GROUPS });
 * });
 * const app = { id: 'agent', integrations: { lookup: {} } };
 * ```
 *
 * The tool keeps its id (`lookup`), the installation id is the tool id, and
 * the definition is `test.fixture/<id>`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import { registerConnector } from '../../services/integrations/protocols/native/connectors/index.js';
import '../../services/integrations/protocols/native/connectors/register.js';

/** The native connector every fixture definition names. */
export const FIXTURE_CONNECTOR_ID = 'test_fixture';

/** Every group may use every integration. */
export const FIXTURE_OPEN_GROUPS = Object.freeze({
  anonymous: { id: 'anonymous', permissions: { integrations: ['*'] } },
  users: { id: 'users', permissions: { integrations: ['*'] } },
  admin: { id: 'admin', permissions: { integrations: ['*'] } }
});

/** Definition id of a fixture tool. */
export const fixtureDefinitionId = id =>
  `test.fixture/${id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

const specs = new Map();
let tempDir = null;
let previousOverride;

/**
 * Describe a fixture tool.
 *
 * @param {string} id - tool id (also the installation id and action name unless set below)
 * @param {Object} [options]
 * @param {string} [options.description]
 * @param {string} [options.action=id] - the action's name (the tool keeps `id` as its tool id)
 * @param {string} [options.type] - the definition's integration type (`web-search`, …)
 * @param {Object} [options.parameters] - JSON schema
 * @param {boolean} [options.requiresApproval] - the tool always asks a person first
 * @param {string} [options.sideEffect='read']
 * @param {Object} [options.extras] - more fields merged into the tool
 * @param {(args: Object, ctx: Object) => any} [options.run]
 */
export function fixtureTool(id, options = {}) {
  return { id, ...options };
}

const actionName = spec => spec.action || spec.id;

function definitionOf(spec) {
  return {
    id: fixtureDefinitionId(spec.id),
    ...(spec.type ? { type: spec.type } : {}),
    version: '1.0.0',
    compatibility: { ihub: '>=5.6.0' },
    name: { en: spec.id, de: spec.id },
    description: { en: `Fixture tool ${spec.id}`, de: `Fixture-Tool ${spec.id}` },
    publisher: { name: 'Test' },
    builtIn: true,
    categories: ['test'],
    protocol: { type: 'native', module: FIXTURE_CONNECTOR_ID },
    auth: { modes: ['none'] },
    install: [],
    capabilities: ['tools'],
    actions: [
      {
        name: actionName(spec),
        toolId: spec.id,
        title: { en: spec.id, de: spec.id },
        description: { en: spec.description || `The ${spec.id} tool`, de: spec.id },
        sideEffect: spec.sideEffect || 'read',
        parameters: spec.parameters || { type: 'object', properties: {}, required: [] }
      }
    ]
  };
}

const connector = {
  id: FIXTURE_CONNECTOR_ID,
  actions: new Proxy(
    {},
    {
      get(_target, name) {
        const spec = specs.get(String(name));
        if (!spec) return undefined;
        return {
          run: async (args, ctx) => (spec.run ? spec.run(args, ctx) : { ok: true, tool: spec.id }),
          extras: () => ({
            ...(spec.requiresApproval ? { requiresApproval: true } : {}),
            ...(spec.extras || {})
          })
        };
      }
    }
  ),
  async test() {
    return [];
  }
};

/**
 * Register the fixture tools: their definitions into the integration registry
 * (an installed tree in a temporary directory, next to the shipped ones) and
 * the shared test connector. Call once per test file, before the installations
 * are put into the config cache.
 *
 * @param {Array<ReturnType<typeof fixtureTool>>} tools
 */
export async function registerFixtureTools(tools) {
  registerConnector(connector);
  for (const tool of tools) specs.set(actionName(tool), tool);
  tempDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-fixture-tools-'));
  const root = path.join(tempDir, 'integration-definitions');
  for (const tool of tools) {
    const dir = path.join(root, fixtureDefinitionId(tool.id).replace('/', '__'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definitionOf(tool)));
  }
  if (previousOverride === undefined)
    previousOverride = integrationRegistry.contentsDirOverride ?? null;
  integrationRegistry.contentsDirOverride = root;
  await integrationRegistry.reload();
}

/** Remove the fixture definitions and restore the registry. */
export async function unregisterFixtureTools() {
  specs.clear();
  if (previousOverride !== undefined) {
    integrationRegistry.contentsDirOverride = previousOverride || undefined;
    previousOverride = undefined;
  }
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    tempDir = null;
  }
}

/**
 * The installation of a fixture tool.
 * @param {string} id
 * @param {Object} [extra] - fields to override (`enabled`, `definition`, `actions`, …)
 */
export function fixtureInstallation(id, extra = {}) {
  return {
    id,
    definition: fixtureDefinitionId(id),
    definitionVersion: '1.0.0',
    enabled: true,
    values: {},
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    ...extra
  };
}

/**
 * `config/integrations.json` with one installation per id.
 * @param {...string} ids
 */
export function fixtureIntegrations(...ids) {
  return {
    installed: ids.map(id => fixtureInstallation(id)),
    security: { blockPrivateIps: true, allowedHosts: [] }
  };
}
