// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test fixture for "a tool an app offers": since the `tools` list left the app
 * config (#3275), an app gets a tool only by binding the installed integration
 * that provides it. A test that needs some tool the model can call puts
 * {@link fixtureIntegrationTool} into `config/tools.json` (a ready-made
 * integration tool, as discovery would list it), {@link fixtureInstallation}
 * into `config/integrations.json` and binds the installation in the app:
 *
 * ```js
 * configCache.setCacheEntry('config/tools.json', [fixtureIntegrationTool('lookup', { ... })]);
 * configCache.setCacheEntry('config/integrations.json', fixtureIntegrations('lookup'));
 * configCache.setCacheEntry('config/groups.json', { groups: FIXTURE_OPEN_GROUPS });
 * const app = { id: 'agent', integrations: { lookup: {} } };
 * ```
 */

/** The definition id the fixture tools claim; no definition folder exists for it. */
export const FIXTURE_DEFINITION = 'test.fixture';

/** Every group may use every integration. */
export const FIXTURE_OPEN_GROUPS = Object.freeze({
  anonymous: { id: 'anonymous', permissions: { integrations: ['*'] } },
  users: { id: 'users', permissions: { integrations: ['*'] } },
  admin: { id: 'admin', permissions: { integrations: ['*'] } }
});

/**
 * A tool of an installed integration as discovery lists it. The tool id is
 * kept as given (`lookup`), the installation id is the id as well.
 *
 * @param {string} id - tool id, installation id and action name
 * @param {Object} [tool] - fields to set (`description`, `parameters`, `script`, …)
 * @returns {Object}
 */
export function fixtureIntegrationTool(id, tool = {}) {
  return {
    id,
    name: id,
    description: `The ${id} tool`,
    parameters: { type: 'object', properties: {} },
    type: 'integration',
    ...tool,
    _integration: {
      instanceId: id,
      instanceLabel: id,
      action: id,
      actionTitle: id,
      definition: FIXTURE_DEFINITION,
      fixedToolId: false,
      ...(tool._integration || {})
    }
  };
}

/**
 * The installation of a fixture tool.
 * @param {string} id
 * @param {Object} [extra] - fields to override (`enabled`, `actions`, …)
 */
export function fixtureInstallation(id, extra = {}) {
  return {
    id,
    definition: FIXTURE_DEFINITION,
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
