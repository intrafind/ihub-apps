// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Links from an audit log entry to the admin page of what it is about.
 *
 * Explicit audit calls name the resource in the singular (`app`), the coarse
 * request middleware derives it from the URL path (`apps`), so both spellings
 * map to the same page. A resource type with no detail page links to its list
 * page; an unknown type is not linked at all.
 */

/** base64url, as the CIMD client edit route expects (the id is a URL). */
function encodeCimdClientId(clientId) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(clientId)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

const detail = base => id => `${base}/${encodeURIComponent(id)}`;
const list = path => () => path;

const RESOURCE_ROUTES = {
  app: detail('/admin/apps'),
  apps: detail('/admin/apps'),
  model: detail('/admin/models'),
  models: detail('/admin/models'),
  prompt: detail('/admin/prompts'),
  prompts: detail('/admin/prompts'),
  skill: detail('/admin/skills'),
  skills: detail('/admin/skills'),
  group: detail('/admin/groups'),
  groups: detail('/admin/groups'),
  user: id => `/admin/users/${encodeURIComponent(id)}/view`,
  users: id => `/admin/users/${encodeURIComponent(id)}/view`,
  project: detail('/admin/projects'),
  projects: detail('/admin/projects'),
  provider: detail('/admin/providers'),
  providers: detail('/admin/providers'),
  integration: detail('/admin/integrations'),
  integrations: detail('/admin/integrations'),
  oauthClient: detail('/admin/oauth/clients'),
  oauthCimdClient: id => `/admin/oauth/clients/cimd/${encodeCimdClientId(id)}`,
  oauthConnection: list('/admin/oauth/connections'),
  pages: detail('/admin/pages'),
  workflows: detail('/admin/workflows'),
  marketplaceRegistry: list('/admin/marketplace/registries'),
  marketplaceRegistryCatalog: list('/admin/marketplace/registries'),
  marketplaceItem: list('/admin/marketplace'),
  scheduledTask: list('/admin/scheduled-tasks'),
  credential: list('/admin/credentials'),
  uiConfig: list('/admin/ui'),
  uiAsset: list('/admin/ui'),
  feature: list('/admin/features'),
  backup: list('/admin/backup'),
  update: list('/admin/updates')
};

/**
 * Admin route for the resource an audit entry is about, or null when there is
 * nothing to open: an unknown resource type, a missing or multi-valued id, or
 * a delete (the target no longer exists).
 *
 * @param {{ resource?: string, resourceId?: string, action?: string }} entry
 * @returns {string|null}
 */
export function getAuditResourceLink(entry) {
  const build = entry?.resource && RESOURCE_ROUTES[entry.resource];
  if (!build) return null;
  const id = entry.resourceId;
  if (typeof id !== 'string' || !id || id.includes(',')) return null;
  if (entry.action === 'delete') return null;
  return build(id);
}

/**
 * Admin route for the user who performed the action, or null for anyone who
 * is not a user account (anonymous visitors, OAuth clients, system jobs,
 * failed logins).
 *
 * @param {{ actor?: { id?: string, authenticated?: boolean }, result?: string, action?: string }} entry
 * @returns {string|null}
 */
export function getAuditActorLink(entry) {
  const actor = entry?.actor;
  if (!actor?.authenticated || typeof actor.id !== 'string' || !actor.id) return null;
  if (entry.action === 'login' && entry.result === 'failure') return null;
  if (actor.id === 'anonymous' || actor.id === 'system' || actor.id.includes(':')) return null;
  if (actor.id.startsWith('client_')) return null;
  return `/admin/users/${encodeURIComponent(actor.id)}/view`;
}
