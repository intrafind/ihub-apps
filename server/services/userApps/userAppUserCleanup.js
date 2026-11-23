// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a user's deletion does to personal apps (design 8.5): every app they
 * own is deleted with its stored content states, their membership is dropped
 * from the apps of others, and offers made to them are cleared.
 *
 * A published company app is not affected: it has no owner.
 *
 * @module services/userApps/userAppUserCleanup
 */
import logger from '../../utils/logger.js';
import { ACCESS_CHANGED, getUserAppRepository } from './UserAppRepository.js';
import { memberTargetKey } from './userAppAccess.js';

const COMPONENT = 'UserAppUserCleanup';

/**
 * Remove what a deleted user leaves in personal apps.
 *
 * Each delete runs under the app's lock with an `authorize` callback, so an
 * app whose offer was accepted a moment earlier stays with its new owner.
 *
 * @param {string} userId - The deleted user's ID.
 * @param {Object} [options]
 * @param {import('./UserAppRepository.js').UserAppRepository} [options.repository]
 *   Defaults to the process-wide one.
 * @returns {Promise<{removed: number, statesRemoved: number, membershipsDropped: number,
 *   offersCleared: number}>}
 * @throws {AggregateError} When an app, a membership or an offer could not be
 *   cleaned up. Everything else was still done.
 *
 * @example
 * await cleanUpUserAppsOfUser('anna'); // → { removed: 3, statesRemoved: 1, membershipsDropped: 2, offersCleared: 0 }
 */
export async function cleanUpUserAppsOfUser(userId, { repository } = {}) {
  const result = { removed: 0, statesRemoved: 0, membershipsDropped: 0, offersCleared: 0 };
  const repo = repository || getUserAppRepository();
  if (!repo.isAvailable()) return result;
  const id = String(userId);
  const failures = [];
  const note = (message, appId, error) => {
    logger.error(message, { component: COMPONENT, appId, error: error.message });
    failures.push(error);
  };

  const ownedBy = record => String(record?.owner?.id) === id;
  for (const app of await repo.listOwned(id)) {
    try {
      // Judged again under the app's lock: an offer accepted since the listing
      // leaves the new owner's app alone. Nothing of the app stays.
      const deleted = await repo.delete(app.id, { keepLastState: false, authorize: ownedBy });
      if (deleted) result.removed += 1;
    } catch (error) {
      if (error?.code === ACCESS_CHANGED) continue; // handed over since the listing
      note('Failed to delete a personal app of a deleted user', app.id, error);
    }
  }

  // The states kept of apps the user deleted earlier.
  try {
    result.statesRemoved = await repo.purgeDeletedStates(id, { all: true });
  } catch (error) {
    note('Failed to remove the kept content states of a deleted user', null, error);
  }

  // The markers hold memberships and open offers alike; each record says which.
  const userKey = memberTargetKey({ type: 'user', id });
  for (const app of await repo.listSharedWith([userKey], { limit: 0 })) {
    try {
      const left = await repo.removeMember(app.id, userKey, {
        actor: { id: 'system', name: 'user deletion' }
      });
      if (left?.removed) result.membershipsDropped += 1;
      const cleared = await repo.clearOffer(app.id, {
        authorize: record => !record.pendingOwner || String(record.pendingOwner.id) === id
      });
      if (cleared?.offer) result.offersCleared += 1;
    } catch (error) {
      if (error?.code === ACCESS_CHANGED) continue; // offered to someone else meanwhile
      note('Failed to drop a membership or an offer of a deleted user', app.id, error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of the user's personal apps, memberships or offers could not be cleaned up`
    );
  }
  return result;
}
