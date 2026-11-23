// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How an app is resolved for the interactive chat.
 *
 * An admin app comes from `configCache.getAppForRequest`, as before. A
 * personal app (feature `userApps`; an ID of the personal shape, see
 * `shared/userAppContent.js`) is not in the config cache: it is loaded from
 * its store, the caller's access is decided, and the ceiling builds the app
 * object the chat runs with (`userAppResolution.js`).
 *
 * **A personal-shaped ID never reaches a default branch.** Every site that
 * receives an app ID from a request or a stored chat either gets the app from
 * {@link resolveAppForChat} or refuses the ID ({@link isUnresolvedUserAppId}).
 *
 * This file is imported by the routes of the chat. It loads the store-backed
 * half only when an ID of the personal shape arrives, so a request for an
 * admin app runs the code it always ran.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 7.
 *
 * @module services/userApps/resolveApp
 */
import configCache from '../../configCache.js';
import { isUserAppId } from '../../../shared/userAppContent.js';

/** The values of `scope` on `GET /api/apps`. */
export const USER_APP_SCOPES = Object.freeze(['mine', 'shared', 'personal']);

/** The store-backed half, loaded on first use. */
let resolution = null;
async function loadResolution() {
  resolution ??= await import('./userAppResolution.js');
  return resolution;
}

/**
 * Whether an ID that did not resolve must be refused instead of being treated
 * as "no app": it has the personal shape. A site that falls back to a default
 * for an unknown app (a base upload policy, "no gate") asks this first.
 *
 * @param {unknown} appId
 * @param {Object|null|undefined} found - What {@link resolveAppForChat} answered.
 * @returns {boolean}
 *
 * @example
 * const found = await resolveAppForChat(appId, req.user, { req });
 * if (isUnresolvedUserAppId(appId, found)) throw new ServiceError('NOT_FOUND', 'App not found');
 */
export function isUnresolvedUserAppId(appId, found) {
  return isUserAppId(appId) && !found?.app;
}

/**
 * The app an interactive chat request may run, or null.
 *
 * Admin app: what `configCache.getAppForRequest` answers; the caller keeps
 * its own group check (`userApp` is null then). Personal app: the feature is
 * on, the caller may hold personal apps, the store answers and the caller may
 * use the app; then the ceiling. The group permission `apps` is not consulted
 * for a personal app: owner and shares decide. Memoised on `req` for the rest
 * of the request.
 *
 * No request field, header or query parameter takes part: only the ID, the
 * principal, the stored record and the configuration.
 *
 * @param {string} appId
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {Object} [options.req] - The request; the decision is memoised on it.
 * @param {Object} [options.repository] - The store of personal apps; defaults
 *   to the process-wide one.
 * @returns {Promise<{app: Object, userApp: null | {record: Object, permissions: Object,
 *   capabilities: Array<{id: string, requested: boolean, granted: boolean, reason?: string}>,
 *   approval: {mode: 'writes'|'always', chatGrants: boolean}}} | null>}
 *
 * @example
 * const found = await resolveAppForChat(appId, req.user, { req });
 * const app = found?.app || null;
 * if (!app || (!found.userApp && !canUserAccessResource(req.user, 'apps', app.id))) {
 *   throw new ServiceError('NOT_FOUND', 'App not found');
 * }
 */
export async function resolveAppForChat(appId, user, { req, repository } = {}) {
  if (isUserAppId(appId)) {
    const { resolveUserApp } = await loadResolution();
    const personal = await resolveUserApp(appId, user, { req, repository });
    // `undefined`: a config app has this ID and no personal app does.
    if (personal !== undefined) return personal;
  }
  const app = configCache.getAppForRequest(appId, user);
  return app ? { app, userApp: null } : null;
}

/**
 * The body of `GET /api/apps/{appId}` for an ID of the personal shape, or
 * null when the answer is the 404 of an unknown ID. See `readUserAppFor` in
 * `userAppResolution.js`.
 *
 * @param {string} appId
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {Object} [options.req]
 * @returns {Promise<{configApp: true} | {configApp: false, body: Object, etag: string|null,
 *   kind: 'full'|'reduced'|'retired'} | null>}
 */
export async function readUserAppFor(appId, user, options = {}) {
  return (await loadResolution()).readUserAppFor(appId, user, options);
}

/**
 * The personal apps of `GET /api/apps?scope=…`. See `listUserAppsFor` in
 * `userAppResolution.js`.
 *
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {'mine'|'shared'|'personal'} scope
 * @param {Object} [options]
 * @returns {Promise<Object[]>}
 */
export async function listUserAppsFor(user, scope, options = {}) {
  return (await loadResolution()).listUserAppsFor(user, scope, options);
}

/**
 * Record that a chat turn ran a personal app (`lastUsedAt`, and one audit
 * entry per chat and revision). Nothing happens for an admin app. Never
 * throws. See `noteUserAppRun` in `userAppResolution.js`.
 *
 * @param {Object} options
 * @param {Object} options.req - The chat request.
 * @param {string} options.chatId
 * @param {{record: Object, permissions: Object}|null|undefined} options.userApp - `userApp`
 *   of {@link resolveAppForChat}.
 * @returns {Promise<boolean>} Whether an audit entry was written.
 */
export async function noteUserAppRun(options = {}) {
  if (!options.userApp) return false;
  return (await loadResolution()).noteUserAppRun(options);
}
