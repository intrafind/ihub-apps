// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test fixtures for the web search engines (installations of type
 * `web-search`): the shipped definitions and native connectors are real; the
 * installations, groups and tool files are set per test in the config cache.
 *
 * Usage:
 *
 * ```js
 * before(setUpWebSearch);
 * beforeEach(() => useWebSearch({ installed: [engine('qwant')] }));
 * ```
 */
import configCache from '../../configCache.js';
import '../../services/integrations/protocols/native/connectors/register.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import { publishDefinitionTypes } from '../../services/integrations/integrationTypes.js';
import mcpClientManager from '../../services/mcp/McpClientManager.js';

/** The shipped engine definitions by installation id. */
export const ENGINE_DEFINITIONS = Object.freeze({
  brave: 'com.intrafind/brave-search',
  staan: 'com.intrafind/staan-search',
  qwant: 'com.intrafind/qwant-search'
});

/** A third-party engine definition (`type: web-search`) used by the tests. */
export const THIRD_PARTY_DEFINITION = 'org.acme/web-search';

/** Every group may use every integration. */
export const OPEN_GROUPS = Object.freeze({
  anonymous: { id: 'anonymous', permissions: { integrations: ['*'] } },
  research: { id: 'research', permissions: { integrations: ['*'] } },
  staff: { id: 'staff', permissions: { integrations: ['*'] } }
});

export const RESEARCHER = Object.freeze({ id: 'r', groups: ['research'] });
export const STAFF = Object.freeze({ id: 's', groups: ['staff'] });

/**
 * An engine installation.
 * @param {string} id - `brave`, `staan`, `qwant` or a third-party id
 * @param {Object} [extra] - fields to override (`enabled`, `values`, `actions`)
 */
export function engine(id, extra = {}) {
  return {
    id,
    definition: ENGINE_DEFINITIONS[id] || THIRD_PARTY_DEFINITION,
    enabled: true,
    values: {},
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    ...extra
  };
}

/**
 * The search tool of a third-party engine as discovery would list it
 * (`<id>__search`), to put into `config/tools.json` — the test has no
 * definition folder for it.
 * @param {string} id
 */
export function thirdPartyEngineTool(id) {
  return {
    id: `${id}__search`,
    name: `Acme: Search the web`,
    description: 'Search the web with Acme.',
    type: 'integration',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
      },
      required: ['query']
    },
    _integration: { instanceId: id, action: 'search', definition: THIRD_PARTY_DEFINITION }
  };
}

/** Load the shipped definitions once and publish the third-party engine type next to them. */
export async function setUpWebSearch() {
  await integrationRegistry.ensureLoaded();
  publishDefinitionTypes([
    ...integrationRegistry.list(),
    { definition: { id: THIRD_PARTY_DEFINITION, type: 'web-search' } }
  ]);
  mcpClientManager.listAllTools = async () => [];
  configCache.getFeatures = () => ({ skills: false, appAsTool: false });
  configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
  configCache.setCacheEntry('config/sources.json', []);
}

/**
 * Set the installations, groups and tool files for one test.
 * @param {Object} [options]
 * @param {Object[]} [options.installed] - `config/integrations.json` → `installed`
 * @param {Object} [options.groups] - `config/groups.json` → `groups`
 * @param {Object[]} [options.tools] - `config/tools.json` (tool files)
 */
export function useWebSearch({ installed = [], groups = OPEN_GROUPS, tools = [] } = {}) {
  configCache.setCacheEntry('config/integrations.json', {
    installed: structuredClone(installed),
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  configCache.setCacheEntry('config/groups.json', { groups: structuredClone(groups) });
  configCache.setCacheEntry('config/tools.json', structuredClone(tools));
}

/** Stop the config cache's refresh timers (call in `after`). */
export function tearDownWebSearch() {
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
}

/** Groups that grant exactly these keys to `research`, nothing to the others. */
export function grantResearchOnly(...keys) {
  return {
    anonymous: { id: 'anonymous', permissions: { integrations: [] } },
    research: { id: 'research', permissions: { integrations: keys } },
    staff: { id: 'staff', permissions: { integrations: [] } }
  };
}
