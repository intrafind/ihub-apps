// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a user does with personal apps (feature `userApps`): create, save,
 * delete, duplicate, change members, leave, and offer an app to a new owner.
 *
 * The routes (`routes/userAppRoutes.js`) check who calls and what the request
 * says; this service decides what the call may do to the app and does it
 * through the repository. Every refusal is a `ServiceError` with a registry
 * code; an error of the repository is translated by {@link asServiceError}.
 *
 * The repository takes the owner lock for `create`, `setOffer` and
 * `acceptOffer` itself. That lock is not re-entrant, so nothing here wraps
 * those calls in `withOwnerLock`.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 6.3, 8.1, 8.3 and 9.1.
 *
 * @module services/userApps/UserAppService
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isAdmin, loadGroupsConfiguration } from '../../utils/authorization.js';
import { getLocalizedString } from '../../utils/localize.js';
import logger from '../../utils/logger.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { usersDb } from '../../middleware/projectAccess.js';
import { resolveShares } from '../../routes/promptRoutes.js';
import {
  mergeUserAppContent,
  userAppContentSchema,
  userAppCreateSchema,
  userAppMembersSchema,
  userAppOwnerOfferSchema
} from '../../validators/userAppSchema.js';
import installedIntegrationService from '../integrations/InstalledIntegrationService.js';
import { mayUseIntegration } from '../integrations/integrationAccess.js';
import { isWebSearchAvailableTo } from '../tools/webSearchResolver.js';
import {
  ACCESS_CHANGED,
  NO_OFFER,
  QUOTA_APPS,
  QUOTA_OFFERS,
  getUserAppRepository
} from './UserAppRepository.js';
import {
  CAPABILITY_REASONS,
  INTEGRATION_CAPABILITY_PREFIX,
  checkCapabilitiesForSave,
  removesCapabilitiesOnly
} from './ceiling.js';
import {
  UNSHAREABLE_GROUPS,
  effectiveUserAppState,
  hasDirectShare,
  mayCreateUserApps,
  mayShareUserApps,
  memberTargetKey,
  openOffer,
  ownerSnapshotNeedsRefresh,
  userAppOwnerSnapshot
} from './userAppAccess.js';
import { hasCompanyApp, userAppCatalog, userAppStanding } from './userAppResolution.js';
import {
  allowedUserAppShareTargets,
  currentUserAppSettings,
  isBlockedOwner,
  isUserAppsEnabled
} from './userAppSettings.js';

const COMPONENT = 'UserApps';

/** Share-target lookup: the rules of `GET /api/projects/share-targets`. */
const LOOKUP_LIMIT = 10;
const LOOKUP_MIN_CHARS = 2;
const LOOKUP_MAX_CHARS = 100;

const NOT_FOUND_MESSAGE = 'App not found';

function displayName(user) {
  return String(user?.name || user?.displayName || user?.username || user?.id || '');
}

/** The caller as the repository names a person. */
function actorOf(user) {
  return { id: String(user.id), name: displayName(user) };
}

/**
 * The `ServiceError` for an error of the repository. An error that is one
 * already, and anything the repository does not name, is returned as it is.
 *
 * @param {unknown} error
 * @returns {unknown}
 *
 * @example
 * try { await repo.update(…); } catch (error) { throw asServiceError(error); }
 */
export function asServiceError(error, { max } = {}) {
  // The limit that was reached, so the client can name it.
  const limit = Number.isFinite(max) && max > 0 ? { details: { max } } : {};
  if (error instanceof ServiceError) return error;
  switch (error?.code) {
    case ACCESS_CHANGED:
      return new ServiceError('USER_APP_ACCESS_CHANGED', 'Your access to this app changed', {
        cause: error
      });
    case 'ETAG_MISMATCH':
      return new ServiceError('ETAG_MISMATCH', 'The app was changed by someone else', {
        cause: error
      });
    case QUOTA_APPS:
      return new ServiceError('QUOTA_USER_APPS', 'The limit of personal apps is reached', {
        cause: error,
        ...limit
      });
    case QUOTA_OFFERS:
      return new ServiceError('QUOTA_USER_APP_OFFERS', 'The limit of open offers is reached', {
        cause: error,
        ...limit
      });
    case NO_OFFER:
      return new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE, { cause: error });
    default:
      return error;
  }
}

/** Run a repository call and translate what it throws. */
async function stored(call, limit) {
  try {
    return await call();
  } catch (error) {
    throw asServiceError(error, limit);
  }
}

/**
 * The capabilities a content object asks for, by the names of the ceiling:
 * `model`, `upload`, `webSearch`, `skills`, `integration:<installationId>`.
 * For audit entries.
 *
 * @param {Object} content - Stored content of a personal app.
 * @returns {string[]}
 */
export function requestedCapabilityIds(content) {
  const capabilities = content?.capabilities || {};
  const ids = [];
  if (content?.preferredModel) ids.push('model');
  for (const flag of ['upload', 'webSearch', 'skills']) {
    if (capabilities[flag] === true) ids.push(flag);
  }
  for (const binding of capabilities.integrations || []) {
    if (binding?.id) ids.push(`${INTEGRATION_CAPABILITY_PREFIX}${binding.id}`);
  }
  return ids;
}

/** `content` without one capability the save check refused. */
function withoutCapability(content, capability) {
  const next = { ...content, capabilities: { ...content.capabilities } };
  if (capability === 'model') delete next.preferredModel;
  else if (capability.startsWith(INTEGRATION_CAPABILITY_PREFIX)) {
    const id = capability.slice(INTEGRATION_CAPABILITY_PREFIX.length);
    next.capabilities.integrations = (content.capabilities?.integrations || []).filter(
      binding => binding.id !== id
    );
  } else next.capabilities[capability] = false;
  return next;
}

function denied(required, message, extra = {}) {
  return new ServiceError('PERMISSION_DENIED', message, {
    status: 403,
    details: { required, ...extra }
  });
}

function conflict(reason, message) {
  return new ServiceError('CONFLICT', message, { details: { reason } });
}

/**
 * Refuse a change to an app that is promoted or switched off: 409 `CONFLICT`
 * with `details.reason`.
 *
 * @param {Object} record - Stored personal app.
 * @param {{publishedAppExists?: boolean}} [context] - `req.userAppContext`.
 * @throws {ServiceError} `CONFLICT`
 */
export function assertChangeable(record, context = {}) {
  const state = effectiveUserAppState(record, {
    publishedAppExists: context.publishedAppExists !== false
  });
  if (state === 'promoted') {
    throw conflict('promoted', 'The app is with the administrators and cannot be changed');
  }
  if (record.disabled) {
    throw conflict('disabled', 'The app is switched off and cannot be changed');
  }
}

/**
 * The lifecycle of personal apps for the user routes.
 */
export class UserAppService {
  /**
   * @param {Object} [options]
   * @param {import('./UserAppRepository.js').UserAppRepository} [options.repository]
   *   Defaults to the process-wide one, looked up on every call.
   * @param {() => Object} [options.users] - The users database (`users.json`), for
   *   share targets and the receiver of an offer. Defaults to `usersDb`.
   * @param {() => Object} [options.groups] - The group configuration's `groups`.
   */
  constructor({ repository = null, users = usersDb, groups = null } = {}) {
    this._repository = repository;
    this._users = users;
    this._groups = groups || (() => loadGroupsConfiguration()?.groups || {});
  }

  /** @returns {import('./UserAppRepository.js').UserAppRepository} */
  get repository() {
    return this._repository || getUserAppRepository();
  }

  /**
   * Refuse a save that asks for a capability the person saving or the owner
   * may not use (design 6.3). The check runs on the whole content, whatever
   * the request changes. One exception: a save that only takes capabilities
   * away from `previous`.
   *
   * @param {Object} content - Validated content (for a `PATCH`: the merged content).
   * @param {Object} options
   * @param {Object} options.actor - `req.user` of the person saving.
   * @param {Object|null} options.owner - The owner's principal; `actor` when the owner saves.
   * @param {Object} options.settings - `currentUserAppSettings()`.
   * @param {Object} [options.previous] - The stored content, for the exception.
   * @returns {Promise<void>}
   * @throws {ServiceError} `USER_APP_CAPABILITY_DENIED` with `details: { capability, reason }`.
   */
  async assertMaySave(content, { actor, owner, settings, previous = null }) {
    const [refused] = await this.refusedCapabilities(content, { actor, owner, settings });
    if (!refused) return;
    if (previous && removesCapabilitiesOnly(previous, content)) return;
    throw new ServiceError(
      'USER_APP_CAPABILITY_DENIED',
      'The app uses something that is not available for it',
      { details: { capability: refused.capability, reason: refused.reason } }
    );
  }

  /**
   * What the save check refuses of `content`: `[{ capability, reason }]`. When
   * the owner saves, "the owner may not" is told as "you may not".
   */
  async refusedCapabilities(content, { actor, owner, settings }) {
    const catalog = await userAppCatalog({ owner, runner: actor });
    const refused = checkCapabilitiesForSave(content, { actor, owner, settings, catalog });
    if (owner !== actor) return refused;
    return refused.map(entry =>
      entry.reason === CAPABILITY_REASONS.ownerMayNot
        ? { ...entry, reason: CAPABILITY_REASONS.youMayNot }
        : entry
    );
  }

  /**
   * Refuse a caller who may not create personal apps: the group permission
   * `userApps`, and not on the list `blockedOwners`.
   *
   * @param {Object} user - `req.user` with resolved permissions.
   * @param {Object} settings - `currentUserAppSettings()`.
   * @throws {ServiceError} `PERMISSION_DENIED` with `details.required: 'userApps'`.
   */
  assertMayCreate(user, settings) {
    if (mayCreateUserApps(user, settings)) return;
    const blocked = isBlockedOwner(settings, user?.id);
    throw denied(
      'userApps',
      blocked
        ? 'An administrator switched off your personal apps'
        : 'You may not create personal apps',
      blocked ? { reason: 'ownerBlocked' } : {}
    );
  }

  /**
   * `POST /api/apps`: create a personal app owned by the caller. Checks, in
   * this order: the right to create, the body, the save check, the limit
   * (counted under the owner's lock by the repository).
   *
   * @param {Object} user - `req.user` with resolved permissions.
   * @param {unknown} body - The request body.
   * @returns {Promise<Object>} The stored record.
   * @throws {ServiceError} `PERMISSION_DENIED`, `VALIDATION_FAILED` (a `ZodError`),
   *   `USER_APP_CAPABILITY_DENIED`, `QUOTA_USER_APPS`, `USER_APPS_UNAVAILABLE`.
   */
  async create(user, body) {
    const settings = currentUserAppSettings();
    this.assertMayCreate(user, settings);
    const { language, origin, content } = userAppCreateSchema.parse(body || {});
    await this.assertMaySave(content, { actor: user, owner: user, settings });
    return this._create(user, { content, language, origin, settings });
  }

  async _create(user, { content, language, origin, settings }) {
    const record = await stored(
      () =>
        this.repository.create({
          owner: actorOf(user),
          ownerPrincipal: userAppOwnerSnapshot(user),
          content,
          language,
          origin,
          limit: settings.limits.maxAppsPerUser
        }),
      { max: settings.limits.maxAppsPerUser }
    );
    if (!record) {
      throw new ServiceError('USER_APPS_UNAVAILABLE', 'Personal apps are unavailable');
    }
    return record;
  }

  /**
   * `PATCH /api/apps/{appId}`: save a JSON Merge Patch over the content keys.
   *
   * @param {Object} record - The record the access check loaded (`req.userApp`).
   * @param {unknown} patch - The request body.
   * @param {Object} options
   * @param {Object} options.user - `req.user`.
   * @param {Object} options.context - `req.userAppContext`.
   * @param {number|null} [options.expectedRevision] - The revision of `If-Match`.
   * @returns {Promise<{record: Object, changedKeys: string[], capabilitiesChanged: boolean}>}
   *   `changedKeys` is empty when the save changed nothing.
   * @throws {ServiceError} `VALIDATION_FAILED`, `USER_APP_CAPABILITY_DENIED`, `ETAG_MISMATCH`,
   *   `USER_APP_ACCESS_CHANGED`, `NOT_FOUND`.
   */
  async update(record, patch, { user, context, expectedRevision = null }) {
    const merged = mergeUserAppContent(record.content, patch);
    const byOwner = String(record.owner?.id) === String(user.id);
    await this.assertMaySave(merged, {
      actor: user,
      owner: byOwner ? user : context.owner?.principal || null,
      settings: context.settings,
      previous: record.content
    });
    const saved = await stored(() =>
      this.repository.update(record.id, merged, {
        actor: actorOf(user),
        expectedRevision,
        // A personal API key carries the groups it was created with; it does
        // not replace the snapshot of a signed-in request (design 6.2).
        ownerPrincipal:
          byOwner && ownerSnapshotNeedsRefresh(record, user)
            ? userAppOwnerSnapshot(user)
            : undefined,
        // A promoted app whose company app was deleted is active again; this write stores it.
        release: record.state === 'promoted' && context.publishedAppExists === false,
        authorize: context.authorize('edit')
      })
    );
    if (!saved) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changedKeys = [
      ...new Set([...Object.keys(record.content || {}), ...Object.keys(saved.content || {})])
    ].filter(key => !same(record.content?.[key], saved.content?.[key]));
    return {
      record: saved,
      changedKeys,
      capabilitiesChanged: !same(
        requestedCapabilityIds(record.content),
        requestedCapabilityIds(saved.content)
      )
    };
  }

  /**
   * `DELETE /api/apps/{appId}`: the owner deletes the app. Its newest content
   * state is kept for 90 days.
   *
   * @param {Object} record - `req.userApp`.
   * @param {Object} options
   * @param {Object} options.context - `req.userAppContext`.
   * @returns {Promise<Object>} The removed record.
   * @throws {ServiceError} `USER_APP_ACCESS_CHANGED`, `NOT_FOUND`.
   */
  async remove(record, { context }) {
    const removed = await stored(() =>
      this.repository.delete(record.id, {
        authorize: loaded => context.authorize('own')(loaded) && context.authorize('delete')(loaded)
      })
    );
    if (!removed) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return removed;
  }

  /**
   * `POST /api/apps/{appId}/_duplicate`: a new app of the caller with the
   * content of `record` and no members. A capability the caller may not use
   * in an app of their own is left out of the copy.
   *
   * @param {Object} record - `req.userApp`; the caller may use it.
   * @param {Object} options
   * @param {Object} options.user - `req.user`.
   * @returns {Promise<{record: Object, dropped: string[]}>} The new record and the
   *   capability IDs the copy does not have.
   * @throws {ServiceError} `CONFLICT` (`disabled`), `PERMISSION_DENIED`, `QUOTA_USER_APPS`.
   */
  async duplicate(record, { user }) {
    if (record.disabled) {
      throw conflict('disabled', 'The app is switched off and cannot be duplicated');
    }
    const settings = currentUserAppSettings();
    this.assertMayCreate(user, settings);
    let content = userAppContentSchema.parse(structuredClone(record.content));
    const dropped = [];
    for (const refused of await this.refusedCapabilities(content, {
      actor: user,
      owner: user,
      settings
    })) {
      content = withoutCapability(content, refused.capability);
      dropped.push(refused.capability);
    }
    if (dropped.length > 0) {
      content = userAppContentSchema.parse(content);
      await this.assertMaySave(content, { actor: user, owner: user, settings });
    }
    const copy = await this._create(user, {
      content,
      language: record.language || Object.keys(content.name)[0],
      origin: 'copy',
      settings
    });
    return { record: copy, dropped };
  }

  /**
   * `PUT /api/apps/{appId}/members`: replace the member list.
   *
   * A target that is new to the list must be a known, active user or an
   * existing group, and an audience the settings allow; targets already on
   * the list stay whatever the settings say today.
   *
   * @param {Object} record - `req.userApp`.
   * @param {unknown} body - `{ members: [{ type, id, role }] }`.
   * @param {Object} options
   * @param {Object} options.user - `req.user`.
   * @param {Object} options.context - `req.userAppContext`.
   * @param {number|null} [options.expectedRevision] - The revision of `If-Match`.
   * @returns {Promise<{record: Object, added: string[], removed: string[], changed: string[]}>}
   * @throws {ServiceError} `VALIDATION_FAILED`, `SHARE_TARGET_INVALID`,
   *   `SHARE_TARGET_NOT_ALLOWED`, `ETAG_MISMATCH`, `USER_APP_ACCESS_CHANGED`, `NOT_FOUND`.
   */
  async setMembers(record, body, { user, context, expectedRevision = null }) {
    const { members } = userAppMembersSchema.parse(body || {});
    const asShare = member => ({
      ...member,
      permission: member.role === 'editor' ? 'edit' : 'use'
    });
    // `resolveShares` speaks of `permission`; members carry `role`.
    const resolved = resolveShares(members.map(asShare), {
      prompt: { ownerId: record.owner?.id, shares: (record.members || []).map(asShare) },
      allowed: allowedUserAppShareTargets(context.settings),
      users: this._users(),
      groups: this._groups(),
      noun: 'apps'
    });
    if (!resolved.ok) {
      const { code = 'SHARE_TARGET_INVALID', ...details } = resolved.details || {};
      throw new ServiceError(code, resolved.error, {
        status: resolved.status,
        details: Object.keys(details).length ? details : undefined
      });
    }
    const next = resolved.shares.map(({ permission, ...share }) => ({
      ...share,
      role: permission === 'edit' ? 'editor' : 'user'
    }));
    const result = await stored(() =>
      this.repository.setMembers(record.id, next, {
        actor: actorOf(user),
        expectedRevision,
        authorize: context.authorize('share')
      })
    );
    if (!result) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return result;
  }

  /**
   * `POST /api/apps/{appId}/_leave`: the caller removes their own direct share.
   *
   * @param {Object} record - `req.userApp`.
   * @param {Object} options
   * @param {Object} options.user - `req.user`.
   * @returns {Promise<Object>} The record without the caller.
   * @throws {ServiceError} `CONFLICT` with `details.reason` `owner` (the owner
   *   cannot leave) or `noDirectShare` (the access comes through a group, an
   *   offer or the admin role).
   */
  async leave(record, { user }) {
    if (String(record.owner?.id) === String(user.id)) {
      throw conflict('owner', 'The owner cannot leave an app');
    }
    if (!hasDirectShare(record, user)) {
      throw conflict('noDirectShare', 'The app is not shared with you directly');
    }
    const result = await stored(() =>
      this.repository.removeMember(
        record.id,
        memberTargetKey({ type: 'user', id: String(user.id) }),
        {
          actor: actorOf(user),
          authorize: loaded => hasDirectShare(loaded, user)
        }
      )
    );
    if (!result) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return result.record;
  }

  /**
   * `PUT /api/apps/{appId}/owner-offer`: offer the app to a new owner. The
   * record keeps its owner until the receiver accepts.
   *
   * @param {Object} record - `req.userApp`.
   * @param {unknown} body - `{ ownerId }`.
   * @param {Object} options
   * @param {Object} options.user - `req.user`: the owner or a full admin.
   * @param {Object} options.context - `req.userAppContext`.
   * @param {number|null} [options.expectedRevision] - The revision of `If-Match`.
   * @returns {Promise<{record: Object, replaced: Object|null, lapsed: boolean}>} The record
   *   with `pendingOwner`, the offer it replaced and whether that one had lapsed.
   * @throws {ServiceError} `VALIDATION_FAILED` (unknown, inactive or current owner),
   *   `QUOTA_USER_APP_OFFERS`, `ETAG_MISMATCH`, `USER_APP_ACCESS_CHANGED`, `NOT_FOUND`.
   */
  async offer(record, body, { user, context, expectedRevision = null }) {
    const { ownerId } = userAppOwnerOfferSchema.parse(body || {});
    const users = this._users();
    const target = Object.hasOwn(users, ownerId) ? users[ownerId] : null;
    const refuse = message =>
      new ServiceError('VALIDATION_FAILED', message, {
        details: [{ path: 'ownerId', code: 'INVALID', message }]
      });
    if (!target || target.active === false) {
      throw refuse('The new owner is not a known, active user');
    }
    if (String(ownerId) === String(record.owner?.id)) {
      throw refuse('This user already owns the app');
    }
    const replaced = record.pendingOwner || null;
    const saved = await stored(
      () =>
        this.repository.setOffer(
          record.id,
          { id: String(ownerId), name: displayName({ ...target, id: ownerId }) },
          {
            actor: actorOf(user),
            maxOpenOffers: context.settings.limits.maxOpenOffersPerUser,
            expectedRevision,
            authorize: context.authorize('offer')
          }
        ),
      { max: context.settings.limits.maxOpenOffersPerUser }
    );
    if (!saved) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return { record: saved, replaced, lapsed: Boolean(replaced) && !openOffer(record) };
  }

  /**
   * `DELETE /api/apps/{appId}/owner-offer`: the owner or a full admin
   * withdraws the offer, the receiver declines it.
   *
   * @param {Object} record - `req.userApp`.
   * @param {Object} options
   * @param {Object} options.user - `req.user`.
   * @returns {Promise<{record: Object, offer: Object,
   *   outcome: 'withdrawn'|'declined'|'lapsed'}>}
   * @throws {ServiceError} `NOT_FOUND` when the app has no offer, `PERMISSION_DENIED`,
   *   `USER_APP_ACCESS_CHANGED`.
   */
  async clearOffer(record, { user }) {
    const admin = isAdmin(user) && user.authMode !== 'oauth_personal_key';
    const mayClear = loaded =>
      Boolean(loaded.pendingOwner) &&
      (String(loaded.owner?.id) === String(user.id) ||
        String(loaded.pendingOwner.id) === String(user.id) ||
        admin);
    if (!record.pendingOwner) {
      throw new ServiceError('NOT_FOUND', 'The app is not offered to anyone');
    }
    if (!mayClear(record)) throw denied('offer', 'You cannot withdraw this offer');
    const lapsed = !openOffer(record);
    const result = await stored(() =>
      this.repository.clearOffer(record.id, { authorize: mayClear })
    );
    if (!result?.offer) throw new ServiceError('NOT_FOUND', 'The app is not offered to anyone');
    const byReceiver = String(result.offer.id) === String(user.id);
    return {
      record: result.record,
      offer: result.offer,
      outcome: lapsed ? 'lapsed' : byReceiver ? 'declined' : 'withdrawn'
    };
  }

  /**
   * `POST /api/apps/{appId}/owner-offer/_accept`: the receiver becomes the
   * owner. In one write the repository swaps the owner, takes the owner
   * snapshot from this request, drops the receiver's own membership and
   * turns every "Can edit" member into "Can use".
   *
   * Checks, in this order: the offer is open and for the caller, the app can
   * change hands (not promoted, not switched off), `expectedRevision` names
   * the stored revision, the caller may create personal apps, the caller is
   * under the limit.
   *
   * @param {Object} record - `req.userApp`.
   * @param {Object} options
   * @param {Object} options.user - `req.user`: the receiver.
   * @param {Object} options.context - `req.userAppContext`.
   * @param {number} options.expectedRevision - The revision of `If-Match`. Required.
   * @returns {Promise<{record: Object, previousOwner: Object, downgraded: number}>}
   * @throws {ServiceError} `NOT_FOUND` (no open offer for the caller), `CONFLICT`,
   *   `ETAG_MISMATCH`, `PERMISSION_DENIED` (`details.required: 'userApps'`),
   *   `QUOTA_USER_APPS`, `USER_APP_ACCESS_CHANGED`.
   */
  async acceptOffer(record, { user, context, expectedRevision }) {
    const offer = openOffer(record);
    if (!offer || String(offer.id) !== String(user.id)) {
      throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    assertChangeable(record, context);
    // Nobody becomes owner of instructions they cannot read (design 8.3): while
    // the owner is blocked or may not share, the receiver sees the reduced
    // body only. Accepting would also move the app away from the block.
    const standing = userAppStanding(record, user, { settings: context.settings });
    if (!standing.permissions.canAcceptOffer) {
      const reason = standing.permissions.suspended;
      throw denied('use', 'The app cannot be handed over right now', reason ? { reason } : {});
    }
    if (Number(expectedRevision) !== Number(record.revision)) {
      throw new ServiceError('ETAG_MISMATCH', 'The app was changed by someone else');
    }
    this.assertMayCreate(user, context.settings);
    const result = await stored(
      () =>
        this.repository.acceptOffer(record.id, {
          receiver: actorOf(user),
          ownerPrincipal: userAppOwnerSnapshot(user),
          expectedRevision,
          limit: context.settings.limits.maxAppsPerUser,
          // Judged again under the lock, with the settings of now: switched
          // off, published, the owner blocked or the shares suspended since
          // the read. The state is the effective one: a promoted record whose
          // company app was deleted counts as active.
          authorize: loaded =>
            userAppStanding(loaded, user, { settings: currentUserAppSettings() }).permissions
              .canAcceptOffer === true,
          // The same write stores the release of such a record.
          release: loaded => loaded.state === 'promoted' && !hasCompanyApp(loaded)
        }),
      { max: context.settings.limits.maxAppsPerUser }
    );
    if (!result) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return result;
  }

  /**
   * The `userApps` block of `GET /api/apps/_config`: what the caller may do
   * and what a personal app of theirs may use. The server enforces the same
   * on every save.
   *
   * @param {Object} user - `req.user` with resolved permissions.
   * @param {Object} [options]
   * @param {string} [options.language='en'] - Language of the labels.
   * @param {boolean} [options.publishAvailable=false] - Whether the publish route is registered.
   * @returns {Promise<{enabled: boolean, canCreate: boolean, canShare: boolean,
   *   canPublish: boolean, maxApps: number, used: number, generator: boolean,
   *   capabilities: {modelChoice: boolean, upload: boolean, webSearch: boolean, skills: boolean,
   *   integrations: Array<{id: string, label: string,
   *   actions: Array<{name: string, description: string}>}>}}>}
   */
  async configFor(user, { language = 'en', publishAvailable = false } = {}) {
    const settings = currentUserAppSettings();
    const features = configCache.getFeatures() || {};
    const repo = this.repository;
    const enabled = isUserAppsEnabled(features) && repo.isAvailable();
    const canCreate = enabled && mayCreateUserApps(user, settings);
    const canShare = enabled && mayShareUserApps(user);
    let used = 0;
    if (enabled && user?.id) {
      used = await repo.countOwned(user.id).catch(() => 0);
    }
    const off = {
      modelChoice: false,
      upload: false,
      webSearch: false,
      skills: false,
      integrations: []
    };
    return {
      enabled,
      canCreate,
      canShare,
      canPublish: canShare && publishAvailable && settings.sharing.allowPublish === true,
      maxApps: settings.limits.maxAppsPerUser,
      used,
      generator: canCreate && isFeatureEnabled('appGenerator', features),
      capabilities: canCreate
        ? {
            modelChoice: settings.capabilities.modelChoice,
            upload: settings.capabilities.upload,
            webSearch: settings.capabilities.webSearch && this._searchFor(user),
            skills: settings.capabilities.skills && isFeatureEnabled('skills', features),
            integrations: await this._bindableInstallations(user, settings, features, language)
          }
        : off
    };
  }

  _searchFor(user) {
    try {
      return isWebSearchAvailableTo(user) === true;
    } catch {
      return false;
    }
  }

  /** The installations the caller may bind in an app of their own, with the allowed actions. */
  async _bindableInstallations(user, settings, features, language) {
    const allowed = settings.capabilities.integrations;
    if (allowed.length === 0 || !isFeatureEnabled('integrations', features)) return [];
    try {
      const resolved = await installedIntegrationService.resolveAllEnabled(language);
      const result = [];
      for (const { id, actions } of allowed) {
        const entry = resolved.find(candidate => candidate?.instance?.id === id);
        if (!entry || !mayUseIntegration(entry.instance, user)) continue;
        const declared = (entry.definition.actions || []).filter(
          action => action?.name && actions.includes(action.name)
        );
        if (declared.length === 0) continue;
        result.push({
          id,
          label: entry.label || getLocalizedString(entry.definition.name, language, 'en', id),
          actions: declared.map(action => ({
            name: action.name,
            description: getLocalizedString(action.description, language, 'en', '')
          }))
        });
      }
      return result;
    } catch (error) {
      logger.warn('Could not list the installations personal apps may bind', {
        component: COMPONENT,
        error: error.message
      });
      return [];
    }
  }

  /**
   * `GET /api/apps/_share-targets`: the users, groups and "everyone" the
   * caller can pick. The rules of the project lookup: users from two
   * characters, at most ten, never the caller; groups without `anonymous`.
   *
   * With `purpose: 'share'` the answer holds only the audiences the settings
   * allow, and the caller needs `userAppSharing`. With `purpose: 'offer'` it
   * holds users only, whatever the sharing settings say, and the caller owns
   * an app or is a full admin.
   *
   * @param {Object} user - `req.user` with resolved permissions.
   * @param {Object} [options]
   * @param {string} [options.q] - Search text.
   * @param {'share'|'offer'} [options.purpose='share']
   * @returns {Promise<{users: Array<{id: string, name: string, email: string|null}>,
   *   groups: Array<{id: string, name: string, description: string}>, everyone: boolean}>}
   * @throws {ServiceError} `PERMISSION_DENIED`
   */
  async shareTargets(user, { q = '', purpose = 'share' } = {}) {
    const settings = currentUserAppSettings();
    const forOffer = purpose === 'offer';
    if (forOffer) {
      const admin = isAdmin(user) && user.authMode !== 'oauth_personal_key';
      if (!admin && (await this.repository.countOwned(user.id)) === 0) {
        throw denied('own', 'You own no app you could hand over');
      }
    } else if (!mayShareUserApps(user)) {
      throw denied('userAppSharing', 'You may not share personal apps');
    }
    const allowed = forOffer
      ? { user: true, group: false, everyone: false }
      : allowedUserAppShareTargets(settings);
    const query = String(q).trim().slice(0, LOOKUP_MAX_CHARS).toLowerCase();
    let users = [];
    if (allowed.user && query.length >= LOOKUP_MIN_CHARS) {
      const me = String(user.id);
      users = Object.entries(this._users())
        .map(([id, entry]) => ({ ...entry, id: String(entry?.id ?? id) }))
        .filter(entry => entry.active !== false && entry.id !== me)
        .filter(entry =>
          [entry.name, entry.username, entry.email].some(
            field => typeof field === 'string' && field.toLowerCase().includes(query)
          )
        )
        .map(entry => ({
          id: entry.id,
          name: displayName(entry),
          email: entry.email ? String(entry.email) : null
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, LOOKUP_LIMIT);
    }
    let groups = [];
    if (allowed.group) {
      groups = Object.entries(this._groups())
        .filter(([id]) => !UNSHAREABLE_GROUPS.includes(id))
        .map(([id, group]) => ({
          id,
          name: String(group?.name || id),
          description: group?.description ? String(group.description) : ''
        }))
        .filter(
          group =>
            !query ||
            group.name.toLowerCase().includes(query) ||
            group.id.toLowerCase().includes(query)
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, LOOKUP_LIMIT);
    }
    return {
      users,
      groups,
      everyone: allowed.everyone === true,
      // Which kinds of audience can be picked at all, so a dialog can leave out a search that
      // would find nothing.
      allowed: {
        user: allowed.user === true,
        group: allowed.group === true,
        everyone: allowed.everyone === true
      }
    };
  }
}

let cachedService = null;

/**
 * The process-wide service over the process-wide repository.
 *
 * @returns {UserAppService}
 */
export function getUserAppService() {
  if (!cachedService) cachedService = new UserAppService();
  return cachedService;
}

export default UserAppService;
