// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { hasIdCaseInsensitive } from './resourceLookup.js';
import { ServiceError } from './ServiceError.js';

/**
 * Which groups may use a piece of content — an app, a prompt, a skill, a tool
 * or a workflow — is stored on the groups, as the `permissions.<type>` lists in
 * `config/groups.json`. This module is the content-first view of those lists:
 * given one piece of content, which groups can use it, and which of those
 * groups the caller is allowed to change.
 *
 * Full admins may change any group. Content admins (`permissions.contentAdmin`
 * without `adminAccess`) may change only the groups they belong to, plus every
 * group that inherits from one of theirs — being in `users`, which `sales` and
 * `marketing` inherit from, means managing content for all three. The groups a
 * signed-in user carries implicitly (`authenticated`, `anonymous`) do not count
 * as membership: otherwise every content admin could publish to everyone.
 *
 * Only the content lists are ever touched here. `models`, `adminAccess`,
 * `contentAdmin`, `mappings` and `inherits` stay with the group editor, which is
 * full-admin only.
 */

/**
 * The permission lists that describe content access. `models` is left out on
 * purpose: which models a group may use is a platform decision, not content.
 */
export const CONTENT_ACCESS_TYPES = Object.freeze(['apps', 'prompts', 'skills', 'workflows']);

const STATUS_CODES = { 403: 'FORBIDDEN', 404: 'NOT_FOUND' };

/**
 * A refused change, carrying the HTTP status the route should answer with.
 */
export class ContentAccessError extends ServiceError {
  /**
   * @param {number} status - HTTP status (400 invalid request, 403 not yours, 404 unknown group)
   * @param {string} message - What was refused, for the admin who asked
   */
  constructor(status, message) {
    super(STATUS_CODES[status] || 'BAD_REQUEST', message, { status });
    this.name = 'ContentAccessError';
  }
}

/**
 * The allowlisted constant equal to `type`, or undefined.
 *
 * Callers use the returned element, not the string they were given, as the
 * property name they read and write on `permissions`. The lists therefore
 * only ever live under one of the five fixed keys above, and whatever a URL
 * or request body said (`__proto__` included) never becomes a property name.
 *
 * @param {string} type
 * @returns {string | undefined}
 */
export function canonicalContentAccessType(type) {
  return CONTENT_ACCESS_TYPES.find(candidate => candidate === type);
}

/**
 * A group's own (not inherited) list for a permission, always as an array.
 * @param {object} group
 * @param {string} type
 * @returns {string[]}
 */
function ownList(group, type) {
  const list = group?.permissions?.[type];
  return Array.isArray(list) ? list : [];
}

/**
 * Whether a permission list names `contentId`. Runtime permission checks ignore
 * case (`hasIdCaseInsensitive`), so the view must too, or a group whose list
 * says `Chat` would read as not granting `chat` while in fact it does.
 */
function listGrants(list, contentId) {
  return hasIdCaseInsensitive(new Set(list), contentId);
}

function listHasWildcard(list) {
  return list.includes('*');
}

/**
 * Every group `groupId` inherits from, directly or through other groups.
 *
 * Cycle-safe: a group is visited once, so a configuration with a cycle in it
 * (which `resolveGroupInheritance` rejects at load time anyway) terminates.
 * Parents that do not exist are skipped rather than thrown on — this view
 * should still render for a file whose inheritance is half-edited.
 *
 * @param {Object<string, object>} groups - `groups` map from groups.json
 * @param {string} groupId
 * @returns {string[]} Ancestor ids, nearest first, without `groupId` itself
 */
export function collectAncestorGroups(groups, groupId) {
  const ancestors = [];
  const seen = new Set([groupId]);
  const queue = [...(Array.isArray(groups?.[groupId]?.inherits) ? groups[groupId].inherits : [])];

  while (queue.length > 0) {
    const parentId = queue.shift();
    if (typeof parentId !== 'string' || seen.has(parentId)) continue;
    seen.add(parentId);
    if (!Object.hasOwn(groups, parentId)) continue;
    ancestors.push(parentId);
    const parent = groups[parentId];
    if (Array.isArray(parent?.inherits)) queue.push(...parent.inherits);
  }

  return ancestors;
}

/**
 * The seed groups plus every group that inherits from one of them.
 *
 * @param {Object<string, object>} groups - `groups` map from groups.json
 * @param {string[]} seedIds - Group ids to start from
 * @returns {Set<string>} Seeds that exist, plus all their descendants
 */
export function collectDescendantGroups(groups, seedIds) {
  const seeds = new Set((seedIds || []).filter(id => Object.hasOwn(groups || {}, id)));
  const result = new Set(seeds);
  if (seeds.size === 0) return result;

  for (const groupId of Object.keys(groups)) {
    if (result.has(groupId)) continue;
    if (collectAncestorGroups(groups, groupId).some(ancestorId => seeds.has(ancestorId))) {
      result.add(groupId);
    }
  }

  return result;
}

/**
 * The groups whose content access `user` may change, in the file's order.
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups - `groups` map from groups.json
 * @param {object} options.user - Request user (`groups` is what counts)
 * @param {boolean} options.fullAdmin - True for a principal with `adminAccess`
 * @param {string[]} [options.implicitGroups] - Groups every signed-in user
 *   carries without being a member — never a seed for the membership scope
 * @returns {{ scope: 'all' | 'membership', groupIds: string[] }}
 */
export function resolveManageableGroups({
  groups,
  user,
  fullAdmin,
  implicitGroups = ['authenticated', 'anonymous']
}) {
  const allIds = Object.keys(groups || {});
  if (fullAdmin) {
    return { scope: 'all', groupIds: allIds };
  }

  const seeds = (Array.isArray(user?.groups) ? user.groups : []).filter(
    id => typeof id === 'string' && !implicitGroups.includes(id)
  );
  const manageable = collectDescendantGroups(groups || {}, seeds);
  return { scope: 'membership', groupIds: allIds.filter(id => manageable.has(id)) };
}

/**
 * How each manageable group stands towards one piece of content.
 *
 * `granted` is the group's own list naming the content; `wildcard` its own
 * list granting everything of that type; `inheritedFrom` the ancestors whose
 * own lists do either. `effective` is what the user in that group actually
 * gets, before any OAuth-client filtering.
 *
 * A row of a group that people carry without being a member of it (the group
 * of every signed-in user, the anonymous group) is marked `implicit: true`.
 * Such a group is not a team somebody belongs to: who it stands for is said
 * by {@link describeAudience}, and a client must not print its name as one of
 * "these groups".
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups - `groups` map from groups.json
 * @param {string} options.type - One of CONTENT_ACCESS_TYPES
 * @param {string} options.contentId - The content's id
 * @param {string[]} options.groupIds - Groups to describe, in output order
 * @param {string[]} [options.implicitGroups] - Groups people carry without
 *   being a member; their rows get `implicit: true`
 * @returns {Array<{id: string, name: string, description: string, granted: boolean,
 *   wildcard: boolean, inheritedFrom: string[], effective: boolean, implicit?: true}>}
 */
export function describeContentAccess({ groups, type, contentId, groupIds, implicitGroups = [] }) {
  const key = canonicalContentAccessType(type);
  return groupIds.map(groupId => {
    const group = groups[groupId];
    const list = ownList(group, key);
    const granted = listGrants(list, contentId);
    const wildcard = listHasWildcard(list);
    const inheritedFrom = collectAncestorGroups(groups, groupId).filter(ancestorId => {
      const ancestorList = ownList(groups[ancestorId], key);
      return listHasWildcard(ancestorList) || listGrants(ancestorList, contentId);
    });
    return {
      id: groupId,
      name: typeof group?.name === 'string' && group.name ? group.name : groupId,
      description: typeof group?.description === 'string' ? group.description : '',
      granted,
      wildcard,
      inheritedFrom,
      effective: granted || wildcard || inheritedFrom.length > 0,
      ...(implicitGroups.includes(groupId) ? { implicit: true } : {})
    };
  });
}

/**
 * Who gets one piece of content without being in any particular group.
 *
 * Computed over all groups, whoever asks: a content admin does not see the row
 * of the group every signed-in user carries, yet has to know before publishing
 * whether that group grants the content. The answer reveals that one fact and
 * nothing else about the group.
 *
 * - `allSignedIn`: the group every signed-in user carries grants the content,
 *   by name, by wildcard or through a group it inherits from.
 * - `anonymous`: anonymous access is on and one of the groups of the anonymous
 *   principal grants the content the same way. It says nothing about signed-in
 *   users; read `allSignedIn` for them.
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups - `groups` map from groups.json
 * @param {string} options.type - One of CONTENT_ACCESS_TYPES
 * @param {string} options.contentId - The content's id
 * @param {string} [options.authenticatedGroup='authenticated'] - The group
 *   every signed-in user carries (`auth.authenticatedGroup`)
 * @param {string[]} [options.anonymousGroups=[]] - The groups of the anonymous
 *   principal (`anonymousAuth.defaultGroups`); empty while anonymous access is off
 * @returns {{ allSignedIn: boolean, anonymous: boolean }}
 *
 * @example
 * describeAudience({
 *   groups: { authenticated: { permissions: { apps: ['*'] } } },
 *   type: 'apps',
 *   contentId: 'chat'
 * }); // → { allSignedIn: true, anonymous: false }
 */
export function describeAudience({
  groups,
  type,
  contentId,
  authenticatedGroup = 'authenticated',
  anonymousGroups = []
}) {
  const map = groups || {};
  const grants = groupIds => {
    const existing = [...new Set(groupIds)].filter(
      id => typeof id === 'string' && Object.hasOwn(map, id)
    );
    return describeContentAccess({ groups: map, type, contentId, groupIds: existing }).some(
      row => row.effective
    );
  };
  return {
    allSignedIn: grants([authenticatedGroup]),
    anonymous: grants(Array.isArray(anonymousGroups) ? anonymousGroups : [])
  };
}

/**
 * Grant and revoke one piece of content on the named groups, in place.
 *
 * Every group in the request is checked before anything is written, so a
 * request either applies as a whole or not at all. A grant to a group that
 * already has the content (by name or by wildcard) is a no-op; a revoke from
 * a group that does not name it is too. A revoke from a wildcard group is
 * refused: the only way to withdraw a single app from `["*"]` is to replace the
 * wildcard with an explicit list, which changes what the group gets tomorrow
 * and belongs in the group editor.
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups - `groups` map, mutated
 * @param {string} options.type - One of CONTENT_ACCESS_TYPES
 * @param {string} options.contentId - The content's canonical id, as configured
 * @param {string[]} [options.grant] - Groups that should be able to use it
 * @param {string[]} [options.revoke] - Groups that should no longer be able to
 * @param {string[]} options.manageableIds - Groups the caller may change
 * @returns {Array<{groupId: string, action: 'grant' | 'revoke', before: object, after: object}>}
 *   One entry per group whose list actually changed
 * @throws {ContentAccessError} 400 on a malformed request or a wildcard revoke,
 *   403 on a group outside the caller's scope, 404 on an unknown group
 */
export function applyContentAccessChanges({
  groups,
  type,
  contentId,
  grant = [],
  revoke = [],
  manageableIds
}) {
  const key = canonicalContentAccessType(type);
  if (key === undefined) {
    throw new ContentAccessError(400, `Unknown content type '${type}'`);
  }
  if (!Array.isArray(grant) || !Array.isArray(revoke)) {
    throw new ContentAccessError(400, "'grant' and 'revoke' must be arrays of group ids");
  }
  const manageable = new Set(manageableIds || []);
  const requested = [
    ...grant.map(groupId => ({ groupId, action: 'grant' })),
    ...revoke.map(groupId => ({ groupId, action: 'revoke' }))
  ];

  // Every group is checked, and looked up, before anything is written. The
  // lookup happens here, next to the checks, and the write loop below only
  // ever touches the group objects collected in `plan` — never `groups[id]`
  // with an id from the request. `groups` is a plain object parsed from JSON,
  // so `groups['__proto__']` would be Object.prototype; writing to that would
  // change every object in the process.
  const grantSet = new Set(grant);
  const plan = [];
  for (const { groupId, action } of requested) {
    if (typeof groupId !== 'string' || groupId.length === 0) {
      throw new ContentAccessError(400, 'Group ids must be non-empty strings');
    }
    if (groupId === '__proto__' || groupId === 'constructor' || groupId === 'prototype') {
      throw new ContentAccessError(400, `Invalid group id '${groupId}'`);
    }
    if (action === 'revoke' && grantSet.has(groupId)) {
      throw new ContentAccessError(400, `Group '${groupId}' is listed under both grant and revoke`);
    }
    if (!Object.hasOwn(groups, groupId)) {
      throw new ContentAccessError(404, `Group '${groupId}' not found`);
    }
    if (!manageable.has(groupId)) {
      throw new ContentAccessError(
        403,
        `You cannot change access for group '${groupId}': it is not one of your groups`
      );
    }
    const group = groups[groupId];
    if (action === 'revoke' && listHasWildcard(ownList(group, key))) {
      throw new ContentAccessError(
        400,
        `Group '${groupId}' can use all ${key} through a wildcard. To withdraw a single one, replace the wildcard with an explicit list in the group settings.`
      );
    }
    plan.push({ groupId, action, group });
  }

  const changed = [];
  for (const { groupId, action, group } of plan) {
    const list = ownList(group, key);
    const hasIt = listGrants(list, contentId);
    if (action === 'grant' && (hasIt || listHasWildcard(list))) continue;
    if (action === 'revoke' && !hasIt) continue;

    const before = structuredClone(group);
    const target = contentId.toLowerCase();
    const after =
      action === 'grant'
        ? [...list, contentId]
        : list.filter(entry => typeof entry !== 'string' || entry.toLowerCase() !== target);
    group.permissions = { ...group.permissions, [key]: after };
    changed.push({ groupId, action, before, after: group });
  }

  return changed;
}
