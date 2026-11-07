// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { appUsesProjects, isProjectsConfigured } from '../projects/projectSettings.js';

/**
 * Sources have no standalone group-level permission — they are scoped through
 * the apps that reference them. A user who can access an app may read the
 * sources that app declares. The MCP gateway therefore derives a caller's
 * visible source set from the apps they can access (the same filter the web UI
 * applies via `configCache.getAppsForUser`).
 *
 * Tools are the actions of the installed integrations (#3275): the gateway
 * offers those of the installations the caller's groups grant
 * (`permissions.integrations`), and which tools a chat app may call is
 * declared by the integrations it binds (`app.integrations`).
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
 * Set of installed-integration ids bound by the apps the user can access
 * (the keys of `app.integrations`). An installation's tools, and for an MCP
 * installation the server itself, are reachable through such a binding; the
 * group grant of the installation (`permissions.integrations`) is checked
 * separately.
 *
 * @param {Object} user
 * @param {Object} platform
 * @returns {Promise<Set<string>>}
 */
export async function getBoundIntegrationIds(user, platform) {
  const ids = new Set();
  const apps = await getAccessibleApps(user, platform);
  for (const app of apps) {
    const bindings = app?.integrations;
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) continue;
    for (const id of Object.keys(bindings)) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Set of project ids the user may read, unioned across accessible apps'
 * `projects` links. Empty while the Projects feature is off: an app that
 * does not itself require the feature may still link projects, and the MCP
 * resource paths read project content without the master-switch check of a
 * chat turn's scope, so this set is where they are switched off.
 */
export async function getVisibleProjectIds(user, platform) {
  if (!isProjectsConfigured(configCache.getFeatures())) return new Set();
  const apps = await getAccessibleApps(user, platform);
  const ids = new Set();
  for (const app of apps) {
    if (!appUsesProjects(app) || !Array.isArray(app.projects)) continue;
    for (const link of app.projects) {
      const id = typeof link === 'string' ? link : link?.id;
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}
