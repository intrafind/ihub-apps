// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `userAppAccessRequired(level)` — the per-resource gate of a personal app
 * (`:appId` of the personal shape).
 *
 * It loads the app, decides what the caller may do with it
 * (`services/userApps/userAppAccess.js`) and refuses before the handler
 * runs. An app the caller may not see answers 404 with the body of an
 * unknown ID, so an ID cannot be probed.
 *
 * Two kinds of route use it:
 *
 * - **Routes that exist without personal apps** (the chat routes, through
 *   `chatAuthRequired`) pass `{ existing: true }`. Everything that is refused
 *   answers that one 404: the feature being off, the store being down and
 *   "you may see it but not use it" must not tell an existing app from an ID
 *   nobody has.
 * - **The routes of personal apps themselves** answer 403
 *   `USER_APPS_DISABLED` while the feature is off, 503
 *   `USER_APPS_UNAVAILABLE` while the store is down, and 403
 *   `PERMISSION_DENIED` with `details.required` for an app the caller may see
 *   but not treat this way.
 *
 * On success the handler finds `req.userApp` (the stored record),
 * `req.userAppPermissions` and `req.userAppContext`.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 4.5, 5 and 7.3.
 *
 * @module middleware/userAppAccess
 */
import configCache from '../configCache.js';
import { enhanceUserWithPermissions, isAnonymousAccessAllowed } from '../utils/authorization.js';
import { ServiceError } from '../utils/ServiceError.js';
import {
  inspectUserApp,
  isConfigAppId,
  userAppStanding
} from '../services/userApps/userAppResolution.js';
import {
  USER_APP_ACCESS_LEVELS,
  satisfiesUserAppLevel
} from '../services/userApps/userAppAccess.js';

/** The message of every 404 of this gate: the same for an unknown and a hidden app. */
const NOT_FOUND_MESSAGE = 'App not found';

/**
 * Give the request a principal with resolved permissions, as the data routes
 * do: the signed-in user, or the anonymous principal when anonymous access is
 * on. The anonymous principal never reaches a personal app; it gets the 404.
 *
 * @param {Object} req
 */
function ensurePrincipal(req) {
  const platformConfig = configCache.getPlatform() || {};
  const authConfig = platformConfig.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
  }
  if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
  }
}

/**
 * Express middleware factory: require `level` on the personal app named by
 * `req.params.appId`.
 *
 * @param {'view'|'use'|'edit'|'share'|'own'|'delete'|'offer'} level
 * @param {Object} [options]
 * @param {boolean} [options.existing=false] - The route exists without
 *   personal apps: every refusal is the 404 of an unknown ID.
 * @param {(req: import('express').Request) => unknown} [options.appIdOf] - Where
 *   the ID comes from; `req.params.appId` by default. A route that names the
 *   app in its body (`POST /api/apps/_revise`) reads it from there.
 * @returns {import('express').RequestHandler}
 *
 * @example
 * app.patch('/api/apps/:appId', authenticatedOnly, userAppAccessRequired('edit'), handler);
 * // in the handler:
 * await repo.update(req.userApp.id, content, {
 *   actor, authorize: req.userAppContext.authorize('edit')
 * });
 */
export function userAppAccessRequired(
  level,
  { existing = false, appIdOf = req => req.params.appId } = {}
) {
  if (!USER_APP_ACCESS_LEVELS.includes(level)) {
    throw new TypeError(`Unknown personal app access level: ${level}`);
  }
  return async function userAppAccess(req, res, next) {
    try {
      ensurePrincipal(req);
      const state = await inspectUserApp(appIdOf(req), req.user, { req });
      if (state.status !== 'ok') {
        if (!existing && state.status === 'disabled') {
          throw new ServiceError('USER_APPS_DISABLED', 'Personal apps are switched off');
        }
        if (!existing && state.status === 'unavailable') {
          throw new ServiceError('USER_APPS_UNAVAILABLE', 'Personal apps are unavailable');
        }
        throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      if (!satisfiesUserAppLevel(state.permissions, level)) {
        if (existing) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
        throw new ServiceError(
          'PERMISSION_DENIED',
          'You do not have the required access to this app',
          { status: 403, details: { required: level } }
        );
      }
      req.userApp = state.record;
      req.userAppPermissions = state.permissions;
      req.userAppContext = {
        settings: state.settings,
        owner: state.owner,
        effective: state.effective,
        retired: state.retired,
        publishedAppExists: state.publishedAppExists,
        /**
         * The same check again, for the repository to run on the record it
         * loads under its lock. The owner is looked up again: the record may
         * have changed hands while the write waited.
         *
         * @param {'view'|'use'|'edit'|'share'|'own'|'delete'|'offer'} required
         * @returns {(record: Object) => boolean}
         */
        authorize: required => loaded =>
          satisfiesUserAppLevel(
            userAppStanding(loaded, req.user, { settings: state.settings }).permissions,
            required
          )
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** The gate of the chat routes for a personal app: use it, or the 404 of an unknown ID. */
const personalAppUseRequired = userAppAccessRequired('use', { existing: true });

/**
 * The gate of the chat routes (`chatAuthRequired`) for an ID of the personal
 * shape. A personal app: the caller may use it, or gets the 404 of an
 * unknown ID. A config app that happens to have such an ID is an admin app
 * and goes to the check of admin apps; the clash with a personal record of
 * the same ID is the resolver's to refuse.
 *
 * @param {import('express').RequestHandler} adminAppGate - `appAccessRequired`.
 * @returns {import('express').RequestHandler}
 */
export function chatUserAppAccess(adminAppGate) {
  return function chatUserAppGate(req, res, next) {
    if (isConfigAppId(req.params.appId)) {
      // `appAccessRequired` throws its refusal.
      try {
        return adminAppGate(req, res, next);
      } catch (error) {
        return next(error);
      }
    }
    return personalAppUseRequired(req, res, next);
  };
}

export default userAppAccessRequired;
