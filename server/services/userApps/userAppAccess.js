// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Personal app access — who may see, chat with, change, share, offer, publish
 * and delete a personal app.
 *
 * Every check the client relies on is answered here, on the server, and the
 * answer travels with each personal app as its `permissions` block. The rules
 * (design section 5):
 *
 *  - The **owner** may do everything. A member reaches the app as `editor`
 *    ("Can edit": chat, change, change members) or `user` ("Can use": chat
 *    only); a member is a user, a group (inheritance resolved) or everyone
 *    signed in. The strongest matching role wins. Only the owner deletes,
 *    offers the app to a new owner and publishes it.
 *  - The **receiver of an open offer** reads the app and chats with it, as a
 *    "Can use" member would, and may accept.
 *  - A **full admin** who is no member may read, chat, delete and offer, and
 *    never edit. A content admin has no access.
 *  - **Sharing** needs three things: the caller is owner or editor, the caller
 *    holds `userAppSharing`, and the owner holds it too.
 *  - **Shares count only while the owner may hold and share personal apps.**
 *    When the owner lost `userApps` or `userAppSharing`, or an admin blocked
 *    the owner, members still see the app and can do nothing else
 *    (`suspended`). A blocked owner's app is chatted with by nobody.
 *  - A **switched-off** app is chatted with by full admins only. A
 *    **promoted** app is read-only. An app whose **owner is inactive** is
 *    read-only for its editors.
 *  - **Anonymous** callers, OAuth clients, agents and third-party apps holding
 *    a user-delegated token never hold or see a personal app. A **personal
 *    API key** reaches the apps its user owns and no other, and is never an
 *    admin.
 *
 * Pure, except {@link lookupUserAppOwner} and {@link userAppOwnerSnapshot},
 * which read `users.json` and the group configuration.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 5 and 6.2.
 *
 * @module services/userApps/userAppAccess
 */
import { isAnonymousUser } from '../loop/runIdentity.js';
import {
  UNSHAREABLE_GROUPS,
  effectiveGroups,
  shareTargetKey
} from '../prompts/userPromptAccess.js';
import { ownerSnapshot, resolveOwnerPrincipal } from '../scheduler/tasks/ownerPrincipal.js';
import { USER_APP_MEMBER_ROLES } from '../../../shared/userAppContent.js';
import { isBlockedOwner } from './userAppSettings.js';

export { UNSHAREABLE_GROUPS, effectiveGroups, shareTargetKey };

const ROLE_RANK = { user: 1, editor: 2 };

/** How long an offer stays open after `offeredAt`. A lapsed offer is treated as none. */
export const OFFER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The age after which a request of the owner rewrites the owner snapshot whatever it holds. */
export const OWNER_SNAPSHOT_REFRESH_MS = 24 * 60 * 60 * 1000;

/** The access levels a route can require. */
export const USER_APP_ACCESS_LEVELS = Object.freeze([
  'view',
  'use',
  'edit',
  'share',
  'own',
  'delete',
  'offer'
]);

/** No access at all. */
export const NO_ACCESS = Object.freeze({
  canView: false,
  canUse: false,
  canEdit: false,
  canShare: false,
  canDelete: false,
  canOffer: false,
  canAcceptOffer: false,
  canPublish: false,
  isOwner: false,
  role: null,
  readOnly: false,
  suspended: null
});

/**
 * The owner lookup the permission function takes when the caller knows
 * nothing about the owner: inactive and without rights. Nothing a share
 * grants works with it.
 */
export const UNKNOWN_OWNER = Object.freeze({
  active: false,
  mayHold: false,
  mayShare: false,
  blocked: false,
  stale: false,
  principal: null
});

/**
 * Whether a principal may hold personal apps at all: signed in, a person (not
 * an OAuth client or an agent), and not a third-party app acting on a user's
 * behalf. A personal API key is the user's own and passes; it reaches only
 * the apps of its user ({@link userAppPermissions}).
 *
 * @param {Object|undefined} user - `req.user`.
 * @returns {boolean}
 */
export function canHoldUserApps(user) {
  if (isAnonymousUser(user)) return false;
  if (user.isOAuthClient || user.isAgent === true) return false;
  if (user.authMode === 'oauth_authorization_code') return false;
  return true;
}

/** Whether the request is made with a personal API key. */
function isPersonalApiKey(user) {
  return user?.authMode === 'oauth_personal_key';
}

/**
 * Whether a principal may create personal apps: the `userApps` group
 * permission, and no admin blocked them.
 *
 * @param {Object|undefined} user - `req.user` with resolved permissions.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} [settings]
 *   The effective settings. Without them the block list is not checked.
 * @returns {boolean}
 */
export function mayCreateUserApps(user, settings) {
  if (!canHoldUserApps(user) || user.permissions?.userApps !== true) return false;
  return !isBlockedOwner(settings, user.id);
}

/**
 * Whether a principal may add members to personal apps they may share, and
 * publish the ones they own (`userAppSharing` group permission).
 *
 * @param {Object|undefined} user - `req.user` with resolved permissions.
 * @returns {boolean}
 */
export function mayShareUserApps(user) {
  return canHoldUserApps(user) && user.permissions?.userAppSharing === true;
}

/**
 * The key a member target is indexed under: the format of prompt shares, so
 * the markers of all four kinds of user content read alike.
 *
 * @param {{type: string, id?: string|null}} member - Member target.
 * @returns {string}
 */
export function memberTargetKey(member) {
  return shareTargetKey(member);
}

/**
 * The share-marker keys that reach a principal: their own user key, each of
 * their effective groups, and everyone. Empty for a principal that may not
 * hold personal apps, and for a personal API key: a key reaches only the
 * apps its user owns.
 *
 * @param {Object|undefined} user - `req.user`.
 * @param {string[]} groups - Effective groups.
 * @returns {string[]}
 */
export function principalMemberKeys(user, groups = []) {
  if (!canHoldUserApps(user) || isPersonalApiKey(user)) return [];
  const keys = [memberTargetKey({ type: 'user', id: String(user.id) }), 'everyone'];
  for (const group of groups) {
    if (!UNSHAREABLE_GROUPS.includes(group)) {
      keys.push(memberTargetKey({ type: 'group', id: group }));
    }
  }
  return keys;
}

/**
 * The strongest member role on `record` that reaches the caller.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} user - `req.user`.
 * @param {string[]} groups - The caller's effective groups.
 * @returns {'editor'|'user'|null}
 */
export function memberRoleFor(record, user, groups = []) {
  if (!canHoldUserApps(user)) return null;
  const userId = String(user.id);
  let best = null;
  for (const member of Array.isArray(record?.members) ? record.members : []) {
    const reaches =
      (member.type === 'user' && String(member.id) === userId) ||
      (member.type === 'group' &&
        !UNSHAREABLE_GROUPS.includes(member.id) &&
        groups.includes(member.id)) ||
      member.type === 'everyone';
    if (!reaches) continue;
    const role = USER_APP_MEMBER_ROLES.includes(member.role) ? member.role : 'user';
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

/**
 * Whether the caller holds a share that names them directly. `_leave` removes
 * exactly that; access through a group or through everyone cannot be left.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} user - `req.user`.
 * @returns {boolean}
 */
export function hasDirectShare(record, user) {
  if (!user?.id) return false;
  const key = memberTargetKey({ type: 'user', id: String(user.id) });
  return (record?.members || []).some(member => memberTargetKey(member) === key);
}

/**
 * The open offer on a record, or null. An offer lapses 30 days after
 * `offeredAt`; a lapsed one is treated as none.
 *
 * @param {Object|null|undefined} record - Stored personal app.
 * @param {number} [now] - Clock in milliseconds, for tests.
 * @returns {{id: string, name: string, offeredAt: string, offeredBy: Object}|null}
 */
export function openOffer(record, now = Date.now()) {
  const offer = record?.pendingOwner;
  if (!offer?.id) return null;
  const offeredAt = Date.parse(offer.offeredAt || '');
  if (!Number.isFinite(offeredAt) || now - offeredAt >= OFFER_TTL_MS) return null;
  return offer;
}

/**
 * The state a record is in right now. A promoted record whose company app no
 * longer exists is released by itself and counts as `active`; the next write
 * stores that.
 *
 * @param {Object|null|undefined} record - Stored personal app.
 * @param {Object} [options]
 * @param {boolean} [options.publishedAppExists=true] - Whether
 *   `publishedAs.appId` is still a config app (`configCache.getApps(true)`).
 * @returns {'active'|'promoted'}
 */
export function effectiveUserAppState(record, { publishedAppExists = true } = {}) {
  return record?.state === 'promoted' && publishedAppExists !== false ? 'promoted' : 'active';
}

/**
 * The owner snapshot a personal app stores: who the owner is and the groups
 * they had at this request. The snapshot scheduled tasks store, without the
 * identity mode a task needs.
 *
 * @param {Object} user - `req.user` of the owner.
 * @param {Object} [options] - Passed to `ownerSnapshot` (`platform`, `lookupUser`).
 * @returns {{userId: string, username: string, name: string, email: string|null,
 *   groups: string[], authMode: string|null, provider: string|null, recorded: boolean}}
 */
export function userAppOwnerSnapshot(user, options) {
  const { identityMode: _unused, ...snapshot } = ownerSnapshot(user, 'default', options);
  return snapshot;
}

/**
 * Whether the stored owner snapshot can no longer be trusted: the owner signs
 * in through an identity provider, and the snapshot is older than
 * `limits.ownerSnapshotMaxAgeDays`. A local owner is never stale: their
 * groups are read from `users.json` on every lookup.
 *
 * @param {Object|null|undefined} record - Stored personal app.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} settings
 * @param {number} [now] - Clock in milliseconds, for tests.
 * @returns {boolean}
 */
export function isOwnerSnapshotStale(record, settings, now = Date.now()) {
  const maxAgeDays = settings?.limits?.ownerSnapshotMaxAgeDays ?? 0;
  if (!(maxAgeDays > 0)) return false;
  if (record?.ownerPrincipal?.authMode === 'local') return false;
  const takenAt = Date.parse(record?.ownerPrincipalAt || '');
  if (!Number.isFinite(takenAt)) return true;
  return now - takenAt > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Whether a request of the owner should rewrite the stored snapshot: the
 * groups differ, or the snapshot is older than a day.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} user - `req.user` of the owner.
 * @param {number} [now] - Clock in milliseconds, for tests.
 * @returns {boolean}
 */
export function ownerSnapshotNeedsRefresh(record, user, now = Date.now()) {
  const stored = record?.ownerPrincipal;
  if (!stored) return true;
  const takenAt = Date.parse(record.ownerPrincipalAt || '');
  if (!Number.isFinite(takenAt) || now - takenAt > OWNER_SNAPSHOT_REFRESH_MS) return true;
  // Code-unit order: the two lists are only compared with each other.
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const before = [...(stored.groups || [])].map(String).sort(byCodeUnit);
  const after = (Array.isArray(user?.groups) ? user.groups : []).map(String).sort(byCodeUnit);
  if (before.length !== after.length || before.some((group, index) => group !== after[index])) {
    return true;
  }
  return (stored.authMode || null) !== (user?.authMode || null);
}

/**
 * What iHub knows about the owner of a personal app right now (design 6.2).
 *
 * The owner's principal is rebuilt from the stored snapshot and resolved
 * against the current group configuration. For a local account the groups are
 * read from `users.json` on every call; for an account of an identity
 * provider they are those of the snapshot.
 *
 * - `active`: the account exists and is not deactivated, as far as iHub can
 *   tell. Any failure of the lookup reads as inactive.
 * - `mayHold`, `mayShare`: the owner holds `userApps` / `userAppSharing`.
 *   Both are `true` for an inactive owner: an app whose owner left stays
 *   usable as plain chat (design 8.5), so an unknown answer does not suspend
 *   the shares. The ceiling withholds every capability in that case.
 * - `blocked`: an admin put the owner on `blockedOwners`.
 * - `stale`: the snapshot is too old to be trusted (the ceiling then
 *   withholds every capability). Staleness does not suspend shares.
 * - `principal`: the owner as a user object with resolved permissions, for
 *   the ceiling; null when inactive.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} [options]
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} [options.settings]
 * @param {Object} [options.platform] - Platform config (defaults to the cached one).
 * @param {Function} [options.lookupUser] - Injectable for tests.
 * @param {Function} [options.resolve] - `resolveOwnerPrincipal`, injectable for tests.
 * @param {number} [options.now] - Clock in milliseconds, for tests.
 * @returns {{active: boolean, mayHold: boolean, mayShare: boolean, blocked: boolean,
 *   stale: boolean, principal: Object|null, reason: string|null}}
 */
export function lookupUserAppOwner(
  record,
  { settings, platform, lookupUser, resolve = resolveOwnerPrincipal, now = Date.now() } = {}
) {
  const ownerId = record?.owner?.id ?? record?.ownerPrincipal?.userId;
  const blocked = isBlockedOwner(settings, ownerId);
  const stale = isOwnerSnapshotStale(record, settings, now);
  let resolved;
  try {
    resolved = resolve(
      { owner: record?.ownerPrincipal },
      { ...(platform ? { platform } : {}), ...(lookupUser ? { lookupUser } : {}) }
    );
  } catch (error) {
    resolved = { ok: false, code: 'OWNER_LOOKUP_FAILED', message: error.message };
  }
  if (!resolved?.ok || !resolved.user) {
    return {
      active: false,
      mayHold: true,
      mayShare: true,
      blocked,
      stale,
      principal: null,
      reason: resolved?.code || 'OWNER_LOOKUP_FAILED'
    };
  }
  const principal = resolved.user;
  return {
    active: true,
    mayHold: canHoldUserApps(principal) && principal.permissions?.userApps === true,
    mayShare: mayShareUserApps(principal),
    blocked,
    stale,
    principal,
    reason: null
  };
}

/**
 * The owner lookup for a request the owner makes: the caller is the owner, so
 * their rights are those of the request.
 *
 * @param {Object} user - `req.user` of the owner.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} [settings]
 * @returns {ReturnType<typeof lookupUserAppOwner>}
 */
export function ownerLookupFromRequest(user, settings) {
  return {
    active: true,
    mayHold: canHoldUserApps(user) && user.permissions?.userApps === true,
    mayShare: mayShareUserApps(user),
    blocked: isBlockedOwner(settings, user?.id),
    stale: false,
    principal: user,
    reason: null
  };
}

/**
 * What the caller may do with one personal app.
 *
 * @param {Object|null} record - Stored personal app.
 * @param {Object|undefined} user - `req.user` with resolved permissions.
 * @param {Object} [context]
 * @param {string[]} [context.groups] - The caller's effective groups.
 * @param {boolean} [context.isAdmin] - Full admin. Ignored for a personal API key.
 * @param {{active: boolean, mayHold: boolean, mayShare: boolean, blocked: boolean}} [context.owner]
 *   The owner lookup ({@link lookupUserAppOwner}). Without it the owner counts
 *   as unknown and no share grants anything.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} [context.settings]
 *   The effective settings; read for `sharing.allowPublish`.
 * @param {boolean} [context.retired=false] - The app is promoted, its company
 *   app is visible and this caller may use it: the personal app only points
 *   there.
 * @param {boolean} [context.publishedAppExists=true] - See {@link effectiveUserAppState}.
 * @param {number} [context.now] - Clock in milliseconds, for tests.
 * @returns {{canView: boolean, canUse: boolean, canEdit: boolean, canShare: boolean,
 *   canDelete: boolean, canOffer: boolean, canAcceptOffer: boolean, canPublish: boolean,
 *   isOwner: boolean, role: 'owner'|'editor'|'user'|'offered'|'admin'|null,
 *   readOnly: boolean, suspended: null|'ownerMayNotShare'|'ownerBlocked'}}
 *
 * @example
 * const owner = lookupUserAppOwner(record, { settings });
 * const permissions = userAppPermissions(record, req.user, {
 *   groups: effectiveGroups(req.user), isAdmin: isAdmin(req.user), owner, settings
 * });
 * if (!permissions.canView) throw new ServiceError('NOT_FOUND', 'App not found');
 */
export function userAppPermissions(
  record,
  user,
  {
    groups = [],
    isAdmin = false,
    owner = UNKNOWN_OWNER,
    settings,
    retired = false,
    publishedAppExists = true,
    now = Date.now()
  } = {}
) {
  if (!record || !user) return NO_ACCESS;
  if (!canHoldUserApps(user)) return NO_ACCESS;

  const isOwner = String(record.owner?.id ?? '') === String(user.id);
  const viaApiKey = isPersonalApiKey(user);
  // A key reaches only the apps of its own user, and is never an admin.
  if (viaApiKey && !isOwner) return NO_ACCESS;
  const admin = isAdmin === true && !viaApiKey;

  const memberRole = isOwner ? null : memberRoleFor(record, user, groups);
  const offer = openOffer(record, now);
  const isReceiver = !isOwner && Boolean(offer) && String(offer.id) === String(user.id);
  const role = isOwner
    ? 'owner'
    : memberRole || (isReceiver ? 'offered' : null) || (admin ? 'admin' : null);
  if (!role) return NO_ACCESS;

  const ownerInfo = isOwner
    ? { ...owner, active: true, mayShare: mayShareUserApps(user) }
    : owner || UNKNOWN_OWNER;
  const blocked = ownerInfo.blocked === true;
  const promoted = effectiveUserAppState(record, { publishedAppExists }) === 'promoted';
  const disabled = Boolean(record.disabled);
  const active = !promoted && !disabled;

  // What a share grants counts only while the owner may hold and share.
  const reachedByShare = role === 'editor' || role === 'user' || role === 'offered';
  const sharesSuspended = blocked
    ? 'ownerBlocked'
    : ownerInfo.mayHold !== true || ownerInfo.mayShare !== true
      ? 'ownerMayNotShare'
      : null;
  const suspended = isOwner
    ? blocked
      ? 'ownerBlocked'
      : null
    : reachedByShare
      ? sharesSuspended
      : blocked
        ? 'ownerBlocked'
        : null;
  const shareWorks = !reachedByShare || !sharesSuspended;

  // Nobody but the owner changes an app whose owner is gone.
  const ownerGone = !isOwner && ownerInfo.active === false;
  const editorWorks = role === 'editor' && shareWorks && !ownerGone;

  const canEdit = active && (isOwner || editorWorks);
  const canUse = retired
    ? false
    : disabled
      ? admin
      : blocked
        ? false
        : isOwner || admin || shareWorks;

  return {
    canView: true,
    canUse,
    canEdit,
    canShare: canEdit && mayShareUserApps(user) && ownerInfo.mayShare === true,
    canDelete: isOwner || admin,
    canOffer: active && (isOwner || admin),
    canAcceptOffer: active && isReceiver,
    canPublish:
      active &&
      isOwner &&
      !blocked &&
      mayShareUserApps(user) &&
      settings?.sharing?.allowPublish === true,
    isOwner,
    role,
    readOnly: promoted || disabled || (role === 'editor' && ownerGone),
    suspended
  };
}

/**
 * Whether a permission block satisfies a required access level.
 *
 * `own` is the owner alone; `delete` and `offer` also pass for a full admin.
 *
 * @param {ReturnType<typeof userAppPermissions>} permissions
 * @param {'view'|'use'|'edit'|'share'|'own'|'delete'|'offer'} level
 * @returns {boolean}
 */
export function satisfiesUserAppLevel(permissions, level) {
  switch (level) {
    case 'view':
      return Boolean(permissions?.canView);
    case 'use':
      return Boolean(permissions?.canUse);
    case 'edit':
      return Boolean(permissions?.canEdit);
    case 'share':
      return Boolean(permissions?.canShare);
    case 'own':
      return Boolean(permissions?.isOwner);
    case 'delete':
      return Boolean(permissions?.canDelete);
    case 'offer':
      return Boolean(permissions?.canOffer);
    default:
      return false;
  }
}
