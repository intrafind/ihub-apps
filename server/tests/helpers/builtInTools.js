// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in tools as the server defines them, for tests that need a tool
 * of a given id: what a tool is comes from the definition the real generator
 * produces (the shipped tool files, the connectors, the engine contract),
 * never from the id the test happens to give it.
 */
import { readShippedToolDefinitions } from '../../services/tools/shippedToolDefinitions.js';
import { platformToolDefinitions } from '../../services/tools/platformTools.js';
import { toolFromAction } from '../../services/integrations/integrationTools.js';
import ifinderConnector from '../../services/integrations/protocols/native/connectors/ifinder/index.js';

const knowledge = readShippedToolDefinitions(['knowledge']);
const platform = new Map(platformToolDefinitions().map(tool => [tool.id, tool]));

/** The `search` action of a built-in web search engine, built by the integration generator. */
function engineTool(id, definition) {
  return toolFromAction(
    {
      instance: { id: id.replace(/Search$/, '').toLowerCase(), definition },
      definition: { id: definition },
      label: id
    },
    {
      name: 'search',
      toolId: id,
      title: 'Search',
      description: 'search',
      parameters: { type: 'object', properties: {} },
      sideEffect: 'read',
      dataFlow: 'external'
    },
    'en'
  );
}

const ENGINES = {
  braveSearch: 'com.intrafind/brave-search',
  staanSearch: 'com.intrafind/staan-search',
  searxngSearch: 'com.intrafind/searxng-search'
};

/**
 * The built-in tool with this id (`braveSearch`, `read_url`, `knowledge_search`,
 * `iFinder_search`, …), carrying the declaration its generator sets, with
 * `extra` merged over it.
 * @param {string} id
 * @param {Object} [extra]
 * @returns {Object}
 */
export function builtInTool(id, extra = {}) {
  let tool;
  if (ENGINES[id]) tool = engineTool(id, ENGINES[id]);
  else if (platform.has(id)) tool = platform.get(id);
  else if (knowledge.has(id)) tool = knowledge.get(id);
  else if (id.startsWith('iFinder_')) {
    const activity = ifinderConnector.activity[id.slice('iFinder_'.length)];
    if (!activity) throw new Error(`iFinder has no action behind ${id}`);
    tool = { id, activity };
  } else {
    throw new Error(`No built-in tool ${id}`);
  }
  return { ...tool, ...extra, id };
}

/**
 * The built-in tool with this id, or a bare definition for an id that is not one
 * (which then declares nothing, like any tool an admin or a server brings).
 * @param {string} id
 * @returns {Object}
 */
export function toolDefOf(id) {
  try {
    return builtInTool(id);
  } catch {
    return { id };
  }
}
