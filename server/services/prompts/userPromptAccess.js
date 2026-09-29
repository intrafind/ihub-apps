/**
 * User prompt access — who may see, use, change, share and delete a prompt a
 * user wrote.
 *
 * Every check the client relies on is answered here, on the server, and the
 * answer travels with each prompt as its `permissions` block: the client only
 * uses it to show or hide actions. The rules (#2519):
 *
 *  - The **owner** may do everything.
 *  - A **share** grants either `use` (see, insert, copy, duplicate) or `edit`
 *    (also change the text and the variables, and share it further). A user
 *    can be reached by a share to them, to any of their groups — inheritance
 *    resolved, so a share to `users` reaches an admin whose group inherits it
 *    — or to everyone signed in. The strongest matching share wins.
 *  - A **prompt admin** (full admin or content admin, the same people who
 *    manage the global prompts) may do everything but only through an
 *    interactive, non-delegated principal.
 *  - Only the owner and an admin may **delete** a prompt or hand it to someone
 *    else.
 *  - When the owner's account is **deleted or deactivated**, the prompt stays
 *    readable for everyone it is shared with, but only an admin can change it.
 *  - **Anonymous** callers, OAuth clients, agents and third-party apps holding
 *    a user-delegated token never see a user prompt. A personal API key acts
 *    as its owner and does.
 *
 * @module services/prompts/userPromptAccess
 */
import { isAnonymousUser, isAdminUser } from '../loop/runIdentity.js';
import { isAdminEligiblePrincipal, loadGroupsConfiguration } from '../../utils/authorization.js';

/** Share target types. */
export const SHARE_TARGET_TYPES = Object.freeze(['user', 'group', 'everyone']);

/** What a share grants. */
export const SHARE_PERMISSIONS = Object.freeze(['use', 'edit']);

/** Groups nobody can share with: anonymous visitors never receive a user prompt. */
export const UNSHAREABLE_GROUPS = Object.freeze(['anonymous']);

const PERMISSION_RANK = { use: 1, edit: 2 };

/** No access at all. */
export const NO_ACCESS = Object.freeze({
  canView: false,
  canEdit: false,
  canShare: false,
  canDelete: false,
  canTransfer: false,
  canDuplicate: false,
  isOwner: false,
  access: null,
  readOnly: false
});

/**
 * The key a share target is indexed under — also how two targets are told
 * apart when a share list is deduplicated.
 *
 * @param {{type: string, id?: string|null}} target - Share target.
 * @returns {string}
 */
export function shareTargetKey(target) {
  if (target?.type === 'everyone') return 'everyone';
  return `${target?.type}:${String(target?.id ?? '')}`;
}

/**
 * Whether a principal may hold user prompts at all: signed in, a person (not
 * an OAuth client or an agent), and not a third-party app acting on a user's
 * behalf. A personal API key is the user's own and passes.
 *
 * @param {Object|undefined} user - `req.user`.
 * @returns {boolean}
 */
export function canHoldUserPrompts(user) {
  if (isAnonymousUser(user)) return false;
  if (user.isOAuthClient || user.isAgent === true) return false;
  if (user.authMode === 'oauth_authorization_code') return false;
  return true;
}

/**
 * Whether a principal administers the prompt library: full admin or content
 * admin, and an interactive principal — the rule `contentAdminAuth` applies
 * to the admin prompt pages.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {Object} [groupsConfig] - Resolved groups configuration; loaded when omitted.
 * @returns {boolean}
 */
export function isPromptAdmin(user, groupsConfig) {
  if (isAnonymousUser(user) || !isAdminEligiblePrincipal(user)) return false;
  if (user.permissions?.adminAccess === true || user.permissions?.contentAdmin === true) {
    return true;
  }
  let config = groupsConfig;
  if (!config) {
    try {
      config = loadGroupsConfiguration();
    } catch {
      return isAdminUser(user);
    }
  }
  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.some(name => {
    const permissions = Object.hasOwn(config?.groups || {}, name)
      ? config.groups[name]?.permissions
      : null;
    return permissions?.adminAccess === true || permissions?.contentAdmin === true;
  });
}

/**
 * A user's groups plus every group they inherit, transitively.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {Object} [groupsConfig] - Groups configuration; loaded when omitted.
 * @returns {string[]}
 */
export function effectiveGroups(user, groupsConfig) {
  const own = Array.isArray(user?.groups) ? user.groups.filter(g => typeof g === 'string') : [];
  let config = groupsConfig;
  if (!config) {
    try {
      config = loadGroupsConfiguration();
    } catch {
      return [...new Set(own)];
    }
  }
  const groups = config?.groups || {};
  const result = new Set();
  const queue = [...own];
  while (queue.length) {
    const name = queue.shift();
    if (result.has(name)) continue;
    result.add(name);
    const parents = Object.hasOwn(groups, name) ? groups[name]?.inherits : null;
    for (const parent of Array.isArray(parents) ? parents : []) {
      if (typeof parent === 'string' && !result.has(parent)) queue.push(parent);
    }
  }
  return [...result];
}

/**
 * The share-marker keys that reach a principal: their own user key, each of
 * their effective groups, and everyone. Empty for a principal that may not
 * hold user prompts.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {string[]} groups - Effective groups.
 * @returns {string[]}
 */
export function principalShareKeys(user, groups = []) {
  if (!canHoldUserPrompts(user)) return [];
  const keys = [shareTargetKey({ type: 'user', id: String(user.id) }), 'everyone'];
  for (const group of groups) {
    if (!UNSHAREABLE_GROUPS.includes(group))
      keys.push(shareTargetKey({ type: 'group', id: group }));
  }
  return keys;
}

/**
 * The strongest share on `prompt` that reaches the caller.
 *
 * @param {Object} prompt - Stored user prompt.
 * @param {Object} user - `req.user`.
 * @param {string[]} groups - The caller's effective groups.
 * @returns {'use'|'edit'|null}
 */
export function sharePermissionFor(prompt, user, groups = []) {
  if (!canHoldUserPrompts(user)) return null;
  const userId = String(user.id);
  let best = null;
  for (const share of Array.isArray(prompt?.shares) ? prompt.shares : []) {
    const reaches =
      (share.type === 'user' && String(share.id) === userId) ||
      (share.type === 'group' &&
        !UNSHAREABLE_GROUPS.includes(share.id) &&
        groups.includes(share.id)) ||
      share.type === 'everyone';
    if (!reaches) continue;
    const permission = SHARE_PERMISSIONS.includes(share.permission) ? share.permission : 'use';
    if (!best || PERMISSION_RANK[permission] > PERMISSION_RANK[best]) best = permission;
  }
  return best;
}

/**
 * What the caller may do with one user prompt.
 *
 * @param {Object|null} prompt - Stored user prompt.
 * @param {Object|undefined} user - `req.user`.
 * @param {Object} [context]
 * @param {string[]} [context.groups] - The caller's effective groups.
 * @param {boolean} [context.isAdmin] - Whether the caller is a prompt admin.
 * @param {boolean} [context.ownerActive=true] - Whether the owner's account
 *   still exists and is active.
 * @returns {{canView: boolean, canEdit: boolean, canShare: boolean,
 *   canDelete: boolean, canTransfer: boolean, canDuplicate: boolean,
 *   isOwner: boolean, access: 'owner'|'edit'|'use'|'admin'|null, readOnly: boolean}}
 */
export function userPromptPermissions(
  prompt,
  user,
  { groups = [], isAdmin = false, ownerActive = true } = {}
) {
  if (!prompt || !canHoldUserPrompts(user)) return NO_ACCESS;
  const isOwner = String(prompt.ownerId) === String(user.id);
  const shared = isOwner ? null : sharePermissionFor(prompt, user, groups);
  if (!isOwner && !shared && !isAdmin) return NO_ACCESS;

  // Nobody but an admin changes a prompt whose owner is gone: what the owner
  // shared stays as they left it.
  const readOnly = !isOwner && ownerActive === false;
  const canEdit = isOwner || isAdmin || (shared === 'edit' && !readOnly);
  return {
    canView: true,
    canEdit,
    // Editors may share further (#2519): the share list is part of what they
    // were trusted to change.
    canShare: canEdit,
    canDelete: isOwner || isAdmin,
    canTransfer: isOwner || isAdmin,
    canDuplicate: true,
    isOwner,
    access: isOwner ? 'owner' : shared || 'admin',
    readOnly: readOnly && !isAdmin
  };
}
