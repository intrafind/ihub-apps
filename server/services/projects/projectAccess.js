// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Project access — who may see, use, change, share and delete a project.
 *
 * Every check the client relies on is answered here, on the server, and the
 * answer travels with each project as its `permissions` block. The rules
 * (spec 1 §2 and §7.1):
 *
 *  - On a **user project** the owner may do everything. A member reaches it
 *    as `editor` (use, change items and instructions, change members) or
 *    `user` (use only); a member can be a user, a group (inheritance
 *    resolved) or everyone signed in. The strongest matching role wins. Only
 *    the owner deletes or transfers. A full admin may read and delete any
 *    project for compliance, never edit.
 *  - An **admin project** has no members. Whoever may use an app, workflow or
 *    agent that links it may use it (the route tells this module which ids
 *    are linked for the caller); content admins may change and delete it.
 *  - A user project its owner or an editor **published to the catalog**
 *    (`project.catalog`, while `sharing.allowCatalog` is on) may be used by
 *    everyone signed in, as role `catalog`: use only. They attach it to their
 *    own chats but never hold a chat inside it, so neither side reads the
 *    other's chats — a chat inside a project is open to its members.
 *  - When the owner's account is deleted or deactivated, the project stays
 *    readable for its members but only an admin can change it.
 *  - **Anonymous** callers, OAuth clients, agents and third-party apps
 *    holding a user-delegated token never hold or see a user project. A
 *    personal API key acts as its owner and does.
 *  - A project of the **iFinder tier** (a smart collection, id `ifc_…`) is
 *    read-only for everyone, whatever the role: the collection is the user's
 *    in iFinder, iHub only reads it. Its permission block is fixed here, ahead
 *    of every other rule, so no member, admin or catalog rule can widen it.
 *
 * The share-target vocabulary and the marker keys are the ones user prompts
 * use (`userPromptAccess.js`), so one "shared with me" index read serves
 * prompts, skills and projects alike.
 *
 * @module services/projects/projectAccess
 */
import { isAnonymousUser, isAdminUser } from '../loop/runIdentity.js';
import { isAdminEligiblePrincipal, loadGroupsConfiguration } from '../../utils/authorization.js';
import {
  UNSHAREABLE_GROUPS,
  effectiveGroups,
  shareTargetKey
} from '../prompts/userPromptAccess.js';

export { UNSHAREABLE_GROUPS, effectiveGroups, shareTargetKey };

import {
  ACCESS_LEVELS,
  MEMBER_ROLES,
  MEMBER_TARGET_TYPES,
  isIFinderProjectId
} from './projectConstants.js';

export { ACCESS_LEVELS, MEMBER_ROLES, MEMBER_TARGET_TYPES };

const ROLE_RANK = { user: 1, editor: 2 };

/** No access at all. */
export const NO_ACCESS = Object.freeze({
  canView: false,
  canUse: false,
  canEdit: false,
  canShare: false,
  canDelete: false,
  canTransfer: false,
  readsAllChats: false,
  canHoldChats: false,
  isOwner: false,
  role: null,
  readOnly: false
});

/**
 * Whether a project is published: a user project to the catalog, an admin
 * project by its `published` switch (everyone signed in may use it).
 *
 * @param {Object|null|undefined} project - Stored project.
 * @returns {boolean}
 */
export function isPublished(project) {
  if (project?.ownership === 'admin') return project.published === true;
  return Boolean(project?.catalog?.publishedAt);
}

/**
 * The key a member target is indexed under — the same format as prompt
 * shares, so the markers of all three features read alike.
 *
 * @param {{type: string, id?: string|null}} member - Member target.
 * @returns {string}
 */
export function memberTargetKey(member) {
  return shareTargetKey(member);
}

/**
 * Whether a principal may hold projects at all: signed in, a person (not an
 * OAuth client or an agent), and not a third-party app acting on a user's
 * behalf. A personal API key is the user's own and passes.
 *
 * @param {Object|undefined} user - `req.user`.
 * @returns {boolean}
 */
export function canHoldProjects(user) {
  if (isAnonymousUser(user)) return false;
  if (user.isOAuthClient || user.isAgent === true) return false;
  if (user.authMode === 'oauth_authorization_code') return false;
  return true;
}

function groupPermissionsOf(user, groupsConfig) {
  let config = groupsConfig;
  if (!config) {
    try {
      config = loadGroupsConfiguration();
    } catch {
      return [];
    }
  }
  const groups = Array.isArray(user?.groups) ? user.groups : [];
  return groups.map(name =>
    Object.hasOwn(config?.groups || {}, name) ? config.groups[name]?.permissions || {} : {}
  );
}

/**
 * Whether a principal is a full administrator who may read and delete any
 * project for compliance: `adminAccess`, through an interactive principal.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {Object} [groupsConfig] - Resolved groups configuration; loaded when omitted.
 * @returns {boolean}
 */
export function isProjectAdmin(user, groupsConfig) {
  if (isAnonymousUser(user) || !isAdminEligiblePrincipal(user)) return false;
  if (user.permissions?.adminAccess === true) return true;
  let config = groupsConfig;
  if (!config) {
    try {
      config = loadGroupsConfiguration();
    } catch {
      return isAdminUser(user);
    }
  }
  return groupPermissionsOf(user, config).some(p => p.adminAccess === true);
}

/**
 * Whether a principal administers admin projects: full admin or content
 * admin, the rule `contentAdminAuth` applies to the admin pages.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {Object} [groupsConfig] - Resolved groups configuration; loaded when omitted.
 * @returns {boolean}
 */
export function isProjectContentAdmin(user, groupsConfig) {
  if (isAnonymousUser(user) || !isAdminEligiblePrincipal(user)) return false;
  if (user.permissions?.adminAccess === true || user.permissions?.contentAdmin === true) {
    return true;
  }
  return groupPermissionsOf(user, groupsConfig).some(
    p => p.adminAccess === true || p.contentAdmin === true
  );
}

/**
 * Whether a principal may create user projects (`projects` group permission).
 *
 * @param {Object|undefined} user - `req.user` with resolved permissions.
 * @returns {boolean}
 */
export function mayCreateProjects(user) {
  return canHoldProjects(user) && user.permissions?.projects === true;
}

/**
 * Whether a principal may add members to projects they may share
 * (`projectSharing` group permission).
 *
 * @param {Object|undefined} user - `req.user` with resolved permissions.
 * @returns {boolean}
 */
export function mayShareProjects(user) {
  return canHoldProjects(user) && user.permissions?.projectSharing === true;
}

/**
 * The share-marker keys that reach a principal: their own user key, each of
 * their effective groups, and everyone. Empty for a principal that may not
 * hold projects.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {string[]} groups - Effective groups.
 * @returns {string[]}
 */
export function principalMemberKeys(user, groups = []) {
  if (!canHoldProjects(user)) return [];
  const keys = [memberTargetKey({ type: 'user', id: String(user.id) }), 'everyone'];
  for (const group of groups) {
    if (!UNSHAREABLE_GROUPS.includes(group))
      keys.push(memberTargetKey({ type: 'group', id: group }));
  }
  return keys;
}

/**
 * The strongest member role on `project` that reaches the caller.
 *
 * @param {Object} project - Stored project.
 * @param {Object} user - `req.user`.
 * @param {string[]} groups - The caller's effective groups.
 * @returns {'editor'|'user'|null}
 */
export function memberRoleFor(project, user, groups = []) {
  if (!canHoldProjects(user)) return null;
  const userId = String(user.id);
  let best = null;
  for (const member of Array.isArray(project?.members) ? project.members : []) {
    const reaches =
      (member.type === 'user' && String(member.id) === userId) ||
      (member.type === 'group' &&
        !UNSHAREABLE_GROUPS.includes(member.id) &&
        groups.includes(member.id)) ||
      member.type === 'everyone';
    if (!reaches) continue;
    const role = MEMBER_ROLES.includes(member.role) ? member.role : 'user';
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

/**
 * What a user may do with a smart collection shown as a project: see it and
 * use it as knowledge, nothing else. It is the user's own in iFinder, so they
 * are its owner in the view; it holds no chats (`canHoldChats`), so a chat
 * that uses it attaches it.
 *
 * @param {Object} user
 * @returns {typeof NO_ACCESS}
 */
function iFinderProjectPermissions(user) {
  if (isAnonymousUser(user) || !canHoldProjects(user)) return NO_ACCESS;
  return {
    canView: true,
    canUse: true,
    canEdit: false,
    canShare: false,
    canDelete: false,
    canTransfer: false,
    readsAllChats: false,
    canHoldChats: false,
    isOwner: true,
    role: 'owner',
    readOnly: true
  };
}

/**
 * What the caller may do with one project.
 *
 * @param {Object|null} project - Stored project (user or admin ownership).
 * @param {Object|undefined} user - `req.user`.
 * @param {Object} [context]
 * @param {string[]} [context.groups] - The caller's effective groups.
 * @param {boolean} [context.isAdmin] - Full admin (compliance read and delete).
 * @param {boolean} [context.isContentAdmin] - May manage admin projects.
 * @param {boolean} [context.ownerActive=true] - The owner's account exists and is active.
 * @param {boolean} [context.linked=false] - An admin project reached through an
 *   app, workflow or agent the caller may use.
 * @param {boolean} [context.catalog=false] - The catalog is on
 *   (`sharing.allowCatalog`): a published project reaches everyone signed in.
 * @returns {{canView: boolean, canUse: boolean, canEdit: boolean, canShare: boolean,
 *   canDelete: boolean, canTransfer: boolean, readsAllChats: boolean, canHoldChats: boolean,
 *   isOwner: boolean, role: 'owner'|'editor'|'user'|'catalog'|'admin'|'linked'|null,
 *   readOnly: boolean}}
 *   `readsAllChats`: the caller may open the other members' chats in the project;
 *   `canHoldChats`: a chat of theirs may run inside it (which opens it to the members).
 */
export function projectPermissions(
  project,
  user,
  {
    groups = [],
    isAdmin = false,
    isContentAdmin = false,
    ownerActive = true,
    linked = false,
    catalog = false
  } = {}
) {
  if (!project || !user) return NO_ACCESS;
  // The id is the discriminator, not the stored `tier`: no stored project can
  // carry an `ifc_` id.
  if (isIFinderProjectId(project.id)) return iFinderProjectPermissions(user);

  if (project.ownership === 'admin') {
    // An admin project is configuration: whoever may use the app, workflow
    // or agent that links it may read it, anonymous and delegated callers
    // included (the app's own permission check already ran). Changing it
    // takes a signed-in content admin.
    const admin = isContentAdmin && !isAnonymousUser(user);
    if (!admin && !linked) {
      // A published admin project reaches everyone signed in who may hold
      // projects, to use and to link from; nobody but an admin changes it.
      if (!isPublished(project) || project.enabled === false) return NO_ACCESS;
      if (isAnonymousUser(user) || !canHoldProjects(user)) return NO_ACCESS;
      return { ...NO_ACCESS, canView: true, canUse: true, role: 'catalog', readOnly: true };
    }
    return {
      canView: true,
      canUse: project.enabled !== false || admin,
      canEdit: admin,
      canShare: false,
      canDelete: admin,
      canTransfer: false,
      readsAllChats: false,
      canHoldChats: false,
      isOwner: false,
      role: admin ? 'admin' : 'linked',
      readOnly: !admin
    };
  }

  if (isAnonymousUser(user) || !canHoldProjects(user)) return NO_ACCESS;
  const isOwner = String(project.owner?.id ?? project.ownerId) === String(user.id);
  // A membership outranks the catalog: a member keeps what the role gives.
  const role = isOwner
    ? null
    : memberRoleFor(project, user, groups) ||
      // A full admin keeps the compliance view, not a catalog role.
      (!isAdmin && catalog && isPublished(project) ? 'catalog' : null);
  if (!isOwner && !role && !isAdmin) return NO_ACCESS;

  // Nobody but an admin changes a project whose owner is gone: what the
  // owner shared stays as they left it until an admin hands it over.
  const readOnly = !isOwner && ownerActive === false;
  const canEdit = isOwner || (role === 'editor' && !readOnly);
  return {
    canView: true,
    canUse: true,
    canEdit,
    // Editors change members too: the member list is part of what they were
    // trusted to change (the prompt library's rule).
    canShare: canEdit,
    canDelete: isOwner || isAdmin,
    canTransfer: isOwner || isAdmin,
    // Someone who only took the project from the catalog is no member: the
    // members' chats stay among the members.
    readsAllChats: role !== 'catalog',
    // A chat inside a project is open to its members; someone who only took
    // the project from the catalog attaches it to their chats instead.
    canHoldChats: role !== 'catalog',
    isOwner,
    role: isOwner ? 'owner' : role || 'admin',
    readOnly: readOnly && !isAdmin
  };
}

/**
 * Whether a permission block satisfies a required access level.
 *
 * @param {ReturnType<typeof projectPermissions>} permissions
 * @param {'use'|'edit'|'share'|'own'} level
 * @returns {boolean}
 */
export function satisfiesLevel(permissions, level) {
  switch (level) {
    case 'use':
      return Boolean(permissions.canUse);
    case 'edit':
      return Boolean(permissions.canEdit);
    case 'share':
      return Boolean(permissions.canShare);
    case 'own':
      return Boolean(permissions.canDelete);
    default:
      return false;
  }
}
