import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { isToolSelected } from '../../utils/toolSelection.js';

/**
 * Sources have no standalone group-level permission — they are scoped through
 * the apps that reference them. A user who can access an app may read the
 * sources that app declares. The MCP gateway therefore derives a caller's
 * visible source set from the apps they can access (the same filter the web UI
 * applies via `configCache.getAppsForUser`).
 *
 * Tools are derived the same way, plus an explicit group-level `tools`
 * permission for callers who need a tool directly over MCP/A2A without going
 * through an app (`groups.json` → `permissions.tools`). That grant covers only
 * the gateways; which tools a chat app may call is still declared by the app.
 *
 * This is the authorization barrier for the gateway: without it, any caller
 * holding `mcp:tools:read` / `mcp:resources:read` would see every tool and
 * source on the platform regardless of group membership.
 */

async function getAccessibleApps(user, platform) {
  try {
    const { data: apps = [] } = await configCache.getAppsForUser(user, platform);
    return apps;
  } catch (err) {
    logger.warn('mcpPermissions: getAppsForUser failed; failing closed', {
      component: 'McpPermissions',
      error: err.message
    });
    return [];
  }
}

/**
 * Set of tool ids the user may use: the group-level `tools` grant unioned with
 * the tools declared by every app they can access. Both the exact tool id and
 * its base id (the part before the first underscore, e.g. `jira` for
 * `jira_searchTickets`) are included so function-style tools match.
 *
 * A group granting the base id (`iFinder`) therefore covers all of that tool's
 * functions; granting `iFinder_search` covers only that one.
 */
export async function getVisibleToolIds(user, platform) {
  const ids = new Set();

  // Direct grant — lets an operator expose a tool over MCP/A2A without having
  // to stand up a carrier app purely to hold the permission.
  const granted = user?.permissions?.tools;
  if (granted instanceof Set) {
    for (const t of granted) {
      if (typeof t === 'string' && t) ids.add(t);
    }
  }

  const apps = await getAccessibleApps(user, platform);
  for (const app of apps) {
    if (!Array.isArray(app.tools)) continue;
    for (const t of app.tools) {
      if (typeof t === 'string' && t) ids.add(t);
    }
  }
  return ids;
}

/**
 * True if `toolId` (or its base id) is referenced by any app the user can
 * access. Used by the gateway to decide tool visibility + call permission.
 *
 * @param {string} toolId
 * @param {Set<string>} visibleSet
 * @param {string} [mcpServerId] - Owning server of a tool discovered from an
 *   MCP server; an app that references the server by id sees all its tools.
 */
export function toolVisibleInSet(toolId, visibleSet, mcpServerId) {
  if (!(visibleSet instanceof Set)) return false;
  if (visibleSet.has('*')) return true;
  const tool = { id: toolId, ...(mcpServerId ? { _mcp: { serverId: mcpServerId } } : {}) };
  return isToolSelected(tool, visibleSet);
}

/**
 * Set of source ids the user may read, unioned across accessible apps'
 * `sources` arrays.
 */
export async function getVisibleSourceIds(user, platform) {
  const apps = await getAccessibleApps(user, platform);
  const ids = new Set();
  for (const app of apps) {
    if (!Array.isArray(app.sources)) continue;
    for (const s of app.sources) {
      if (typeof s === 'string' && s) ids.add(s);
    }
  }
  return ids;
}
