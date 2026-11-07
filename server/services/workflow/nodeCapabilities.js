// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a workflow node, an agent profile or a planner task template can use,
 * and how a planner narrows it per task.
 *
 * A node has no tool list (#3275). Like an app it binds installed
 * integrations (`integrations`: `{ <installation id | definition id |
 * type:…>: { actions? } }`), and next to them it may
 *
 * - switch on web search (`webSearch: true`): native search where the model
 *   runs it, else the search tool of the first web search engine the user may
 *   use;
 * - name platform tools (`systemTools`: the agent workspace, the evidence
 *   tools, the page reader). They are plain tools of workflows and agents,
 *   not integrations.
 *
 * The planner of an agent run picks, per task, from the capabilities of its
 * template. A capability is named by its **catalog id**: the key of an
 * integration binding, a platform tool id, or `webSearch`.
 *
 * @module services/workflow/nodeCapabilities
 */

/** The catalog id of the node's web search switch. */
export const WEB_SEARCH_CAPABILITY = 'webSearch';

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The catalog ids a node config or template offers, in a stable order:
 * integration keys, then platform tools, then `webSearch`.
 *
 * @param {{ integrations?: Object, systemTools?: string[], webSearch?: boolean }} [config]
 * @returns {string[]}
 */
export function capabilitiesOf(config) {
  const ids = [];
  if (plainObject(config?.integrations)) ids.push(...Object.keys(config.integrations));
  if (Array.isArray(config?.systemTools)) {
    for (const id of config.systemTools) {
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  if (config?.webSearch === true) ids.push(WEB_SEARCH_CAPABILITY);
  return [...new Set(ids)];
}

/**
 * The part of a template a list of catalog ids picks: the bindings (with their
 * action lists), the platform tools and the web search switch. An id the
 * template does not offer is dropped, never taken as given.
 *
 * @param {{ integrations?: Object, systemTools?: string[], webSearch?: boolean }} template
 * @param {string[]} picked - catalog ids
 * @returns {{ integrations: Object, systemTools: string[], webSearch: boolean }}
 */
export function pickCapabilities(template, picked) {
  const wanted = new Set(Array.isArray(picked) ? picked : []);
  const integrations = {};
  if (plainObject(template?.integrations)) {
    for (const [key, binding] of Object.entries(template.integrations)) {
      if (wanted.has(key)) integrations[key] = binding;
    }
  }
  const systemTools = (Array.isArray(template?.systemTools) ? template.systemTools : []).filter(
    id => wanted.has(id)
  );
  return {
    integrations,
    systemTools: [...new Set(systemTools)],
    webSearch: template?.webSearch === true && wanted.has(WEB_SEARCH_CAPABILITY)
  };
}

/**
 * Whether a node config offers anything the model can call.
 * @param {Object} [config]
 * @returns {boolean}
 */
export function hasCapabilities(config) {
  return capabilitiesOf(config).length > 0;
}
