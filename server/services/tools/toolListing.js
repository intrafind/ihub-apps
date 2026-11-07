// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool listing of a user: every tool (built-in, MCP, A2A, integration)
 * the user's group grants, or the app the chat runs in, make visible, with an
 * ETag that tells one user's list from another's.
 *
 * Lives next to the tool loader, not in the config cache: it needs the loader's
 * `loadTools`, and the loader reads the cache.
 */

import configCache from '../../configCache.js';
import { loadTools } from './catalog.js';
import {
  filterResourcesByPermissions,
  isAnonymousAccessAllowed
} from '../../utils/authorization.js';
import { etagForIds, etagWithSuffix, shortHash } from '../../utils/etag.js';
import { isToolSelected } from '../../utils/toolSelection.js';
import { filterDirectoryToolsForUser } from '../peopleDirectory/PeopleDirectoryService.js';
import { filterBrowserToolsForUser } from '../peopleDirectory/LdapBrowserService.js';

/**
 * The tool grants the tools listing filters by: the user's
 * `permissions.tools`, an empty set for anyone without them when anonymous
 * access is on (no default tools for anonymous), or null (no filtering).
 *
 * @param {Object|undefined} user - user with resolved permissions
 * @param {Object} platformConfig - platform configuration
 * @returns {Set<string>|null}
 */
function allowedToolsFor(user, platformConfig) {
  if (user?.permissions?.tools) return user.permissions.tools;
  if (isAnonymousAccessAllowed(platformConfig)) return new Set();
  return null;
}

/**
 * Get tools filtered by user permissions with user-specific ETag
 * @param {Object} user - User object with permissions
 * @param {Object} platformConfig - Platform configuration
 * @param {string} language - User language for localization
 * @returns {Promise<Object>} Filtered tools with user-specific ETag
 */
export async function getToolsForUser(user, platformConfig, language = 'en', { appId } = {}) {
  // Get all tools (including MCP discovered ones) with localization
  let tools = await loadTools(language);
  const { etag: toolsEtag } = configCache.getTools();

  if (!tools) {
    return { data: [], etag: null };
  }

  // Workflows are first-class citizens (app.workflows). They are NOT mixed
  // into the tools list returned to the chat UI.

  const originalToolsCount = tools.length;
  let userSpecificEtag = toolsEtagWithIntegrations(toolsEtag);

  // Apply filtering based on user permissions
  const allowedTools = allowedToolsFor(user, platformConfig);
  if (allowedTools) {
    tools = await filterToolsByGrants(tools, allowedTools, {
      user,
      platformConfig,
      appId
    });
  }

  // The group grant of an installation (`permissions.integrations`) holds
  // on top of every tool grant, `*` included: a tool the user could not run
  // is not listed.
  if (tools.some(tool => tool._integration)) {
    const { filterIntegrationToolsForUser } = await import('../integrations/integrationTools.js');
    tools = filterIntegrationToolsForUser(tools, user);
  }

  // A people directory's grant, and an LDAP browser's own rules (signed-in,
  // non-delegated users, its directory enabled), hold on top of every
  // grant, `*` included.
  tools = filterBrowserToolsForUser(filterDirectoryToolsForUser(tools, user), user);

  // A user-specific ETag if tools were filtered
  if (tools.length < originalToolsCount) {
    userSpecificEtag = etagForIds(
      userSpecificEtag,
      tools.map(tool => tool.id)
    );
  }

  return { data: tools, etag: userSpecificEtag };
}

/**
 * The tools ETag extended by the integrations ETag. The tools of installed
 * integrations come from integrations.json, which the tools ETag does not
 * cover: a renamed or re-enabled installation must not be answered with a
 * 304 for the old list.
 *
 * @param {string|null|undefined} toolsEtag - the ETag of the tools config
 * @returns {string}
 */
function toolsEtagWithIntegrations(toolsEtag) {
  const etag = toolsEtag || 'no-etag';
  const { etag: integrationsEtag } = configCache.getIntegrations();
  if (!integrationsEtag) return etag;
  const integrationsHash = shortHash(String(integrationsEtag));
  return etagWithSuffix(etag, `i${integrationsHash}`);
}

/**
 * The tools a user's group grants list, plus the tools of the app the chat
 * runs in. A group grant reads like a tool reference (`isToolSelected`), as it
 * does for the MCP gateway (`getVisibleToolIds`): besides the exact tool id
 * (case-insensitive), a base id covers a function-style tool's functions,
 * an MCP server id that server's tools and an A2A agent id that agent's
 * skills.
 *
 * @param {Array<object>} tools - every tool, localized
 * @param {Set<string>} allowedTools - the user's tool grants (`allowedToolsFor`)
 * @param {{ user: object, platformConfig: object, appId?: string }} context
 * @returns {Promise<Array<object>>} the listed tools, in their original order
 */
async function filterToolsByGrants(tools, allowedTools, { user, platformConfig, appId }) {
  const granted = new Set(filterResourcesByPermissions(tools, allowedTools));
  for (const tool of tools) {
    if (isToolSelected(tool, allowedTools)) granted.add(tool);
  }
  // The chat's tools menu asks for the tools of the app it runs in. Those
  // are callable in that app whatever the group grants say, so they are
  // listed too — otherwise the menu cannot name them or tell which MCP
  // server they belong to.
  const app = appId ? await configCache.getAppForUserById(user, platformConfig, appId) : null;
  // An installed integration's tools are listed as the chat gets them
  // (`getIntegrationToolsForApp`): only when the app binds the
  // installation, the user's groups grant it (`permissions.integrations`)
  // and the binding allows the action — never through the instance id alone.
  let appIntegrationTools = new Set();
  if (app?.integrations && typeof app.integrations === 'object') {
    const { getIntegrationToolsForApp } = await import('../integrations/integrationTools.js');
    appIntegrationTools = new Set(getIntegrationToolsForApp(app, tools, { user }));
  }
  return tools.filter(tool => granted.has(tool) || appIntegrationTools.has(tool));
}
